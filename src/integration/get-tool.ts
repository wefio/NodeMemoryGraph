import type { NmgMethodResult } from "../cli/protocol.ts";
import { loadPrompts, renderDisclosure } from "../prompts/load.ts";
import { renderEvidenceSurface } from "./agent-surface.ts";
import {
  discloseMemoryContext,
  renderFoldedDisclosure,
  type AdapterToolSession,
  type EvidenceLookup,
} from "./adapter-tool-session.ts";

type ExactContext = NmgMethodResult["get"];
const prompts = loadPrompts();

export function createGetTool(graphSupported: boolean) {
  return {
    name: "nmg_get" as const,
    requiresNativeSession: false,
    label: "Get NMG evidence",
    description: prompts.get_description,
    inputSchema: {
      type: "object" as const,
      properties: {
        memoryIds: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 50,
          description: "Memory IDs or references from nmg_search.",
        },
        ...(graphSupported
          ? {
              activeGraphId: {
                type: "string",
                description: prompts.active_graph_id_parameter_description,
              },
              graphHops: { type: "integer", minimum: 0, maximum: 3 },
            }
          : {}),
      },
      required: ["memoryIds"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, session: AdapterToolSession) {
      const memoryIds = Array.isArray(args.memoryIds)
        ? args.memoryIds.filter((id): id is string => typeof id === "string" && id.trim() !== "")
        : [];
      if (!memoryIds.length) throw new Error("nmg_get requires at least one memory ID.");
      const memory = session.memory;
      if (memory?.recallFlow && !memory.recallFlow.allowGet(session.sessionId)) {
        return {
          details: { getSuppressed: true, reason: "recall_tool_budget_exhausted" },
          text: "Recall tool budget exhausted for this user turn. Answer from the evidence already loaded or state what remains uncertain.",
        };
      }
      const request = boundEvidenceLookup(args, memoryIds, session, graphSupported);
      const graphHops = graphSupported ? args.graphHops : undefined;
      const result = await loadEvidence(request, graphHops, session);
      memory?.recallFlow?.recordGet(
        session.sessionId,
        result.results.map((entry) => entry.memory.id),
      );
      memory?.attribution?.note(session.sessionId, result);
      await memory?.onEvidenceLookup?.(request, result);
      const { context, folded } = await discloseMemoryContext(
        result,
        session,
        "evidence",
        graphSupported,
        request.activeGraphId,
      );
      await memory?.onEvidenceDisclosed?.(request, context);
      return { details: result, text: renderExactContext(context, folded) };
    },
  };
}

export type SharedGetTool = ReturnType<typeof createGetTool>;

function boundEvidenceLookup(
  args: Record<string, unknown>,
  memoryIds: string[],
  session: AdapterToolSession,
  graphSupported: boolean,
): EvidenceLookup {
  const supplied = typeof args.activeGraphId === "string" ? args.activeGraphId.trim() : "";
  const activeGraphId = graphSupported
    ? supplied ||
      session.memory?.attribution?.latestActiveGraphIdForMemories(session.sessionId, memoryIds) ||
      undefined
    : undefined;
  return { memoryIds, activeGraphId };
}

async function loadEvidence(
  request: EvidenceLookup,
  graphHops: unknown,
  session: AdapterToolSession,
) {
  const run = async (activeGraphId: string | undefined) => {
    const params = {
      memoryIds: request.memoryIds,
      activeGraphId,
      graphHops,
      sessionId: session.sessionId,
      projectDir: session.memory?.projectDir,
    };
    const cli = ["get", ...request.memoryIds, "--session-id", session.sessionId, "--json"];
    if (params.projectDir) cli.push("--project-dir", params.projectDir);
    if (activeGraphId) cli.push("--active-graph-id", activeGraphId);
    if (graphHops !== undefined) cli.push("--graph-hops", String(graphHops));
    return (await session.invoke("get", params, cli)) as ExactContext;
  };
  try {
    return await run(request.activeGraphId);
  } catch (error) {
    if (
      !session.memory?.retryForeignGraph ||
      !request.activeGraphId ||
      !/active graph .* (belongs to another session|does not exist)/iu.test(String(error))
    )
      throw error;
    request.activeGraphId = undefined;
    return run(undefined);
  }
}

function renderExactContext(context: ExactContext, folded: string[]): string {
  const containsForget = context.results.some(({ memory }) =>
    (memory.markers ?? []).some((marker) => marker.kind === "forget"),
  );
  const detail =
    context.results.length > 0 || (context.missingMemoryIds?.length ?? 0) > 0
      ? renderEvidenceSurface(context, {
          preamble: renderDisclosure(prompts.get_disclosure, {}),
          postamble: renderDisclosure(prompts.get_disclosure_metadata, {
            count: String(context.results.length),
            next_step: "",
            forget_hint: containsForget ? prompts.forget_hint : "",
          }),
          missingMemoryIds: context.missingMemoryIds,
        })
      : "";
  return (
    [detail, renderFoldedDisclosure(folded)].filter(Boolean).join("\n") || "No active memory found."
  );
}
