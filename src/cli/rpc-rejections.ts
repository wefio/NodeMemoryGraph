import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NmgMethod, NmgRpcRejection } from "./protocol.ts";
import { NmgProtocolError } from "./protocol.ts";

const REJECTION_CODES = new Set([
  "METHOD_NOT_FOUND",
  "INVALID_PARAMS",
  "NOT_FOUND",
  "WRITE_REJECTED",
  "LAB_OPERATION_UNAVAILABLE",
]);

/** Local diagnostics stay independent of memory and coordination writes. Only
 * names supplied by the protocol implementation enter the bounded counter. */
export class RpcRejections {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  record(method: NmgMethod | "(unknown)", error: unknown): void {
    if (!(error instanceof NmgProtocolError)) return;
    if (!REJECTION_CODES.has(error.code)) return;
    const parameter = error.parameter ?? "";
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const db = new DatabaseSync(this.path);
      try {
        db.exec(`
          PRAGMA busy_timeout=250;
          CREATE TABLE IF NOT EXISTS rejections (
            method TEXT NOT NULL, code TEXT NOT NULL, parameter TEXT NOT NULL,
            count INTEGER NOT NULL, last_at TEXT NOT NULL,
            PRIMARY KEY (method, code, parameter)
          );
        `);
        db.prepare(
          `
          INSERT INTO rejections VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (method, code, parameter)
          DO UPDATE SET count=count+1, last_at=excluded.last_at
        `,
        ).run(method, error.code, parameter, new Date().toISOString());
      } finally {
        db.close();
      }
    } catch {
      // A diagnostics failure must preserve the original RPC error.
    }
  }

  report(): NmgRpcRejection[] {
    if (!existsSync(this.path)) return [];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(this.path, { readOnly: true });
      return db
        .prepare(
          `
        SELECT method, code, parameter, count, last_at AS lastAt FROM rejections
        ORDER BY count DESC, method, code, parameter
      `,
        )
        .all()
        .map(({ method, code, parameter, count, lastAt }) => ({
          method: String(method),
          code: String(code),
          ...(parameter ? { parameter: String(parameter) } : {}),
          count: Number(count),
          lastAt: String(lastAt),
        }));
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }
}
