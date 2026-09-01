// Bounded passive-scan file index for nmg search.
//
// This module gives nmg search a second content source — the project's own
// files and documents — so an Agent does not have to re-discover a changing
// project by hand every session. It is deliberately scoped:
//
//   - the scan is BOUNDED to paths listed in `.nmg-search-scope` (semantically
//     opposite to `.gitignore`: it INCLUDES hot zones instead of excluding);
//   - the scan is PASSIVE (automatic, no manual trigger) and INCREMENTAL
//     (git status / content hash tells which files changed since last scan);
//   - files are a search index, NOT memory: content never enters LTG/STG and
//     never gets provenance/scope/verification semantics.
//
// The index lives in a project-local SQLite file (`.nmg/file-index.sqlite`),
// physically separate from the memory store, so deleting `.nmg/` removes the
// file index without touching memory.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isAbsolute, join, relative, resolve } from "node:path";

import { ftsExpression, surfaceIndexedText } from "./store/search-ranking.ts";
import type { FileHit } from "./types.ts";

export type { FileHit };

export interface FileIndexOptions {
  /** Project root; `.nmg-search-scope` is resolved against it. */
  projectRoot: string;
  /** Directory for the index file (default `<projectRoot>/.nmg`). */
  dataDir?: string;
  /** Explicit scope file path (default `<projectRoot>/.nmg-search-scope`). */
  scopePath?: string;
  /** Max paths kept in the scope (auto-grown cap). Default 256. */
  maxScopePaths?: number;
  /** Max file size in bytes to index (skip larger). Default 1 MiB. */
  maxFileBytes?: number;
}

interface ScopeEntry {
  path: string;
  dir: boolean;
}

const DEFAULT_MAX_SCOPE = 256;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

/** Parse a `.nmg-search-scope` file: one path per line, `#` comments.
 *  Directories imply recursion. Empty/blank lines are ignored. */
export function parseScopeFile(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.replace(/[\\/]+$/u, "")) // strip trailing slash
    .filter(Boolean);
}

/** Expand scope entries into concrete paths under the project root. A
 *  directory entry expands to the directory itself (recursion happens at
 *  scan time); a file entry is used as-is. Paths are normalized relative. */
export function resolveScopeEntries(projectRoot: string, entries: string[]): ScopeEntry[] {
  const seen = new Set<string>();
  const out: ScopeEntry[] = [];
  for (const entry of entries) {
    const abs = isAbsolute(entry) ? entry : resolve(projectRoot, entry);
    const rel = relative(projectRoot, abs).replaceAll("\\", "/");
    const key = rel || entry;
    if (seen.has(key)) continue;
    seen.add(key);
    let dir: boolean;
    try {
      dir = statSync(abs).isDirectory();
    } catch {
      dir = entry.endsWith("/");
    }
    out.push({ path: key, dir });
  }
  return out;
}

/** Collect indexable files under a directory entry, respecting a caller
 *  supplied exclusion predicate (node_modules/.git/etc). */
export function collectFiles(
  root: string,
  entry: ScopeEntry,
  maxBytes: number,
  exclude: (relPath: string) => boolean,
): string[] {
  if (!entry.dir) return [entry.path];
  const out: string[] = [];
  const absRoot = resolve(root, entry.path);
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const abs = join(dir, name);
      const rel = relative(root, abs).replaceAll("\\", "/");
      if (exclude(rel)) continue;
      let stat;
      try {
        stat = statSync(abs);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile() && stat.size <= maxBytes) {
        out.push(rel);
      }
    }
  };
  walk(absRoot);
  return out.sort();
}

/** Default exclusion predicate: skip VCS dirs, node_modules, build output,
 *  binaries, and dot-dirs (mirrors common .gitignore behavior). */
export function defaultExclude(relPath: string): boolean {
  const parts = relPath.split("/");
  if (parts.some((part) => part === "node_modules" || part === ".git" || part === ".nmg")) {
    return true;
  }
  if (parts.some((part) => part.startsWith(".") && part !== "." && part !== "..")) {
    // allow .nmg-search-scope itself but skip other dot-dirs
    return !(parts.length === 1 && parts[0] === ".nmg-search-scope");
  }
  const binary = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|exe|dll|so|dylib|woff2?|ttf|eot|class|jar)$/iu;
  return binary.test(relPath);
}

/**
 * Bounded passive-scan file index.
 *
 * Storage: `.nmg/file-index.sqlite` with two tables:
 *   - `file_fts`   FTS5 trigram index over (path, content)
 *   - `file_meta`  per-file content hash for incremental scans
 *
 * The scope is read from `.nmg-search-scope`; `addScopePath` grows it
 * (the Agent is the first crawler: grep/read hits teach the scope).
 */
export class FileIndex {
  readonly projectRoot: string;
  readonly dataDir: string;
  readonly scopePath: string;
  readonly maxScopePaths: number;
  readonly maxFileBytes: number;
  readonly db: DatabaseSync;

