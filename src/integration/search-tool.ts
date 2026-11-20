import type { NmgSearchParams } from "../cli/protocol.ts";
import type { MemoryContext } from "../core/types.ts";
import { loadPrompts, renderDisclosure } from "../prompts/load.ts";
import {
  discloseMemoryContext,
  renderFoldedDisclosure,
  type AdapterSearchBinding,
  type AdapterToolSession,
} from "./adapter-tool-session.ts";
import { renderSearchSurface } from "./agent-surface.ts";
import { shortActiveGraphId } from "./memory-reference.ts";
import { SEARCH_REQUIRED_PARAMETERS, searchParameterProperties } from "./tool-contract.ts";

const prompts = loadPrompts();
const PROPERTIES = {
  ...searchParameterProperties(),
  query: { type: "string", description: prompts.search_query_parameter_description },
  queries: {
    type: "array",
    items: { type: "string" },
    description: prompts.search_queries_parameter_description,
  },
  recallCue: { type: "string", description: prompts.search_recall_cue_parameter_description },
  recallRevision: {
    type: "integer",
    minimum: 1,
    description: prompts.search_recall_revision_parameter_description,
  },
  secondPass: { type: "boolean" },
  tieredDisclosure: { type: "boolean" },
  initialEvidenceTarget: { type: "integer", minimum: 1, maximum: 50 },
  strongHitTopGap: { type: "number", minimum: 0, maximum: 1 },
  strongHitInitialTarget: { type: "integer", minimum: 1, maximum: 50 },
};

export function createSearchTool(graphSupported: boolean, searchParameters?: readonly string[]) {
  const properties = Object.fromEntries(
    Object.entries(PROPERTIES).filter(([key]) => allowsSearchParameter(key, searchParameters)),
  );
  return {
    name: "nmg_search" as const,
    requiresNativeSession: false,
    label: "Search NMG",
    description: prompts.search_description,
    inputSchema: {
      type: "object" as const,
      properties,
      required: [...SEARCH_REQUIRED_PARAMETERS],
      additionalProperties: false,
    },
    execute(args: Record<string, unknown>, session: AdapterToolSession) {
      const input = Object.fromEntries(
        Object.entries(args).filter(
          ([key, value]) => Object.hasOwn(properties, key) && value != null,
        ),
      ) as unknown as NmgSearchParams;
      if (typeof input.query !== "string") throw new Error("nmg_search requires a query.");
      return executeSearch(input, session, graphSupported, searchParameters);
    },
  };
}

export type SharedSearchTool = ReturnType<typeof createSearchTool>;

function allowsSearchParameter(key: string, searchParameters: readonly string[] | undefined) {
  return key === "query" || (searchParameters?.includes(key) ?? true);
}

async function executeSearch(
  input: NmgSearchParams,
  session: AdapterToolSession,
  graphSupported: boolean,
  searchParameters: readonly string[] | undefined,
) {
  const { sessionId, memory } = session;
  const search: AdapterSearchBinding = memory?.search ?? {};
  const flow = memory?.recallFlow;
  if (flow && !flow.allowSearch(sessionId)) {
    await search.onSuppressed?.(input.query);
    return {
      details: { searchSuppressed: true, reason: flow.searchBlockReason(sessionId) },
      text: prompts.search_progression_required,
    };
  }
  await openSearchDisclosureTurn(input, session, graphSupported, search);
  const ranked = await runSearch(input, session, search, searchParameters);
  const visible = (await search.fold?.(ranked, input.limit !== undefined)) ?? ranked;
  flow?.recordSearch(
    sessionId,
    visible.results.map(({ memory: entry }) => entry.id),
  );
  memory?.attribution?.note(sessionId, ranked);
  const disclosure = await discloseMemoryContext(visible, session, "header", graphSupported);
  const text = [
    renderSearchHeaders(disclosure.context, disclosure.folded),
    search.feedback?.(ranked.activeGraph?.id),
  ]
    .filter(Boolean)
    .join("\n");
  await search.onSearch?.({ query: input.query, ranked, disclosed: disclosure.context, text });
  return { details: visible, text };
}

