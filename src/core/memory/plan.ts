import type { HistoryRecord, MemoryRecord, MemoryWriteEvent, RememberResult } from "../types.ts";
import { TESSERA_REF_MARKER } from "../types.ts";
import { serializeScope } from "../scope.ts";
import { normalizeStatement } from "../memory-normalization.ts";
import { statementSimilarity } from "../store/search-ranking.ts";
import type { MemoryBackend, MemoryEntity, MemoryEntityQuery, MemoryReadView } from "./backend.ts";
import { sessionScopedEntity } from "./backend.ts";
import {
  memoryIdentity,
  memoryResidence,
  newHistory,
  newMemory,
  newNode,
  stateAliasId,
  visibleMemory,
} from "./model.ts";
import type { MemoryInput } from "./model.ts";

/** One planning view plus uncommitted entities; ordered batch inputs observe prior inputs. */
export class MemoryPlan {
  readonly changes = new Map<string, MemoryEntity>();
  readonly audit: MemoryWriteEvent[] = [];
  readonly backend: MemoryBackend;
  readonly view: MemoryReadView;

  constructor(backend: MemoryBackend, view: MemoryReadView) {
    this.backend = backend;
    this.view = view;
  }

  put(entity: MemoryEntity): void {
    this.changes.set(`${entity.kind}:${entity.value.id}`, entity);
  }

