import type { MemoryContext, MemorySearchResult } from "../core/types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const REFERENCE_PREFIX = "ref:";
const QUOTE_CODE_POINTS = 6;

export class MemoryReferenceError extends Error {}

export interface MemoryReferenceTarget {
  memory: Pick<MemorySearchResult["memory"], "id" | "statement">;
}

/** Content witnesses belong to the existing immutable retrieval projection,
 * not to a separate alias store. Only the short quote is retained. */
export function captureMemoryReferenceTargets(
  targets: readonly MemoryReferenceTarget[],
): readonly MemoryReferenceTarget[] {
  return Object.freeze(
    targets.map(({ memory }) =>
      Object.freeze({
        memory: Object.freeze({
          id: memory.id,
          statement: statementQuote(memory.statement),
        }),
      }),
    ),
  );
}

export function isMemoryReference(value: string): boolean {
  return value.startsWith(REFERENCE_PREFIX);
}

function normalizedStatement(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function statementQuote(value: string): string {
  return Array.from(normalizedStatement(value)).slice(0, QUOTE_CODE_POINTS).join("").trimEnd();
}

function unsafeQuote(value: string): boolean {
  return (
    !value ||
    Array.from(value).some((character) => {
      const code = character.codePointAt(0)!;
      return character === ";" || code < 32 || code === 127;
    })
  );
}

function matchingIds(
  prefix: string,
  quote: string,
  targets: readonly MemoryReferenceTarget[],
): Set<string> {
  return new Set(
    targets
      .filter(
        ({ memory }) =>
          UUID.test(memory.id) &&
          memory.id.replaceAll("-", "").toLowerCase().startsWith(prefix) &&
          statementQuote(memory.statement) === quote,
      )
      .map(({ memory }) => memory.id),
  );
}

function referenceFor(
  result: MemorySearchResult,
  targets: readonly MemoryReferenceTarget[],
): string | undefined {
  const { memory } = result;
  if (!UUID.test(memory.id) || memory.markers.some((marker) => marker.kind === "forget"))
    return undefined;
  const quote = statementQuote(memory.statement);
  if (unsafeQuote(quote)) return undefined;
  const hex = memory.id.replaceAll("-", "").toLowerCase();
  for (let length = 4; length <= hex.length; length += 2) {
    const prefix = hex.slice(0, length);
    const reference = `${REFERENCE_PREFIX}${prefix}|${quote}`;
    if (reference.length >= memory.id.length) return undefined;
    const ids = matchingIds(prefix, quote, targets);
    if (ids.size === 1 && ids.has(memory.id)) return reference;
  }
  return undefined;
}

/** Derived presentation only; targets are the original graph's readable records.
 * Canonical IDs, candidate order, previews and disclosure entries stay intact. */
export function createMemoryReferences(
  context: MemoryContext,
  targets: readonly MemoryReferenceTarget[] = context.results,
): Readonly<Record<string, string>> {
  if (!context.activeGraph) return {};
  return Object.fromEntries(
    context.results.flatMap((result) => {
      const reference = referenceFor(result, targets);
      return reference ? [[result.memory.id, reference]] : [];
    }),
  );
}

/** The caller supplies an owned graph's original candidate set, filtered by the
 * same read visibility as exact get. No latest-scope or similarity fallback. */
export function resolveMemoryReferences(
  memoryIds: readonly string[],
  targets: readonly MemoryReferenceTarget[],
  currentTargets: readonly MemoryReferenceTarget[] = targets,
): string[] {
  return memoryIds.map((value) => {
    if (!isMemoryReference(value)) return value;
    const match = /^ref:([0-9a-fA-F]{4,32})\|(.{1,6})$/u.exec(value);
    if (
      !match ||
      match[1]!.length % 2 !== 0 ||
      unsafeQuote(match[2]!) ||
      match[2] !== normalizedStatement(match[2]!)
    )
      throw new MemoryReferenceError("Invalid memory reference; copy the whole displayed key.");
    const ids = matchingIds(match[1]!.toLowerCase(), match[2]!, targets);
    if (ids.size !== 1)
      throw new MemoryReferenceError(
        ids.size === 0 ? "Memory reference has no match." : "Memory reference is ambiguous.",
      );
    const id = [...ids][0]!;
    const current = currentTargets.filter((target) => target.memory.id === id);
    if (!matchingIds(match[1]!.toLowerCase(), match[2]!, current).has(id))
      throw new MemoryReferenceError("Memory reference has no match.");
    return id;
  });
}
