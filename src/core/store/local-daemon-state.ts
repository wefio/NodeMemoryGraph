import { withCoordination } from "./coordination.ts";
import { LocalSqliteStateBase } from "./local-sqlite-state-base.ts";
import { withRetrievalDiagnostics } from "./retrieval-diagnostics.ts";

/** SQLite owner for local coordination and persisted retrieval diagnostics. */
export class SqliteLocalDaemonState extends withCoordination(
  withRetrievalDiagnostics(LocalSqliteStateBase),
) {}
