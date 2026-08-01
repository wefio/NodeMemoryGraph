import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  type NmgGetParams,
  type NmgDeleteMemoryParams,
  type NmgMergeNodesParams,
  type NmgMethod,
  type NmgPerfParams,
  type NmgRememberParams,
  type NmgRetentionCandidatesParams,
  type NmgSearchParams,
  type NmgSetStorageStateParams,
  type NmgSplitNodeParams,
  type NmgSyncStgParams,
} from "./protocol.ts";
import { httpCall } from "./http-client.ts";
import { serveHttp } from "./http-server.ts";
import {
  acquireServerLease,
  isProcessAlive,
  readServerState,
  serverStatePath,
  stopServer,
} from "./lifecycle.ts";
import { NmgService } from "./service.ts";
import { histogramQuantile } from "../core/perf.ts";

const USAGE = `NMG command line

Usage:
  nmg status [--json] [--data-dir DIR | --db FILE]
  nmg remember STATEMENT --node NAME [options] [--json]
  nmg search QUERY [options] [--json]
  nmg get MEMORY_ID... [--graph-hops N] [--json]
  nmg retention candidates [policy options] [--json]
  nmg retention archive MEMORY_ID [--json]
  nmg retention quarantine MEMORY_ID [--recovery-days N] [--json]
  nmg retention restore MEMORY_ID [--json]
  nmg memory delete MEMORY_ID [--json]
  nmg node merge NODE_ID... --target-name NAME [--target-kind KIND] [--json]
  nmg node split NODE_ID --partition NAME=MEMORY_ID,... --partition ... [--json]
  nmg perf aggregates [--json]
  nmg perf prune [--max-days N] [--max-rows N] [--json]
  nmg stg sync --project-dir DIR --scope KEY=VALUE [--limit N] [--json]
  nmg daemon start|status|stop [--data-dir DIR | --db FILE] [--json]

Common options:
  --data-dir DIR             NMG data directory (default: NMG_DATA_DIR or .nmg)
  --db FILE                  Explicit SQLite database path
  --scope KEY=VALUE          Repeatable or comma-separated scope filter
  --project-dir DIR          Project-local STG root (stores .nmg/stg.sqlite)
  --json                     Emit the full machine-readable result

Remember options:
  --node NAME                Stable semantic node name (required)
  --type TYPE                fact, state, event, preference, constraint, strategy
  --state-key KEY            Stable key required for state memory
  --evidence TEXT            Supporting source text
  --actor ACTOR              user, assistant, system, or tool
  --truth STATUS             asserted, inferred, unverified, or verified
  --tier N                   Initial tier 0..3
  --importance N             Importance 0..1
  --residence VALUE          ltg or stg
  --write-reason TEXT        Durable-write justification
  --external-source REF      External provenance: web:URL or file:PATH
  --retrieved-at ISO         External retrieval timestamp (default: now)
  --content-hash HASH        Optional external content hash

Search options:
  --node NAME                Restrict to one semantic node
  --max-tier N               Deepest tier 0..3
  --limit N                  Return 1..50 records
  --graph-hops N             Expand 0..3 graph hops
  --source-actor ACTOR       Restrict evidence actor
  --include-historical       Include inactive/superseded memories
  --retrieval-mode MODE      fts5, hybrid, qwen3, hashing, or legacy
  --vector-granularity MODE  hierarchy, records, or union
  --second-pass              Enable progressive QPP recall
  --no-perf                  Disable per-phase performance timing

Retention policy options:
  --dormant-after-days N     Minimum age and idle time before L4
  --quarantine-after-days N  Minimum time in L4 before L5
  --maximum-importance N     Candidate ceiling from 0..1
  --maximum-access-count N   Candidate access-count ceiling

Node maintenance:
  --target-name NAME         New canonical node name for merge
  --target-kind KIND         Optional semantic node kind
  --partition NAME=IDS       Split partition; repeat and assign every memory ID
`;
const ALL_FLAGS = new Set(["include-historical", "json", "no-perf", "second-pass"]);
const ALL_OPTIONS = new Set([
  "actor",
  "data-dir",
  "db",
  "dormant-after-days",
  "event-time",
  "external-source",
  "evidence",
  "evidence-role",
  "expires-at",
  "graph-hops",
  "importance",
  "content-hash",
  "maximum-access-count",
  "maximum-importance",
  "limit",
  "max-days",
  "max-rows",
  "max-tier",
  "node",
  "partition",
  "project-dir",
  "quarantine-after-days",
  "recovery-days",
  "retrieved-at",
  "residence",
  "retrieval-mode",
  "scope",
  "session-id",
  "source-actor",
  "source-ref",
  "state-key",
  "summary",
  "supersedes",
  "tier",
  "target-kind",
  "target-name",
  "truth",
  "type",
  "valid-from",
  "valid-until",
  "vector-granularity",
  "write-reason",
]);

