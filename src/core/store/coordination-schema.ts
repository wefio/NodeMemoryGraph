import type { DatabaseSync } from "node:sqlite";

/** Additive, idempotent migration; event history is not ordinary board TTL state. */
export function ensureCoordinationSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS coordination_events (
      id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('active','ended')),
      revision INTEGER NOT NULL CHECK(revision > 0), updated_at TEXT NOT NULL,
      active_effects INTEGER NOT NULL DEFAULT 0, record_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS coordination_event_changes (
      event_id TEXT NOT NULL REFERENCES coordination_events(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, actor_id TEXT NOT NULL, kind TEXT NOT NULL,
      text TEXT NOT NULL, payload_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(event_id,revision)
    );
    CREATE TABLE IF NOT EXISTS coordination_event_members (
      event_id TEXT NOT NULL REFERENCES coordination_events(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL, subscribed INTEGER NOT NULL DEFAULT 1 CHECK(subscribed IN (0,1)),
      PRIMARY KEY(event_id,agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_coordination_event_status ON coordination_events(status,updated_at);
    CREATE TABLE IF NOT EXISTS board_channel_members (
      task_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      subscribed INTEGER NOT NULL CHECK(subscribed IN (0,1)), subscribed_at TEXT NOT NULL,
      PRIMARY KEY(task_id,agent_id)
    );
    CREATE TABLE IF NOT EXISTS board_notification_requests (
      agent_id TEXT NOT NULL, request_key TEXT NOT NULL, body_hash TEXT NOT NULL,
      entry_id TEXT NOT NULL, PRIMARY KEY(agent_id,request_key)
    );
  `);
  addColumns(db, "task_board_entries", [
    ["coordination_event_id", "TEXT REFERENCES coordination_events(id) ON DELETE SET NULL"],
    ["coordination_event_revision", "INTEGER"],
    ["coordination_notice", "INTEGER NOT NULL DEFAULT 0"],
    ["notification_source_id", "TEXT"],
    ["notification_channel_id", "TEXT"],
    ["notification_scopes_json", "TEXT"],
    ["notification_invitation", "INTEGER NOT NULL DEFAULT 0"],
    ["notification_origin", "INTEGER NOT NULL DEFAULT 0"],
  ]);
  addColumns(db, "task_board_agents", [["status_note", "TEXT NOT NULL DEFAULT ''"]]);
  addColumns(db, "coordination_event_members", [
    ["associated", "INTEGER NOT NULL DEFAULT 0 CHECK(associated IN (0,1))"],
  ]);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_board_notice_recipient ON task_board_entries(notification_source_id,[to]) WHERE notification_source_id IS NOT NULL;`,
  );
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_coordination_notice_identity
    ON task_board_entries(coordination_event_id,coordination_event_revision,[to]) WHERE coordination_notice = 1;`);
}
function addColumns(db: DatabaseSync, table: string, additions: Array<[string, string]>): void {
  const present = new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
  for (const [name, definition] of additions)
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}
