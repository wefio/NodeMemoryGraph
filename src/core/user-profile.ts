import { normalizeStatement } from "./memory-normalization.ts";
import { recallTriggersFromStoredMarkers } from "./recall-triggers.ts";
import type { MemoryRecord, MemoryScope } from "./types.ts";

export const USER_PROFILE_SCOPE = { profile: "user" } as const;
export const USER_PROFILE_PREVIEW_CODE_POINTS = 120;

export function isUserProfileScope(scope?: MemoryScope): boolean {
  return scope?.profile === USER_PROFILE_SCOPE.profile && Object.keys(scope).length === 1;
}

export function isUserProfileRecord(memory: MemoryRecord): boolean {
  return (
    isUserProfileScope(memory.scope) &&
    memory.residence === "ltg" &&
    memory.sourceActor === "user" &&
    (memory.truthStatus === "asserted" || memory.truthStatus === "verified") &&
    (memory.memoryType === "preference" || memory.memoryType === "constraint") &&
    !memory.markers.some(({ kind }) => kind === "sensitive" || kind === "external_source")
  );
}

/** Prefer the longest explicit trigger present in the current user request. */
export function userProfileMatch(normalizedQuery: string, memory: MemoryRecord): number {
  let longest = 0;
  for (const value of recallTriggersFromStoredMarkers(memory.markers)) {
    const phrase = normalizeStatement(value);
    if (phrase.length < 2) continue;
    const match = /\p{Script=Han}/u.test(phrase)
      ? normalizedQuery.includes(phrase)
      : ` ${normalizedQuery} `.includes(` ${phrase} `);
    if (match) longest = Math.max(longest, phrase.length);
  }
  return longest;
}
