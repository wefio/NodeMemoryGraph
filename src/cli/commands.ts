/**
 * CLI command registry — single source of truth for the CLI surface.
 *
 * Each spec binds a CLI invocation (`nmg retention quarantine`) to the RPC
 * method it calls, the options/flags it accepts, its params builder, and its
 * USAGE text. `main.ts` dispatches through this table, the global
 * known-option/flag sets are derived from it, and USAGE is assembled from it,
 * so adding a command touches one entry here instead of four places
 * (previously: protocol method, service dispatch, main switch, http
 * whitelist, USAGE text).
 */
import { resolve } from "node:path";

import type { NmgMethod } from "./protocol.ts";
import type {
  NmgDeleteMemoryParams,
  NmgExportMemoriesParams,
  NmgGetParams,
  NmgMergeNodesParams,
  NmgPerfParams,
  NmgRememberParams,
  NmgRollbackNodeTransformParams,
  NmgRetentionCandidatesParams,
  NmgSearchParams,
  NmgSetStorageStateParams,
  NmgSplitNodeParams,
  NmgSyncStgParams,
} from "./protocol.ts";

export interface OptionValues {
  flags: Set<string>;
  options: Map<string, string[]>;
  positionals: string[];
}

export interface CliCommandSpec {
  /** RPC method invoked (see protocol.ts NmgMethod). Absent for local commands. */
  method?: NmgMethod;
  /** Local command dispatched by main.ts without RPC (e.g. the inspect TUI). */
  local?: boolean;
  /** Set false to reject COMMON_FLAGS (e.g. --json) for this command. */
  includeCommonFlags?: boolean;
  /** CLI words, e.g. ["search"] or ["retention", "candidates"]. */
  words: readonly [string, ...string[]] | readonly [string];
  /** The `nmg ...` line in the USAGE synopsis. */
  usageLine: string;
  /** Allowed --options on top of COMMON_OPTIONS. */
  options: readonly string[];
  /** Allowed boolean flags on top of COMMON_FLAGS. */
  flags: readonly string[];
  /** Extra USAGE section (option details), appended after the synopsis. */
  usageDetail?: string;
  /** Build RPC params from parsed CLI values (throws on invalid input). */
  buildParams: (values: OptionValues) => unknown;
}

export const COMMON_OPTIONS = ["data-dir", "db"] as const;
export const COMMON_FLAGS = ["json"] as const;

