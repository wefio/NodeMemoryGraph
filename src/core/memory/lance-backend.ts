import { createHash, randomUUID } from "node:crypto";
import { connect, Index } from "@lancedb/lancedb";
import type { Connection, Table } from "@lancedb/lancedb";
import { MemoryOperationConflict } from "./backend.ts";
import type {
  MemoryBackend,
  MemoryCommitOutcome,
  MemoryCommitReceipt,
  MemoryCommitRequest,
  MemoryEntity,
  MemoryEntityQuery,
  MemoryReadView,
} from "./backend.ts";
import {
  entityRow,
  queryBounds,
  queryWhere,
  receiptRow,
  sqlLiteral,
  validateCommit,
} from "./entity-rows.ts";

interface PublishedHead {
  revision: number;
  branch: string;
  version: number;
}

/** Native Lance objects and indexes; no SQLite database or query executor. */
export class LanceMemoryBackend implements MemoryBackend {
  readonly kind = "lancedb" as const;
  private readonly readers = new Map<MemoryReadView, Table>();
  private closed = false;
  readonly namespace: string;
  private readonly connection: Connection;
  private readonly head: Table;
  private readonly data: Table;

  private constructor(namespace: string, connection: Connection, head: Table, data: Table) {
    this.namespace = namespace;
    this.connection = connection;
    this.head = head;
    this.data = data;
  }

  static async open(
    uri: string,
    namespace: string,
    storageOptions?: Record<string, string>,
  ): Promise<LanceMemoryBackend> {
    if (!namespace.trim()) throw new Error("Memory namespace is required");
    const connection = await connect(uri, { storageOptions, readConsistencyInterval: 0 });
    // Bound native object paths on Windows; 128-bit namespace keys avoid long local cache paths.
    const key = createHash("sha256").update(namespace).digest("hex").slice(0, 32);
    try {
      const seed = {
        ...receiptRow({ operationId: "", requestHash: "", revision: 0, resultIds: [] }),
        kind: "seed",
      };
      const data = await connection.createTable(`nmg_${key}_data`, [seed], { existOk: true });
      if (!(await data.listIndices()).some((index) => index.columns.includes("text")))
        await data.createIndex("text", { config: Index.fts(), replace: true });
      const head = await connection.createTable(
        `nmg_${key}_head`,
        [{ revision: 0, branch: "main", version: await data.version() }],
        { existOk: true },
      );
      return new LanceMemoryBackend(namespace, connection, head, data);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async openRead(): Promise<MemoryReadView> {
    this.assertOpen();
    const head = await this.published();
    const table = await (await this.data.branches()).checkout(head.branch, head.version);
    const view = Object.freeze({ revision: head.revision });
    this.readers.set(view, table);
    return view;
  }

  async scan(view: MemoryReadView, query: MemoryEntityQuery): Promise<MemoryEntity[]> {
    const table = this.reader(view);
    const { limit, offset } = queryBounds(query);
    const where = queryWhere(query);
    const builder = query.text?.trim()
      ? table.search(query.text, "fts").where(where)
      : table
          .query()
          .where(where)
          .orderBy({ columnName: "id", ascending: true, nullsFirst: false });
    const columns = query.text?.trim() ? ["kind", "payload", "_score"] : ["kind", "payload"];
    const rows = await builder.select(columns).offset(offset).limit(limit).toArray();
    return rows.map(
      (row) => ({ kind: row.kind, value: JSON.parse(String(row.payload)) }) as MemoryEntity,
    );
  }

  async receipt(view: MemoryReadView, operationId: string): Promise<MemoryCommitReceipt | null> {
    return this.readReceipt(this.reader(view), operationId);
  }

  async closeRead(view: MemoryReadView): Promise<void> {
    this.readers.get(view)?.close();
    this.readers.delete(view);
  }

  async commit(request: MemoryCommitRequest): Promise<MemoryCommitOutcome> {
    this.assertOpen();
    validateCommit(request);
    const head = await this.published();
    const branches = await this.data.branches();
    const current = await branches.checkout(head.branch, head.version);
    try {
      const previous = await this.readReceipt(current, request.operationId);
      if (previous) return this.replay(previous, request);
    } finally {
      current.close();
    }
    if (head.revision !== request.expectedRevision)
      return { status: "conflict", revision: head.revision };
    const receipt: MemoryCommitReceipt = {
      operationId: request.operationId,
      requestHash: request.requestHash,
      revision: head.revision + 1,
      resultIds: [...request.resultIds],
      result: request.result,
    };
    const name = `nmg_${randomUUID().replaceAll("-", "")}`;
    const staged = await branches.create(name, head.branch, head.version);
    try {
      await staged
        .mergeInsert("key")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute([...request.changes.upsert.map(entityRow), receiptRow(receipt)]);
      if (request.changes.upsert.some((entity) => entity.kind === "memory"))
        await staged.createIndex("text", { config: Index.fts(), replace: true });
      const version = await staged.version();
      const updated = await this.head.update({
        where: `revision = ${head.revision}`,
        values: { revision: receipt.revision, branch: name, version },
      });
      if (updated.rowsUpdated === 1) return { status: "committed", receipt };
      return this.afterConflict(request);
    } finally {
      // Never delete a branch after an ambiguous publication failure: it may be live.
      // Explicit maintenance can collect unreachable branches after reader retention.
      staged.close();
    }
  }

  private async afterConflict(request: MemoryCommitRequest): Promise<MemoryCommitOutcome> {
    const view = await this.openRead();
    try {
      const previous = await this.receipt(view, request.operationId);
      return previous
        ? this.replay(previous, request)
        : { status: "conflict", revision: view.revision };
    } finally {
      await this.closeRead(view);
    }
  }

  private replay(receipt: MemoryCommitReceipt, request: MemoryCommitRequest): MemoryCommitOutcome {
    if (receipt.requestHash !== request.requestHash)
      throw new MemoryOperationConflict(request.operationId);
    return { status: "replayed", receipt };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    for (const view of this.readers.keys()) await this.closeRead(view);
    this.head.close();
    this.data.close();
    this.connection.close();
    this.closed = true;
  }

  private async published(): Promise<PublishedHead> {
    const rows = await this.head.query().limit(2).toArray();
    if (rows.length !== 1) throw new Error("Invalid memory publication head");
    const row = rows[0]!;
    return {
      revision: Number(row.revision),
      branch: String(row.branch),
      version: Number(row.version),
    };
  }

  private async readReceipt(
    table: Table,
    operationId: string,
  ): Promise<MemoryCommitReceipt | null> {
    const rows = await table
      .query()
      .where(`key = ${sqlLiteral(`receipt:${operationId}`)}`)
      .select(["payload"])
      .limit(1)
      .toArray();
    return rows.length ? (JSON.parse(String(rows[0]!.payload)) as MemoryCommitReceipt) : null;
  }

  private reader(view: MemoryReadView): Table {
    this.assertOpen();
    const table = this.readers.get(view);
    if (!table) throw new Error("Memory read view is closed or belongs to another backend");
    return table;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Memory backend is closed");
  }
}
