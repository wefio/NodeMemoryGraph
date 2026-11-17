import { NmgStoreBase } from "./base.ts";
import { withCoordination } from "./coordination.ts";
import { withMaintenance } from "./maintenance.ts";

/** SQLite owner for local coordination and persisted retrieval diagnostics. */
export class SqliteLocalDaemonState extends withCoordination(withMaintenance(NmgStoreBase)) {}
