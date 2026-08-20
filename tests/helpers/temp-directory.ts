import { rmSync } from "node:fs";

/**
 * Windows may retain a just-closed SQLite/native handle for a few milliseconds.
 * Node retries EPERM/EBUSY only when maxRetries is configured, so temp cleanup
 * should consistently use the bounded retry path.
 */
export function removeTempDirectory(path: string): void {
  rmSync(path, {
    recursive: true,
    force: true,
    maxRetries: 8,
    retryDelay: 50,
  });
}
