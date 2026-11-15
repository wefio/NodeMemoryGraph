import { randomUUID } from "node:crypto";
import type {
  MemoryBackend,
  MemoryCommitReceipt,
  MemoryEntity,
  MemoryReadView,
} from "./backend.ts";
import { MemoryOperationConflict } from "./backend.ts";
import {
  memoryIdentity,
  requestHash,
  searchableMemory,
  validateMemoryInput,
  visibleMemory,
} from "./model.ts";
import type { MemoryInput } from "./model.ts";
import { MemoryPlan } from "./plan.ts";
import { MemoryWriteRejected } from "../write-policy.ts";
import { TESSERA_REF_MARKER } from "../types.ts";
import type {
  MemoryContext,
  EdgePathStep,
  MemoryActor,
  MemoryRecord,
  MemoryScope,
  MemorySearchResult,
  MemoryWriteEvent,
  NodeRelation,
  RememberResult,
  TesseraHit,
} from "../types.ts";

export interface MemoryQueryOptions {
  scope?: MemoryScope;
  sessionId?: string;
  limit?: number;
  maxTier?: 0 | 1 | 2 | 3;
  graphHops?: number;
  includeHistorical?: boolean;
  sourceActor?: MemoryActor;
  nodeName?: string;
}

interface PlannedResult<T> {
  result: T;
  ids: string[];
}

/** Memory semantics and graph organization depend only on the asynchronous domain port. */
export class MemoryEngine {
  readonly backend: MemoryBackend;
  private readonly now: () => string;

  constructor(backend: MemoryBackend, now = () => new Date().toISOString()) {
    this.backend = backend;
    this.now = now;
  }

  async remember(input: MemoryInput, operationId: string = randomUUID()): Promise<RememberResult> {
    return (await this.rememberMany([input], operationId))[0]!;
  }

  async rememberMany(
    inputs: readonly MemoryInput[],
    operationId: string = randomUUID(),
  ): Promise<RememberResult[]> {
    if (!inputs.length || inputs.length > 128)
      throw new Error("A memory batch needs 1..128 inputs");
    const timestamp = this.now();
    await this.validateWrites(inputs, operationId, timestamp);
    return this.mutate(
      operationId,
      { action: "remember", inputs },
      async (plan) => {
        const result: RememberResult[] = [];
        for (const [slot, input] of inputs.entries())
          result.push(await plan.remember(input, operationId, slot, timestamp));
        return { result, ids: result.map((item) => item.memory.id) };
      },
      async (view, receipt) => {
        const result = receipt.result as RememberResult[];
        await this.requireAvailable(view, result);
        return result;
      },
    );
  }

  private async validateWrites(inputs: readonly MemoryInput[], operationId: string, now: string) {
    for (const [slot, input] of inputs.entries()) {
      try {
        validateMemoryInput(input);
      } catch (error) {
        if (error instanceof MemoryWriteRejected)
          await this.recordRejection(input, operationId, slot, error.reason, now);
        throw error;
      }
    }
  }

  private async recordRejection(
    input: MemoryInput,
    operationId: string,
    slot: number,
    policyReason: string,
    now: string,
  ) {
    const id = memoryIdentity("rejected-memory-write", operationId, String(slot), policyReason);
    const metadata: Omit<MemoryWriteEvent, "createdAt"> = {
      id,
      memoryId: null,
      historyId: null,
      sessionId: input.sessionId ?? null,
      decision: "rejected",
      policyReason,
      writeReason: `cli_rejected_${input.memoryType ?? "fact"}`,
      writeSource: input.writeSource ?? "agent",
      memoryType: input.memoryType ?? "fact",
      requestedResidence: input.residence ?? "ltg",
    };
    await this.mutate(
      `audit:${id}`,
      metadata,
      async (plan) => {
        plan.audit.push({ ...metadata, createdAt: now });
        return { result: null, ids: [] };
      },
      async () => null,
    );
  }