async function openSearchDisclosureTurn(
  input: NmgSearchParams,
  session: AdapterToolSession,
  graphSupported: boolean,
  search: AdapterSearchBinding,
) {
  if (!search.beginDisclosureTurn || !graphSupported || input.recallRevision !== undefined) return;
  await session
    .invoke("sessionActiveGraph", {
      action: "beginDisclosureTurn",
      sessionId: session.sessionId,
    })
    .catch(() => undefined);
}

async function runSearch(
  input: NmgSearchParams,
  session: AdapterToolSession,
  search: AdapterSearchBinding,
  searchParameters: readonly string[] | undefined,
) {
  const { recallCue, recallRevision, ...filters } = input;
  const params = {
    ...filters,
    maxTier: filters.maxTier ?? search.defaultTier,
    sessionId: session.sessionId,
    projectDir: session.memory?.projectDir,
  };
  const invoke = (request: Record<string, unknown>, cliFallback?: string[]) =>
    session.invoke(
      "search",
      Object.fromEntries(
        Object.entries(request).filter(
          ([key, value]) => value !== undefined && allowsSearchParameter(key, searchParameters),
        ),
      ),
      cliFallback,
    ) as Promise<MemoryContext>;
  const canProbe =
    input.limit === undefined &&
    allowsSearchParameter("persistTrace", searchParameters) &&
    allowsSearchParameter("activeGraphBudget", searchParameters);
  const budget = canProbe
    ? await search.allocate?.(() =>
        invoke({ ...params, limit: 20, secondPass: false, persistTrace: false }),
      )
    : undefined;
  const request = {
    ...params,
    ...(search.bindRecallCue?.(recallCue, recallRevision) ?? { recallCue, recallRevision }),
    secondPass: filters.secondPass ?? search.defaultSecondPass,
    ...(budget ? { activeGraphBudget: budget, limit: budget.maxEvidence } : {}),
  };
  const result = await invoke(request, searchCli(request));
  return (await search.rank?.(result)) ?? result;
}

function searchCli(params: NmgSearchParams): string[] {
  const argv = ["search", params.query, "--session-id", params.sessionId ?? "", "--json"];
  for (const [value, flag] of [
    [params.projectDir, "--project-dir"],
    [params.limit, "--limit"],
    [params.maxTier, "--max-tier"],
    [params.graphHops, "--graph-hops"],
    [params.nodeName, "--node"],
    [params.sourceActor, "--source-actor"],
    [params.eventTimeFrom, "--from"],
    [params.eventTimeTo, "--to"],
  ] as const) {
    if (value !== undefined) argv.push(flag, String(value));
  }
  if (params.includeHistorical) argv.push("--include-historical");
  if (params.secondPass) argv.push("--second-pass");
  if (params.tieredDisclosure) argv.push("--tiered-disclosure");
  for (const [key, value] of Object.entries(params.scope ?? {}))
    argv.push("--scope", `${key}=${value}`);
  return argv;
}

export function renderSearchHeaders(context: MemoryContext, folded: string[] = []): string {
  const deferred = context.progressiveDisclosure?.deferredMemoryIds;
  const forget = context.results.some(({ memory }) =>
    (memory.markers ?? []).some((marker) => marker.kind === "forget"),
  );
  const nextStep = deferred?.length
    ? `${prompts.deferred_hint} Memory IDs: ${deferred.join(",")}`
    : "";
  const text = renderSearchSurface(context, {
    emptyText: folded.length ? "" : "No NMG match.",
    preamble: renderDisclosure(prompts.search_disclosure, {}),
    postamble: renderDisclosure(prompts.search_disclosure_metadata, {
      count: String(context.results.length),
      next_step: nextStep,
      forget_hint: forget ? prompts.forget_hint : "",
    }),
  });
  const graph = context.activeGraph?.id;
  const foldedOnlyGraph =
    folded.length && !context.results.length && graph
      ? `activeGraphId=${shortActiveGraphId(graph)}`
      : "";
  return [text, renderFoldedDisclosure(folded), foldedOnlyGraph].filter(Boolean).join("\n");
}
