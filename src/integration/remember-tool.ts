import type { NmgMethodResult, NmgRememberParams } from "../cli/protocol.ts";
import type { MemoryMarker } from "../core/types.ts";
import { loadPrompts } from "../prompts/load.ts";
import type {
  AdapterRememberBinding,
  AdapterToolSession,
  RememberFeedbackLabels,
} from "./adapter-tool-session.ts";
import { renderRememberSurface } from "./agent-surface.ts";
import { supportedRememberActions } from "./tool-contract.ts";

const prompts = loadPrompts();
const string = (description?: string) => ({ type: "string", description });
const enumString = (values: readonly string[], description?: string) => ({
  ...string(description),
  enum: [...values],
});
const unitInterval = { type: "number", minimum: 0, maximum: 1 };

const booleanLabel = { type: "boolean", description: prompts.feedback_label_parameter_description };
const SAVE_FIELDS = {
  statement: string("Self-contained semantic statement."),
  nodeName: string(prompts.node_name_parameter_description),
  memoryType: enumString(["fact", "state", "event", "preference", "constraint", "strategy"]),
  sourceActor: enumString(
    ["assistant", "system", "tool", "user"],
    prompts.source_actor_parameter_description,
  ),
  truthStatus: enumString(["asserted", "inferred", "unverified", "verified"]),
  stateKey: string(prompts.state_key_parameter_description),
  resolution: enumString(["open", "resolved", "reopened"]),
  openedAt: string(),
  relatedMemoryIds: { type: "array", items: string() },
  eventTime: string(),
  referenceTime: string(
    "Source ISO timestamp with Z/offset anchoring eventTime, for historical replay.",
  ),
  timeZone: string("Source IANA time zone; defaults to referenceTime's offset."),
  evidence: string(prompts.evidence_parameter_description),
  evidenceRole: enumString(["contradict", "example", "exception", "origin", "support", "update"]),
  tier: { type: "integer", minimum: 0, maximum: 3 },
  importance: unitInterval,
  scope: {
    type: "object",
    additionalProperties: { type: "string" },
    description:
      'Use {"profile":"user"} for a confirmed durable personal preference or constraint.',
  },
  residence: enumString(["ltg", "stg"]),
  expiresAt: string(),
  writeReason: string(),
  recallTriggers: {
    type: "array",
    items: { type: "string", minLength: 1, maxLength: 80 },
    maxItems: 16,
    description: prompts.recall_triggers_parameter_description,
  },
  tesserae: {
    type: "array",
    maxItems: 10,
    items: {
      type: "object",
      properties: { path: string(), snippet: string(), label: string(), kind: string() },
      required: ["path", "snippet"],
      additionalProperties: false,
    },
    description:
      "File bookmarks. Use the project-relative path and an exact excerpt for relocation.",
  },
};

const FIELDS = {
  ...SAVE_FIELDS,
  unsafe: {
    type: "boolean",
    description:
      "Explicitly bypass transient-write policy for genuine durable information. Secrets remain blocked.",
  },
  externalSource: {
    type: "object",
    properties: {
      source: string(prompts.external_source_parameter_description),
      retrievedAt: string(),
      hash: string(),
    },
    required: ["source"],
    additionalProperties: false,
  },
  boardSource: {
    type: "object",
    properties: { taskId: string(), entryId: string() },
    required: ["taskId", "entryId"],
    additionalProperties: false,
    description: prompts.remember_board_source_parameter_description,
  },
  memoryId: string(prompts.remember_memory_id_parameter_description),
  newMemoryId: string(prompts.remember_new_memory_id_parameter_description),
  supersededMemoryId: string(prompts.remember_superseded_memory_id_parameter_description),
  relatedMemoryId: string(prompts.remember_related_memory_id_parameter_description),
  relationJudgement: enumString(
    ["conflict", "distinct", "refines", "related", "same_entity"],
    prompts.remember_relation_judgement_parameter_description,
  ),
  relationConfidence: unitInterval,
  resolutionReason: string(),
  activeGraphId: string(prompts.active_graph_id_parameter_description),
  taskSuccess: booleanLabel,
  userCorrection: booleanLabel,
  evidenceSufficient: booleanLabel,
  expansionUseful: booleanLabel,
  excessiveNoise: booleanLabel,
  noMemoryNeeded: booleanLabel,
  memoryMisleading: {
    type: "boolean",
    description: prompts.feedback_misleading_parameter_description,
  },
  feedbackNote: string(prompts.feedback_note_parameter_description),
  semanticTaskId: string(prompts.semantic_task_id_parameter_description),
  claimOutcome: enumString(
    ["supported", "contradicted"],
    prompts.claim_outcome_parameter_description,
  ),
  claimOutcomeSource: enumString(
    ["user", "tool", "task"],
    prompts.claim_outcome_source_parameter_description,
  ),
  claimSourceLineage: string(prompts.claim_source_lineage_parameter_description),
  claimIndexes: {
    type: "array",
    items: { type: "integer", minimum: 0 },
    description: prompts.claim_indexes_parameter_description,
  },
  claimWeight: { type: "number", exclusiveMinimum: 0, maximum: 1 },
};

