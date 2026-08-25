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
  NmgLabParams,
  NmgMergeNodesParams,
  NmgMemoryMaintenanceProposalParams,
  NmgPerfParams,
  NmgRecordClaimOutcomesParams,
  NmgRememberParams,
  NmgResolveRememberParams,
  NmgRollbackNodeTransformParams,
  NmgRetentionCandidatesParams,
  NmgSearchParams,
  NmgSetStorageStateParams,
  NmgSplitNodeParams,
  NmgSyncStgParams,
  NmgTaskBoardParams,
  NmgTopologyProposalParams,
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
    method: "lab",
    words: ["lab", "list"],
    usageLine: "nmg lab list [--json]",
    options: [],
    flags: [],
    buildParams: (values): NmgLabParams => {
      rejectPositionals(values, "lab list");
      return { action: "list" };
    },
  },
  {
    method: "lab",
    words: ["lab", "status"],
    usageLine: "nmg lab status CAPABILITY --session-id ID [--json]",
    options: ["session-id"],
    flags: [],
    buildParams: (values): NmgLabParams => ({
      action: "status",
      capability: singlePositional(values, "lab status") as NmgLabParams extends {
        capability: infer C;
      }
        ? C
        : never,
      sessionId: requiredOption(values, "session-id"),
    }),
  },
  {
    method: "lab",
    words: ["lab", "enable"],
    usageLine:
      "nmg lab enable CAPABILITY --session-id ID --requester ID --reason TEXT [--ttl-seconds N] [--json]",
    options: ["session-id", "requester", "reason", "ttl-seconds"],
    flags: [],
    buildParams: (values): NmgLabParams => ({
      action: "enable",
      capability: singlePositional(values, "lab enable") as NmgLabParams extends {
        capability: infer C;
      }
        ? C
        : never,
      scope: "session",
      sessionId: requiredOption(values, "session-id"),
      requester: requiredOption(values, "requester"),
      reason: requiredOption(values, "reason"),
      ttlSeconds: numericOption(values, "ttl-seconds"),
    }),
  },
  {
    method: "lab",
    words: ["lab", "disable"],
    usageLine: "nmg lab disable CAPABILITY --session-id ID [--json]",
    options: ["session-id"],
    flags: [],
    buildParams: (values): NmgLabParams => ({
      action: "disable",
      capability: singlePositional(values, "lab disable") as NmgLabParams extends {
        capability: infer C;
      }
        ? C
        : never,
      sessionId: requiredOption(values, "session-id"),
    }),
  },
  {
    method: "lab",
    words: ["lab", "invoke"],
    usageLine:
      "nmg lab invoke CAPABILITY --session-id ID --operation NAME [--input-json JSON] [--json]",
    options: ["session-id", "operation", "input-json"],
    flags: [],
    buildParams: (values): NmgLabParams => {
      const rawInput = firstOption(values, "input-json");
      let input: unknown;
      if (rawInput !== undefined) {
        try {
          input = JSON.parse(rawInput);
        } catch {
          throw new Error("--input-json must be valid JSON");
        }
      }
      return {
        action: "invoke",
        capability: singlePositional(values, "lab invoke") as NmgLabParams extends {
          capability: infer C;
        }
          ? C
          : never,
        sessionId: requiredOption(values, "session-id"),
        operation: requiredOption(values, "operation"),
        input,
      };
    },
  },
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
      "write-source",
      "resolution",
      "opened-at",
      "related-memory",
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
  --resolution VALUE         open, resolved, or reopened
  --opened-at ISO            When the open structure was created
  --related-memory ID        Repeatable evidence anchor; required for open/reopened
  --write-reason TEXT        Durable-write justification
  --write-source SOURCE      Submission channel; defaults to user for the CLI
  --external-source REF      External provenance: web:URL or file:PATH
  --retrieved-at ISO         External retrieval timestamp (default: now)
  --content-hash HASH        Optional external content hash`,
    buildParams: rememberParams,
  },
  {
    method: "resolveRemember",
    words: ["resolve"],
    usageLine: "nmg resolve MEMORY_ID [--reason TEXT] [--json]",
    options: ["reason", "project-dir", "session-id"],
    flags: [],
    buildParams: (values) => resolutionParams(values, "resolve"),
  },
  {
    method: "recordClaimOutcomes",
    words: ["claim", "outcome"],
    usageLine:
      "nmg claim outcome MEMORY_ID --outcome supported|contradicted --source SOURCE --source-lineage ID --semantic-task-id ID [options] [--json]",
    options: [
      "outcome",
      "source",
      "source-lineage",
      "semantic-task-id",
      "claim-index",
      "weight",
      "active-graph-id",
      "project-dir",
      "session-id",
      "evidence",
      "source-ref",
      "collection-origin",
    ],
    flags: [],
    usageDetail: `Claim outcome options:
  --outcome VALUE            Explicit supported or contradicted result
  --source SOURCE            user, tool, task, or benchmark
  --source-lineage ID        Stable identity of the original evidence source
  --evidence TEXT            Exact user/tool evidence excerpt to retain
  --source-ref REF           Optional durable reference for the evidence excerpt
  --collection-origin VALUE  natural (default) or controlled probe/benchmark
  --semantic-task-id ID      Independent task identity used for vote deduplication
  --claim-index N            Repeatable atomic claim index; omit for every claim
  --weight N                 Reliability in (0,1], default 1
  --active-graph-id ID       Restrict voting to evidence exposed by this AG`,
    buildParams: claimOutcomeParams,
  },
  {
    method: "resolveRemember",
    words: ["reopen"],
    usageLine: "nmg reopen MEMORY_ID --related-memory ID [options] [--json]",
    options: ["reason", "related-memory", "project-dir", "session-id"],
    flags: [],
    buildParams: (values) => resolutionParams(values, "reopen"),
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
      "chain-max-chains",
      "chain-hops",
      "chain-memory-hops",
      "retrieval-mode",
      "vector-granularity",
    ],
    flags: [
      "include-historical",
      "no-perf",
      "second-pass",
      "full-warm",
      "tiered-disclosure",
      "no-chain-expansion",
      "compact-json",
    ],
    usageDetail: `Search options:
  --node NAME                Restrict to one semantic node
  --max-tier N               Deepest tier 0..3
  --limit N                  Return 1..50 records
  --graph-hops N             Expand 0..3 graph hops
  --chain-max-chains N       Expand at most 1..8 MMR-selected chains
  --chain-hops N             Follow 0..1 chain-intersection hops
  --chain-memory-hops N      Follow 0..8 logical DAG memory hops
  --no-chain-expansion       Disable bounded chain evidence expansion
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
    usageLine: "nmg get MEMORY_ID... [--active-graph-id ID] [--graph-hops N] [--json]",
    options: ["active-graph-id", "graph-hops", "project-dir", "session-id"],
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
    method: "topologyProposal",
    words: ["topology", "proposals"],
    usageLine: "nmg topology proposals [--status pending|accepted|rejected] [--json]",
    options: ["status"],
    flags: [],
    usageDetail: `Topology proposal administration:
  proposals                    List proposals, pending by default
  assess PROPOSAL_ID           Check whether automatic merge safeguards pass
  review PROPOSAL_ID           Record an explicit accept or reject decision
  actuate PROPOSAL_ID          Execute an eligible accepted merge proposal`,
    buildParams: (values): NmgTopologyProposalParams => {
      rejectPositionals(values, "topology proposals");
      return {
        action: "list",
        status: firstOption(values, "status") as "accepted" | "pending" | "rejected" | undefined,
      };
    },
  },
  {
    method: "topologyProposal",
    words: ["topology", "assess"],
    usageLine: "nmg topology assess PROPOSAL_ID [policy options] [--json]",
    options: ["minimum-observations", "minimum-estimated-gain", "minimum-evidence-memories"],
    flags: [],
    buildParams: (values): NmgTopologyProposalParams => ({
      action: "assess",
      proposalId: singlePositional(values, "topology assess"),
      minimumObservations: numericOption(values, "minimum-observations"),
      minimumEstimatedGain: numericOption(values, "minimum-estimated-gain"),
      minimumEvidenceMemories: numericOption(values, "minimum-evidence-memories"),
    }),
  },
  {
    method: "memoryMaintenanceProposal",
    words: ["maintenance", "proposals"],
    usageLine: "nmg maintenance proposals [--status pending|accepted|rejected] [--json]",
    options: ["status"],
    flags: [],
    buildParams: (values): NmgMemoryMaintenanceProposalParams => {
      rejectPositionals(values, "maintenance proposals");
      return {
        action: "list",
        status: firstOption(values, "status") as "accepted" | "pending" | "rejected" | undefined,
      };
    },
  },
  {
    method: "memoryMaintenanceProposal",
    words: ["maintenance", "propose"],
    usageLine:
      "nmg maintenance propose --defect TYPE --maintenance-action ACTION --target-memory ID --policy-id ID --policy-revision REV --policy-hash HASH --policy-min-score N --score N --evaluation-kind KIND --evaluation-ref REF [options] [--json]",
    options: [
      "defect",
      "maintenance-action",
      "target-memory",
      "evidence-memory",
      "evidence-trace",
      "proposed-statement",
      "scope",
      "policy-id",
      "policy-revision",
      "policy-hash",
      "policy-min-score",
      "score",
      "evaluation-kind",
      "evaluation-ref",
    ],
    flags: [],
    usageDetail: `Maintenance proposals are review-only and never mutate memory automatically.
  --defect TYPE             content, scope, or retrieval
  --maintenance-action A    observe, rewrite, rescope, supersede, split, or merge
  --target-memory ID        Target memory; repeat for multiple targets
  --evidence-memory ID      Supporting memory; repeat as needed
  --evidence-trace ID       Supporting retrieval trace; repeat as needed
  --scope KEY=VALUE         Proposed scope for rescope; repeat as needed
  Retrieval defects may only use observe: selection failures must not rewrite content.`,
    buildParams: (values): NmgMemoryMaintenanceProposalParams => {
      rejectPositionals(values, "maintenance propose");
      const targetMemoryIds = values.options.get("target-memory") ?? [];
      if (targetMemoryIds.length === 0) throw new Error("--target-memory is required");
      return {
        action: "propose",
        defectType: requiredOption(values, "defect") as "content" | "retrieval" | "scope",
        maintenanceAction: requiredOption(values, "maintenance-action") as
          "merge" | "observe" | "rescope" | "rewrite" | "split" | "supersede",
        targetMemoryIds,
        evidenceMemoryIds: values.options.get("evidence-memory"),
        evidenceTraceIds: values.options.get("evidence-trace"),
        proposedStatement: firstOption(values, "proposed-statement"),
        proposedScope: scopeOptions(values),
        policy: {
          id: requiredOption(values, "policy-id"),
          revision: requiredOption(values, "policy-revision"),
          sourceHash: requiredOption(values, "policy-hash"),
          minimumLongHorizonScore: requiredNumericOption(values, "policy-min-score"),
        },
        longHorizonScore: requiredNumericOption(values, "score"),
        evaluationKind: requiredOption(values, "evaluation-kind") as "held_out" | "matched_replay",
        evaluationRef: requiredOption(values, "evaluation-ref"),
      };
    },
  },
  {
    method: "memoryMaintenanceProposal",
    words: ["maintenance", "review"],
    usageLine: "nmg maintenance review PROPOSAL_ID --decision accept|reject --reason TEXT [--json]",
    options: ["decision", "reason"],
    flags: [],
    buildParams: (values): NmgMemoryMaintenanceProposalParams => ({
      action: "review",
      proposalId: singlePositional(values, "maintenance review"),
      decision: requiredOption(values, "decision") as "accept" | "reject",
      reason: requiredOption(values, "reason"),
    }),
  },
  {
    method: "topologyProposal",
    words: ["topology", "review"],
    usageLine: "nmg topology review PROPOSAL_ID --decision accept|reject [--json]",
    options: ["decision"],
    flags: [],
    buildParams: (values): NmgTopologyProposalParams => ({
      action: "review",
      proposalId: singlePositional(values, "topology review"),
      decision: requiredOption(values, "decision") as "accept" | "reject",
    }),
  },
  {
    method: "topologyProposal",
    words: ["topology", "actuate"],
    usageLine: "nmg topology actuate PROPOSAL_ID [--json]",
    options: [],
    flags: [],
    buildParams: (values): NmgTopologyProposalParams => ({
      action: "actuate",
      proposalId: singlePositional(values, "topology actuate"),
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
    method: "taskBoard",
    words: ["board", "discover"],
    usageLine: "nmg board discover --agent AGENT [--capabilities TEXT] [--json]",
    options: ["agent", "capabilities"],
    flags: [],
    buildParams: (values): NmgTaskBoardParams => {
      rejectPositionals(values, "board discover");
      return compactObject({
        action: "discover",
        taskId: "default",
        agentId: requiredOption(values, "agent"),
        capabilities: firstOption(values, "capabilities"),
      }) as unknown as NmgTaskBoardParams;
    },
  },
  {
    method: "taskBoard",
    words: ["board", "put"],
    usageLine: "nmg board put TASK_ID CONTENT --agent AGENT [options] [--json]",
    options: ["agent", "kind", "session-id", "to", "ttl-seconds", "expires-at"],
    flags: [],
    usageDetail: `Task board options:
  --agent ID                 Writer/reader identity (required)
  --capabilities TEXT        Filter discover by an advertised capability substring
  --kind KIND                goal, note, question, result, handoff, decision, or blocker
  --to AGENT                 Wake only this stable agent name; omit to broadcast
  --ttl-seconds N            Lifetime from 60 seconds to 30 days (default: 1 day)
  --expires-at ISO           Explicit expiry instead of --ttl-seconds
  --after-cursor N           Read only entries after this task-local sequence
  --include-resolved         Include resolved entries when reading`,
    buildParams: (values): NmgTaskBoardParams => {
      if (values.positionals.length < 2) {
        throw new Error("board put requires TASK_ID and CONTENT");
      }
      return compactObject({
        action: "put",
        taskId: values.positionals[0],
        content: values.positionals.slice(1).join(" "),
        agentId: requiredOption(values, "agent"),
        kind: firstOption(values, "kind"),
        sourceSessionId: firstOption(values, "session-id"),
        to: firstOption(values, "to"),
        ttlSeconds: numericOption(values, "ttl-seconds"),
        expiresAt: firstOption(values, "expires-at"),
      }) as unknown as NmgTaskBoardParams;
    },
  },
  {
    method: "taskBoard",
    words: ["board", "read"],
    usageLine: "nmg board read TASK_ID --agent AGENT [options] [--json]",
    options: ["agent", "after-cursor", "limit"],
    flags: ["include-resolved"],
    buildParams: (values): NmgTaskBoardParams => ({
      action: "read",
      taskId: singlePositional(values, "board read"),
      agentId: requiredOption(values, "agent"),
      afterCursor: numericOption(values, "after-cursor"),
      limit: numericOption(values, "limit"),
      includeResolved: values.flags.has("include-resolved"),
    }),
  },
  {
    method: "taskBoard",
    words: ["board", "resolve"],
    usageLine: "nmg board resolve TASK_ID ENTRY_ID --agent AGENT [--resolution TEXT] [--json]",
    options: ["agent", "resolution"],
    flags: [],
    buildParams: (values): NmgTaskBoardParams => {
      if (values.positionals.length !== 2) {
        throw new Error("board resolve requires TASK_ID and ENTRY_ID");
      }
      return compactObject({
        action: "resolve",
        taskId: values.positionals[0],
        entryId: values.positionals[1],
        agentId: requiredOption(values, "agent"),
        resolution: firstOption(values, "resolution"),
      }) as unknown as NmgTaskBoardParams;
    },
  },
  {
    method: "taskBoard",
    words: ["board", "claim"],
    usageLine: "nmg board claim TASK_ID ENTRY_ID --agent AGENT [--lease-seconds N] [--json]",
    options: ["agent", "lease-seconds"],
    flags: [],
    buildParams: (values): NmgTaskBoardParams => {
      if (values.positionals.length !== 2) {
        throw new Error("board claim requires TASK_ID and ENTRY_ID");
      }
      return compactObject({
        action: "claim",
        taskId: values.positionals[0],
        entryId: values.positionals[1],
        agentId: requiredOption(values, "agent"),
        leaseSeconds: numericOption(values, "lease-seconds"),
      }) as unknown as NmgTaskBoardParams;
    },
  },
  {
    method: "taskBoard",
    words: ["board", "release"],
    usageLine: "nmg board release TASK_ID ENTRY_ID --agent AGENT [--json]",
    options: ["agent"],
    flags: [],
    buildParams: (values): NmgTaskBoardParams => {
      if (values.positionals.length !== 2) {
        throw new Error("board release requires TASK_ID and ENTRY_ID");
      }
      return compactObject({
        action: "release",
        taskId: values.positionals[0],
        entryId: values.positionals[1],
        agentId: requiredOption(values, "agent"),
      }) as unknown as NmgTaskBoardParams;
    },
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
  {
    // Local read-only graph export — renders the node/relation projection
    // into a self-contained HTML file; main.ts dispatches it.
    local: true,
    includeCommonFlags: false,
    words: ["graph"],
    usageLine: "nmg graph [--out FILE] [--data-dir DIR | --db FILE]",
    options: ["out"],
    flags: [],
    usageDetail: `Graph export options:
  --out FILE                 Output HTML file (default: nmg-graph.html)`,
    buildParams: (values) => {
      rejectPositionals(values, "graph");
      return undefined;
    },
  },
  {
    method: "chainCreate",
    words: ["chain", "create"],
    usageLine: "nmg chain create --type temporal|logical --topic NAME [--owner SESSION] [--json]",
    options: ["type", "topic", "owner", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain create options:
  --type TYPE              temporal | logical (required)
  --topic NAME             Chain topic/name (required)
  --owner SESSION          Owning session id (default: none)`,
    buildParams: (values) => {
      rejectPositionals(values, "chain create");
      const type = requiredOption(values, "type");
      if (type !== "temporal" && type !== "logical") {
        throw new Error("--type must be 'temporal' or 'logical'");
      }
      return {
        chainType: type,
        topic: requiredOption(values, "topic"),
        ownerSessionId: firstOption(values, "owner"),
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
    },
  },
  {
    method: "chainAdd",
    words: ["chain", "add"],
    usageLine: "nmg chain add --chain ID --memory ID [--position N] [--note TEXT] [--json]",
    options: ["chain", "memory", "position", "note", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain add options:
  --chain ID               Chain id (required)
  --memory ID              Memory id to reference (required)
  --position N             Explicit position (default: append)
  --note TEXT              Optional per-member note`,
    buildParams: (values) => {
      rejectPositionals(values, "chain add");
      const position = firstOption(values, "position");
      return {
        chainId: requiredOption(values, "chain"),
        memoryId: requiredOption(values, "memory"),
        position: position === undefined ? undefined : Number(position),
        note: firstOption(values, "note"),
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
    },
  },
  {
    method: "chainRemove",
    words: ["chain", "remove"],
    usageLine: "nmg chain remove --chain ID --memory ID [--json]",
    options: ["chain", "memory", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain remove options:
  --chain ID               Chain id (required)
  --memory ID              Memory id to remove (required)`,
    buildParams: (values) => {
      rejectPositionals(values, "chain remove");
      return {
        chainId: requiredOption(values, "chain"),
        memoryId: requiredOption(values, "memory"),
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
    },
  },
  {
    method: "chainEdgeAdd",
    words: ["chain", "edge", "add"],
    usageLine: "nmg chain edge add --chain ID --from MEMORY --to MEMORY [--json]",
    options: ["chain", "from", "to", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain edge add options:
  --chain ID               Chain id (required)
  --from MEMORY            Source memory id (required)
  --to MEMORY              Target memory id (required)`,
    buildParams: (values) => {
      rejectPositionals(values, "chain edge add");
      return {
        chainId: requiredOption(values, "chain"),
        sourceMemoryId: requiredOption(values, "from"),
        targetMemoryId: requiredOption(values, "to"),
        edgeType: "order" as const,
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
    },
  },
  {
    method: "chainEdgeRemove",
    words: ["chain", "edge", "remove"],
    usageLine: "nmg chain edge remove --chain ID --from MEMORY --to MEMORY [--json]",
    options: ["chain", "from", "to", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain edge remove options:
  --chain ID               Chain id (required)
  --from MEMORY            Source memory id (required)
  --to MEMORY              Target memory id (required)`,
    buildParams: (values) => {
      rejectPositionals(values, "chain edge remove");
      return {
        chainId: requiredOption(values, "chain"),
        sourceMemoryId: requiredOption(values, "from"),
        targetMemoryId: requiredOption(values, "to"),
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
    },
  },
  {
    method: "chainGet",
    words: ["chain", "get"],
    usageLine: "nmg chain get --chain ID [--json]",
    options: ["chain", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain get options:
  --chain ID               Chain id (required)`,
    buildParams: (values) => {
      rejectPositionals(values, "chain get");
      return {
        chainId: requiredOption(values, "chain"),
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
    },
  },
  {
    method: "chainList",
    words: ["chain", "list"],
    usageLine: "nmg chain list [--type temporal|logical] [--owner SESSION] [--json]",
    options: ["type", "owner", "project-dir", "session-id"],
    flags: [],
    usageDetail: `Chain list options:
  --type TYPE              Filter by chain type
  --owner SESSION          Filter by owner session`,
    buildParams: (values) => {
      rejectPositionals(values, "chain list");
      const type = firstOption(values, "type");
      if (type !== undefined && type !== "temporal" && type !== "logical") {
        throw new Error("--type must be 'temporal' or 'logical'");
      }
      return {
        chainType: type,
        ownerSessionId: firstOption(values, "owner"),
        projectDir: firstOption(values, "project-dir"),
        sessionId: firstOption(values, "session-id"),
      };
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

/** Common option block shared by global and per-command usage. */
const COMMON_OPTIONS_TEXT = `Common options:
  --data-dir DIR             NMG data directory (default: NMG_DATA_DIR or ~/.nmg)
  --db FILE                  Explicit SQLite database path
  --scope KEY=VALUE          Repeatable or comma-separated scope filter
  --project-dir DIR          Project-local STG root (stores .nmg/stg.sqlite)
  --json                     Emit the full machine-readable result`;

/** USAGE text assembled from the registry (daemon line is appended by main). */
export function cliUsage(extraLines: readonly string[] = []): string {
  const synopsis = [
    ...NMG_CLI_COMMANDS.map((spec) => `  ${spec.usageLine}`),
    ...extraLines.map((line) => `  ${line}`),
  ].join("\n");
  const details = NMG_CLI_COMMANDS.flatMap((spec) => (spec.usageDetail ? [spec.usageDetail] : []));
  return `NMG command line\n\nUsage:\n${synopsis}\n\n${[COMMON_OPTIONS_TEXT, ...details].join("\n\n")}\n`;
}

/** Focused usage for one top-level command; undefined when unknown. */
export function cliCommandUsage(word: string): string | undefined {
  const group = cliCommandGroup(word);
  if (group.length === 0) return undefined;
  const synopsis = group.map((spec) => `  ${spec.usageLine}`).join("\n");
  const details = group.flatMap((spec) => (spec.usageDetail ? [spec.usageDetail] : []));
  return `NMG command line — ${word}\n\nUsage:\n${synopsis}\n\n${[COMMON_OPTIONS_TEXT, ...details].filter(Boolean).join("\n\n")}\n`;
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
    writeSource: firstOption(values, "write-source") ?? "user",
    resolution: firstOption(values, "resolution"),
    openedAt: firstOption(values, "opened-at"),
    relatedMemoryIds: values.options.get("related-memory"),
    markers: externalMarker,
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
  }) as unknown as NmgRememberParams;
}

function resolutionParams(
  values: OptionValues,
  action: "resolve" | "reopen",
): NmgResolveRememberParams {
  return compactObject({
    action,
    memoryId: singlePositional(values, action),
    relatedMemoryIds: values.options.get("related-memory"),
    reason: firstOption(values, "reason"),
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
    sessionId: firstOption(values, "session-id"),
  }) as unknown as NmgResolveRememberParams;
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
    expandChains: values.flags.has("no-chain-expansion") ? false : undefined,
    chainExpansionMaxChains: numericOption(values, "chain-max-chains"),
    chainExpansionMaxHops: numericOption(values, "chain-hops"),
    chainExpansionMaxMemoryHops: numericOption(values, "chain-memory-hops"),
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
    activeGraphId: firstOption(values, "active-graph-id"),
    graphHops: numericOption(values, "graph-hops"),
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
    sessionId: firstOption(values, "session-id"),
  }) as unknown as NmgGetParams;
}

function claimOutcomeParams(values: OptionValues): NmgRecordClaimOutcomesParams {
  const memoryId = singlePositional(values, "claim outcome");
  const claimIndexes = (values.options.get("claim-index") ?? []).map((value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error("--claim-index must be a non-negative integer");
    }
    return parsed;
  });
  const source = requiredOption(values, "source");
  const sourceLineage = requiredOption(values, "source-lineage");
  const sessionId = firstOption(values, "session-id");
  const evidence = firstOption(values, "evidence");
  if (evidence && source !== "user" && source !== "tool") {
    throw new Error("--evidence is only valid with --source user or tool");
  }
  if (evidence && !sessionId) {
    throw new Error("--evidence requires --session-id so its provenance remains attributable");
  }
  return compactObject({
    semanticTaskId: requiredOption(values, "semantic-task-id"),
    activeGraphId: firstOption(values, "active-graph-id"),
    sessionId,
    projectDir: optionalResolvedPath(firstOption(values, "project-dir")),
    collectionOrigin: firstOption(values, "collection-origin"),
    votes: [
      compactObject({
        memoryId,
        claimIndexes: claimIndexes.length ? claimIndexes : undefined,
        outcome: requiredOption(values, "outcome"),
        source,
        sourceLineage,
        evidenceSource: evidence
          ? compactObject({
              actor: source,
              content: evidence,
              sessionId,
              sourceMessageId: sourceLineage,
              sourceRef: firstOption(values, "source-ref"),
            })
          : undefined,
        weight: numericOption(values, "weight"),
      }),
    ],
  }) as unknown as NmgRecordClaimOutcomesParams;
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

function requiredOption(values: OptionValues, name: string): string {
  const value = firstOption(values, name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function numericOption(values: OptionValues, name: string): number | undefined {
  const value = firstOption(values, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number`);
  return parsed;
}

function requiredNumericOption(values: OptionValues, name: string): number {
  const value = numericOption(values, name);
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
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