export async function runCli(
  argv: readonly string[],
  io: {
    stdout: Pick<NodeJS.WriteStream, "write">;
    stderr: Pick<NodeJS.WriteStream, "write">;
  } = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.command === "help") {
    io.stdout.write(USAGE);
    return 0;
  }

  const service = new NmgService({
    dataDirectory: parsed.dataDirectory,
    databasePath: parsed.databasePath,
  });
  if (isDaemonCommand(parsed.command)) {
    try {
      const result = await runDaemonCommand(parsed.command, service);
      io.stdout.write(
        parsed.json ? `${JSON.stringify(result, null, 2)}\n` : humanDaemonResult(result),
      );
      return 0;
    } catch (error) {
      io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    } finally {
      service.close();
    }
  }

  try {
    const state = readServerState(serverStatePath(service.databasePath));
    const result =
      state?.transport === "http" && isProcessAlive(state.pid)
        ? await httpCall(state, parsed.command, (parsed.params ?? {}) as Record<string, unknown>)
        : await service.invoke(parsed.command, parsed.params);
    io.stdout.write(parsed.json ? `${JSON.stringify(result, null, 2)}\n` : humanResult(result));
    return 0;
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    service.close();
  }
}

async function runDaemonCommand(
  command: DaemonCommand,
  service: NmgService,
): Promise<Record<string, unknown>> {
  const statePath = serverStatePath(service.databasePath);
  const existing = readServerState(statePath);

  if (command === "daemon-status") {
    if (!existing || !isProcessAlive(existing.pid) || existing.transport !== "http") {
      return { running: false };
    }
    const status = await httpCall(existing, "status");
    return {
      running: true,
      pid: existing.pid,
      endpoint: `${existing.host}:${existing.port}`,
      status,
    };
  }

  if (command === "daemon-stop") {
    if (existing?.transport === "http" && isProcessAlive(existing.pid)) {
      await httpCall(existing, "shutdown");
      await waitForProcessExit(existing.pid);
      return { stopped: true, pid: existing.pid };
    }
    return stopServer(service.databasePath);
  }

  if (command === "daemon-start") {
    if (existing && isProcessAlive(existing.pid)) {
      return { started: false, alreadyRunning: true, pid: existing.pid };
    }
    const entrypoint = process.argv[1];
    if (!entrypoint) throw new Error("cannot locate the NMG CLI entrypoint");
    const child = spawn(
      process.execPath,
      [...process.execArgv, entrypoint, "daemon", "run", "--db", service.databasePath],
      {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      },
    );
    child.unref();
    const state = await waitForState(statePath);
    await httpCall(state, "hello");
    return {
      started: true,
      pid: state.pid,
      endpoint: `${state.host}:${state.port}`,
    };
  }

  const lease = acquireServerLease(service.databasePath);
  const stopOnSignal = () => {
    lease.release();
    service.close();
    process.exit(0);
  };
  process.once("SIGINT", stopOnSignal);
  process.once("SIGTERM", stopOnSignal);
  try {
    await serveHttp(service, lease);
    return { stopped: true };
  } finally {
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
    lease.release();
  }
}

async function waitForState(statePath: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = readServerState(statePath);
    if (state?.transport === "http" && state.port && state.token) return state;
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  throw new Error("NMG daemon did not become ready");
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  if (isProcessAlive(pid)) throw new Error(`NMG daemon pid ${pid} did not stop`);
}

