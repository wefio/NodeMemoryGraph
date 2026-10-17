/** Passive HTTP-lease transport shared by thin harness adapters that must
 * never start, own, or stop a daemon. Adapters read the live-lease handshake
 * file (<dataDir>/nmg.sqlite.server.json), verify the protocol over one `hello`
 * RPC, and then talk JSON-RPC/HTTP with a small per-call timeout. All transport
 * here is fail-soft at the call site: adapters decide how to degrade.
 *
 * Recipe source: skills/nmg-memory/references/harness-adapters.md ("Passive
 * transport"). Hosts with long-lived processes (resident plugins) re-resolve a
 * failed or absent lease with `dropCompatibleLease` instead of caching it
 * forever; the per-directory cache only saves the one-time hello handshake. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { assertDaemonProtocol } from "../cli/daemon-client.ts";
import type { NmgHelloResult } from "../cli/protocol.ts";

export interface HttpLease {
  transport?: "http";
  host: string;
  port: number;
  token: string;
  pid: number;
}

/** Budget per harness-adapters.md: an RPC must never stall a user turn. */
export const RPC_TIMEOUT_MS = 2_000;

function pidAlive(pid: unknown): boolean {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

/** Parse+validate the lease file without touching the network. Returns null
 * when the file is missing, non-loopback, malformed, or the pid is dead. */
export function liveLease(dir: string): HttpLease | null {
  let lease: unknown;
  try {
    // JSON.parse SyntaxError and fs read errors both mean "no usable lease".
    lease = JSON.parse(readFileSync(join(dir, "nmg.sqlite.server.json"), "utf8"));
  } catch {
    return null;
  }
  const candidate = lease as Partial<HttpLease> | null;
  if (
    !candidate ||
    candidate.transport !== "http" ||
    candidate.host !== "127.0.0.1" ||
    !Number.isInteger(candidate.port) ||
    (candidate.port as number) < 1 ||
    (candidate.port as number) > 65_535 ||
    typeof candidate.token !== "string" ||
    candidate.token.length < 16
  )
    return null;
  return pidAlive(candidate.pid) ? (candidate as HttpLease) : null;
}

/** One JSON-RPC/HTTP call over a verified lease. Throws on transport errors so
 * the adapter decides between CLI fallback, retry, or silence. */
export async function rpcCall(
  lease: HttpLease,
  method: string,
  params: unknown,
  signal?: AbortSignal,
) {
  const response = await fetch(`http://${lease.host}:${lease.port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${lease.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    signal: signal ?? AbortSignal.timeout(RPC_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`NMG HTTP ${response.status}`);
  const parsed = await response.json();
  if (parsed?.jsonrpc !== "2.0") throw new Error("invalid NMG JSON-RPC response");
  if (parsed.error) throw new Error(parsed.error.message ?? "rpc error");
  return parsed.result;
}

const verifiedLeaseByDirectory = new Map<string, Promise<HttpLease | null>>();

/** Lease verified against the daemon protocol (nmg.v9 + session-active-graph
 * capability). One hello per directory per process; a failed verification is
 * not cached as permanent (see dropCompatibleLease). */
export async function compatibleLease(dir: string): Promise<HttpLease | null> {
  let pending = verifiedLeaseByDirectory.get(dir);
  if (!pending) {
    pending = verifyLease(dir);
    verifiedLeaseByDirectory.set(dir, pending);
    void pending
      .then((lease) => {
        // A null result (no daemon now) must not pin the cache: a daemon may
        // start later, and a dead lease leaves an unusable stale entry.
        if (!lease) verifiedLeaseByDirectory.delete(dir);
      })
      .catch(() => undefined);
  }
  return pending;
}

/** Forget the cached verification for a directory so the next call re-reads
 * the lease file and re-handshakes. Resident adapters call this after an RPC
 * transport failure (the lease may have rotated port/token) and when a probe
 * returned no lease (the daemon may start later). */
export function dropCompatibleLease(dir: string): void {
  verifiedLeaseByDirectory.delete(dir);
}

async function verifyLease(dir: string): Promise<HttpLease | null> {
  const lease = liveLease(dir);
  if (!lease) return null;
  try {
    const hello = (await rpcCall(lease, "hello", {})) as NmgHelloResult;
    assertDaemonProtocol(hello);
    if (!hello.capabilities.includes("session-active-graph")) return null;
    return lease;
  } catch {
    return null;
  }
}
