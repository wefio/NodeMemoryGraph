import { serializeScope } from "../scope.ts";
import { normalizeStatement } from "../store/search-ranking.ts";
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
  }
  return row;
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

export function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function queryWhere(query: MemoryEntityQuery): string {
  const clauses = [`kind = ${sqlLiteral(query.kind)}`];
  if (query.ids) {
    if (query.ids.length > 512) throw new Error("At most 512 entity IDs per read");
    clauses.push(query.ids.length ? `id IN (${query.ids.map(sqlLiteral).join(",")})` : "1 = 0");
  }
  if (query.nodeId !== undefined) clauses.push(`node = ${sqlLiteral(query.nodeId)}`);
  if (query.exactText !== undefined)
    clauses.push(`name = ${sqlLiteral(normalizeStatement(query.exactText))}`);
  if (query.stateKey !== undefined) clauses.push(`statekey = ${sqlLiteral(query.stateKey)}`);
  if (query.nodeName !== undefined)
    clauses.push(`name = ${sqlLiteral(query.nodeName.trim().toLocaleLowerCase("en-US"))}`);
  if (query.scope !== undefined) clauses.push(`scope = ${sqlLiteral(serializeScope(query.scope))}`);
  if (query.kind === "memory")
    clauses.push(`(session = '' OR session = ${sqlLiteral(query.sessionId ?? "")})`);
  if (query.connectedTo !== undefined)
    clauses.push(
      `(source = ${sqlLiteral(query.connectedTo)} OR target = ${sqlLiteral(query.connectedTo)})`,
    );
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

export function validateCommit(request: MemoryCommitRequest): void {
  if (!request.operationId.trim() || !request.requestHash.trim())
    throw new Error("Operation identity is required");
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0)
    throw new Error("Invalid expected revision");
  if (request.changes.upsert.length > 512) throw new Error("At most 512 entity changes per commit");
  const keys = new Set<string>();
  for (const entity of request.changes.upsert) {
    if (!entity.value.id.trim()) throw new Error("Entity identity is required");
    const key = `${entity.kind}:${entity.value.id}`;
    if (keys.has(key)) throw new Error(`Duplicate entity change ${key}`);
    keys.add(key);
    JSON.stringify(entity.value);
  }
}
