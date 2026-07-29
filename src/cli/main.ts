import { spawn } from "node:child_process";
import { resolve } from "node:path";

import {
  type NmgGetParams,
  type NmgMethod,
  type NmgRememberParams,
  type NmgSearchParams,
} from "./protocol.ts";
import { callGrpc, serveGrpc } from "./grpc.ts";
import {
  acquireServerLease,
  isProcessAlive,
  readServerState,
  serverStatePath,
  stopServer,
} from "./lifecycle.ts";
import { NmgService } from "./service.ts";

const USAGE = `NMG command line

Usage:
  nmg status [--json] [--data-dir DIR | --db FILE]
  nmg remember STATEMENT --node NAME [options] [--json]
  nmg search QUERY [options] [--json]
  nmg get MEMORY_ID... [--graph-hops N] [--json]
  nmg daemon start|status|stop [--data-dir DIR | --db FILE] [--json]

Common options:
  --data-dir DIR             NMG data directory (default: NMG_DATA_DIR or .nmg)
  --db FILE                  Explicit SQLite database path
  --scope KEY=VALUE          Repeatable or comma-separated scope filter
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
`;
const ALL_FLAGS = new Set(["include-historical", "json", "second-pass"]);
const ALL_OPTIONS = new Set([
  "actor",
  "data-dir",
  "db",
  "event-time",
  "evidence",
  "evidence-role",
  "expires-at",
  "graph-hops",
  "importance",
  "limit",
  "max-tier",
  "node",
  "residence",
  "retrieval-mode",
  "scope",
  "session-id",
  "source-actor",
  "source-ref",
  "state-key",
  "supersedes",
  "tier",
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
      state?.transport === "grpc" && isProcessAlive(state.pid)
        ? await callGrpc(state, parsed.command, (parsed.params ?? {}) as Record<string, unknown>)
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
    if (!existing || !isProcessAlive(existing.pid) || existing.transport !== "grpc") {
      return { running: false };
    }
    const status = await callGrpc(existing, "status");
    return { running: true, pid: existing.pid, endpoint: `${existing.host}:${existing.port}`, status };
  }

  if (command === "daemon-stop") {
    if (existing?.transport === "grpc" && isProcessAlive(existing.pid)) {
      await callGrpc(existing, "shutdown");
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
    const state = await waitForGrpcState(statePath);
    await callGrpc(state, "hello");
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
    await serveGrpc(service, lease);
    return { stopped: true };
  } finally {
    process.off("SIGINT", stopOnSignal);
    process.off("SIGTERM", stopOnSignal);
    lease.release();
  }
}

async function waitForGrpcState(statePath: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = readServerState(statePath);
    if (state?.transport === "grpc" && state.port && state.token) return state;
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
  params?: NmgRememberParams | NmgSearchParams | NmgGetParams;
  json: boolean;
  dataDirectory?: string;
  databasePath?: string;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    return { command: "help", json: false };
  }
  const [command, ...rest] = argv;
  if (!["status", "remember", "search", "get", "daemon"].includes(command!)) {
    throw new Error(`unknown command: ${command}`);
  }
  const daemonAction = command === "daemon" ? rest[0] : undefined;
  if (
    command === "daemon" &&
    !["run", "start", "status", "stop"].includes(daemonAction ?? "")
  ) {
    throw new Error("daemon requires start, status, or stop");
  }
  const values = parseOptions(command === "daemon" ? rest.slice(1) : rest);
  const common = {
    command:
      command === "daemon"
        ? (`daemon-${daemonAction}` as DaemonCommand)
        : (command as ParsedArguments["command"]),
    json: values.flags.has("json"),
    dataDirectory: firstOption(values, "data-dir"),
    databasePath: optionalResolvedPath(firstOption(values, "db")),
  };
  if (command === "daemon") {
    assertAllowed(values, ["data-dir", "db"], daemonAction === "run" ? [] : ["json"]);
    rejectPositionals(values, "daemon");
    return common;
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
          "type",
          "state-key",
          "event-time",
          "actor",
          "truth",
          "evidence",
          "tier",
          "importance",
          "scope",
          "valid-from",
          "valid-until",
          "evidence-role",
          "supersedes",
          "residence",
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
          "scope",
          "source-actor",
          "max-tier",
          "limit",
          "graph-hops",
          "retrieval-mode",
          "vector-granularity",
        ],
        ["json", "include-historical", "second-pass"],
      );
      return {
        ...common,
        params: searchParams(values),
      };
    case "get":
      assertAllowed(values, ["data-dir", "db", "graph-hops"], ["json"]);
      return {
        ...common,
        params: getParams(values),
      };
    default:
      throw new Error(`unknown command: ${command}`);
  }
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
  }) as unknown as NmgSearchParams;
}

function getParams(values: OptionValues): NmgGetParams {
  const memoryIds = values.positionals.flatMap((value) => value.split(",")).filter(Boolean);
  if (memoryIds.length === 0) throw new Error("get requires at least one memory ID");
  return compactObject({
    memoryIds,
    graphHops: numericOption(values, "graph-hops"),
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
    };
    return `${context.results
      .map(
        ({ memory, node }) =>
          `${memory.id}\t${memory.memoryType}\tL${memory.tier}\t${node.canonicalName}\t${memory.statement}`,
      )
      .join("\n")}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function humanDaemonResult(result: Record<string, unknown>): string {
  if (result.started) return `Started NMG daemon pid ${String(result.pid)} at ${String(result.endpoint)}.\n`;
  if (result.alreadyRunning) return `NMG daemon is already running (pid ${String(result.pid)}).\n`;
  if (result.running) return `NMG daemon pid ${String(result.pid)} is running at ${String(result.endpoint)}.\n`;
  if (result.stopped) return `Stopped NMG daemon pid ${String(result.pid ?? "")}.\n`;
  return "NMG daemon is not running.\n";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