type DaemonCommand = "daemon-run" | "daemon-start" | "daemon-status" | "daemon-stop";

function isDaemonCommand(command: ParsedArguments["command"]): command is DaemonCommand {
  return command.startsWith("daemon-");
}

interface ParsedArguments {
  command: NmgMethod | DaemonCommand | "help";
  params?:
    | NmgRememberParams
    | NmgSearchParams
    | NmgGetParams
    | NmgRetentionCandidatesParams
    | NmgSetStorageStateParams
    | NmgDeleteMemoryParams
    | NmgMergeNodesParams
    | NmgSplitNodeParams
    | NmgSyncStgParams
    | NmgPerfParams;
  json: boolean;
  dataDirectory?: string;
  databasePath?: string;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help", json: false };
  }
  const [command, ...rest] = argv;
  if (
    ![
      "status",
      "remember",
      "search",
      "get",
      "retention",
      "memory",
      "node",
      "perf",
      "stg",
      "daemon",
    ].includes(command!)
  ) {
    throw new Error(`unknown command: ${command}`);
  }
  const daemonAction = command === "daemon" ? rest[0] : undefined;
  if (command === "daemon" && !["run", "start", "status", "stop"].includes(daemonAction ?? "")) {
    throw new Error("daemon requires start, status, or stop");
  }
  const subcommand = ["retention", "memory", "node", "perf", "stg"].includes(command!)
    ? rest[0]
    : undefined;
  if (
    command === "retention" &&
    !["candidates", "archive", "quarantine", "restore"].includes(subcommand ?? "")
  ) {
    throw new Error("retention requires candidates, archive, quarantine, or restore");
  }
  if (command === "memory" && subcommand !== "delete") {
    throw new Error("memory requires delete");
  }
  if (command === "node" && !["merge", "split"].includes(subcommand ?? "")) {
    throw new Error("node requires merge or split");
  }
  if (command === "perf" && !["aggregates", "prune"].includes(subcommand ?? "")) {
    throw new Error("perf requires aggregates or prune");
  }
  if (command === "stg" && subcommand !== "sync") {
    throw new Error("stg requires sync");
  }
  const values = parseOptions(command === "daemon" || subcommand ? rest.slice(1) : rest);
  const maintenanceCommand =
    command === "retention"
      ? subcommand === "candidates"
        ? "retentionCandidates"
        : "setStorageState"
      : command === "memory"
        ? "deleteMemory"
        : command === "node"
          ? subcommand === "merge"
            ? "mergeNodes"
            : "splitNode"
          : command === "perf"
            ? subcommand === "aggregates"
              ? "perfAggregates"
              : "pruneRetrievalTraces"
            : command === "stg"
              ? "syncStg"
            : undefined;
  const common = {
    command:
      command === "daemon"
        ? (`daemon-${daemonAction}` as DaemonCommand)
        : ((maintenanceCommand ?? command) as ParsedArguments["command"]),
    json: values.flags.has("json"),
    dataDirectory: firstOption(values, "data-dir"),
    databasePath: optionalResolvedPath(firstOption(values, "db")),
  };
  if (command === "daemon") {
    assertAllowed(values, ["data-dir", "db"], daemonAction === "run" ? [] : ["json"]);
    rejectPositionals(values, "daemon");
    return common;
  }
  if (command === "retention") {
    if (subcommand === "candidates") {
      assertAllowed(
        values,
        [
          "data-dir",
          "db",
          "dormant-after-days",
          "quarantine-after-days",
          "maximum-importance",
          "maximum-access-count",
        ],
        ["json"],
      );
      rejectPositionals(values, "retention candidates");
      return { ...common, params: retentionCandidatesParams(values) };
    }
    assertAllowed(
      values,
      ["data-dir", "db", ...(subcommand === "quarantine" ? ["recovery-days"] : [])],
      ["json"],
    );
    return {
      ...common,
      params: storageStateParams(values, subcommand as "archive" | "quarantine" | "restore"),
    };
  }
  if (command === "memory") {
    assertAllowed(values, ["data-dir", "db"], ["json"]);
    return { ...common, params: singleMemoryParams(values, "memory delete") };
  }
  if (command === "node") {
    if (subcommand === "merge") {
      assertAllowed(values, ["data-dir", "db", "target-name", "target-kind", "summary"], ["json"]);
      return { ...common, params: mergeNodesParams(values) };
    }
    assertAllowed(values, ["data-dir", "db", "partition"], ["json"]);
    return { ...common, params: splitNodeParams(values) };
  }
  if (command === "perf") {
    if (subcommand === "aggregates") {
      assertAllowed(values, ["data-dir", "db"], ["json"]);
      rejectPositionals(values, "perf aggregates");
      return { ...common, params: undefined };
    }
    assertAllowed(values, ["data-dir", "db", "max-days", "max-rows"], ["json"]);
    return {
      ...common,
      params: perfPruneParams(values),
    };
  }
  if (command === "stg") {
    assertAllowed(values, ["data-dir", "db", "project-dir", "scope", "limit"], ["json"]);
    rejectPositionals(values, "stg sync");
    return { ...common, params: syncStgParams(values) };
  }
  switch (command) {
    case "status":
      assertAllowed(values, ["data-dir", "db"], ["json"]);
      rejectPositionals(values, "status");
      return common;
    case "remember":
      assertAllowed(
        values,
        [
          "data-dir",
          "db",
          "node",
          "project-dir",
          "type",
          "state-key",
          "event-time",
          "external-source",
          "actor",
          "truth",
          "evidence",
          "tier",
          "importance",
          "content-hash",
          "scope",
          "valid-from",
          "valid-until",
          "evidence-role",
          "supersedes",
          "residence",
          "retrieved-at",
          "expires-at",
          "write-reason",
          "session-id",
          "source-ref",
        ],
        ["json"],
      );
      return {
        ...common,
        params: rememberParams(values),
      };
    case "search":
      assertAllowed(
        values,
        [
          "data-dir",
          "db",
          "node",
          "project-dir",
          "scope",
          "source-actor",
          "max-tier",
          "limit",
          "graph-hops",
          "retrieval-mode",
          "vector-granularity",
        ],
        ["json", "include-historical", "no-perf", "second-pass"],
      );
      return {
        ...common,
        params: searchParams(values),
      };
    case "get":
      assertAllowed(values, ["data-dir", "db", "graph-hops", "project-dir"], ["json"]);
      return {
        ...common,
        params: getParams(values),
      };
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

function retentionCandidatesParams(values: OptionValues): NmgRetentionCandidatesParams {
  return compactObject({
    dormantAfterDays: numericOption(values, "dormant-after-days"),
    quarantineAfterDays: numericOption(values, "quarantine-after-days"),
    maximumImportance: numericOption(values, "maximum-importance"),
    maximumAccessCount: numericOption(values, "maximum-access-count"),
  });
}

function storageStateParams(
  values: OptionValues,
  action: "archive" | "quarantine" | "restore",
): NmgSetStorageStateParams {
  const memoryId = singlePositional(values, `retention ${action}`);
  return compactObject({
    memoryId,
    storageState:
      action === "archive" ? "dormant" : action === "quarantine" ? "quarantine" : "indexed",
    recoveryDays: numericOption(values, "recovery-days"),
  }) as unknown as NmgSetStorageStateParams;
}

function singleMemoryParams(values: OptionValues, command: string): NmgDeleteMemoryParams {
  return { memoryId: singlePositional(values, command) };
}

function mergeNodesParams(values: OptionValues): NmgMergeNodesParams {
  if (values.positionals.length < 2) throw new Error("node merge requires at least two node IDs");
  const targetName = firstOption(values, "target-name");
  if (!targetName) throw new Error("node merge requires --target-name NAME");
  return compactObject({
    sourceNodeIds: values.positionals,
    targetName,
    targetKind: firstOption(values, "target-kind"),
    summary: firstOption(values, "summary"),
  }) as unknown as NmgMergeNodesParams;
}

function splitNodeParams(values: OptionValues): NmgSplitNodeParams {
  const sourceNodeId = singlePositional(values, "node split");
  const partitions = (values.options.get("partition") ?? []).map((entry) => {
    const separator = entry.indexOf("=");
    if (separator < 1 || separator === entry.length - 1) {
      throw new Error("--partition must use NAME=MEMORY_ID,...");
    }
    const memoryIds = entry
      .slice(separator + 1)
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (memoryIds.length === 0) throw new Error("--partition requires at least one memory ID");
    return { nodeName: entry.slice(0, separator).trim(), memoryIds };
  });
  if (partitions.length < 2)
    throw new Error("node split requires at least two --partition options");
  return { sourceNodeId, partitions };
}

function perfPruneParams(values: OptionValues): NmgPerfParams {
  return compactObject({
    action: "prune",
    maxDays: numericOption(values, "max-days"),
    maxRows: numericOption(values, "max-rows"),
  });
}

function syncStgParams(values: OptionValues): NmgSyncStgParams {
  const projectDir = firstOption(values, "project-dir");
  if (!projectDir) throw new Error("stg sync requires --project-dir DIR");
  const scope = scopeOptions(values);
  if (!scope) throw new Error("stg sync requires --scope KEY=VALUE");
  return compactObject({
    projectDir: resolve(projectDir),
    scope,
    limit: numericOption(values, "limit"),
  }) as unknown as NmgSyncStgParams;
}

function singlePositional(values: OptionValues, command: string): string {
  if (values.positionals.length !== 1) throw new Error(`${command} requires exactly one ID`);
  return values.positionals[0]!;
}

interface OptionValues {
  flags: Set<string>;
  options: Map<string, string[]>;
  positionals: string[];
}

function parseOptions(args: readonly string[]): OptionValues {
  const flags = new Set<string>();
  const options = new Map<string, string[]>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const [rawName, inlineValue] = argument.slice(2).split("=", 2);
    if (!rawName) throw new Error("empty option name");
    if (!ALL_FLAGS.has(rawName) && !ALL_OPTIONS.has(rawName)) {
      throw new Error(`unknown option: --${rawName}`);
    }
    if (ALL_FLAGS.has(rawName)) {
      if (inlineValue !== undefined) throw new Error(`--${rawName} does not take a value`);
      flags.add(rawName);
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${rawName} requires a value`);
    }
    const entries = options.get(rawName) ?? [];
    entries.push(value);
    options.set(rawName, entries);
  }
  return { flags, options, positionals };
}

function rememberParams(values: OptionValues): NmgRememberParams {
  const statement = values.positionals.join(" ").trim();
  if (!statement) throw new Error("remember requires a statement");
  const nodeName = firstOption(values, "node");
  if (!nodeName) throw new Error("remember requires --node NAME");
  const externalSource = firstOption(values, "external-source");
  if (externalSource && !/^(?:file|web):.+/u.test(externalSource)) {
    throw new Error("--external-source must start with web: or file:");
  }
  const externalMarker = externalSource
    ? [
        {
          kind: "external_source",
          attributes: compactObject({
            source: externalSource,
            retrievedAt: firstOption(values, "retrieved-at") ?? new Date().toISOString(),
            hash: firstOption(values, "content-hash"),
          }),
        },
      ]
    : undefined;
  return compactObject({
    statement,
    nodeName,
    memoryType: firstOption(values, "type"),
    stateKey: firstOption(values, "state-key"),
    eventTime: firstOption(values, "event-time"),
    sourceActor: firstOption(values, "actor"),
    truthStatus: firstOption(values, "truth"),
    evidence: firstOption(values, "evidence"),
    tier: numericOption(values, "tier"),
    importance: numericOption(values, "importance"),
    scope: scopeOptions(values),
    validFrom: firstOption(values, "valid-from"),
    validUntil: firstOption(values, "valid-until"),
    evidenceRole: firstOption(values, "evidence-role"),
    supersedesId: firstOption(values, "supersedes"),
    residence: firstOption(values, "residence"),
    expiresAt: firstOption(values, "expires-at"),
    writeReason: firstOption(values, "write-reason"),
    sessionId: firstOption(values, "session-id"),
    sourceRef: firstOption(values, "source-ref"),
    markers: externalMarker,
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
  }) as unknown as NmgRememberParams;
}

function searchParams(values: OptionValues): NmgSearchParams {
  const query = values.positionals.join(" ").trim();
  if (!query) throw new Error("search requires a query");
  return compactObject({
    query,
    nodeName: firstOption(values, "node"),
    scope: scopeOptions(values),
    sourceActor: firstOption(values, "source-actor"),
    includeHistorical: values.flags.has("include-historical") || undefined,
    maxTier: numericOption(values, "max-tier"),
    limit: numericOption(values, "limit"),
    graphHops: numericOption(values, "graph-hops"),
    retrievalMode: firstOption(values, "retrieval-mode"),
    vectorGranularity: firstOption(values, "vector-granularity"),
    secondPass: values.flags.has("second-pass") || undefined,
    perf: values.flags.has("no-perf") ? false : undefined,
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
  }) as unknown as NmgSearchParams;
}

function getParams(values: OptionValues): NmgGetParams {
  const memoryIds = values.positionals.flatMap((value) => value.split(",")).filter(Boolean);
  if (memoryIds.length === 0) throw new Error("get requires at least one memory ID");
  return compactObject({
    memoryIds,
    graphHops: numericOption(values, "graph-hops"),
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
  }) as unknown as NmgGetParams;
}

function firstOption(values: OptionValues, name: string): string | undefined {
  return values.options.get(name)?.at(-1);
}

function numericOption(values: OptionValues, name: string): number | undefined {
  const value = firstOption(values, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function scopeOptions(values: OptionValues): Record<string, string> | undefined {
  const entries = (values.options.get("scope") ?? []).flatMap((value) => value.split(","));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1 || separator === entry.length - 1) {
        throw new Error("--scope values must use KEY=VALUE");
      }
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }),
  );
}

function rejectPositionals(values: OptionValues, command: string): void {
  if (values.positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
}

function assertAllowed(
  values: OptionValues,
  optionNames: readonly string[],
  flagNames: readonly string[],
): void {
  const allowedOptions = new Set(optionNames);
  const allowedFlags = new Set(flagNames);
  for (const name of values.options.keys()) {
    if (!allowedOptions.has(name)) throw new Error(`unknown option: --${name}`);
  }
  for (const name of values.flags) {
    if (!allowedFlags.has(name)) throw new Error(`unknown option: --${name}`);
  }
}

function optionalResolvedPath(value: string | undefined): string | undefined {
  return value ? resolve(value) : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}

function humanResult(value: unknown): string {
  const result = value as Record<string, unknown>;
  if ("pruned" in result && typeof result.pruned === "number") {
    return `Pruned ${String(result.pruned)} retrieval traces.\n`;
  }
  if (Array.isArray(result) && result.every((entry) => typeof entry === "object" && entry !== null && "section" in entry && "count" in entry && "sum" in entry)) {
    const rows = (result as Array<{
      section: string;
      count: number;
      sum: number;
      sumSq: number;
      buckets?: number[];
    }>).map((entry) => {
      const avg = entry.count > 0 ? entry.sum / entry.count : 0;
      const variance =
        entry.count > 1
          ? (entry.sumSq - (entry.sum * entry.sum) / entry.count) / (entry.count - 1)
          : 0;
      // Fewer than ~10 samples: histogram quantiles are unreliable (buckets
      // are logarithmic; a couple of outliers dominate the median). Fall back
      // to avg as the only meaningful location statistic.
      const fmtMs = (value: number) => (value >= 0 ? `${value.toFixed(2)}ms` : "n/a");
      const p50 =
        entry.count >= 10 && entry.buckets?.length
          ? histogramQuantile(entry.buckets, 0.5)
          : -1;
      const p90 =
        entry.count >= 10 && entry.buckets?.length
          ? histogramQuantile(entry.buckets, 0.9)
          : -1;
      const p95 =
        entry.count >= 10 && entry.buckets?.length
          ? histogramQuantile(entry.buckets, 0.95)
          : -1;
      return `${entry.section}\tcount=${entry.count}\tavg=${avg.toFixed(2)}ms\tp50=${fmtMs(p50)}\tp90=${fmtMs(p90)}\tp95=${fmtMs(p95)}\tσ=${Math.sqrt(Math.max(0, variance)).toFixed(2)}ms`;
    });
    return rows.length === 0 ? "No performance aggregates yet.\n" : `${rows.join("\n")}\n`;
  }
  if ("candidates" in result) {
    const candidates = result.candidates as Array<{
      memoryId: string;
      storageState: string;
      recommendedState: string;
      statement: string;
    }>;
    return candidates.length === 0
      ? "No retention candidates.\n"
      : `${candidates
          .map(
            (candidate) =>
              `${candidate.memoryId}\t${candidate.storageState}->${candidate.recommendedState}\t${candidate.statement}`,
          )
          .join("\n")}\n`;
  }
  if ("storageState" in result && "memoryId" in result) {
    return `${String(result.memoryId)} is now ${String(result.storageState)}.\n`;
  }
  if ("deleted" in result) {
    return result.deleted
      ? `Deleted semantic memory ${String((result.memory as { id: string }).id)}; source history was retained.\n`
      : "Memory not found.\n";
  }
  if ("sourceNodeIds" in result && "targetNodeIds" in result) {
    return `Applied ${String(result.type)} transform ${String(result.id)}: ${String(
      (result.sourceNodeIds as string[]).join(", "),
    )} -> ${String((result.targetNodeIds as string[]).join(", "))}.\n`;
  }
  if ("memory" in result) {
    const memory = result.memory as { id: string };
    const node = result.node as { canonicalName: string };
    return `Saved ${memory.id} under ${node.canonicalName}.\n`;
  }
  if ("storage" in result) {
    const storage = result.storage as {
      databasePath: string;
      exists: boolean;
      bytes: number;
      loaded: boolean;
    };
    return (
      `NMG ${String(result.version)} (${String(result.protocol)})\n` +
      `Database: ${storage.databasePath}\n` +
      `Exists: ${storage.exists}; loaded: ${storage.loaded}; bytes: ${storage.bytes}\n`
    );
  }
  if ("missingMemoryIds" in result) {
    const context = result as unknown as {
      results: Array<{ memory: { id: string; statement: string } }>;
      missingMemoryIds: string[];
    };
    const lines = context.results.map(({ memory }) => `${memory.id}\t${memory.statement}`);
    if (context.missingMemoryIds.length > 0) {
      lines.push(`Missing: ${context.missingMemoryIds.join(", ")}`);
    }
    return `${lines.join("\n")}\n`;
  }
  if ("results" in result) {
    const context = result as unknown as {
      results: Array<{
        memory: { id: string; memoryType: string; tier: number; statement: string };
        node: { canonicalName: string };
      }>;
      timings?: { timings?: Record<string, number>; totalMs?: number };
    };
    const lines = context.results.map(
      ({ memory, node }) =>
        `${memory.id}\t${memory.memoryType}\tL${memory.tier}\t${node.canonicalName}\t${memory.statement}`,
    );
    if (context.timings) {
      const sections = Object.entries(context.timings.timings ?? {})
        .sort((left, right) => right[1] - left[1])
        .map(([section, ms]) => `${section}=${ms.toFixed(1)}ms`);
      lines.push(`perf\t${sections.join(" ")} total=${(context.timings.totalMs ?? 0).toFixed(1)}ms`);
    }
    return `${lines.join("\n")}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function humanDaemonResult(result: Record<string, unknown>): string {
  if (result.started)
    return `Started NMG daemon pid ${String(result.pid)} at ${String(result.endpoint)}.\n`;
  if (result.alreadyRunning) return `NMG daemon is already running (pid ${String(result.pid)}).\n`;
  if (result.running)
    return `NMG daemon pid ${String(result.pid)} is running at ${String(result.endpoint)}.\n`;
  if (result.stopped) return `Stopped NMG daemon pid ${String(result.pid ?? "")}.\n`;
  return "NMG daemon is not running.\n";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
