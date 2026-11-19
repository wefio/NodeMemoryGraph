import { serializeScope } from "../scope.ts";
import { normalizeStatement } from "../memory-normalization.ts";
import { recallTriggersFromMarkers } from "../recall-triggers.ts";
import { CANONICAL_EVENT_TIME_GLOB } from "../event-time.ts";
import { MAX_MEMORY_COMMIT_ENTITIES, sessionScopedEntity } from "./backend.ts";
import type {
  MemoryCommitReceipt,
  MemoryCommitRequest,
  MemoryEntity,
  MemoryEntityQuery,
} from "./backend.ts";

export type EntityRow = {
  key: string;
  kind: string;
  id: string;
  payload: string;
  text: string;
  node: string;
  scope: string;
  session: string;
  source: string;
  target: string;
  name: string;
  statekey: string;
};

export const ENTITY_COLUMNS = [
  "key",
  "kind",
  "id",
  "payload",
  "text",
  "node",
  "scope",
  "session",
  "source",
  "target",
  "name",
  "statekey",
] as const;

export function entityRow(entity: MemoryEntity): EntityRow {
  const row: EntityRow = {
    key: `${entity.kind}:${entity.value.id}`,
    kind: entity.kind,
    id: entity.value.id,
    payload: JSON.stringify(entity.value),
    text: "",
    node: "",
    scope: "{}",
    session: "",
    source: "",
    target: "",
    name: "",
    statekey: "",
  };
  if (entity.kind === "memory") {
    row.text = entity.value.statement;
    row.name = normalizeStatement(entity.value.statement);
    row.statekey = entity.value.stateKey ?? "";
    row.node = entity.value.nodeId;
    row.scope = serializeScope(entity.value.scope);
    row.session = entity.value.sessionId ?? "";
  } else if (entity.kind === "node") {
    row.name = entity.value.canonicalName.trim().toLocaleLowerCase("en-US");
    row.text = entity.value.summary;
  } else if (entity.kind === "edge") {
    row.source = entity.value.sourceNodeId;
    row.target = entity.value.targetNodeId;
  } else if (entity.kind === "history") {
    row.name = entity.value.sourceMessageId ?? "";
  } else if (entity.kind === "tessera") {
    row.text = [entity.value.path, entity.value.label, entity.value.snippet].join(" ");
  } else if ("sessionId" in entity.value) {
    row.session = entity.value.sessionId ?? "";
  }
  if (entity.kind === "claimPosterior") row.target = entity.value.posterior.memoryId;
  return row;
}

export function lexicalMemoryText(
  memory: Extract<MemoryEntity, { kind: "memory" }>["value"],
): string {
  if (memory.storageState) return "";
  return [memory.statement, ...recallTriggersFromMarkers(memory.markers)].join(" ");
}

export function receiptRow(receipt: MemoryCommitReceipt): EntityRow {
  return {
    key: `receipt:${receipt.operationId}`,
    kind: "receipt",
    id: receipt.operationId,
    payload: JSON.stringify(receipt),
    text: "",
    node: "",
    scope: "{}",
    session: "",
    source: "",
    target: "",
    name: "",
    statekey: "",
  };
}

export function commitRows(
  request: MemoryCommitRequest,
  receipt: MemoryCommitReceipt,
): EntityRow[] {
  return [
    ...request.changes.upsert.map(entityRow),
    ...(request.audit ?? []).map((value) => entityRow({ kind: "writeEvent", value })),
    receiptRow(receipt),
  ];
}

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function idFilter(column: "id" | "node", ids: readonly string[]): string {
  if (ids.length > 512)
    throw new Error(
      column === "id" ? "At most 512 entity IDs per read" : "At most 512 node IDs per read",
    );
  return ids.length ? `${column} IN (${ids.map(sqlLiteral).join(",")})` : "1 = 0";
}

