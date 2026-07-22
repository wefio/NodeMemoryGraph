import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { decideMemoryLoad } from "../../../src/core/gate.ts";
import { OpenAIEmbeddingClient } from "../../../src/core/openai-embedding.ts";
import { NmgStore } from "../../../src/core/store.ts";
import { assessMemoryWrite } from "../../../src/core/write-policy.ts";
import type {
  EvidenceRole,
  MemoryActor,
  MemoryContext,
  MemoryResidence,
  RecallIndex,
  MemoryScope,
  MemoryTier,
  MemoryType,
  NodeRelationType,
  TruthStatus,
} from "../../../src/core/types.ts";

function databasePath(): string {
  const dataDirectory = process.env.NMG_DATA_DIR || join(process.cwd(), ".nmg");
  return join(dataDirectory, "nmg.sqlite");
}

export function configuredGraphHops(fallback: number): number {
  const configured = Number.parseInt(process.env.NMG_GRAPH_HOPS ?? "", 10);
  return Number.isInteger(configured) ? Math.max(0, Math.min(configured, 3)) : fallback;
}

export default function nmgExtension(pi: ExtensionAPI): void {
  const labToolsEnabled = process.env.NMG_ENABLE_LAB_TOOLS === "1";
  let store: NmgStore | undefined;
  const getStore = (): NmgStore => (store ??= new NmgStore(databasePath()));
  const embeddingClient = process.env.NMG_EMBED_BASE_URL
    ? new OpenAIEmbeddingClient({
        baseUrl: process.env.NMG_EMBED_BASE_URL,
        apiKey: process.env.NMG_EMBED_API_KEY,
        model: process.env.NMG_EMBED_MODEL,
        dimensions: process.env.NMG_EMBED_DIMENSIONS
          ? Number(process.env.NMG_EMBED_DIMENSIONS)
          : undefined,
      })
    : undefined;
  const searchMemory = async (
    query: string,
    options: Parameters<NmgStore["searchContext"]>[1],
  ): Promise<MemoryContext> => {
    const memoryStore = getStore();
    if (!embeddingClient) return memoryStore.searchContext(query, options);
    const [queryVector] = await embeddingClient.embedQueries([query]);
    const results = memoryStore.searchHierarchyByVector(
      query,
      queryVector!,
      embeddingClient.model,
      options,
    );
    return {
      results,
      relations: memoryStore.getRelations(
        [...new Set(results.map((result) => result.node.id))],
        configuredGraphHops(options?.graphHops ?? 0),
      ),
    };
  };

  pi.on("before_agent_start", async (event) => {
    const memoryStore = getStore();
    memoryStore.expireShortTermMemories();
    const kernelBlock = formatResidentKernel(memoryStore.residentKernel());
    const decision = decideMemoryLoad(event.prompt);
    let dynamicBlock = "";
    if (decision.mode === "retrieve") {
      const context = await searchMemory(event.prompt, {
        maxTier: decision.maxTier,
        limit: decision.limit,
        graphHops: configuredGraphHops(decision.graphHops),
      });
      const formatted = formatMemoryContext(context);
      if (formatted) {
        dynamicBlock = `<nmg_automatic_recall>\n${formatted}\n</nmg_automatic_recall>`;
      }
    } else if (decision.mode === "cue") {
      dynamicBlock = formatRecallIndex(
        memoryStore.recallCues(event.prompt, {
          limit: decision.limit,
        }),
      );
    }

    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `<nmg_write_policy>\n` +
        `NMG is the user's long-term memory. Automatically call nmg_remember ` +
        `for stable facts, states, events, preferences, constraints, and reusable ` +
        `strategies. Use memoryType=state plus a stable stateKey for values that ` +
        `can change, including current/latest versions, status, personal bests, ` +
        `counts, and progress. Build stateKey from the semantic property and ` +
        `scope, never from its value or date, so later values reuse the exact ` +
        `same key. NMG automatically supersedes the prior state in the same ` +
        `scope. Use memoryType=event and eventTime for things that happened; ` +
        `when an event also establishes a new current value, save both the dated ` +
        `event and an updated state. Preserve separately countable entities and ` +
        `pending actions as separate memories; do not compress several pickups, ` +
        `returns, obligations, or people into one statement when each may matter. ` +
        `For user-stated facts, states, events, preferences, and constraints, set ` +
        `evidence to the shortest exact source excerpt that supports the memory. ` +
        `The statement is a retrieval summary; evidence preserves exact details. ` +
        `Preserve useful assistant output as conversation_evidence with ` +
        `sourceActor=assistant and truthStatus=unverified: remember that it was ` +
        `said without asserting it is true. Ask before saving ambiguous or ` +
        `sensitive information. Do not save casual conversation, temporary ` +
        `instructions, duplicates, credentials, or secrets.` +
        (labToolsEnabled
          ? ` Lab tools are enabled: use nmg_derive for multi-memory conclusions, ` +
            `nmg_link for semantic relations, and nmg_feedback after explicit ` +
            `searches when useful nodes are known.`
          : "") +
        `\n` +
        `</nmg_write_policy>\n` +
        `\n<nmg_recall_policy>\n` +
        `Resident kernel memories are directly usable hard constraints. ` +
        `Automatic recall contains retrieved evidence and can be used directly. ` +
        `Recall cues are only a compressed directory: call nmg_search, then ` +
        `nmg_get for the selected IDs before using specific remembered values. ` +
        `You may call nmg_search ` +
        `even without a cue when the task later proves to depend on past user ` +
        `information. Start shallow and expand only when evidence is insufficient. ` +
        `Treat the latest active state as authoritative for its stateKey and scope; ` +
        `older events are historical evidence. Use preferences to produce a newly ` +
        `tailored answer, not merely to report that the preference exists. A ` +
        `preference memory constrains generation; recommendations do not need to ` +
        `have appeared verbatim in the remembered conversation.\n` +
        `For counting, listing, comparison, or multi-session questions, inspect ` +
        `all relevant retrieved events and states. If the automatic set appears ` +
        `partial, call nmg_search with alternate subqueries before answering.\n` +
        `</nmg_recall_policy>\n` +
        [kernelBlock, dynamicBlock].filter(Boolean).join("\n"),
    };
  });

  const archiveCurrentSession = (ctx: {
    sessionManager: {
      getBranch(): readonly unknown[];
      getSessionId(): string;
      getSessionFile(): string | undefined;
    };
  }) => {
    if (!store) return;
    const branch = ctx.sessionManager.getBranch();
    persistSessionMessages(
      store,
      ctx.sessionManager.getSessionId(),
      branch,
      ctx.sessionManager.getSessionFile(),
    );
    const transcript = serializeSession(branch);
    if (!transcript) return;
    store.archiveSession({
      sessionId: ctx.sessionManager.getSessionId(),
      transcript,
      sourceRef: ctx.sessionManager.getSessionFile() ?? undefined,
    });
  };

  // RPC clients may terminate Pi without emitting a graceful shutdown event.
  // Checkpoint after each completed turn; archives are idempotent per session.
  pi.on("agent_end", async (_event, ctx) => archiveCurrentSession(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    archiveCurrentSession(ctx);
    store?.close();
    store = undefined;
  });

  if (labToolsEnabled)
    pi.registerTool({
      name: "nmg_derive",
      label: "Derive NMG memory",
      description:
        "Save a durable conclusion supported by two or more existing memories. " +
        "Use for aggregation, comparison, temporal conclusions, and reusable rules.",
      parameters: Type.Object({
        statement: Type.String(),
        nodeName: Type.String(),
        sourceMemoryIds: Type.Array(Type.String(), { minItems: 2 }),
        derivation: Type.String({
          description: "Explain how the source memories support the conclusion",
        }),
        scope: Type.Optional(Type.Record(Type.String(), Type.String())),
        eventTime: Type.Optional(Type.String()),
        tier: Type.Optional(
          Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
        ),
        importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const result = getStore().deriveMemory({
          statement: params.statement,
          nodeName: params.nodeName,
          memoryType: "derived",
          sourceMemoryIds: params.sourceMemoryIds,
          derivation: params.derivation,
          scope: params.scope as MemoryScope | undefined,
          eventTime: params.eventTime,
          tier: params.tier as MemoryTier | undefined,
          importance: params.importance,
          sessionId: ctx.sessionManager.getSessionId(),
          sourceRef: ctx.sessionManager.getSessionFile() ?? undefined,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Saved derived memory ${result.memory.id} with ` +
                `${result.memory.evidenceIds.length} evidence records.`,
            },
          ],
          details: result,
        };
      },
    });

  if (labToolsEnabled)
    pi.registerTool({
      name: "nmg_link",
      label: "Link NMG nodes",
      description: "Create a typed semantic relation between two MemoryNodes.",
      parameters: Type.Object({
        sourceNodeId: Type.String(),
        targetNodeId: Type.String(),
        relationType: Type.Union([
          Type.Literal("applies_to"),
          Type.Literal("causes"),
          Type.Literal("contradicts"),
          Type.Literal("depends_on"),
          Type.Literal("derived_from"),
          Type.Literal("exception_to"),
          Type.Literal("is_a"),
          Type.Literal("part_of"),
          Type.Literal("related_to"),
          Type.Literal("supports"),
          Type.Literal("supersedes"),
        ]),
        evidenceIds: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_toolCallId, params) {
        const relation = getStore().linkNodes({
          sourceNodeId: params.sourceNodeId,
          targetNodeId: params.targetNodeId,
          type: params.relationType as NodeRelationType,
          evidenceIds: params.evidenceIds,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Linked ${relation.sourceNodeId} -[${relation.type}]-> ` + relation.targetNodeId,
            },
          ],
          details: relation,
        };
      },
    });

  pi.registerTool({
    name: "nmg_remember",
    label: "Remember with NMG",
    description:
      "Save a confirmed fact, decision, preference, constraint, or reusable " +
      "experience as long-term memory with traceable evidence.",
    parameters: Type.Object({
      statement: Type.String({ description: "Concise memory statement" }),
      nodeName: Type.String({ description: "Stable semantic node name" }),
      memoryType: Type.Optional(
        Type.Union(
          [
            Type.Literal("constraint"),
            Type.Literal("conversation_evidence"),
            Type.Literal("event"),
            Type.Literal("fact"),
            Type.Literal("preference"),
            Type.Literal("state"),
            Type.Literal("strategy"),
          ],
          { description: "How Pi must use this memory; defaults to fact" },
        ),
      ),
      stateKey: Type.Optional(
        Type.String({ description: "Stable identity required for changeable state" }),
      ),
      eventTime: Type.Optional(Type.String({ description: "ISO time when an event happened" })),
      sourceActor: Type.Optional(
        Type.Union([
          Type.Literal("assistant"),
          Type.Literal("system"),
          Type.Literal("tool"),
          Type.Literal("user"),
        ]),
      ),
      truthStatus: Type.Optional(
        Type.Union([
          Type.Literal("asserted"),
          Type.Literal("inferred"),
          Type.Literal("unverified"),
          Type.Literal("verified"),
        ]),
      ),
      evidence: Type.Optional(
        Type.String({ description: "Exact supporting text or source description" }),
      ),
      evidenceHistoryId: Type.Optional(
        Type.String({
          description: "Exact NMG history ID when the source message was pre-ingested",
        }),
      ),
      tier: Type.Optional(
        Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
          description: "Initial tier; defaults to L1",
        }),
      ),
      importance: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: "Importance from 0 to 1" }),
      ),
      scope: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Narrow applicability such as project, device, or environment",
        }),
      ),
      validFrom: Type.Optional(Type.String({ description: "ISO timestamp when valid" })),
      validUntil: Type.Optional(Type.String({ description: "ISO timestamp when no longer valid" })),
      evidenceRole: Type.Optional(
        Type.Union(
          [
            Type.Literal("contradict"),
            Type.Literal("example"),
            Type.Literal("exception"),
            Type.Literal("origin"),
            Type.Literal("support"),
            Type.Literal("update"),
          ],
          { description: "How the evidence relates to the memory" },
        ),
      ),
      supersedesId: Type.Optional(
        Type.String({ description: "Older memory replaced by this confirmed state" }),
      ),
      residence: Type.Optional(
        Type.Union([Type.Literal("stg"), Type.Literal("ltg")], {
          description:
            "Semantic lifecycle; durable governed memories default to LTG, provisional inferences to STG",
        }),
      ),
      expiresAt: Type.Optional(
        Type.String({ description: "Optional ISO expiry for an STG memory" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const assessment = assessMemoryWrite({
        statement: params.statement,
        evidence: params.evidence,
        memoryType: params.memoryType as MemoryType | undefined,
      });
      if (!assessment.allowed) {
        return {
          content: [
            {
              type: "text",
              text: `NMG rejected this long-term write: ${assessment.reason}.`,
            },
          ],
          details: { saved: false, reason: assessment.reason },
        };
      }
      const result = getStore().remember({
        statement: params.statement,
        nodeName: params.nodeName,
        memoryType: params.memoryType as MemoryType | undefined,
        stateKey: params.stateKey,
        eventTime: params.eventTime,
        sourceActor: params.sourceActor as MemoryActor | undefined,
        truthStatus: params.truthStatus as TruthStatus | undefined,
        evidence: params.evidence,
        evidenceHistoryId: params.evidenceHistoryId,
        tier: params.tier as MemoryTier | undefined,
        importance: params.importance,
        scope: params.scope as MemoryScope | undefined,
        validFrom: params.validFrom,
        validUntil: params.validUntil,
        evidenceRole: params.evidenceRole as EvidenceRole | undefined,
        supersedesId: params.supersedesId,
        residence: params.residence as MemoryResidence | undefined,
        expiresAt: params.expiresAt,
        sessionId: ctx.sessionManager.getSessionId(),
        sourceRef: ctx.sessionManager.getSessionFile() ?? undefined,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Saved memory ${result.memory.id} under ` +
              `${result.node.canonicalName}; evidence ${result.history.id}.`,
          },
        ],
        details: result,
      };
    },
  });

  if (labToolsEnabled)
    pi.registerTool({
      name: "nmg_organize",
      label: "Organize NMG nodes",
      description:
        "Merge duplicate semantic nodes or split an over-broad node. This preserves " +
        "all memories and evidence and records source-to-target mappings.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("merge"), Type.Literal("split")]),
        sourceNodeIds: Type.Optional(Type.Array(Type.String(), { minItems: 2 })),
        targetName: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        sourceNodeId: Type.Optional(Type.String()),
        partitions: Type.Optional(
          Type.Array(
            Type.Object({
              nodeName: Type.String(),
              memoryIds: Type.Array(Type.String(), { minItems: 1 }),
            }),
            { minItems: 2 },
          ),
        ),
      }),
      async execute(_toolCallId, params) {
        let transform;
        if (params.action === "merge") {
          if (!params.sourceNodeIds || !params.targetName) {
            throw new Error("merge requires sourceNodeIds and targetName");
          }
          transform = getStore().mergeNodes({
            sourceNodeIds: params.sourceNodeIds,
            targetName: params.targetName,
            summary: params.summary,
          });
        } else {
          if (!params.sourceNodeId || !params.partitions) {
            throw new Error("split requires sourceNodeId and partitions");
          }
          transform = getStore().splitNode({
            sourceNodeId: params.sourceNodeId,
            partitions: params.partitions,
          });
        }
        return {
          content: [
            {
              type: "text",
              text:
                `${transform.type} transform ${transform.id} moved ` +
                `${transform.movedMemoryIds.length} memories without deleting evidence.`,
            },
          ],
          details: transform,
        };
      },
    });

  if (labToolsEnabled)
    pi.registerTool({
      name: "nmg_feedback",
      label: "Train NMG router",
      description:
        "Report which semantic nodes were useful for a query so the local online " +
        "router can improve future node ranking.",
      parameters: Type.Object({
        query: Type.String(),
        usefulNodeIds: Type.Array(Type.String(), { minItems: 1 }),
      }),
      async execute(_toolCallId, params) {
        getStore().trainRouter(params.query, params.usefulNodeIds);
        return {
          content: [
            { type: "text", text: `Trained router on ${params.usefulNodeIds.length} nodes.` },
          ],
          details: { query: params.query, usefulNodeIds: params.usefulNodeIds },
        };
      },
    });

  if (labToolsEnabled)
    pi.registerTool({
      name: "nmg_rebalance",
      label: "Rebalance NMG memory tiers",
      description: "Batch-rebuild Huffman-like block tiers from accumulated access statistics.",
      parameters: Type.Object({
        nodeId: Type.Optional(Type.String()),
        pendingThreshold: Type.Optional(Type.Number({ minimum: 1 })),
      }),
      async execute(_toolCallId, params) {
        const results = params.nodeId
          ? [getStore().rebalanceNode(params.nodeId)]
          : getStore().rebalanceDueNodes(params.pendingThreshold ?? 32);
        return {
          content: [
            {
              type: "text",
              text:
                results.length === 0
                  ? "No node has enough pending accesses for batch rebalancing."
                  : `Rebalanced ${results.length} nodes; changed ` +
                    `${results.reduce((sum, result) => sum + result.changedMemoryIds.length, 0)} tiers.`,
            },
          ],
          details: results,
        };
      },
    });

  if (labToolsEnabled)
    pi.registerTool({
      name: "nmg_consolidate",
      label: "Consolidate stable NMG relations",
      description:
        "Materialize or demote LTG relations from independent actual-use evidence with hysteresis.",
      parameters: Type.Object({
        minIndependentTasks: Type.Optional(Type.Number({ minimum: 2 })),
        promoteThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        demoteThreshold: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
        cooldownMs: Type.Optional(Type.Number({ minimum: 0 })),
      }),
      async execute(_toolCallId, params) {
        const result = getStore().reconcileConsolidation(params);
        return {
          content: [
            {
              type: "text",
              text:
                `Consolidated ${result.consolidatedRelations.length} relations and ` +
                `demoted ${result.demotedRelations.length}; ${result.events.length} audit events.`,
            },
          ],
          details: result,
        };
      },
    });

  pi.registerTool({
    name: "nmg_get",
    label: "Get NMG evidence",
    description:
      "Load exact long-term memory records and their source evidence by IDs " +
      "returned from nmg_search. Use before relying on a specific recalled value.",
    parameters: Type.Object({
      memoryIds: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 20,
        description: "Stable memory IDs returned by nmg_search",
      }),
      graphHops: Type.Optional(
        Type.Number({ minimum: 0, maximum: 2, description: "Related node hops" }),
      ),
      activeGraphId: Type.Optional(
        Type.String({
          description: "Active Graph ID returned by nmg_search; enables actual-use feedback",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const context = getStore().getContext(
        params.memoryIds,
        configuredGraphHops(params.graphHops ?? 0),
      );
      const usedMemoryIds = context.results.map((result) => result.memory.id);
      if (params.activeGraphId) {
        getStore().recordActiveGraphUse(params.activeGraphId, { usedMemoryIds });
      } else {
        getStore().recordUsage(usedMemoryIds);
      }
      const missing = params.memoryIds.filter(
        (id) => !context.results.some((result) => result.memory.id === id),
      );
      const text = formatMemoryContext(context);
      return {
        content: [
          {
            type: "text",
            text: [
              text || "No active NMG memory found for the requested IDs.",
              missing.length > 0 ? `Missing or inactive IDs: ${missing.join(", ")}` : "",
            ]
              .filter(Boolean)
              .join("\n\n"),
          },
        ],
        details: { ...context, missingMemoryIds: missing },
      };
    },
  });

  pi.registerTool({
    name: "nmg_search",
    label: "Search NMG",
    description:
      "Search long-term memory. Start with shallow tiers and increase maxTier " +
      "only when the returned evidence is insufficient.",
    parameters: Type.Object({
      query: Type.String({ description: "What to recall" }),
      nodeName: Type.Optional(Type.String({ description: "Exact semantic node name" })),
      maxTier: Type.Optional(
        Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)], {
          description: "Deepest tier to read; defaults to L1",
        }),
      ),
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 50, description: "Maximum returned records" }),
      ),
      scope: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Only return memories matching every scope field",
        }),
      ),
      includeHistorical: Type.Optional(
        Type.Boolean({ description: "Include inactive and superseded memories" }),
      ),
      graphHops: Type.Optional(
        Type.Number({ minimum: 0, maximum: 3, description: "Typed relation hops" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const context = await searchMemory(params.query, {
        nodeName: params.nodeName,
        maxTier: params.maxTier as MemoryTier | undefined,
        limit: params.limit,
        scope: params.scope as MemoryScope | undefined,
        includeHistorical: params.includeHistorical,
        // An explicit environment override is useful for controlled Lite/Graph
        // experiments. Without it the model can silently defeat a Lite run by
        // choosing graphHops in the tool call.
        graphHops: configuredGraphHops(params.graphHops ?? 1),
        taskId: `${ctx.sessionManager.getSessionId()}:${params.query.trim().toLocaleLowerCase()}`,
      });
      const { results } = context;
      return {
        content: [
          {
            type: "text",
            text:
              results.length === 0
                ? "No matching NMG memory found within the requested tier budget."
                : formatSearchHeaders(context),
          },
        ],
        details: context,
      };
    },
  });
}

export function formatSearchHeaders(context: MemoryContext): string {
  const headers = context.results.map(({ memory, node }) =>
    [
      `- memory=${memory.id}`,
      `node=${node.id}:${node.canonicalName}`,
      `type=${memory.memoryType}`,
      `tier=L${memory.tier}`,
      `created=${memory.createdAt}`,
      `truth=${memory.truthStatus}`,
      `status=${memory.status}`,
      `residence=${memory.residence.toUpperCase()}`,
      `preview=${excerpt(node.summary, 120)}`,
    ].join("; "),
  );
  return [
    "NMG SEARCH HEADERS",
    context.activeGraph
      ? `active_graph=${context.activeGraph.id}; task=${context.activeGraph.taskId}; ` +
        `budget=${context.activeGraph.usage.evidence}/${context.activeGraph.budget.maxEvidence} evidence, ` +
        `${context.activeGraph.usage.estimatedTokens}/${context.activeGraph.budget.maxTokens} tokens`
      : "",
    ...headers,
    "Use nmg_get with selected memory IDs and activeGraphId to load exact statements, " +
      "source evidence, and record which recalled memories were actually used.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function formatRecallIndex(index: RecallIndex): string {
  const cues = index.cues.map((cue) =>
    [
      `- node=${cue.nodeId}:${cue.canonicalName}`,
      `types=${cue.memoryTypes.join(",") || "unknown"}`,
      `active=${cue.activeCount}`,
      `newest=${cue.newestAt ?? "unknown"}`,
      `deep=${cue.hasDeepMemory ? "yes" : "no"}`,
      `conflicts=${cue.hasConflicts ? "yes" : "no"}`,
      `match=${cue.reason}`,
    ].join("; "),
  );
  return cues.length > 0 ? `<nmg_recall_cues>\n${cues.join("\n")}\n</nmg_recall_cues>` : "";
}

export function formatResidentKernel(context: MemoryContext): string {
  const formatted = formatMemoryContext(context);
  return formatted ? `<nmg_resident_kernel>\n${formatted}\n</nmg_resident_kernel>` : "";
}

export function formatMemoryContext(context: MemoryContext): string {
  const memories = context.results.map(({ memory, node, evidence }) => {
    const metadata = [
      `TYPE=${memory.memoryType}`,
      `USAGE=${usageInstruction(memory.memoryType)}`,
      `node=${node.id}:${node.canonicalName}`,
      `memory=${memory.id}`,
      `residence=${memory.residence.toUpperCase()}`,
      `evidence=${memory.evidenceIds.join(",")}`,
      `actor=${memory.sourceActor}`,
      `truth=${memory.truthStatus}`,
      `status=${memory.status}`,
      `tier=L${memory.tier}`,
      memory.stateKey ? `stateKey=${memory.stateKey}` : "",
      memory.eventTime ? `eventTime=${memory.eventTime}` : "",
      memory.validFrom ? `validFrom=${memory.validFrom}` : "",
      `scope=${JSON.stringify(memory.scope)}`,
    ]
      .filter(Boolean)
      .join("; ");
    const source =
      evidence.content.trim() !== memory.statement.trim()
        ? `\n  SOURCE=${excerpt(evidence.content, 320)}`
        : "";
    return `- ${memory.statement}\n  ${metadata}${source}`;
  });
  const relations = context.relations.map(
    (relation) => `- ${relation.sourceNodeId} -[${relation.type}]-> ${relation.targetNodeId}`,
  );
  return [
    memories.length > 0 ? `MEMORIES\n${memories.join("\n")}` : "",
    relations.length > 0 ? `RELATIONS\n${relations.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function excerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function usageInstruction(type: MemoryType): string {
  switch (type) {
    case "constraint":
      return "obey within scope unless a newer active constraint overrides it";
    case "conversation_evidence":
      return "report what was said; do not present unverified content as world truth";
    case "derived":
      return "use as a multi-evidence conclusion and inspect sources when uncertain";
    case "event":
      return "use as a dated occurrence; preserve ordering and do not generalize";
    case "preference":
      return "generate the requested answer or recommendation tailored to this preference";
    case "state":
      return "treat this latest active value as authoritative for its stateKey and scope; older events are not competing current states";
    case "strategy":
      return "apply the reusable procedure when its situation matches";
    case "fact":
      return "use as a claim weighted by truth status and evidence";
  }
}

function serializeSession(entries: readonly unknown[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; message?: unknown };
    if (candidate.type !== "message") continue;
    const text = messageText(candidate.message);
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

function persistSessionMessages(
  memoryStore: NmgStore,
  sessionId: string,
  entries: readonly unknown[],
  sourceRef?: string,
): void {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { id?: unknown; type?: unknown; message?: unknown };
    if (candidate.type !== "message" || typeof candidate.id !== "string") continue;
    const content = rawMessageContent(candidate.message);
    const role = historyRole(candidate.message);
    if (!content || !role) continue;
    memoryStore.appendHistory({
      content,
      role,
      sessionId,
      sourceMessageId: candidate.id,
      sourceRef,
    });
  }
}

function historyRole(value: unknown): "user" | "assistant" | "tool" | "system" | null {
  if (!value || typeof value !== "object") return null;
  const role = (value as { role?: unknown }).role;
  if (role === "user" || role === "assistant" || role === "system") return role;
  if (role === "tool" || role === "toolResult") return "tool";
  return null;
}

function rawMessageContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const content = (value as { content?: unknown }).content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") return [];
      const item = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
      if (item.type === "text" && typeof item.text === "string") return [item.text];
      if (item.type === "toolCall" && typeof item.name === "string") {
        return [`[tool ${item.name} ${JSON.stringify(item.arguments ?? {})}]`];
      }
      return [];
    })
    .join(" ")
    .trim();
}

function messageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const message = value as { role?: unknown; content?: unknown };
  const role = typeof message.role === "string" ? message.role.toUpperCase() : "MESSAGE";
  const content = rawMessageContent(message);
  return content ? `${role}: ${content}` : "";
}
