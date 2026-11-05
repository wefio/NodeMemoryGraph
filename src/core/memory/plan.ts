import type { HistoryRecord, MemoryRecord, RememberResult } from "../types.ts";
import { serializeScope } from "../scope.ts";
import { normalizeStatement } from "../store/search-ranking.ts";
import type { MemoryBackend, MemoryEntity, MemoryEntityQuery, MemoryReadView } from "./backend.ts";
import { memoryIdentity, newHistory, newMemory, newNode, visibleMemory } from "./model.ts";
import type { MemoryInput } from "./model.ts";

/** One planning view plus uncommitted entities; ordered batch inputs observe prior inputs. */
export class MemoryPlan {
  readonly changes = new Map<string, MemoryEntity>();
  readonly backend: MemoryBackend;
  readonly view: MemoryReadView;

  constructor(backend: MemoryBackend, view: MemoryReadView) {
    this.backend = backend;
    this.view = view;
  }

  put(entity: MemoryEntity): void {
    this.changes.set(`${entity.kind}:${entity.value.id}`, entity);
  }

  async find(query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    const base: MemoryEntity[] = [];
    for (let offset = 0; ; offset += 512) {
      const page = await this.backend.scan(this.view, { ...query, limit: 512, offset });
      base.push(...page);
      if (page.length < 512) break;
    }
    const merged = new Map(base.map((entity) => [`${entity.kind}:${entity.value.id}`, entity]));
    for (const [key, entity] of this.changes) {
      merged.delete(key);
      if (matches(entity, query)) merged.set(key, entity);
    }
    return [...merged.values()];
  }

  async remember(
    input: MemoryInput,
    operationId: string,
    slot: number,
    now: string,
  ): Promise<RememberResult> {
    const sessionId = input.residence === "stg" ? (input.sessionId ?? undefined) : undefined;
    const duplicates = await this.find({
      kind: "memory",
      exactText: input.statement,
      scope: input.scope ?? {},
      sessionId,
    });
    const duplicate = duplicates.find(
      (entity) =>
        entity.kind === "memory" &&
        visibleMemory(entity.value, sessionId, now) &&
        entity.value.memoryType === (input.memoryType ?? "fact") &&
        entity.value.stateKey === (input.stateKey ?? null) &&
        entity.value.residence === (input.residence ?? "ltg"),
    );
    if (duplicate?.kind === "memory") return this.result(duplicate.value);
    const nodeId = memoryIdentity(
      this.backend.namespace,
      "node",
      input.nodeName.trim().toLocaleLowerCase("en-US"),
      input.residence ?? "ltg",
      sessionId ?? "",
    );
    const nodes = await this.find({ kind: "node", ids: [nodeId] });
    const existing = nodes.find(
      (entity) => entity.kind === "node" && entity.value.status === "active",
    );
    const node = existing?.kind === "node" ? existing.value : newNode(input, nodeId, now);
    const id = memoryIdentity(this.backend.namespace, operationId, String(slot));
    const history = await this.history(input, `${id}_evidence`, now);
    const memory = newMemory(input, id, node.id, history.id, now);
    await this.replacePrevious(input, memory, now);
    await this.requireRelated(memory, sessionId, now);
    this.put({ kind: "node", value: node });
    this.put({ kind: "history", value: history });
    this.put({ kind: "memory", value: memory });
    return { history, node, memory };
  }

  private async replacePrevious(
    input: MemoryInput,
    memory: MemoryRecord,
    now: string,
  ): Promise<void> {
    let previous: MemoryRecord | undefined;
    if (input.supersedesId) {
      const found = await this.find({
        kind: "memory",
        ids: [input.supersedesId],
        sessionId: input.sessionId ?? undefined,
      });
      const entity = found[0];
      if (entity?.kind !== "memory")
        throw new Error("Superseded memory does not exist in this session");
      previous = entity.value;
    } else if (memory.memoryType === "state") {
      const states = await this.find({
        kind: "memory",
        stateKey: memory.stateKey!,
        scope: memory.scope,
        sessionId: input.sessionId ?? undefined,
      });
      previous = states
        .flatMap((entity) => (entity.kind === "memory" ? [entity.value] : []))
        .find(
          (value) =>
            visibleMemory(value, input.sessionId ?? undefined, now) &&
            value.memoryType === "state" &&
            value.residence === memory.residence &&
            value.sessionId === memory.sessionId,
        );
    }
    if (!previous) return;
    if (
      previous.status !== "active" ||
      serializeScope(previous.scope) !== serializeScope(memory.scope) ||
      previous.residence !== memory.residence ||
      previous.sessionId !== memory.sessionId
    )
      throw new Error("Supersession requires active memories in identical scope and residence");
    memory.supersedesId = previous.id;
    this.put({
      kind: "memory",
      value: { ...previous, status: "superseded", validUntil: memory.validFrom },
    });
  }

  private async history(input: MemoryInput, id: string, now: string): Promise<HistoryRecord> {
    if (!input.evidenceHistoryId) return newHistory(input, id, now);
    const entities = await this.find({ kind: "history", ids: [input.evidenceHistoryId] });
    const entity = entities[0];
    const sessionId = input.residence === "stg" ? input.sessionId : null;
    if (
      entity?.kind !== "history" ||
      (entity.value.sessionId && entity.value.sessionId !== sessionId)
    )
      throw new Error("Evidence does not exist in this session");
    return entity.value;
  }

  private async requireRelated(
    memory: MemoryRecord,
    sessionId: string | undefined,
    now: string,
  ): Promise<void> {
    if (!memory.relatedMemoryIds.length) return;
    const related = await this.find({ kind: "memory", ids: memory.relatedMemoryIds, sessionId });
    if (
      related.filter(
        (entity) => entity.kind === "memory" && visibleMemory(entity.value, sessionId, now),
      ).length !== new Set(memory.relatedMemoryIds).size
    )
      throw new Error("Related memory is unavailable");
  }

  private async result(memory: MemoryRecord): Promise<RememberResult> {
    const nodes = await this.find({ kind: "node", ids: [memory.nodeId] });
    const history = await this.find({ kind: "history", ids: [memory.evidenceId] });
    if (nodes[0]?.kind !== "node" || history[0]?.kind !== "history")
      throw new Error("Broken memory references");
    return { memory, node: nodes[0].value, history: history[0].value };
  }
}

function matches(entity: MemoryEntity, query: MemoryEntityQuery): boolean {
  if (entity.kind !== query.kind || (query.ids && !query.ids.includes(entity.value.id)))
    return false;
  if (entity.kind === "memory") {
    return matchesMemory(entity.value, query);
  }
  if (
    entity.kind === "node" &&
    query.nodeName &&
    entity.value.canonicalName.trim().toLocaleLowerCase("en-US") !==
      query.nodeName.trim().toLocaleLowerCase("en-US")
  )
    return false;
  return true;
}

function matchesMemory(memory: MemoryRecord, query: MemoryEntityQuery): boolean {
  if (query.scope && serializeScope(query.scope) !== serializeScope(memory.scope)) return false;
  if (memory.sessionId && memory.sessionId !== query.sessionId) return false;
  if (query.nodeId && memory.nodeId !== query.nodeId) return false;
  if (query.stateKey !== undefined && memory.stateKey !== query.stateKey) return false;
  return (
    !query.exactText || normalizeStatement(memory.statement) === normalizeStatement(query.exactText)
  );
}
