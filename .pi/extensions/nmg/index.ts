import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  connectDaemon,
  invokeDaemon,
  shutdownOwnedDaemon,
  type DaemonConnection,
} from "../../../src/cli/daemon-client.ts";
import type { MemoryContext, MemorySearchResult, MemoryTier } from "../../../src/core/types.ts";

/**
 * NMG Pi extension.
 *
 * Transport: connects to the NMG daemon over JSON-RPC/HTTP via
 * `daemon-client.ts`. The client path is intentionally thin — it imports only
 * `http-client.ts` (Node built-in fetch) and never `service.ts` / the core
 * store. That keeps the store dependency tree out of every Pi startup. See
 * tests/cli/http-boundary.test.ts.
 */

function databasePath(): string {
  return join(process.env.NMG_DATA_DIR || join(homedir(), ".nmg"), "nmg.sqlite");
}

function projectDirectory(): string {
  return process.env.NMG_PROJECT_DIR || process.cwd();
}

export default function nmgExtension(pi: ExtensionAPI): void {
  let connectionPromise: Promise<DaemonConnection> | undefined;
  const injectionWindow = new SessionInjectionWindow();
  const connection = (): Promise<DaemonConnection> =>
    (connectionPromise ??= connectDaemon(databasePath()));
  const invoke = async (method: "get" | "remember" | "search", params: Record<string, unknown>) =>
    invokeDaemon(await connection(), method, params);

  pi.on("before_agent_start", async (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    injectionWindow.beginTurn(sessionId);
    if (!shouldAutoRecall(event.prompt)) {
      return { systemPrompt: composeNmgSystemPrompt(event.systemPrompt) };
    }
    try {
      const context = (await invoke("search", {
        query: event.prompt,
        projectDir: projectDirectory(),
        sessionId,
        maxTier: configuredAutoRecallTier(),
        limit: configuredAutoRecallLimit(),
        initialEvidenceTarget: configuredInitialTarget(),
        secondPass: true,
        graphHops: 1,
        tieredDisclosure: true,
      })) as MemoryContext;
      const recalled = injectionWindow.format(sessionId, context, "header");
      return {
        systemPrompt: composeNmgSystemPrompt(event.systemPrompt, recalled),
      };
    } catch (error) {
      return {
        systemPrompt: composeNmgSystemPrompt(
          event.systemPrompt,
          "",
          `NMG unavailable: ${message(error)}`,
        ),
      };
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    injectionWindow.clear(ctx.sessionManager.getSessionId());
    if (!connectionPromise) return;
    const active = await connectionPromise.catch(() => undefined);
    connectionPromise = undefined;
    if (active) await shutdownOwnedDaemon(active);
  });

  pi.on("session_before_compact", async (_event, ctx) => {
    injectionWindow.clear(ctx.sessionManager.getSessionId());
  });

  pi.registerTool({
    name: "nmg_remember",
    label: "Remember with NMG",
    description: "Save a durable fact, state, event, preference, constraint, or reusable strategy.",
    parameters: Type.Object({
      statement: Type.String(),
      nodeName: Type.String({ description: "Stable semantic node name" }),
      memoryType: Type.Optional(
        Type.Union([
          Type.Literal("constraint"),
          Type.Literal("event"),
          Type.Literal("fact"),
          Type.Literal("preference"),
          Type.Literal("state"),
          Type.Literal("strategy"),
        ]),
      ),
      stateKey: Type.Optional(Type.String()),
      eventTime: Type.Optional(Type.String()),
      sourceActor: Type.Optional(
        Type.Union([
          Type.Literal("assistant"),
          Type.Literal("system"),
          Type.Literal("tool"),
          Type.Literal("user"),
        ]),
      ),
      truthStatus: Type.Optional(
        Type.Union([
          Type.Literal("asserted"),
          Type.Literal("inferred"),
          Type.Literal("unverified"),
          Type.Literal("verified"),
        ]),
      ),
      evidence: Type.Optional(Type.String()),
      writeReason: Type.Optional(Type.String()),
      tier: Type.Optional(
        Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
      ),
      importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
      scope: Type.Optional(Type.Record(Type.String(), Type.String())),
      residence: Type.Optional(Type.Union([Type.Literal("ltg"), Type.Literal("stg")])),
      expiresAt: Type.Optional(Type.String()),
      externalSource: Type.Optional(
        Type.Object({
          source: Type.String({ description: "web:URL or file:PATH" }),
          retrievedAt: Type.Optional(Type.String()),
          hash: Type.Optional(Type.String()),
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { externalSource, ...memory } = params;
      if (externalSource && !/^(?:file|web):.+/u.test(externalSource.source)) {
        throw new Error("externalSource.source must start with web: or file:");
      }
      const result = await invoke("remember", {
        ...memory,
        markers: externalSource
          ? [
              {
                kind: "external_source",
                attributes: {
                  source: externalSource.source,
                  retrievedAt: externalSource.retrievedAt ?? new Date().toISOString(),
                  ...(externalSource.hash ? { hash: externalSource.hash } : {}),
                },
              },
            ]
          : undefined,
        projectDir: projectDirectory(),
        sessionId: ctx.sessionManager.getSessionId(),
      });
      return toolResult(result, "Memory saved.");
    },
  });

  pi.registerTool({
    name: "nmg_get",
    label: "Get NMG evidence",
    description:
      "Load exact memory and evidence for IDs returned by nmg_search; pass its activeGraphId for use attribution.",
    parameters: Type.Object({
      memoryIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
      activeGraphId: Type.Optional(
        Type.String({ description: "activeGraphId returned by nmg_search" }),
      ),
      graphHops: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = (await invoke("get", {
        ...params,
        projectDir: projectDirectory(),
        sessionId: ctx.sessionManager.getSessionId(),
      })) as MemoryContext;
      const text = injectionWindow.format(ctx.sessionManager.getSessionId(), result, "evidence");
      return toolResult(result, text || "No active memory found.");
    },
  });

  pi.registerTool({
    name: "nmg_search",
    label: "Search NMG",
    description:
      "Search long-term memory headers. Use nmg_get on selected IDs when exact evidence is needed.",
    parameters: Type.Object({
      query: Type.String(),
      nodeName: Type.Optional(Type.String()),
      maxTier: Type.Optional(
        Type.Union([Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)]),
      ),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
      scope: Type.Optional(Type.Record(Type.String(), Type.String())),
      includeHistorical: Type.Optional(Type.Boolean()),
      graphHops: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
      secondPass: Type.Optional(Type.Boolean()),
      tieredDisclosure: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = (await invoke("search", {
        ...params,
        projectDir: projectDirectory(),
        sessionId: ctx.sessionManager.getSessionId(),
      })) as MemoryContext;
      return toolResult(
        result,
        injectionWindow.format(ctx.sessionManager.getSessionId(), result, "header"),
      );
    },
  });
}

type DisclosureLevel = "header" | "exact" | "evidence";

interface InjectionEntry {
  contentHash: string;
  disclosure: DisclosureLevel;
  turn: number;
}

interface SessionInjectionState {
  turn: number;
  entries: Map<string, InjectionEntry>;
}

/** Small, session-local cache of memory content already placed in Pi's context. */
export class SessionInjectionWindow {
  readonly #sessions = new Map<string, SessionInjectionState>();
  readonly maxTurns: number;
  readonly maxEntries: number;

  constructor(maxTurns = 12, maxEntries = 128) {
    this.maxTurns = maxTurns;
    this.maxEntries = maxEntries;
  }

  beginTurn(sessionId: string): void {
    const state = this.#state(sessionId);
    state.turn += 1;
    for (const [memoryId, entry] of state.entries) {
      if (state.turn - entry.turn >= this.maxTurns) state.entries.delete(memoryId);
    }
  }

  clear(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  format(sessionId: string, context: MemoryContext, disclosure: DisclosureLevel): string {
    if (context.results.length === 0) {
      return disclosure === "header" ? "No matching NMG memory found." : "";
    }
    const state = this.#state(sessionId);
    const fresh = [];
    const folded = [];
    for (const result of context.results) {
      const contentHash = injectionHash(result);
      const previous = state.entries.get(result.memory.id);
      const alreadyAvailable =
        previous?.contentHash === contentHash &&
        disclosureRank(previous.disclosure) >= disclosureRank(disclosure);
      if (alreadyAvailable) folded.push(result);
      else {
        fresh.push(result);
        state.entries.delete(result.memory.id);
        state.entries.set(result.memory.id, { contentHash, disclosure, turn: state.turn });
      }
    }
    while (state.entries.size > this.maxEntries) {
      state.entries.delete(state.entries.keys().next().value!);
    }

    const sections = [];
    if (fresh.length > 0) {
      const visible = { ...context, results: fresh } as MemoryContext;
      sections.push(
        disclosure === "header" ? formatSearchHeaders(visible) : formatMemoryContext(visible),
      );
    }
    if (folded.length > 0) {
      sections.push(
        "NMG ALREADY IN CURRENT CONTEXT\n" +
          folded.map(({ memory }) => `- memory=${memory.id}; already_in_context=true`).join("\n"),
      );
    }
    if (disclosure === "header" && fresh.length === 0) {
      const activeGraph = formatActiveGraph(context);
      if (activeGraph) sections.push(activeGraph);
    }
    return sections.join("\n");
  }

  #state(sessionId: string): SessionInjectionState {
    let state = this.#sessions.get(sessionId);
    if (!state) {
      state = { turn: 0, entries: new Map() };
      this.#sessions.set(sessionId, state);
    }
    return state;
  }
}

function disclosureRank(level: DisclosureLevel): number {
  return { header: 0, exact: 1, evidence: 2 }[level];
}

function injectionHash(result: MemoryContext["results"][number]): string {
  const content = `${result.memory.statement}\n${result.evidence.content}`;
  return createHash("sha256").update(content).digest("base64url");
}

export const MEMORY_POLICY =
  `<nmg_policy>\n` +
  `NMG supplies durable memory; it does not decide answer truth or evidence completeness. ` +
  `nmg_automatic_recall and nmg_search return candidate headers. nmg_get loads selected exact ` +
  `records and source evidence. nmg_remember saves durable information. For the latest user ` +
  `request, decide which candidates matter, whether one or several records are needed, and ` +
  `whether more recall or current verification is required. No useful memory is a valid result. ` +
  `Do not treat candidate count as completeness or a memory as current truth. If the recalled ` +
  `headers under-determine the answer, request additional evidence (append/re-fetch) before ` +
  `guessing; ignore headers that are clearly irrelevant noise. Save only ` +
  `attributable, durable information; do not save secrets, transient content, unconfirmed ` +
  `assistant proposals, or unsupported guesses.\n` +
  `</nmg_policy>`;

export function composeNmgSystemPrompt(
  baseSystemPrompt: string,
  automaticRecall = "",
  status = "",
): string {
  return [
    baseSystemPrompt,
    MEMORY_POLICY,
    automaticRecall
      ? `<nmg_automatic_recall>\n${automaticRecall}\n</nmg_automatic_recall>`
      : "",
    status ? `<nmg_status>${status}</nmg_status>` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function configuredAutoRecallTier(): MemoryTier {
  const value = Number(process.env.NMG_AUTO_RECALL_TIER ?? 1);
  return Math.max(0, Math.min(3, Number.isFinite(value) ? Math.floor(value) : 1)) as MemoryTier;
}

function configuredAutoRecallLimit(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_LIMIT ?? 13);
  return Math.max(1, Math.min(50, Number.isFinite(value) ? Math.floor(value) : 13));
}

function configuredInitialTarget(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_INITIAL_TARGET ?? 13);
  return Math.max(1, Math.min(50, Number.isFinite(value) ? Math.floor(value) : 13));
}

function shouldAutoRecall(prompt: string): boolean {
  const normalized = prompt.toLocaleLowerCase();
  return [
    /\b(previous(?:ly)?|before|earlier|last time|remember|recall|my preference|my project|we decided)\b/u,
    /(?:之前|以前|上次|还记得|回忆|记忆|我的偏好|我们决定|项目决定|当前状态)/u,
  ].some((pattern) => pattern.test(normalized));
}

export function formatSearchHeaders(context: MemoryContext): string {
  if (context.results.length === 0) return "No matching NMG memory found.";
  return [
    "NMG SEARCH HEADERS",
    "fields: memory=id; node=memory cluster; type=memory type; matches=query terms hit, else semantic/graph/hybrid; time=event date; expires=expiry date; preview=statement excerpt",
    ...context.results.map(
      ({ memory, node, recallReason: reason, hitTerms }) =>
        `- ${(memory.markers ?? []).some((marker) => marker.kind === "external_source") ? "[external] " : ""}` +
        `memory=${memory.id}; node=${node.canonicalName}; type=${memory.memoryType}; ` +
        `${recallMatchLabel(reason, hitTerms)}` +
        `${recallTimeLabel(memory)}` +
        `preview=${excerpt(memory.statement, 160)}`,
    ),
    formatActiveGraph(context),
    formatProgressiveDisclosure(context),
    "Use nmg_get with selected memory IDs and this activeGraphId to load exact evidence.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** What the query actually matched, not why the record surfaced:
 *  literal query terms for lexical hits, otherwise the mechanism
 *  (semantic / graph route / hybrid) when no term is available. */
function recallMatchLabel(
  reason: MemorySearchResult["recallReason"],
  hitTerms: MemorySearchResult["hitTerms"],
): string {
  if (hitTerms && hitTerms.length > 0) return `matches=${hitTerms.join(",")}; `;
  const label =
    reason === "learned_route" ? "graph" : reason === "vector_match" ? "semantic" : reason ?? "hybrid";
  return `matches=${label}; `;
}

/** Temporal anchors the agent can act on: the event's own time when
 *  recorded, and an expiry when the record stops being current. Dates only,
 *  omitted when absent. */
function recallTimeLabel(memory: MemorySearchResult["memory"]): string {
  const day = (iso: string | null): string | null => (iso ? iso.slice(0, 10) : null);
  const parts: string[] = [];
  const event = day(memory.eventTime);
  if (event) parts.push(`time=${event}`);
  const expires = day(memory.expiresAt ?? memory.validUntil);
  if (expires) parts.push(`expires=${expires}`);
  return parts.length > 0 ? `${parts.join("; ")}; ` : "";
}

function formatProgressiveDisclosure(context: MemoryContext): string {
  const disclosure = context.progressiveDisclosure;
  if (!disclosure || disclosure.deferredMemoryIds.length === 0) return "";
  return (
    `L1 continuation: ${disclosure.deferredMemoryIds.length} ranked memories are folded. ` +
    "If the visible evidence is insufficient, call nmg_get once with these memory IDs; " +
    `do not repeat nmg_search: ${disclosure.deferredMemoryIds.join(",")}`
  );
}

function formatActiveGraph(context: MemoryContext): string {
  return context.activeGraph ? `AG activeGraphId=${context.activeGraph.id}` : "";
}

export function formatMemoryContext(context: MemoryContext): string {
  const records = context.results
    .map(({ memory, node, evidence }) => {
      const source =
        evidence.content.trim() !== memory.statement.trim()
          ? `\n  SOURCE=${excerpt(evidence.content, 320)}`
          : "";
      const external = (memory.markers ?? []).find((marker) => marker.kind === "external_source");
      const externalLabel = external ? `[external, ${memory.truthStatus}] ` : "";
      const externalSource = external?.attributes?.source
        ? `\n  EXTERNAL_SOURCE=${String(external.attributes.source)}; retrievedAt=${String(external.attributes.retrievedAt ?? "unknown")}`
        : "";
      return (
        `- ${externalLabel}${memory.statement}\n  memory=${memory.id}; node=${node.canonicalName}; ` +
        `type=${memory.memoryType}; truth=${memory.truthStatus}; scope=${JSON.stringify(memory.scope)}` +
        externalSource +
        source
      );
    })
    .join("\n");
  return [records, formatProgressiveDisclosure(context)].filter(Boolean).join("\n");
}

function toolResult(details: unknown, text: string) {
  return { content: [{ type: "text" as const, text }], details };
}

function excerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
