import { rmSync } from "node:fs";

/**
 * Windows may retain a just-closed SQLite/native handle for a few milliseconds.
 * Node retries EPERM/EBUSY only when maxRetries is configured, so temp cleanup
 * should consistently use the bounded retry path. Full-suite concurrency can
 * keep a directory enumeration handle alive for longer than a few hundred
 * milliseconds, so the retry window covers that Windows-specific tail while
 * remaining a no-op on the ordinary first-attempt path.
 */
export function removeTempDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 100,
  });
}