  async get(ids: readonly string[], options: MemoryQueryOptions = {}): Promise<MemoryContext> {
    const graphHops = boundedGraphHops(options.graphHops);
    const view = await this.backend.openRead();
    try {
      const entities = await this.backend.scan(view, {
        kind: "memory",
        ids,
        sessionId: options.sessionId,
        scope: options.scope,
        limit: 512,
      });
      const results = await this.project(view, entities, options);
      const order = new Map(ids.map((id, index) => [id, index]));
      results.sort((left, right) => order.get(left.memory.id)! - order.get(right.memory.id)!);
      const relations = await this.expand(view, results, {
        ...options,
        graphHops,
        limit: Math.max(results.length, options.limit ?? 50),
      });
      const tesserae = await this.attachedTesserae(view, results);
      return { results, relations, ...(tesserae.length ? { tesserae } : {}) };
    } finally {
      await this.backend.closeRead(view);
    }
  }

  async search(text: string, options: MemoryQueryOptions = {}): Promise<MemoryContext> {
    if (!text.trim()) throw new Error("Search query is required");
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new Error("Search limit must be 1..100");
    boundedGraphHops(options.graphHops);
    const view = await this.backend.openRead();
    try {
      const entities = await this.backend.scan(view, {
        kind: "memory",
        text,
        scope: options.scope,
        sessionId: options.sessionId,
        limit: 512,
      });
      const results = (await this.project(view, entities, options)).slice(0, limit);
      const relations = await this.expand(view, results, { ...options, limit });
      const tesserae = await this.attachedTesserae(view, results);
      return {
        results,
        relations,
        retrieval: { mode: "lexical", degraded: false },
        ...(tesserae.length ? { tesserae } : {}),
      };
    } finally {
      await this.backend.closeRead(view);
    }
  }

  async linkNodes(
    input: {
      sourceNodeId: string;
      targetNodeId: string;
      type: NodeRelation["type"];
      evidenceIds?: string[];
    },
    operationId: string = randomUUID(),
  ): Promise<NodeRelation> {
    if (input.sourceNodeId === input.targetNodeId)
      throw new Error("Self relations are not supported");
    const timestamp = this.now();
    return this.mutate(
      operationId,
      { action: "link", input },
      async (plan) => {
        const nodes = await plan.find({
          kind: "node",
          ids: [input.sourceNodeId, input.targetNodeId],
        });
        if (
          nodes.length !== 2 ||
          nodes.some(
            (entity) =>
              entity.kind !== "node" ||
              entity.value.status !== "active" ||
              entity.value.residence !== "ltg",
          )
        )
          throw new Error("Relations require active LTG nodes");
        const evidenceIds = input.evidenceIds ?? [];
        const evidence = await plan.find({ kind: "history", ids: evidenceIds });
        if (
          evidence.length !== new Set(evidenceIds).size ||
          evidence.some((entity) => entity.kind !== "history" || entity.value.sessionId !== null)
        )
          throw new Error("Relation evidence must exist and be shared");
        const result: NodeRelation = {
          ...input,
          evidenceIds,
          id: memoryIdentity(
            this.backend.namespace,
            "edge",
            input.sourceNodeId,
            input.targetNodeId,
            input.type,
          ),
          residence: "ltg",
          status: "consolidated",
          stability: 1,
          strength: 1,
          direction: "both",
          fanBudget: true,
          activationRule: "conductive",
          consolidationSource: "explicit",
          consolidatedAt: timestamp,
          createdAt: timestamp,
        };
        plan.put({ kind: "edge", value: result });
        return { result, ids: [result.id] };
      },
      async (_view, receipt) => receipt.result as NodeRelation,
    );
  }