export function queryWhere(query: MemoryEntityQuery): string {
  const clauses = [`kind = ${sqlLiteral(query.kind)}`];
  if (query.ids) clauses.push(idFilter("id", query.ids));
  if (query.nodeId !== undefined) clauses.push(`node = ${sqlLiteral(query.nodeId)}`);
  if (query.nodeIds) clauses.push(idFilter("node", query.nodeIds));
  if (query.exactText !== undefined)
    clauses.push(`name = ${sqlLiteral(normalizeStatement(query.exactText))}`);
  if (query.stateKey !== undefined) clauses.push(`statekey = ${sqlLiteral(query.stateKey)}`);
  if (query.nodeName !== undefined)
    clauses.push(`name = ${sqlLiteral(query.nodeName.trim().toLocaleLowerCase("en-US"))}`);
  if (query.scope !== undefined) clauses.push(`scope = ${sqlLiteral(serializeScope(query.scope))}`);
  if (sessionScopedEntity(query.kind))
    clauses.push(`(session = '' OR session = ${sqlLiteral(query.sessionId ?? "")})`);
  if (query.claimMemoryId) clauses.push(`target = ${sqlLiteral(query.claimMemoryId)}`);
  if (query.connectedTo !== undefined)
    clauses.push(
      `(source = ${sqlLiteral(query.connectedTo)} OR target = ${sqlLiteral(query.connectedTo)})`,
    );
  if (query.sourceMessageId !== undefined)
    clauses.push(`(name = ${sqlLiteral(query.sourceMessageId)} OR name = '')`);
  return clauses.join(" AND ");
}

export function queryBounds(query: MemoryEntityQuery): { limit: number; offset: number } {
  const limit = query.limit ?? 100;
  const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 512)
    throw new Error("Read limit must be an integer from 1 to 512");
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid read offset");
  return { limit, offset };
}

/** Older portable history rows projected the source message ID only in the payload. */
export const SQLITE_HISTORY_SOURCE =
  "coalesce(nullif(name, ''), json_extract(payload, '$.sourceMessageId'))";

/** Filter the SQLite candidate pool before FTS or vector ranking applies its limit. */
export function sqliteQueryWhere(query: MemoryEntityQuery): string {
  const source = query.kind === "history" ? query.sourceMessageId : undefined;
  const clauses =
    source === undefined
      ? [queryWhere(query)]
      : [
          queryWhere({ ...query, sourceMessageId: undefined }),
          `${SQLITE_HISTORY_SOURCE} = ${sqlLiteral(source)}`,
        ];
  if (query.supersedesId)
    clauses.push(`json_extract(payload, '$.supersedesId') = ${sqlLiteral(query.supersedesId)}`);
  if (query.consolidatedFrom)
    clauses.push(`EXISTS (
    SELECT 1 FROM json_each(json_extract(payload, '$.markers'))
    WHERE json_extract(value, '$.kind')='consolidated_from_stg'
      AND json_extract(value, '$.attributes.sourceMemoryId')=${sqlLiteral(query.consolidatedFrom)}
  )`);
  if (query.eventTimeFrom)
    clauses.push(`json_extract(payload, '$.eventTime') >= ${sqlLiteral(query.eventTimeFrom)}`);
  if (query.eventTimeTo)
    clauses.push(`json_extract(payload, '$.eventTime') <= ${sqlLiteral(query.eventTimeTo)}`);
  if (query.eventTimeFrom || query.eventTimeTo)
    clauses.push(
      `json_extract(payload, '$.eventTime') GLOB ${sqlLiteral(CANONICAL_EVENT_TIME_GLOB)}`,
    );
  return clauses.join(" AND ");
}

export function validateCommit(
  request: MemoryCommitRequest,
  limit = MAX_MEMORY_COMMIT_ENTITIES,
): void {
  if (!request.operationId.trim() || !request.requestHash.trim())
    throw new Error("Operation identity is required");
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
    throw new Error("Invalid expected revision");
  if (request.changes.upsert.length > limit)
    throw new Error(`At most ${limit} entity changes per commit`);
  const audit = request.audit ?? [];
  if (audit.length > 128) throw new Error("At most 128 audit events per commit");
  validateEntities([
    ...request.changes.upsert,
    ...audit.map((value): MemoryEntity => ({ kind: "writeEvent", value })),
  ]);
}

function validateEntities(entities: readonly MemoryEntity[]): void {
  const keys = new Set<string>();
  for (const entity of entities) {
    if (!entity.value.id.trim()) throw new Error("Entity identity is required");
    const key = `${entity.kind}:${entity.value.id}`;
    if (keys.has(key)) throw new Error(`Duplicate entity change ${key}`);
    keys.add(key);
    JSON.stringify(entity.value);
  }
}
