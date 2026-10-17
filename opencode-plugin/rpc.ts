/**
 * Transport wrapper for the OpenCode thin adapter.
 *
 * HOST-ADAPTER BOUNDARY (shared layer rule): this file owns no NMG capability
 * and no daemon lifecycle. It reuses the running daemon through the passive
 * HTTP-lease handshake (src/integration/lease-transport.ts) and only falls back
 * to a one-shot CLI spawn for the three model-visible methods. All transport
 * errors surface as actionable text, never raw stack traces.
 *
 * Host context: OpenCode v2 plugins run inside the shared background service
 * (`opencode serve --service`), so this module is long-lived. A daemon restart
 * rotates port/token, so one failed RPC triggers a lease re-verify before the
 * CLI fallback is considered; a null probe (no daemon yet) also restarts the
 * handshake on the next call instead of caching "unavailable" forever.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveNmgDataDir } from "../src/cli/data-path.ts";
import {
  compatibleLease,
  dropCompatibleLease,
  rpcCall,
} from "../src/integration/lease-transport.ts";

/** Board and session-AG bookkeeping are lease-RPC-only surfaces: without a
 * live daemon they must fail loudly and actionably rather than silently drop
 * coordination state. */
const CLI_FALLBACK_METHODS = new Set(["get", "search", "remember"]);

function pluginDirectory(): string {
  return dirname(fileURLToPath(import.meta.url));
}

/** Repository checkout root: NMG_ROOT wins, else the package layout
 * (<repoRoot>/opencode-plugin/) implies the parent directory. */
export function resolveRepoRoot(): string {
  const configured = process.env.NMG_ROOT?.trim();
  return configured || dirname(pluginDirectory());
}

export interface InvokeContext {
  dataDir?: string;
}

/**
 * One daemon call. Lease first (single-digit-ms), one re-verify after an RPC
 * failure (a resident service outlives daemon restarts), then the CLI fallback
 * for the methods that have one. Non-fallback failures throw actionable text.
 */
export async function invokeDaemon(
  method: string,
  params: Record<string, unknown>,
  context: InvokeContext = {},
): Promise<unknown> {
  const dataDir = context.dataDir ?? resolveNmgDataDir();
  let lease = await compatibleLease(dataDir).catch(() => null);
  if (lease) {
    try {
      return await rpcCall(lease, method, params);
    } catch (error) {
      dropCompatibleLease(dataDir);
      lease = await compatibleLease(dataDir).catch(() => null);
      if (lease) {
        try {
          return await rpcCall(lease, method, params);
        } catch {
          // Both lease attempts failed; fall back to the CLI below.
        }
      }
      if (!CLI_FALLBACK_METHODS.has(method)) {
        throw bookkeepingUnavailable(method, error);
      }
    }
  }
  if (CLI_FALLBACK_METHODS.has(method)) return cliFallback(method, params);
  throw noLeaseForBookkeeping(method);
}

function noLeaseForBookkeeping(method: string): Error {
  return new Error(
    `NMG ${method} failed and the method is not covered by the CLI fallback. ` +
      "Board delivery receipts, AG disclosure, and attribution need a live " +
      "daemon lease: run `nmg daemon start` from a node-memory-graph checkout " +
      "and retry; the adapter re-handshakes without a host restart.",
  );
}

function bookkeepingUnavailable(method: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(
    `NMG ${method} failed over HTTP after a lease re-verify (${reason}) and ` +
      "this method has no CLI fallback. Check `nmg daemon status`; the " +
      "adapter re-handshakes on the next call.",
  );
}

function cliFallback(method: string, params: Record<string, unknown>): Promise<unknown> {
  const argv =
    method === "search"
      ? searchArgv(params)
      : method === "get"
        ? getArgv(params)
        : rememberArgv(params);
  return cliJson(argv);
}

function optionalList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .map((entry) => entry.trim())
    .slice(0, max);
}