export const NMG_CLI_COMMANDS: readonly CliCommandSpec[] = [
  {
    method: "status",
    words: ["status"],
    usageLine: "nmg status [--json] [--data-dir DIR | --db FILE]",
    options: [],
    flags: [],
    buildParams: (values) => {
      rejectPositionals(values, "status");
      return undefined;
    },
  },
  {
    method: "remember",
    words: ["remember"],
    usageLine: "nmg remember STATEMENT --node NAME [options] [--json]",
    options: [
      "node",
      "project-dir",
      "session-id",
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
      "source-ref",
    ],
    flags: [],
    usageDetail: `Remember options:
  --node NAME                Stable semantic node name (required)
  --type TYPE                fact, state, event, preference, constraint, strategy
  --state-key KEY            One replaceable property in scope, not a topic/group
  --evidence TEXT            Supporting source text
  --actor ACTOR              user, assistant, system, or tool
  --truth STATUS             asserted, inferred, unverified, or verified
  --tier N                   Initial tier 0..3
  --importance N             Importance 0..1
  --residence VALUE          ltg or stg
  --write-reason TEXT        Durable-write justification
  --external-source REF      External provenance: web:URL or file:PATH
  --retrieved-at ISO         External retrieval timestamp (default: now)
  --content-hash HASH        Optional external content hash`,
    buildParams: rememberParams,
  },
  {
    method: "search",
    words: ["search"],
    usageLine: "nmg search QUERY [options] [--compact-json | --json]",
    options: [
      "node",
      "project-dir",
      "session-id",
      "scope",
      "source-actor",
      "max-tier",
      "limit",
      "graph-hops",
      "retrieval-mode",
      "vector-granularity",
    ],
    flags: [
      "include-historical",
      "no-perf",
      "second-pass",
      "full-warm",
      "tiered-disclosure",
      "compact-json",
    ],
    usageDetail: `Search options:
  --node NAME                Restrict to one semantic node
  --max-tier N               Deepest tier 0..3
  --limit N                  Return 1..50 records
  --graph-hops N             Expand 0..3 graph hops
  --source-actor ACTOR       Restrict evidence actor
  --include-historical       Include inactive/superseded memories
  --retrieval-mode MODE      fts5, hybrid, qwen3, hashing, or legacy
  --vector-granularity MODE  hierarchy, records, or union
  --second-pass              Enable progressive QPP recall
  --full-warm                Expose all ranked L1 records in the first response
  --tiered-disclosure        Open tiers sequentially until QPP is sufficient
  --compact-json             Emit agent-facing headers; exact evidence stays behind get
  --no-perf                  Disable per-phase performance timing`,
    buildParams: searchParams,
  },
  {
    method: "get",
    words: ["get"],
    usageLine: "nmg get MEMORY_ID... [--graph-hops N] [--json]",
    options: ["graph-hops", "project-dir", "session-id"],
    flags: [],
    buildParams: getParams,
  },
  {
    method: "retentionCandidates",
    words: ["retention", "candidates"],
    usageLine: "nmg retention candidates [policy options] [--json]",
    options: [
      "dormant-after-days",
      "quarantine-after-days",
      "maximum-importance",
      "maximum-access-count",
    ],
    flags: [],
    usageDetail: `Retention policy options:
  --dormant-after-days N     Minimum age and idle time before L4
  --quarantine-after-days N  Minimum time in L4 before L5
  --maximum-importance N     Candidate ceiling from 0..1
  --maximum-access-count N   Candidate access-count ceiling`,
    buildParams: (values) => {
      rejectPositionals(values, "retention candidates");
      return compactObject({
        dormantAfterDays: numericOption(values, "dormant-after-days"),
        quarantineAfterDays: numericOption(values, "quarantine-after-days"),
        maximumImportance: numericOption(values, "maximum-importance"),
        maximumAccessCount: numericOption(values, "maximum-access-count"),
      }) as NmgRetentionCandidatesParams;
    },
  },
  {
    method: "setStorageState",
    words: ["retention", "archive"],
    usageLine: "nmg retention archive MEMORY_ID [--json]",
    options: [],
    flags: [],
    buildParams: (values) => storageStateParams(values, "archive"),
  },
  {
    method: "setStorageState",
    words: ["retention", "quarantine"],
    usageLine: "nmg retention quarantine MEMORY_ID [--recovery-days N] [--json]",
    options: ["recovery-days"],
    flags: [],
    buildParams: (values) => storageStateParams(values, "quarantine"),
  },
  {
    method: "setStorageState",
    words: ["retention", "restore"],
    usageLine: "nmg retention restore MEMORY_ID [--json]",
    options: [],
    flags: [],
    buildParams: (values) => storageStateParams(values, "restore"),
  },
  {
    method: "deleteMemory",
    words: ["memory", "delete"],
    usageLine: "nmg memory delete MEMORY_ID [--json]",
    options: [],
    flags: [],
    buildParams: (values): NmgDeleteMemoryParams => ({
      memoryId: singlePositional(values, "memory delete"),
    }),
  },
  {
    method: "exportMemories",
    words: ["memory", "export"],
    usageLine: "nmg memory export [--all-actors] [--include-deleted] [--json]",
    options: [],
    flags: ["all-actors", "include-deleted"],
    usageDetail: `Memory export options:
  --all-actors              Include assistant, system, and tool memories
  --include-deleted         Include logical-deletion tombstones and retained provenance`,
    buildParams: (values): NmgExportMemoriesParams => {
      rejectPositionals(values, "memory export");
      return {
        sourceActor: values.flags.has("all-actors") ? undefined : "user",
        includeDeleted: values.flags.has("include-deleted"),
      };
    },
  },
  {
    method: "mergeNodes",
    words: ["node", "merge"],
    usageLine: "nmg node merge NODE_ID... --target-name NAME [--target-kind KIND] [--json]",
    options: ["target-name", "target-kind", "summary"],
    flags: [],
    usageDetail: `Node maintenance:
  --target-name NAME         New canonical node name for merge
  --target-kind KIND         Optional semantic node kind
  --partition NAME=IDS       Split partition; repeat and assign every memory ID`,
    buildParams: mergeNodesParams,
  },
  {
    method: "splitNode",
    words: ["node", "split"],
    usageLine: "nmg node split NODE_ID --partition NAME=MEMORY_ID,... --partition ... [--json]",
    options: ["partition"],
    flags: [],
    buildParams: splitNodeParams,
  },
  {
    method: "rollbackNodeTransform",
    words: ["node", "rollback"],
    usageLine: "nmg node rollback TRANSFORM_ID [--json]",
    options: [],
    flags: [],
    usageDetail: `Node rollback:
  Restores a journaled merge only when its memories, node states, and local topology
  have not changed since the merge. Older unjournaled transforms cannot be restored.`,
    buildParams: (values): NmgRollbackNodeTransformParams => ({
      transformId: singlePositional(values, "node rollback"),
    }),
  },
  {
    method: "perfAggregates",
    words: ["perf", "aggregates"],
    usageLine: "nmg perf aggregates [--json]",
    options: [],
    flags: [],
    buildParams: (values) => {
      rejectPositionals(values, "perf aggregates");
      return undefined;
    },
  },
  {
    method: "pruneRetrievalTraces",
    words: ["perf", "prune"],
    usageLine: "nmg perf prune [--max-days N] [--max-rows N] [--json]",
    options: ["max-days", "max-rows"],
    flags: [],
    buildParams: (values): NmgPerfParams =>
      compactObject({
        action: "prune",
        maxDays: numericOption(values, "max-days"),
        maxRows: numericOption(values, "max-rows"),
      }) as NmgPerfParams,
  },
  {
    method: "syncStg",
    words: ["stg", "sync"],
    usageLine: "nmg stg sync --project-dir DIR --scope KEY=VALUE [--limit N] [--json]",
    options: ["project-dir", "session-id", "scope", "limit"],
    flags: [],
    buildParams: (values) => {
      rejectPositionals(values, "stg sync");
      return syncStgParams(values);
    },
  },
  {
    // Local read-only TUI — no RPC method, no --json; main.ts dispatches it.
    local: true,
    includeCommonFlags: false,
    words: ["inspect"],
    usageLine: "nmg inspect [--data-dir DIR | --db FILE]",
    options: [],
    flags: [],
    buildParams: (values) => {
      rejectPositionals(values, "inspect");
      return undefined;
    },
  },
];

