/**
 * Filesystem parts shared by one-off scripts.
 *
 * They live here so a report or calibration script does not grow its own copy.
 * The shelf that describes them is `docs/guides/parts.md`.
 */
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write JSON so a concurrent reader sees either the previous file or the complete
 * new one, never a partial write: write a sibling temp file, then rename over the
 * target. The temp name carries the pid so two writers cannot collide.
 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