function projectAndSession(params: Record<string, unknown>): string[] {
  const argv: string[] = [];
  if (typeof params.projectDir === "string" && params.projectDir.trim()) {
    argv.push("--project-dir", params.projectDir.trim());
  }
  if (typeof params.sessionId === "string" && params.sessionId.trim()) {
    argv.push("--session-id", params.sessionId.trim());
  }
  return argv;
}

function searchArgv(params: Record<string, unknown>): string[] {
  const argv = ["search", String(params.query ?? "")];
  if (Number.isFinite(params.limit)) argv.push("--limit", String(params.limit));
  if (Number.isFinite(params.maxTier)) argv.push("--max-tier", String(params.maxTier));
  if (Number.isFinite(params.graphHops)) argv.push("--graph-hops", String(params.graphHops));
  if (typeof params.nodeName === "string" && params.nodeName.trim()) {
    argv.push("--node", params.nodeName.trim());
  }
  if (params.includeHistorical === true) argv.push("--include-historical");
  if (params.tieredDisclosure === true) argv.push("--tiered-disclosure");
  argv.push(...projectAndSession(params), "--json");
  return argv;
}

function getArgv(params: Record<string, unknown>): string[] {
  const argv = ["get", ...optionalList(params.memoryIds, 50)];
  if (typeof params.activeGraphId === "string" && params.activeGraphId.trim()) {
    argv.push("--active-graph-id", params.activeGraphId.trim());
  }
  if (Number.isFinite(params.graphHops)) argv.push("--graph-hops", String(params.graphHops));
  argv.push(...projectAndSession(params), "--json");
  return argv;
}

function rememberArgv(params: Record<string, unknown>): string[] {
  const argv = [
    "remember",
    String(params.statement ?? ""),
    "--node",
    String(params.nodeName ?? ""),
  ];
  if (typeof params.memoryType === "string" && params.memoryType.trim()) {
    argv.push("--type", params.memoryType.trim());
  }
  if (typeof params.evidence === "string" && params.evidence.trim()) {
    argv.push("--evidence", params.evidence);
  }
  if (typeof params.eventTime === "string" && params.eventTime.trim()) {
    argv.push("--event-time", params.eventTime.trim());
  }
  if (Number.isFinite(params.tier)) argv.push("--tier", String(params.tier));
  if (Number.isFinite(params.importance)) argv.push("--importance", String(params.importance));
  if (typeof params.writeReason === "string" && params.writeReason.trim()) {
    argv.push("--write-reason", params.writeReason);
  }
  if (typeof params.writeSource === "string" && params.writeSource.trim()) {
    argv.push("--write-source", params.writeSource.trim());
  }
  if (typeof params.externalSource === "object" && params.externalSource !== null) {
    const source = String((params.externalSource as { source?: unknown }).source ?? "").trim();
    if (source) argv.push("--external-source", source);
  }
  for (const trigger of optionalList(params.recallTriggers, 16)) {
    argv.push("--recall-trigger", trigger);
  }
  argv.push(...projectAndSession(params), "--json");
  return argv;
}

/** One-shot CLI call (`node bin/nmg.mjs …`). Spawn cost (~180 ms) is why this
 * is only the no-daemon fallback, never the happy path. */
function cliJson(argv: readonly string[]): Promise<unknown> {
  const cli = join(resolveRepoRoot(), "bin", "nmg.mjs");
  return new Promise((resolve, reject) => {
    execFile(
      "node",
      [cli, ...argv],
      { windowsHide: true, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `NMG CLI fallback failed: ${(error.message ?? "").slice(0, 200)}` +
                ((stderr ?? "").trim() ? ` — ${String(stderr).trim().slice(0, 200)}` : ""),
            ),
          );
          return;
        }
        try {
          resolve(JSON.parse(String(stdout)) as unknown);
        } catch {
          reject(new Error("NMG CLI fallback returned non-JSON output"));
        }
      },
    );
  });
}