/** All option names any command accepts (drives parse-time typo rejection). */
export const CLI_KNOWN_OPTIONS: ReadonlySet<string> = new Set([
  ...COMMON_OPTIONS,
  ...NMG_CLI_COMMANDS.flatMap((spec) => spec.options),
]);

/** All flag names any command accepts. */
export const CLI_KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ...COMMON_FLAGS,
  ...NMG_CLI_COMMANDS.flatMap((spec) => spec.flags),
]);

/** Specs whose first CLI word equals `word` (one group per top-level command). */
export function cliCommandGroup(word: string): readonly CliCommandSpec[] {
  return NMG_CLI_COMMANDS.filter((spec) => spec.words[0] === word);
}

/** Reject options/flags outside the spec's allowed set (plus COMMON_*). */
export function assertSpecOptions(spec: CliCommandSpec, values: OptionValues): void {
  const allowedOptions = new Set([...COMMON_OPTIONS, ...spec.options]);
  const allowedFlags = new Set([
    ...(spec.includeCommonFlags === false ? [] : COMMON_FLAGS),
    ...spec.flags,
  ]);
  for (const name of values.options.keys()) {
    if (!allowedOptions.has(name)) throw new Error(`unknown option: --${name}`);
  }
  for (const name of values.flags) {
    if (!allowedFlags.has(name)) throw new Error(`unknown option: --${name}`);
  }
}

/** USAGE text assembled from the registry (daemon line is appended by main). */
export function cliUsage(extraLines: readonly string[] = []): string {
  const synopsis = [
    ...NMG_CLI_COMMANDS.map((spec) => `  ${spec.usageLine}`),
    ...extraLines.map((line) => `  ${line}`),
  ].join("\n");
  const common = `Common options:
  --data-dir DIR             NMG data directory (default: NMG_DATA_DIR or .nmg)
  --db FILE                  Explicit SQLite database path
  --scope KEY=VALUE          Repeatable or comma-separated scope filter
  --project-dir DIR          Project-local STG root (stores .nmg/stg.sqlite)
  --json                     Emit the full machine-readable result`;
  const details = NMG_CLI_COMMANDS.flatMap((spec) => (spec.usageDetail ? [spec.usageDetail] : []));
  return `NMG command line\n\nUsage:\n${synopsis}\n\n${[common, ...details].join("\n\n")}\n`;
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
    progressiveWarmDisclosure: values.flags.has("full-warm") ? false : undefined,
    tieredDisclosure: values.flags.has("tiered-disclosure") || undefined,
    perf: values.flags.has("no-perf") ? false : undefined,
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
    sessionId: firstOption(values, "session-id"),
  }) as unknown as NmgSearchParams;
}

function getParams(values: OptionValues): NmgGetParams {
  const memoryIds = values.positionals.flatMap((value) => value.split(",")).filter(Boolean);
  if (memoryIds.length === 0) throw new Error("get requires at least one memory ID");
  return compactObject({
    memoryIds,
    graphHops: numericOption(values, "graph-hops"),
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
    sessionId: firstOption(values, "session-id"),
  }) as unknown as NmgGetParams;
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

function syncStgParams(values: OptionValues): NmgSyncStgParams {
  const projectDir = firstOption(values, "project-dir");
  if (!projectDir) throw new Error("stg sync requires --project-dir DIR");
  const scope = scopeOptions(values);
  if (!scope) throw new Error("stg sync requires --scope KEY=VALUE");
  return compactObject({
    projectDir: resolve(projectDir),
    sessionId: firstOption(values, "session-id"),
    scope,
    limit: numericOption(values, "limit"),
  }) as unknown as NmgSyncStgParams;
}

function singlePositional(values: OptionValues, command: string): string {
  if (values.positionals.length !== 1) throw new Error(`${command} requires exactly one ID`);
  return values.positionals[0]!;
}

export function rejectPositionals(values: OptionValues, command: string): void {
  if (values.positionals.length > 0) {
    throw new Error(`${command} does not accept positional arguments`);
  }
}

export function firstOption(values: OptionValues, name: string): string | undefined {
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

export function optionalResolvedPath(value: string | undefined): string | undefined {
  return value ? resolve(value) : undefined;
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined));
}
