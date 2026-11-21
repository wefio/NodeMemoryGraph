import type { NmgSearchParams } from "../cli/protocol.ts";
import type { ActiveGraph, MemoryContext } from "../core/types.ts";
import { createMemoryReferences } from "./memory-reference.ts";
import { renderSearchHeaders } from "./search-tool.ts";

export const DEFAULT_EXPLICIT_SEARCH_LIMIT = 20;
const DEFAULT_EXPLICIT_SEARCH_CHARACTERS = 5_500;
const EXPLICIT_SEARCH_PREVIEW_CODE_POINTS = 240;
// The graph does not exist until after selection. This ID has the rendered ID's width.
const PREVIEW_GRAPH = { id: "00000000-0000-4000-8000-000000000000" } as ActiveGraph;

export function usesExplicitSearchPage(input: NmgSearchParams): boolean {
  return (
    !input.autoRecall &&
    !input.secondPass &&
    !input.tieredDisclosure &&
    !input.progressiveWarmDisclosure
  );
}

export function fitExplicitSearchPage(
  context: MemoryContext,
  input: NmgSearchParams,
): MemoryContext {
  if (!usesExplicitSearchPage(input)) return context;
  const limit = input.limit ?? DEFAULT_EXPLICIT_SEARCH_LIMIT;
  const characters =
    DEFAULT_EXPLICIT_SEARCH_CHARACTERS * Math.max(1, limit / DEFAULT_EXPLICIT_SEARCH_LIMIT);
  const page = {
    ...context,
    results: context.results.slice(0, limit),
    searchPreviewCodePoints: EXPLICIT_SEARCH_PREVIEW_CODE_POINTS,
  };
  const sizing = { ...page, activeGraph: PREVIEW_GRAPH };
  const references = input.persistTrace === false ? undefined : createMemoryReferences(sizing);
  const size = (slice: Pick<MemoryContext, "results" | "tesserae">) =>
    renderSearchHeaders({ ...sizing, ...slice, memoryReferences: references }).length;
  const results = fittingPrefix(
    page.results,
    (results) => size({ results, tesserae: undefined }) <= characters,
  );
  const tesserae = fittingPrefix(
    page.tesserae ?? [],
    (tesserae) => size({ results, tesserae }) <= characters,
  );
  return { ...page, results, tesserae: page.tesserae ? tesserae : undefined };
}

function fittingPrefix<T>(items: readonly T[], fits: (items: T[]) => boolean): T[] {
  let lower = 0;
  let upper = items.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (fits(items.slice(0, middle))) lower = middle;
    else upper = middle - 1;
  }
  return items.slice(0, lower);
}
