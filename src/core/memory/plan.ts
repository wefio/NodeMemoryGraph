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

const PLAN_PAGE_SIZE = 512;
const PREFETCH_LIMIT = 8;

/** One planning view plus uncommitted entities; ordered batch inputs observe prior inputs. */
export class MemoryPlan {
  readonly changes = new Map<string, MemoryEntity>();
  readonly audit: MemoryWriteEvent[] = [];
  readonly backend: MemoryBackend;
  readonly view: MemoryReadView;
  private readonly snapshotPages = new Map<string, MemoryEntity[]>();
  private readonly changedKeys = new Map<string, Set<string>>();
  private readonly changeOrder = new Map<string, number>();

  constructor(backend: MemoryBackend, view: MemoryReadView) {
    this.backend = backend;
    this.view = view;
  }

  put(entity: MemoryEntity): void {
    const id = entityKey(entity);
    if (!this.changes.has(id)) this.changeOrder.set(id, this.changes.size);
    this.changes.set(id, entity);
    for (const query of entityLookups(entity)) {
      const key = lookupKey(query)!;
      const entries = this.changedKeys.get(key) ?? new Set<string>();
      entries.add(id);
      this.changedKeys.set(key, entries);
    }
  }

  async prefetchRemember(inputs: readonly MemoryInput[]): Promise<void> {
    if (inputs.length < 2 || !this.backend.scanBatch) return;
    const queries = new Map<string, MemoryEntityQuery>();
    for (const input of inputs) {
      const { query: node } = this.nodeLookup(input);
      const duplicate = duplicateLookup(input);
      for (const query of [node, duplicate]) {
        const key = JSON.stringify({ ...query, limit: PLAN_PAGE_SIZE, offset: 0 });
        queries.set(key, { ...query, limit: PREFETCH_LIMIT });
      }
    }
    const pages = await this.backend.scanBatch(this.view, [...queries.values()]);
    [...queries.keys()].forEach((key, i) => {
      const rows = pages[i]!;
      if (rows.length < PREFETCH_LIMIT) this.snapshotPages.set(key, rows);
    });
  }

  async record(id: string, sessionId?: string): Promise<MemoryRecord | null> {
    const [entity] = await this.find({ kind: "memory", ids: [id], sessionId });
    return entity?.kind === "memory" ? entity.value : null;
  }

  async find(query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    const base = new Map<string, MemoryEntity>();
    for (let offset = 0; ; offset += PLAN_PAGE_SIZE) {
      const page = await this.readPage({ ...query, limit: PLAN_PAGE_SIZE, offset });
      for (const entity of page) {
        const id = entityKey(entity);
        if (!this.changes.has(id)) base.set(id, entity);
      }
      if (page.length < PLAN_PAGE_SIZE) break;
    }
    for (const entity of this.changedCandidates(query)) {
      if (matches(entity, query)) base.set(entityKey(entity), entity);
    }
    return [...base.values()];
  }

  private changedCandidates(query: MemoryEntityQuery): Iterable<MemoryEntity> {
    const key = lookupKey(query);
    const ids = query.ids
      ? [...new Set(query.ids)].map((id) => `${query.kind}:${id}`)
      : key === undefined
        ? undefined
        : [...(this.changedKeys.get(key) ?? [])];
    if (!ids) return this.changes.values();
    return ids
      .filter((id) => this.changes.has(id))
      .sort((a, b) => this.changeOrder.get(a)! - this.changeOrder.get(b)!)
      .map((id) => this.changes.get(id)!);
  }

  private async readPage(query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    const key = JSON.stringify(query);
    const cached = this.snapshotPages.get(key);
    if (cached) return cached;
    const rows = await this.backend.scan(this.view, query);
    // Repeated empty and bounded reads are common within one write batch.
    if (query.limit !== PLAN_PAGE_SIZE || (query.offset === 0 && rows.length < PLAN_PAGE_SIZE))
      this.snapshotPages.set(key, rows);
    return rows;
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
    const duplicates = await this.find(duplicateLookup(input));
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
    const node = await this.node(input, now);
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
    const rows = await this.readPage({
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

  private nodeLookup(input: MemoryInput) {
    const residence = memoryResidence(input);
    const name = input.nodeName.trim().toLocaleLowerCase("en-US");
    const nodeId = memoryIdentity(
      this.backend.namespace,
      "node",
      name,
      residence,
      residence === "stg" ? (input.sessionId ?? "") : "",
    );
    const query: MemoryEntityQuery =
      residence === "ltg" ? { kind: "node", nodeName: name } : { kind: "node", ids: [nodeId] };
    return { nodeId, query };
  }

  private async node(input: MemoryInput, now: string) {
    const residence = memoryResidence(input);
    const { nodeId, query } = this.nodeLookup(input);
    const nodes = await this.find(query);
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

function entityKey(entity: MemoryEntity): string {
  return `${entity.kind}:${entity.value.id}`;
}

function duplicateLookup(input: MemoryInput): MemoryEntityQuery {
  return {
    kind: "memory",
    exactText: normalizeStatement(input.statement),
    scope: input.scope ?? {},
    sessionId: memoryResidence(input) === "stg" ? (input.sessionId ?? undefined) : undefined,
  };
}

function lookupKey(query: MemoryEntityQuery): string | undefined {
  if (query.kind === "node" && query.nodeName)
    return JSON.stringify(["node", query.nodeName.trim().toLocaleLowerCase("en-US")]);
  if (query.kind === "history" && query.sourceMessageId)
    return JSON.stringify(["history", query.sourceMessageId]);
  if (query.kind === "memory" && query.scope) {
    const scope = serializeScope(query.scope);
    if (query.exactText !== undefined)
      return JSON.stringify(["text", scope, normalizeStatement(query.exactText)]);
    if (query.stateKey !== undefined) return JSON.stringify(["state", scope, query.stateKey]);
  }
  return undefined;
}

function entityLookups(entity: MemoryEntity): MemoryEntityQuery[] {
  if (entity.kind === "node") return [{ kind: "node", nodeName: entity.value.canonicalName }];
  if (entity.kind === "history" && entity.value.sourceMessageId)
    return [{ kind: "history", sourceMessageId: entity.value.sourceMessageId }];
  if (entity.kind !== "memory") return [];
  const { statement, scope, stateKey } = entity.value;
  return [
    { kind: "memory", exactText: statement, scope },
    ...(stateKey === null ? [] : [{ kind: "memory" as const, stateKey, scope }]),
  ];
}

function matches(entity: MemoryEntity, query: MemoryEntityQuery): boolean {
  if (entity.kind !== query.kind || (query.ids && !query.ids.includes(entity.value.id)))
    return false;
  if (entity.kind === "memory") {
    return matchesMemory(entity.value, query);
  }
  if (!matchesMetadata(entity, query)) return false;
  if (entity.kind === "history" && query.sourceMessageId)
    return entity.value.sourceMessageId === query.sourceMessageId;
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
    query.exactText === undefined ||
    normalizeStatement(memory.statement) === normalizeStatement(query.exactText)
  );
}