  async withdraw(
    memoryId: string,
    operationId: string = randomUUID(),
    sessionId?: string,
  ): Promise<{ memoryId: string; memory: MemoryRecord }> {
    return this.mutate(
      operationId,
      { action: "withdraw", memoryId, sessionId },
      async (plan) => {
        const found = await plan.find({ kind: "memory", ids: [memoryId], sessionId });
        if (found[0]?.kind !== "memory") throw new Error("Memory does not exist in this session");
        plan.put({ kind: "memory", value: { ...found[0].value, status: "deleted" } });
        return {
          result: { memoryId, memory: { ...found[0].value, status: "deleted" as const } },
          ids: [memoryId],
        };
      },
      async (_view, receipt) => receipt.result as { memoryId: string; memory: MemoryRecord },
    );
  }

  private async mutate<T>(
    operationId: string,
    request: unknown,
    prepare: (plan: MemoryPlan) => Promise<PlannedResult<T>>,
    replay: (view: MemoryReadView, receipt: MemoryCommitReceipt) => Promise<T>,
  ): Promise<T> {
    const hash = requestHash(request);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const view = await this.backend.openRead();
      try {
        const previous = await this.backend.receipt(view, operationId);
        if (previous) {
          if (previous.requestHash !== hash) throw new MemoryOperationConflict(operationId);
          return await replay(view, previous);
        }
        const plan = new MemoryPlan(this.backend, view);
        const prepared = await prepare(plan);
        const outcome = await this.backend.commit({
          operationId,
          requestHash: hash,
          expectedRevision: view.revision,
          changes: { upsert: [...plan.changes.values()] },
          audit: plan.audit,
          resultIds: prepared.ids,
          result: prepared.result,
        });
        if (outcome.status === "committed") return prepared.result;
        if (outcome.status === "replayed") {
          const current = await this.backend.openRead();
          try {
            return await replay(current, outcome.receipt);
          } finally {
            await this.backend.closeRead(current);
          }
        }
      } finally {
        await this.backend.closeRead(view);
      }
    }
    throw new Error("Memory write conflicted repeatedly; retry the same operation ID");
  }

  private async project(
    view: MemoryReadView,
    entities: MemoryEntity[],
    options: MemoryQueryOptions,
  ): Promise<MemorySearchResult[]> {
    const now = this.now();
    const memories = entities.flatMap((entity) =>
      entity.kind === "memory" &&
      searchableMemory(entity.value, options, now) &&
      entity.value.tier <= (options.maxTier ?? 3)
        ? [entity.value]
        : [],
    );
    if (!memories.length) return [];
    const nodes = await this.backend.scan(view, {
      kind: "node",
      ids: [...new Set(memories.map((memory) => memory.nodeId))],
      limit: 512,
    });
    const evidenceIds = [...new Set(memories.flatMap((memory) => memory.evidenceIds))];
    const histories = await this.histories(view, evidenceIds);
    return memories.flatMap((memory, index) => {
      const node = nodes.find(
        (entity) => entity.kind === "node" && entity.value.id === memory.nodeId,
      );
      const evidenceRecords = histories.filter((entity) => memory.evidenceIds.includes(entity.id));
      const evidence = evidenceRecords.find((item) => item.id === memory.evidenceId);
      if (node?.kind !== "node" || !evidence) throw new Error("Broken memory references");
      if (options.nodeName && node.value.canonicalName !== options.nodeName) return [];
      return [
        {
          memory,
          node: node.value,
          evidence,
          evidenceRecords,
          lexicalScore: 1 / (index + 1),
          vectorScore: 0,
          routeScore: 0,
          combinedScore: 1 / (index + 1),
          recallReason: "lexical_match",
        },
      ];
    });
  }

  private async histories(view: MemoryReadView, ids: string[]) {
    const result = [];
    for (let offset = 0; offset < ids.length; offset += 512) {
      const entities = await this.backend.scan(view, {
        kind: "history",
        ids: ids.slice(offset, offset + 512),
        limit: 512,
      });
      for (const entity of entities) if (entity.kind === "history") result.push(entity.value);
    }
    return result;
  }

  private async attachedTesserae(
    view: MemoryReadView,
    results: MemorySearchResult[],
  ): Promise<TesseraHit[]> {
    const references = new Map<string, Set<string>>();
    for (const { memory } of results) {
      for (const marker of memory.markers) {
        const id = marker.attributes?.tesseraId;
        if (marker.kind !== TESSERA_REF_MARKER || typeof id !== "string") continue;
        const owners = references.get(id) ?? new Set<string>();
        owners.add(memory.id);
        references.set(id, owners);
      }
    }
    const ids = [...references.keys()];
    const hits: TesseraHit[] = [];
    for (let offset = 0; offset < ids.length; offset += 512) {
      const entities = await this.backend.scan(view, {
        kind: "tessera",
        ids: ids.slice(offset, offset + 512),
        limit: 512,
      });
      for (const entity of entities) {
        if (
          entity.kind !== "tessera" ||
          !references.get(entity.value.id)?.has(entity.value.memoryId ?? "")
        )
          continue;
        const { id, path, snippet, label, kind, memoryId, fileSimhash } = entity.value;
        hits.push({ id, path, snippet, label, kind, memoryId, fileSimhash });
      }
    }
    return hits;
  }

  private async expand(
    view: MemoryReadView,
    results: MemorySearchResult[],
    options: MemoryQueryOptions,
  ): Promise<NodeRelation[]> {
    let frontier = [...new Set(results.map((item) => item.node.id))];
    const visited = new Set(frontier);
    const paths = new Map<string, EdgePathStep[]>(frontier.map((id) => [id, []]));
    const relations = new Map<string, NodeRelation>();
    for (
      let depth = 0;
      depth < (options.graphHops ?? 0) && results.length < options.limit!;
      depth += 1
    ) {
      const next: string[] = [];
      for (const nodeId of frontier) {
        const edges = await this.backend.scan(view, {
          kind: "edge",
          connectedTo: nodeId,
          limit: 128,
        });
        for (const entity of edges) {
          if (
            entity.kind !== "edge" ||
            entity.value.status !== "consolidated" ||
            relations.size >= 128
          )
            continue;
          const edge = entity.value;
          if (edge.direction === "source->target" && edge.sourceNodeId !== nodeId) continue;
          relations.set(edge.id, edge);
          const adjacent = edge.sourceNodeId === nodeId ? edge.targetNodeId : edge.sourceNodeId;
          if (visited.has(adjacent)) continue;
          visited.add(adjacent);
          next.push(adjacent);
          const path = [
            ...paths.get(nodeId)!,
            {
              relationId: edge.id,
              sourceNodeId: nodeId,
              targetNodeId: adjacent,
              relationType: edge.type,
              hop: depth + 1,
            },
          ];
          paths.set(adjacent, path);
          const found = await this.backend.scan(view, {
            kind: "memory",
            nodeId: adjacent,
            scope: options.scope,
            sessionId: options.sessionId,
            limit: 100,
          });
          const projected = await this.project(view, found, options);
          for (const item of projected)
            if (results.length < options.limit!) results.push({ ...item, path });
        }
      }
      frontier = next;
    }
    return [...relations.values()];
  }

  private async requireAvailable(view: MemoryReadView, results: RememberResult[]): Promise<void> {
    // Receipts acknowledge prior writes, but must not disclose subsequently withdrawn evidence.
    for (const result of results) {
      const sessionId = result.memory.sessionId ?? undefined;
      const found = await this.backend.scan(view, {
        kind: "memory",
        ids: [result.memory.id],
        sessionId,
        limit: 1,
      });
      if (found[0]?.kind !== "memory" || !visibleMemory(found[0].value, sessionId, this.now()))
        throw new Error("The recorded operation result is unavailable");
    }
  }
}

function boundedGraphHops(hops = 0): number {
  if (!Number.isInteger(hops) || hops < 0 || hops > 3) throw new Error("Graph hops must be 0..3");
  return hops;
}