export interface RememberToolOptions {
  allowUnsafe?: boolean;
  claimOutcome?: "native-evidence" | "task" | "disabled";
}

type RememberAction = ReturnType<typeof supportedRememberActions>[number];
type RememberInput = Partial<NmgRememberParams> &
  Omit<RememberFeedbackLabels, "note"> & {
    action?: RememberAction;
    externalSource?: { source: string; retrievedAt?: string; hash?: string };
    boardSource?: { taskId: string; entryId: string };
    memoryId?: string;
    newMemoryId?: string;
    supersededMemoryId?: string;
    relatedMemoryId?: string;
    relationJudgement?: string;
    relationConfidence?: number;
    resolutionReason?: string;
    activeGraphId?: string;
    feedbackNote?: string;
    claimOutcome?: "supported" | "contradicted";
    claimOutcomeSource?: "user" | "tool" | "task";
    claimSourceLineage?: string;
    claimIndexes?: number[];
    claimWeight?: number;
  };

export function createRememberTool(methods?: readonly string[], options: RememberToolOptions = {}) {
  const claimMode = options.claimOutcome ?? "task";
  const actions = supportedRememberActions(methods).filter(
    (action) => action !== "claim_outcome" || claimMode !== "disabled",
  );
  const properties = {
    action: enumString(actions, prompts.remember_action_parameter_description),
    ...Object.fromEntries(
      Object.entries(FIELDS).filter(([key]) => isRememberFieldSupported(key, actions, options)),
    ),
  };
  return {
    name: "nmg_remember" as const,
    requiresNativeSession: false,
    label: "Remember in NMG",
    description: prompts.remember_description,
    inputSchema: {
      type: "object" as const,
      properties,
      additionalProperties: false,
    },
    execute(args: Record<string, unknown>, session: AdapterToolSession) {
      const input = Object.fromEntries(
        Object.entries(args).filter(
          ([key, value]) => Object.hasOwn(properties, key) && value != null,
        ),
      ) as RememberInput;
      const action = input.action ?? "save";
      if (!actions.includes(action)) throw new Error(`Unsupported remember action: ${action}`);
      return runRemember(action, input, session, claimMode);
    },
  };
}

export type SharedRememberTool = ReturnType<typeof createRememberTool>;

function isRememberFieldSupported(
  key: string,
  actions: RememberAction[],
  options: RememberToolOptions,
) {
  if (key === "unsafe") return options.allowUnsafe === true;
  if (key === "claimOutcomeSource")
    return options.claimOutcome === "native-evidence" && actions.includes("claim_outcome");
  if (key.startsWith("claim")) return actions.includes("claim_outcome");
  return true;
}

function runRemember(
  action: RememberAction,
  input: RememberInput,
  session: AdapterToolSession,
  claimMode: NonNullable<RememberToolOptions["claimOutcome"]>,
) {
  switch (action) {
    case "save":
      return saveMemory(input, session);
    case "feedback":
      return recordFeedback(input, session);
    case "claim_outcome":
      return recordClaimOutcome(input, session, claimMode);
    default:
      return resolveMemory(action, input, session);
  }
}

