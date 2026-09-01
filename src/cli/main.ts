import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
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
  type NmgHelloResult,
  NMG_PROTOCOL_VERSION,
} from "./protocol.ts";
import {
  assertSpecOptions,
  cliCommandGroup,
  cliCommandUsage,
  cliUsage,
  firstOption,
  optionalResolvedPath,
  rejectPositionals,
  CLI_KNOWN_FLAGS,
  CLI_KNOWN_OPTIONS,
  type OptionValues,
} from "./commands.ts";
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
import type { MemoryContext } from "../core/types.ts";
import { compactSearchContext } from "../integration/search-projection.ts";
import { assertDaemonProtocol } from "./daemon-client.ts";

// The CLI surface (synopsis, option details, known options/flags) is
// assembled from the command registry in commands.ts; only the daemon
// synopsis line is local because daemon commands are not RPC methods.
const USAGE = cliUsage([
  "nmg daemon start|restart|status|stop [--data-dir DIR | --db FILE] [--json]",
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
    if (parsed.helpTopic) {
      io.stdout.write(cliCommandUsage(parsed.helpTopic) ?? USAGE);
    } else {
      io.stdout.write(USAGE);
    }
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
  if (parsed.command === "inspect" || parsed.command === "graph") {
    try {
      if (parsed.command === "graph") {
        const { exportGraphHtml } = await import("./graph-render.ts");
        const outputPath = exportGraphHtml(
          service.databasePath,
          parsed.outPath ?? "nmg-graph.html",
        );
        io.stdout.write(`Wrote memory graph to ${outputPath}\n`);
      } else {
        const { runInspectTui } = await import("./inspect-tui.ts");
        await runInspectTui(service.databasePath);
      }
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
    let result: unknown;
    if (state?.transport === "http" && isProcessAlive(state.pid)) {
      if (state.protocol !== NMG_PROTOCOL_VERSION) {
        assertDaemonProtocol((await httpCall(state, "hello")) as NmgHelloResult);
      }
      result = await httpCall(
        state,
        parsed.command,
        (parsed.params ?? {}) as Record<string, unknown>,
      );
    } else {
      result = await service.invoke(parsed.command, parsed.params);
    }
    const output =
      parsed.compactJson && parsed.command === "search"
        ? compactSearchContext(result as MemoryContext)
        : result;
    io.stdout.write(
      parsed.json || parsed.compactJson
        ? `${JSON.stringify(output, null, 2)}\n`
        : humanResult(result),
    );
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
    let status: unknown;
    try {
      status = await httpCall(existing, "status");
    } catch {
      rmSync(statePath, { force: true });
      return { running: false };
    }
    return {
      running: true,
      pid: existing.pid,
      endpoint: `${existing.host}:${existing.port}`,
      compatible:
        (status as Partial<NmgHelloResult> | undefined)?.protocol === NMG_PROTOCOL_VERSION,
      status,
    };
  }

  if (command === "daemon-stop") {
    if (existing?.transport === "http" && isProcessAlive(existing.pid)) {
      try {
        await httpCall(existing, "shutdown");
      } catch {
        rmSync(statePath, { force: true });
        return { stopped: false, reason: "stale-state", pid: existing.pid };
      }
      await waitForProcessExit(existing.pid);
      return { stopped: true, pid: existing.pid };
    }
    return stopServer(service.databasePath);
  }

  let restartedFrom: number | undefined;
  if (command === "daemon-restart") {
    if (existing?.transport === "http" && isProcessAlive(existing.pid)) {
      restartedFrom = existing.pid;
      await httpCall(existing, "shutdown");
      await waitForProcessExit(existing.pid);
    } else {
      await stopServer(service.databasePath);
    }
    rmSync(statePath, { force: true });
  }

  if (command === "daemon-start" || command === "daemon-restart") {
    if (existing && isProcessAlive(existing.pid)) {
      try {
        const hello = (await httpCall(existing, "hello")) as NmgHelloResult;
        return {
          started: false,
          alreadyRunning: true,
          pid: existing.pid,
          compatible: hello.protocol === NMG_PROTOCOL_VERSION,
          protocol: hello.protocol,
        };
      } catch {
        rmSync(statePath, { force: true });
      }
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
    assertDaemonProtocol((await httpCall(state, "hello")) as NmgHelloResult);
    return {
      started: true,
      restarted: command === "daemon-restart",
      restartedFrom,
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
    // serveHttp resolves on the shutdown RPC or idle timeout, but it only
    // closes the HTTP server. Without service.close() the SQLite handle keeps
    // the event loop alive and the daemon silently lingers (observed as leaked
    // nmg.mjs daemon processes after tests). Release it so the process exits.
    service.close();
  }
}

async function waitForState(statePath: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = readServerState(statePath);
    // 必须同时探活：stale lease（强杀残留）里也带着 transport/port/token，
    // 仅校验字段会把死进程端点当成活 daemon 去连接。
    if (state?.transport === "http" && state.port && state.token && isProcessAlive(state.pid)) {
      return state;
    }
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

type DaemonCommand =
  "daemon-run" | "daemon-start" | "daemon-restart" | "daemon-status" | "daemon-stop";

function isDaemonCommand(command: ParsedArguments["command"]): command is DaemonCommand {
  return command.startsWith("daemon-");
}

interface ParsedArguments {
  command: NmgMethod | DaemonCommand | "inspect" | "graph" | "help";
  /** When set, help is scoped to this top-level command instead of global. */
  helpTopic?: string;
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
  compactJson?: boolean;
  dataDirectory?: string;
  databasePath?: string;
  /** Local `graph` command: output HTML path. */
  outPath?: string;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  if (argv.length === 0) {
    return { command: "help", json: false };
  }
  const [command, ...rest] = argv;
  // `nmg --help` prints the global synopsis; `nmg <command> --help` prints a
  // focused usage for that command so agents can discover real option names
  // without reading source.
  if (command === "--help" || command === "-h") {
    return { command: "help", json: false };
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    return { command: "help", helpTopic: command, json: false };
  }
  if (command === "help") {
    if (rest.length > 0) throw new Error("help does not accept arguments");
    return { command: "help", json: false };
  }
  if (command === "daemon") return daemonArguments(rest);
  const group = cliCommandGroup(command!);
  if (group.length === 0) throw new Error(`unknown command: ${command}`);
  // Prefer the longest matching command prefix. The registry supports nested
  // administrative verbs such as `chain edge add`; matching only the second
  // word would silently route `chain edge remove` to the first `chain edge *`
  // entry.
  const fullWords = [command!, ...rest];
  const spec = [...group]
    .sort((left, right) => right.words.length - left.words.length)
    .find((entry) => entry.words.every((word, index) => fullWords[index] === word));
  if (!spec) {
    throw new Error(
      `${command} requires ${oxfordJoin(group.map((entry) => entry.words.slice(1).join(" ")))}`,
    );
  }
  const values = parseOptions(rest.slice(spec.words.length - 1));
  assertSpecOptions(spec, values);
  if (values.flags.has("json") && values.flags.has("compact-json")) {
    throw new Error("--json and --compact-json are mutually exclusive");
  }
  if (spec.local) {
    // Local commands (inspect, graph) validate through the registry but
    // dispatch directly — no RPC method, no params, no --json.
    spec.buildParams(values);
    return {
      command: spec.words[0] as "inspect" | "graph",
      json: false,
      dataDirectory: firstOption(values, "data-dir"),
      databasePath: optionalResolvedPath(firstOption(values, "db")),
      outPath: optionalResolvedPath(firstOption(values, "out")),
    };
  }
  return {
    command: spec.method!,
    params: spec.buildParams(values) as ParsedArguments["params"],
    json: values.flags.has("json"),
    compactJson: values.flags.has("compact-json"),
    dataDirectory: firstOption(values, "data-dir"),
    databasePath: optionalResolvedPath(firstOption(values, "db")),
  };
}

function daemonArguments(rest: readonly string[]): ParsedArguments {
  const action = rest[0];
  if (!["run", "start", "restart", "status", "stop"].includes(action ?? "")) {
    throw new Error("daemon requires start, restart, status, or stop");
  }
  const values = parseOptions(rest.slice(1));
  const allowedFlags = new Set(action === "run" ? [] : ["json"]);
  for (const name of values.options.keys()) {
    if (name !== "data-dir" && name !== "db") throw new Error(`unknown option: --${name}`);
  }
  for (const name of values.flags) {
    if (!allowedFlags.has(name)) throw new Error(`unknown option: --${name}`);
  }
  rejectPositionals(values, "daemon");
  return {
    command: `daemon-${action}` as DaemonCommand,
    json: values.flags.has("json"),
    dataDirectory: firstOption(values, "data-dir"),
    databasePath: optionalResolvedPath(firstOption(values, "db")),
  };
}

/** "a" / "a or b" / "a, b, or c" — matches the historical error messages. */
function oxfordJoin(words: readonly string[]): string {
  if (words.length === 1) return words[0]!;
  if (words.length === 2) return `${words[0]} or ${words[1]}`;
  return `${words.slice(0, -1).join(", ")}, or ${words.at(-1)}`;
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
    if (!CLI_KNOWN_FLAGS.has(rawName) && !CLI_KNOWN_OPTIONS.has(rawName)) {
      throw new Error(`unknown option: --${rawName}`);
    }
    if (CLI_KNOWN_FLAGS.has(rawName)) {
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

function humanResult(value: unknown): string {
  const result = value as Record<string, unknown>;
  if (result.action === "discover" && Array.isArray(result.agents)) {
    const agents = result.agents as Array<{
      agentName: string;
      capabilities: string | null;
      lastSeenAt: string;
    }>;
    return agents.length === 0
      ? "No online NMG agents match.\n"
      : `${agents
          .map(
            (agent) =>
              `${agent.agentName}\t${agent.capabilities ?? "-"}\tlastSeen=${agent.lastSeenAt}`,
          )
          .join("\n")}\n`;
  }
  if (result.action === "read" && Array.isArray(result.entries)) {
    const entries = result.entries as Array<{
      id: string;
      agentId: string;
      kind: string;
      status: string;
      content: string;
    }>;
    return entries.length === 0
      ? "Task board has no matching entries.\n"
      : `${entries
          .map(
            (entry) =>
              `${entry.id}\t${entry.agentId}\t${entry.kind}\t${entry.status}\t${entry.content}`,
          )
          .join("\n")}\nnextCursor=${String(result.nextCursor)}\n`;
  }
  if ((result.action === "put" || result.action === "resolve") && result.entry) {
    const entry = result.entry as { id: string; status: string };
    return `Task board ${String(result.action)}: ${entry.id} (${entry.status}).\n`;
  }
  if ("pruned" in result && typeof result.pruned === "number") {
    return `Pruned ${String(result.pruned)} retrieval traces.\n`;
  }
  if (
    Array.isArray(result) &&
    result.every(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "section" in entry &&
        "count" in entry &&
        "sum" in entry,
    )
  ) {
    const rows = (
      result as Array<{
        section: string;
        count: number;
        sum: number;
        sumSq: number;
        buckets?: number[];
      }>
    ).map((entry) => {
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
        entry.count >= 10 && entry.buckets?.length ? histogramQuantile(entry.buckets, 0.5) : -1;
      const p90 =
        entry.count >= 10 && entry.buckets?.length ? histogramQuantile(entry.buckets, 0.9) : -1;
      const p95 =
        entry.count >= 10 && entry.buckets?.length ? histogramQuantile(entry.buckets, 0.95) : -1;
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
  if ("resolution" in result && "memoryId" in result) {
    return `${String(result.memoryId)} is now ${String(result.resolution)}.\n`;
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
      files?: Array<{ path: string; excerpt: string }>;
      timings?: { timings?: Record<string, number>; totalMs?: number };
    };
    const lines = context.results.map(
      ({ memory, node }) =>
        `${memory.id}\t${memory.memoryType}\tL${memory.tier}\t${node.canonicalName}\t${memory.statement}`,
    );
    if (context.files && context.files.length > 0) {
      lines.push("FILES:");
      for (const file of context.files) {
        lines.push(`${file.path}\t${file.excerpt}`);
      }
    }
    if (context.timings) {
      const sections = Object.entries(context.timings.timings ?? {})
        .sort((left, right) => right[1] - left[1])
        .map(([section, ms]) => `${section}=${ms.toFixed(1)}ms`);
      lines.push(
        `perf\t${sections.join(" ")} total=${(context.timings.totalMs ?? 0).toFixed(1)}ms`,
      );
    }
    return `${lines.join("\n")}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

function humanDaemonResult(result: Record<string, unknown>): string {
  if (result.restarted)
    return `Restarted NMG daemon from pid ${String(result.restartedFrom)} to pid ${String(result.pid)} at ${String(result.endpoint)}.\n`;
  if (result.started)
    return `Started NMG daemon pid ${String(result.pid)} at ${String(result.endpoint)}.\n`;
  if (result.alreadyRunning && result.compatible === false)
    return `NMG daemon pid ${String(result.pid)} uses incompatible protocol ${String(result.protocol ?? "unknown")}; run \`nmg daemon restart\` when active agents can reconnect.\n`;
  if (result.alreadyRunning) return `NMG daemon is already running (pid ${String(result.pid)}).\n`;
  if (result.running)
    return `NMG daemon pid ${String(result.pid)} is running at ${String(result.endpoint)}.\n`;
  if (result.stopped) return `Stopped NMG daemon pid ${String(result.pid ?? "")}.\n`;
  return "NMG daemon is not running.\n";
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