  async record(id: string, sessionId?: string): Promise<MemoryRecord | null> {
    const [entity] = await this.find({ kind: "memory", ids: [id], sessionId });
    return entity?.kind === "memory" ? entity.value : null;
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
    input = await this.resolveStateAlias(input);
    const residence = memoryResidence(input);
    const sessionId = residence === "stg" ? (input.sessionId ?? undefined) : undefined;
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
        entity.value.residence === residence &&
        entity.value.sessionId === (sessionId ?? null),
    );
    if (duplicate?.kind === "memory") return this.result(duplicate.value);
    const node = await this.node(input, sessionId, now);
    const id = memoryIdentity(this.backend.namespace, operationId, String(slot));
    const history = await this.history(input, `${id}_evidence`, now);
    const memory = newMemory(input, id, node.id, history.id, now);
    await this.replacePrevious(input, memory, now);
    const supersedeCandidates = await this.possiblePredecessors(memory, now);
    await this.requireRelated(memory, sessionId, now);
    this.attachTesserae(input, memory, now);
    this.put({ kind: "node", value: node });
    this.put({ kind: "history", value: history });
    this.put({ kind: "memory", value: memory });
    this.audit.push({
      id: `${memory.id}_write`,
      memoryId: memory.id,
      historyId: history.id,
      sessionId: input.sessionId ?? null,
      decision: "accepted",
      policyReason: "allowed",
      writeReason: memory.writeReason,
      writeSource: memory.writeSource,
      memoryType: memory.memoryType,
      requestedResidence: residence,
      createdAt: now,
    });
    return {
      history,
      node,
      memory,
      ...(supersedeCandidates.length ? { supersedeCandidates } : {}),
    };
  }

  private async possiblePredecessors(memory: MemoryRecord, now: string) {
    if (memory.supersedesId || memory.stateKey) return [];
    const sessionId = memory.sessionId ?? undefined;
    const scope = serializeScope(memory.scope);
    const rows = await this.backend.scan(this.view, {
      kind: "memory",
      nodeId: memory.nodeId,
      scope: memory.scope,
      sessionId,
      limit: 80,
    });
    return rows
      .flatMap((row) => {
        if (row.kind !== "memory") return [];
        const candidate = row.value;
        if (
          candidate.sessionId !== memory.sessionId ||
          candidate.storageState ||
          serializeScope(candidate.scope) !== scope ||
          !visibleMemory(candidate, sessionId, now)
        )
          return [];
        const similarity = statementSimilarity(memory.statement, candidate.statement);
        return similarity >= 0.3
          ? [
              {
                memoryId: candidate.id,
                nodeId: candidate.nodeId,
                statement: candidate.statement,
                eventTime: candidate.eventTime,
                similarity,
                priority: "token" as const,
              },
            ]
          : [];
      })
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 8);
  }

  private attachTesserae(input: MemoryInput, memory: MemoryRecord, now: string): void {
    for (const [index, tessera] of (input.tesserae ?? []).entries()) {
      const path = tessera.path.trim();
      const snippet = tessera.snippet.trim();
      if (!path || !snippet) continue;
      const id = memoryIdentity(memory.id, "tessera", String(index));
      this.put({
        kind: "tessera",
        value: {
          id,
          path,
          snippet,
          label: tessera.label?.trim() ?? "",
          kind: tessera.kind?.trim(),
          memoryId: memory.id,
          createdAt: now,
          fileSimhash: tessera.fileSimhash,
        },
      });
      memory.markers.push({ kind: TESSERA_REF_MARKER, attributes: { tesseraId: id, path } });
    }
  }

  private async resolveStateAlias(input: MemoryInput): Promise<MemoryInput> {
    if (input.memoryType !== "state" || !input.stateKey) return input;
    const [alias] = await this.find({
      kind: "stateAlias",
      ids: [stateAliasId(input.stateKey, input.scope ?? {})],
    });
    return alias?.kind === "stateAlias" ? { ...input, stateKey: alias.value.canonicalKey } : input;
  }

  private async node(input: MemoryInput, sessionId: string | undefined, now: string) {
    const residence = memoryResidence(input);
    const nodeId = memoryIdentity(
      this.backend.namespace,
      "node",
      input.nodeName.trim().toLocaleLowerCase("en-US"),
      residence,
      sessionId ?? "",
    );
    const nodes = await this.find(
      residence === "ltg"
        ? { kind: "node", nodeName: input.nodeName }
        : { kind: "node", ids: [nodeId] },
    );
    const active = nodes.flatMap((entity) =>
      entity.kind === "node" &&
      entity.value.status === "active" &&
      entity.value.residence === residence
        ? [entity.value]
        : [],
    );
    const exact = active.find((node) => node.canonicalName === input.nodeName.trim());
    if (exact) return exact;
    if (active.length > 1) throw new Error("Multiple active nodes match this name");
    return active[0] ?? newNode(input, nodeId, now);
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
    memory.evidenceRole = input.evidenceRole ?? "update";
    this.put({
      kind: "memory",
      value: { ...previous, status: "superseded", validUntil: memory.validFrom },
    });
  }

  private async history(input: MemoryInput, id: string, now: string): Promise<HistoryRecord> {
    if (!input.evidenceHistoryId) return this.historyForSource(input, id, now);
    const entities = await this.find({ kind: "history", ids: [input.evidenceHistoryId] });
    const entity = entities[0];
    const sessionId = memoryResidence(input) === "stg" ? input.sessionId : null;
    if (
      entity?.kind !== "history" ||
      (entity.value.sessionId && entity.value.sessionId !== sessionId)
    )
      throw new Error("Evidence does not exist in this session");
    return entity.value;
  }

  private async historyForSource(
    input: MemoryInput,
    id: string,
    now: string,
  ): Promise<HistoryRecord> {
    const history = newHistory(input, id, now);
    if (!history.sourceMessageId) return history;
    const entities = await this.find({ kind: "history", sourceMessageId: history.sourceMessageId });
    const existing = entities.find(
      (entity) =>
        entity.kind === "history" &&
        entity.value.sessionId === history.sessionId &&
        entity.value.sourceMessageId === history.sourceMessageId,
    );
    if (existing?.kind !== "history") return history;
    if (existing.value.content !== history.content || existing.value.role !== history.role)
      throw new Error(
        `source message ${history.sourceMessageId} already exists with different content`,
      );
    return existing.value;
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
  if (!matchesMetadata(entity, query)) return false;
  if (
    entity.kind === "node" &&
    query.nodeName &&
    entity.value.canonicalName.trim().toLocaleLowerCase("en-US") !==
      query.nodeName.trim().toLocaleLowerCase("en-US")
  )
    return false;
  return true;
}

function matchesMetadata(entity: MemoryEntity, query: MemoryEntityQuery): boolean {
  if (
    sessionScopedEntity(entity.kind) &&
    "sessionId" in entity.value &&
    entity.value.sessionId &&
    entity.value.sessionId !== query.sessionId
  )
    return false;
  return (
    !query.claimMemoryId ||
    (entity.kind === "claimPosterior" && entity.value.posterior.memoryId === query.claimMemoryId)
  );
}

function matchesMemory(memory: MemoryRecord, query: MemoryEntityQuery): boolean {
  if (query.scope && serializeScope(query.scope) !== serializeScope(memory.scope)) return false;
  if (memory.sessionId && memory.sessionId !== query.sessionId) return false;
  if (query.nodeId && memory.nodeId !== query.nodeId) return false;
  if (query.stateKey !== undefined && memory.stateKey !== query.stateKey) return false;
  if (query.supersedesId && memory.supersedesId !== query.supersedesId) return false;
  return (
    !query.exactText || normalizeStatement(memory.statement) === normalizeStatement(query.exactText)
  );
}