function writeContext(session: AdapterToolSession) {
  return { sessionId: session.sessionId, projectDir: session.memory?.projectDir };
}

function evidenceForSave(input: RememberInput, session: AdapterToolSession) {
  const { externalSource } = input;
  const provenance = session.memory?.remember?.provenance;
  const sourceActor = input.sourceActor ?? (provenance ? "assistant" : undefined);
  const evidence = sourceActor && provenance?.lookup(input.evidence, sourceActor);
  const witness = evidence?.source;
  const markers = sourceMarkers(input);
  if (provenance?.requireWitness && sourceActor !== "assistant" && !witness && !externalSource)
    throw new Error(
      `sourceActor=${sourceActor} requires an exact matching evidence excerpt from the current ${provenance.provider} session or an explicit externalSource`,
    );
  const degradation = degradedSourceMarker(input, provenance, evidence);
  if (degradation) markers.push(degradation);
  return { sourceActor, evidenceSource: witness, markers };
}

type EvidenceBinding = NonNullable<AdapterRememberBinding["provenance"]>;

function degradedSourceMarker(
  input: RememberInput,
  provenance: EvidenceBinding | undefined,
  evidence: ReturnType<EvidenceBinding["lookup"]>,
): MemoryMarker | undefined {
  if (
    !input.evidence?.trim() ||
    !provenance ||
    !evidence ||
    evidence.source ||
    input.externalSource
  )
    return undefined;
  return {
    kind: "provenance_degraded",
    attributes: {
      provider: provenance.provider,
      historyReferenceVersion: evidence.version,
      reason: evidence.reason ?? "unbound_source",
    },
  };
}

function sourceMarkers({ externalSource, boardSource }: RememberInput) {
  const markers: MemoryMarker[] = [];
  if (externalSource && !/^(?:file|web):.+/u.test(externalSource.source))
    throw new Error("externalSource.source must start with web: or file:");
  if (externalSource)
    markers.push({
      kind: "external_source",
      attributes: {
        source: externalSource.source,
        retrievedAt: externalSource.retrievedAt ?? new Date().toISOString(),
        ...(externalSource.hash ? { hash: externalSource.hash } : {}),
      },
    });
  if (boardSource)
    markers.push({
      kind: "board_origin",
      attributes: { taskId: boardSource.taskId, entryId: boardSource.entryId },
    });
  return markers;
}

async function saveMemory(input: RememberInput, session: AdapterToolSession) {
  const { statement, nodeName } = input;
  if (!statement?.trim() || !nodeName?.trim())
    throw new Error("action=save requires statement and nodeName");
  const { sourceActor, evidenceSource, markers } = evidenceForSave(input, session);
  const data: NmgRememberParams = {
    ...Object.fromEntries(Object.entries(input).filter(([key]) => Object.hasOwn(SAVE_FIELDS, key))),
    ...writeContext(session),
    statement,
    nodeName,
    sourceActor,
    writeSource: "agent",
    unsafe: input.unsafe,
    evidenceSource,
    markers: markers.length ? markers : undefined,
  };
  const result = (await session.invoke(
    "remember",
    { ...data },
    saveCli(data, input),
  )) as NmgMethodResult["remember"];
  return { details: result, text: renderRememberSurface(result) };
}

function saveCli(params: NmgRememberParams, input: RememberInput): string[] | undefined {
  if (
    params.unsafe ||
    params.evidenceSource ||
    input.boardSource ||
    params.markers?.some((marker) => marker.kind === "provenance_degraded")
  )
    return undefined;
  const argv = [
    "remember",
    params.statement,
    "--node",
    params.nodeName,
    "--write-source",
    "agent",
    "--json",
  ];
  appendSaveOptions(argv, params, input.externalSource);
  for (const bookmark of params.tesserae ?? []) {
    const parts = [bookmark.path, bookmark.snippet, bookmark.label].filter(
      (value): value is string => value !== undefined,
    );
    if (bookmark.kind || parts.some((part) => part.includes("::"))) return undefined;
    argv.push("--tessera", parts.join("::"));
  }
  return argv;
}

