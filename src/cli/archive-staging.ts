/**
 * Session-archive staging: a crash-safe write-through with fallback for the
 * pi extension's session_shutdown archival.
 *
 * The shutdown handler must never block daemon teardown, so the archival
 * decision is "try the daemon RPC with a hard timeout; on any failure, write
 * the entry to a staging file that the next session_start flushes". Staging
 * files are written atomically (tmp + rename) so a crash mid-write never
 * leaves a partial entry, and flushing deletes each file only after its
 * remember call succeeds — an interrupted flush simply retries next startup.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SessionArchiveEntry {
  sessionId: string;
  sessionFile?: string;
  projectDir?: string;
  archivedAt: string;
  reason?: string;
  /** Optional pre-built summary (e.g. pi's compaction summary). */
  summary?: string;
}

export interface ArchiveEntryParams extends SessionArchiveEntry {
  statement: string;
  nodeName: string;
}

export function stagingDirFor(projectDir: string): string {
  return join(projectDir, ".nmg", "archive-staging");
}

function entryPath(stagingDir: string, sessionId: string): string {
  return join(stagingDir, `${sessionId.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

/** Atomically stage an archive entry (tmp + rename). */
export function stageArchive(stagingDir: string, entry: SessionArchiveEntry): string {
  mkdirSync(stagingDir, { recursive: true });
  const target = entryPath(stagingDir, entry.sessionId);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), "utf8");
  renameSync(tmp, target);
  return target;
}

/** List staged entries (skips unreadable/corrupt files defensively). */
export function pendingArchives(stagingDir: string): SessionArchiveEntry[] {
  let files: string[];
  try {
    files = readdirSync(stagingDir).filter((name) => name.endsWith(".json") && !name.endsWith(".tmp"));
  } catch {
    return [];
  }
  const entries: SessionArchiveEntry[] = [];
  for (const name of files) {
    try {
      const parsed = JSON.parse(readFileSync(join(stagingDir, name), "utf8"));
      if (parsed && typeof parsed.sessionId === "string") entries.push(parsed);
    } catch {
      // Corrupt staging files are dropped rather than retried forever.
      try {
        rmSync(join(stagingDir, name), { force: true });
      } catch {
        // Best effort.
      }
    }
  }
  return entries;
}

/**
 * Flush staged entries through `flush` (a remember call). Each entry is
 * deleted only after its flush succeeds, so an interrupted flush resumes on
 * the next startup without losing entries. Returns the number flushed.
 */
export async function flushArchives(
  stagingDir: string,
  flush: (entry: SessionArchiveEntry) => Promise<void>,
): Promise<number> {
  const entries = pendingArchives(stagingDir);
  let flushed = 0;
  for (const entry of entries) {
    await flush(entry);
    try {
      rmSync(entryPath(stagingDir, entry.sessionId), { force: true });
    } catch {
      // Leave the file; next flush retries (flush is idempotent by sessionId).
    }
    flushed += 1;
  }
  return flushed;
}

/**
 * The write-through decision used by session_shutdown: try the daemon RPC
 * within `timeoutMs`; on timeout or any error, stage the entry for the next
 * startup instead. Never throws — the caller must be able to proceed to
 * daemon teardown unconditionally.
 */
export async function archiveOrStage(
  stagingDir: string,
  entry: SessionArchiveEntry,
  remember: (params: ArchiveEntryParams) => Promise<unknown>,
  timeoutMs = 5_000,
): Promise<"remembered" | "staged"> {
  const params: ArchiveEntryParams = {
    ...entry,
    statement: `Session ${entry.sessionId} archived${entry.summary ? `: ${entry.summary}` : ""}`,
    nodeName: `Session ${entry.sessionId}`,
  };
  try {
    await Promise.race([
      remember(params),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("archive timeout")), timeoutMs),
      ),
    ]);
    return "remembered";
  } catch {
    try {
      stageArchive(stagingDir, entry);
    } catch {
      // Staging failed too — nothing more we can do at shutdown time.
    }
    return "staged";
  }
}

/** Build a remember-ready statement for an entry (used by flush). */
export function archiveStatement(entry: SessionArchiveEntry): string {
  const parts = [`Session ${entry.sessionId} archived`];
  if (entry.sessionFile) parts.push(`at ${entry.sessionFile}`);
  if (entry.reason) parts.push(`reason=${entry.reason}`);
  if (entry.summary) parts.push(`summary: ${entry.summary}`);
  return parts.join(" ");
}

export function archiveNodeName(entry: SessionArchiveEntry): string {
  return `Session ${entry.sessionId}`;
}
