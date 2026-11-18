import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface ManagedEmbedding {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  dimensions?: number;
  profile?: string;
}

export interface OperatorSettings {
  revision: number;
  active?: ManagedEmbedding;
  candidate?: ManagedEmbedding;
  useManaged: boolean;
}

type Activity = {
  day: string;
  kind: "automaticRecall" | "search";
  outcome: "success" | "empty" | "failure";
  count: number;
};

/** Service-owned configuration and bounded metadata. No memory bodies enter this database. */
export class OperatorStore {
  constructor(privatePath: string) {
    this.path = privatePath;
  }
  private readonly path: string;
  private initialized = false;
  private readonly pending = new Map<string, Activity>();
  private timer?: ReturnType<typeof setTimeout>;

  private open(): DatabaseSync {
    mkdirSync(dirname(this.path), { recursive: true });
    if (!existsSync(this.path)) {
      try {
        closeSync(openSync(this.path, "wx", 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    const db = new DatabaseSync(this.path);
    db.exec("PRAGMA busy_timeout=250");
    if (!this.initialized) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      INSERT OR IGNORE INTO settings VALUES (1,0,'{"useManaged":false}');
      CREATE TABLE IF NOT EXISTS activity (day TEXT NOT NULL, kind TEXT NOT NULL, outcome TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day,kind,outcome));`);
      this.initialized = true;
    }
    return db;
  }

  read(): OperatorSettings {
    if (!existsSync(this.path)) return { revision: 0, useManaged: false };
    const db = this.open();
    try {
      const row = db.prepare("SELECT revision,payload FROM settings WHERE id=1").get()!;
      return {
        ...JSON.parse(String(row.payload)),
        revision: Number(row.revision),
      } as OperatorSettings;
    } finally {
      db.close();
    }
  }

  write(expectedRevision: number, state: Omit<OperatorSettings, "revision">): OperatorSettings {
    const db = this.open();
    try {
      const result = db
        .prepare("UPDATE settings SET revision=revision+1,payload=? WHERE id=1 AND revision=?")
        .run(JSON.stringify(state), expectedRevision);
      if (Number(result.changes) !== 1) throw new Error("Operator configuration revision conflict");
      return { ...state, revision: expectedRevision + 1 };
    } finally {
      db.close();
    }
  }

  record(kind: Activity["kind"], outcome: Activity["outcome"]): void {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${day}/${kind}/${outcome}`;
    const existing = this.pending.get(key);
    if (existing) existing.count++;
    else this.pending.set(key, { day, kind, outcome, count: 1 });
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, 1000);
    this.timer.unref();
  }

  private flush(): void {
    if (!this.pending.size) return;
    try {
      this.persistActivity();
      this.pending.clear();
    } catch {
      // Retry on the next batch or snapshot without interrupting retrieval.
      const oldest = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      for (const [key, row] of this.pending) {
        if (row.day < oldest) this.pending.delete(key);
      }
    }
  }

  private persistActivity(): void {
    const db = this.open();
    try {
      db.exec("BEGIN");
      const increment = db.prepare(
        "INSERT INTO activity VALUES (?,?,?,?) ON CONFLICT(day,kind,outcome) DO UPDATE SET count=count+excluded.count",
      );
      for (const { day, kind, outcome, count } of this.pending.values())
        increment.run(day, kind, outcome, count);
      db.prepare("DELETE FROM activity WHERE day < date('now','-30 days')").run();
      db.exec("COMMIT");
    } finally {
      db.close();
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.flush();
  }

  activity(): Array<{ day: string; kind: string; outcome: string; count: number }> {
    this.flush();
    const db = this.open();
    try {
      return db
        .prepare(
          "SELECT day,kind,outcome,count FROM activity WHERE day >= date('now','-30 days') ORDER BY day DESC,kind,outcome",
        )
        .all()
        .map((row) => ({
          day: String(row.day),
          kind: String(row.kind),
          outcome: String(row.outcome),
          count: Number(row.count),
        }));
    } finally {
      db.close();
    }
  }
}

const ENV_FIELDS = {
  provider: "NMG_EMBED_PROVIDER",
  model: "NMG_EMBED_MODEL",
  baseUrl: "NMG_EMBED_BASE_URL",
  apiKey: "NMG_EMBED_API_KEY",
  dimensions: "NMG_EMBED_DIMENSIONS",
  profile: "NMG_EMBED_PROFILE",
} as const;

export function managedEmbeddingEnvironment(
  base: NodeJS.ProcessEnv,
  settings: OperatorSettings,
): NodeJS.ProcessEnv {
  if (!settings.useManaged || !settings.active) return base;
  const environment = { ...base };
  delete environment.GEMINI_API_KEY;
  delete environment.JINA_API_KEY;
  delete environment.CLOUDFLARE_API_TOKEN;
  for (const [field, key] of Object.entries(ENV_FIELDS)) {
    delete environment[key];
    const value = settings.active[field as keyof ManagedEmbedding];
    if (value !== undefined) environment[key] = String(value);
  }
  return environment;
}

export function publicEmbedding(config: ManagedEmbedding | undefined) {
  if (!config) return null;
  const { apiKey, ...publicConfig } = config;
  return { ...publicConfig, keyConfigured: Boolean(apiKey) };
}