  constructor(options: FileIndexOptions) {
    this.projectRoot = resolve(options.projectRoot);
    this.dataDir = resolve(options.dataDir ?? join(this.projectRoot, ".nmg"));
    this.scopePath = resolve(options.scopePath ?? join(this.projectRoot, ".nmg-search-scope"));
    this.maxScopePaths = Math.max(1, options.maxScopePaths ?? DEFAULT_MAX_SCOPE);
    this.maxFileBytes = Math.max(1, options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES);
    mkdirSync(this.dataDir, { recursive: true });
    this.db = new DatabaseSync(join(this.dataDir, "file-index.sqlite"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_meta (
        path TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(
        path UNINDEXED,
        content,
        content = 'file_meta',
        content_rowid = 'rowid',
        tokenize = 'trigram'
      );
      CREATE TRIGGER IF NOT EXISTS file_fts_ai AFTER INSERT ON file_meta BEGIN
        INSERT INTO file_fts (rowid, path, content) VALUES (new.rowid, new.path, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS file_fts_ad AFTER DELETE ON file_meta BEGIN
        INSERT INTO file_fts (file_fts, rowid, path, content)
        VALUES ('delete', old.rowid, old.path, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS file_fts_au AFTER UPDATE ON file_meta BEGIN
        INSERT INTO file_fts (file_fts, rowid, path, content)
        VALUES ('delete', old.rowid, old.path, old.content);
        INSERT INTO file_fts (rowid, path, content) VALUES (new.rowid, new.path, new.content);
      END;
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Read the current scope (relative paths). */
  readScope(): string[] {
    if (!existsSync(this.scopePath)) return [];
    try {
      return parseScopeFile(readFileSync(this.scopePath, "utf8"));
    } catch {
      return [];
    }
  }

  /** Add a hot-zone path to the scope (dedup, cap, auto-create file). The
   *  Agent is the first crawler: grep/read hits feed this. */
  addScopePath(path: string): void {
    const clean = String(path ?? "").trim().replace(/[\\/]+$/u, "");
    if (!clean) return;
    const entries = this.readScope();
    if (entries.includes(clean)) return;
    entries.push(clean);
    // Cap: keep the most recently added (tail) paths.
    const capped = entries.slice(-this.maxScopePaths);
    writeFileSync(
      this.scopePath,
      `# .nmg-search-scope — hot zones indexed by the file content source\n` +
        `# (semantically opposite to .gitignore: INCLUDES paths to index)\n` +
        capped.map((path) => path).join("\n") +
        "\n",
      "utf8",
    );
  }

  /** Incremental scan: index files under the scope whose content hash changed
   *  (or are new), remove files no longer present. Returns counts. */
  crawl(now = new Date().toISOString()): { indexed: number; removed: number } {
    const scopeEntries = resolveScopeEntries(this.projectRoot, this.readScope());
    const wanted = new Map<string, string>(); // relPath -> contentHash
    for (const entry of scopeEntries) {
      for (const rel of collectFiles(this.projectRoot, entry, this.maxFileBytes, defaultExclude)) {
        const abs = resolve(this.projectRoot, rel);
        try {
          const content = readFileSync(abs, "utf8");
          wanted.set(rel, hash(content));
        } catch {
          // unreadable/binary: skip
        }
      }
    }

    let indexed = 0;
    const upsertMeta = this.db.prepare(
      "INSERT INTO file_meta (path, content, content_hash, indexed_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash, indexed_at = excluded.indexed_at",
    );
    for (const [rel, contentHash] of wanted) {
      const prev = this.db
        .prepare("SELECT content_hash FROM file_meta WHERE path = ?")
        .get(rel) as { content_hash: string } | undefined;
      if (prev && prev.content_hash === contentHash) continue; // unchanged
      const abs = resolve(this.projectRoot, rel);
      let content: string;
      try {
        content = readFileSync(abs, "utf8");
      } catch {
        continue;
      }
      // file_meta drives the FTS via triggers (insert/update/delete), so the
      // index always has exactly one row per file.
      upsertMeta.run(rel, surfaceIndexedText(content), contentHash, now);
      indexed += 1;
    }

    // Remove files that disappeared from the scope (or changed scope).
    const known = this.db
      .prepare("SELECT path FROM file_meta")
      .all() as Array<{ path: string }>;
    let removed = 0;
    for (const row of known) {
      if (!wanted.has(row.path)) {
        this.db.prepare("DELETE FROM file_meta WHERE path = ?").run(row.path);
        removed += 1;
      }
    }
    return { indexed, removed };
  }

  /** Search the file index. Returns hits with a short excerpt. */
  search(query: string, limit = 8): FileHit[] {
    const expression = ftsExpression(query);
    if (!expression) return [];
    const rows = this.db
      .prepare(
        `SELECT path, snippet(file_fts, 1, '[', ']', '…', 12) AS excerpt, bm25(file_fts) AS rank
         FROM file_fts
         WHERE file_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(expression, Math.max(1, Math.min(limit, 50))) as Array<{
      path: string;
      excerpt: string | null;
      rank: number;
    }>;
    return rows.map((row) => ({
      path: row.path,
      excerpt: row.excerpt ?? "",
      score: -Number(row.rank), // bm25 lower is better; negate for descending
    }));
  }

  /** Remove the index database entirely (e.g. on scope reset). */
  destroy(): void {
    this.db.close();
    try {
      rmSync(join(this.dataDir, "file-index.sqlite"), { force: true });
    } catch {
      // best-effort
    }
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}