function appendSaveOptions(
  argv: string[],
  params: NmgRememberParams,
  externalSource: RememberInput["externalSource"],
) {
  for (const [value, flag] of [
    [params.projectDir, "--project-dir"],
    [params.sessionId, "--session-id"],
    [params.memoryType, "--type"],
    [params.stateKey, "--state-key"],
    [params.resolution, "--resolution"],
    [params.openedAt, "--opened-at"],
    [params.sourceActor, "--actor"],
    [params.truthStatus, "--truth"],
    [params.evidence, "--evidence"],
    [params.eventTime, "--event-time"],
    [params.referenceTime, "--reference-time"],
    [params.timeZone, "--time-zone"],
    [params.tier, "--tier"],
    [params.importance, "--importance"],
    [params.residence, "--residence"],
    [params.evidenceRole, "--evidence-role"],
    [params.expiresAt, "--expires-at"],
    [params.writeReason, "--write-reason"],
    [externalSource?.source, "--external-source"],
    [externalSource?.retrievedAt, "--retrieved-at"],
    [externalSource?.hash, "--content-hash"],
  ] as const) {
    if (value !== undefined) argv.push(flag, String(value));
  }
  for (const trigger of params.recallTriggers ?? []) argv.push("--recall-trigger", trigger);
  for (const id of params.relatedMemoryIds ?? []) argv.push("--related-memory", id);
  for (const [key, value] of Object.entries(params.scope ?? {}))
    argv.push("--scope", `${key}=${value}`);
}

const RESOLUTION_OPERATIONS = {
  forget: {
    required: ["memoryId"],
    text: "Memory withdrawn from normal retrieval. The tombstone remains for audit.",
  },
  resolve: {
    required: ["memoryId"],
    text: "Open memory marked resolved; it is now eligible for ordinary retention policy.",
  },
  reopen: {
    required: ["memoryId"],
    text: "Memory reopened and restored to indexed storage with its related evidence anchors.",
  },
  supersede: {
    required: ["newMemoryId", "supersededMemoryId"],
    text: "Older memory superseded by the new value.",
  },
  relate: {
    required: ["newMemoryId", "relatedMemoryId", "relationJudgement"],
    text: "Semantic relation recorded as a reversible pending proposal; node identities remain separate.",
  },
} as const;

async function resolveMemory(
  action: keyof typeof RESOLUTION_OPERATIONS,
  input: RememberInput,
  session: AdapterToolSession,
) {
  const op = RESOLUTION_OPERATIONS[action];
  if (op.required.some((key) => !input[key]))
    throw new Error(`action=${action} requires ${op.required.join(" and ")}`);
  const result = (await session.invoke("resolveRemember", {
    ...writeContext(session),
    action,
    ...Object.fromEntries(op.required.map((key) => [key, input[key]])),
    ...(["resolve", "reopen"].includes(action) ? { relatedMemoryIds: input.relatedMemoryIds } : {}),
    ...(["resolve", "reopen", "supersede"].includes(action)
      ? { reason: input.resolutionReason }
      : {}),
    ...(action === "relate" ? { confidence: input.relationConfidence } : {}),
  })) as NmgMethodResult["resolveRemember"];
  return { details: result, text: resolutionText(result, op.text) };
}

function resolutionText(result: NmgMethodResult["resolveRemember"], success: string) {
  if (result.action === "forget" && !result.deleted)
    return "Memory is already withdrawn or unavailable.";
  if (result.action === "supersede" && !result.applied) return "Supersession was not applied.";
  return success;
}

