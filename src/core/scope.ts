import type { MemoryScope } from "./types.ts";

/** Stable representation used by persistence, state identity, and equality. */
export function serializeScope(scope: MemoryScope): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(scope).sort(([left], [right]) => left.localeCompare(right))),
  );
}

export function sameScope(left: MemoryScope, right: MemoryScope): boolean {
  return serializeScope(left) === serializeScope(right);
}
