import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

export function sampleFingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export function gitRevision(cwd: string): string | null {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}