async function recordFeedback(input: RememberInput, session: AdapterToolSession) {
  const binding = session.memory?.remember;
  const labels: RememberFeedbackLabels = {
    taskSuccess: input.taskSuccess,
    userCorrection: input.userCorrection,
    evidenceSufficient: input.evidenceSufficient,
    expansionUseful: input.expansionUseful,
    excessiveNoise: input.excessiveNoise,
    noMemoryNeeded: input.noMemoryNeeded,
    memoryMisleading: input.memoryMisleading,
    note: input.feedbackNote,
  };
  if (Object.values(labels).every((value) => value === undefined))
    throw new Error("action=feedback requires at least one label or feedbackNote");
  const graph = input.activeGraphId?.trim() || undefined;
  if (!graph && !binding?.latestFeedback)
    throw new Error("action=feedback requires activeGraphId from the rated recall");
  const shadow = await binding
    ?.observeFeedback?.(graph, { ...labels, semanticTaskId: input.semanticTaskId })
    .catch(() => undefined);
  const result = (await session.invoke("recordFeedback", {
    sessionId: session.sessionId,
    activeGraphId: graph,
    ...labels,
    semanticTaskId: input.semanticTaskId,
  })) as NmgMethodResult["recordFeedback"];
  binding?.onFeedback?.(result);
  return formatFeedback(result, graph, shadow);
}

function formatFeedback(
  result: NmgMethodResult["recordFeedback"],
  graph: string | undefined,
  shadow: { recorded: boolean; activeGraphId?: string | null } | undefined,
) {
  const status = result.trained
    ? `Retrieval feedback applied. Online router updated (reward=${result.reward}, loss=${result.loss?.toFixed(4)}).`
    : "Retrieval feedback processed. No staged decision or usable label was found.";
  return {
    details: {
      ...result,
      recorded: shadow?.recorded ?? false,
      activeGraphId: graph ?? shadow?.activeGraphId ?? result.activeGraphId,
    },
    text: shadow?.recorded === false ? `${status} Shadow log not recorded.` : status,
  };
}

async function recordClaimOutcome(
  input: RememberInput,
  session: AdapterToolSession,
  mode: NonNullable<RememberToolOptions["claimOutcome"]>,
) {
  const { claimOutcome, memoryId, semanticTaskId } = input;
  if (!memoryId || !claimOutcome || !semanticTaskId)
    throw new Error("action=claim_outcome requires memoryId, claimOutcome, and semanticTaskId");
  const vote = claimVote(input, session, mode);
  const binding = session.memory?.remember;
  const activeGraphId = input.activeGraphId ?? binding?.claimGraph?.(memoryId) ?? undefined;
  const result = (await session.invoke("recordClaimOutcomes", {
    ...writeContext(session),
    semanticTaskId,
    activeGraphId,
    collectionOrigin: binding?.claimOrigin ?? "natural",
    votes: [{ memoryId, outcome: claimOutcome, ...vote }],
  })) as NmgMethodResult["recordClaimOutcomes"];
  if (vote.evidenceSource && result.events.length > 0)
    await binding?.onVerifiedClaim?.(activeGraphId, memoryId, claimOutcome);
  return { details: result, text: "Explicit attributable claim outcome recorded." };
}

function claimVote(
  input: RememberInput,
  session: AdapterToolSession,
  mode: NonNullable<RememberToolOptions["claimOutcome"]>,
) {
  const source = mode === "native-evidence" ? input.claimOutcomeSource : "task";
  if (!source) throw new Error("action=claim_outcome requires claimOutcomeSource");
  if (input.claimIndexes?.some((index) => !Number.isInteger(index) || index < 0))
    throw new Error("claimIndexes must contain only non-negative integers");
  const witness = claimWitness(source, input.evidence, session);
  const sourceLineage = witness?.sourceMessageId ?? input.claimSourceLineage?.trim();
  if (!sourceLineage) throw new Error("claimOutcomeSource=task requires claimSourceLineage");
  return {
    source,
    sourceLineage,
    claimIndexes: input.claimIndexes,
    weight: input.claimWeight,
    evidenceSource: witness ? { ...witness, sessionId: session.sessionId } : undefined,
  };
}

function claimWitness(
  source: NonNullable<RememberInput["claimOutcomeSource"]>,
  evidence: string | undefined,
  session: AdapterToolSession,
) {
  if (source === "task") return undefined;
  const witness = session.memory?.remember?.provenance?.lookup(evidence, source)?.source;
  if (!witness)
    throw new Error(
      `claimOutcomeSource=${source} requires an exact matching evidence excerpt from the current session`,
    );
  return witness;
}
