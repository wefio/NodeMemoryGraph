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
import type { MemoryContext, MemoryTier } from "../../../src/core/types.ts";

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
  const connection = (): Promise<DaemonConnection> =>
    (connectionPromise ??= connectDaemon(databasePath()));
  const invoke = async (method: "get" | "remember" | "search", params: Record<string, unknown>) =>
    invokeDaemon(await connection(), method, params);

  pi.on("before_agent_start", async (event) => {
    if (!shouldAutoRecall(event.prompt)) {
      return { systemPrompt: `${event.systemPrompt}\n\n${MEMORY_POLICY}` };
    }
    try {
      const context = (await invoke("search", {
        query: event.prompt,
        projectDir: projectDirectory(),
        maxTier: configuredAutoRecallTier(),
        limit: configuredAutoRecallLimit(),
        graphHops: 1,
      })) as MemoryContext;
      const recalled = formatMemoryContext(context);
      return {
        systemPrompt: [
          event.systemPrompt,
          MEMORY_POLICY,
          recalled ? `<nmg_automatic_recall>\n${recalled}\n</nmg_automatic_recall>` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      };
    } catch (error) {
      return {
        systemPrompt: `${event.systemPrompt}\n\n<nmg_status>NMG unavailable: ${message(error)}</nmg_status>`,
      };
    }
  });

  pi.on("session_shutdown", async () => {
    if (!connectionPromise) return;
    const active = await connectionPromise.catch(() => undefined);
    connectionPromise = undefined;
    if (active) await shutdownOwnedDaemon(active);
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
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await invoke("remember", {
        ...params,
        projectDir: projectDirectory(),
        sessionId: ctx.sessionManager.getSessionId(),
      });
      return toolResult(result, "Memory saved.");
    },
  });

  pi.registerTool({
    name: "nmg_get",
    label: "Get NMG evidence",
    description: "Load exact memory and evidence for IDs returned by nmg_search.",
    parameters: Type.Object({
      memoryIds: Type.Array(Type.String(), { minItems: 1, maxItems: 50 }),
      graphHops: Type.Optional(Type.Number({ minimum: 0, maximum: 3 })),
    }),
    async execute(_toolCallId, params) {
      const result = (await invoke("get", { ...params, projectDir: projectDirectory() })) as MemoryContext;
      return toolResult(result, formatMemoryContext(result) || "No active memory found.");
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
    }),
    async execute(_toolCallId, params) {
      const result = (await invoke("search", {
        ...params,
        projectDir: projectDirectory(),
      })) as MemoryContext;
      return toolResult(result, formatSearchHeaders(result));
    },
  });
}

const MEMORY_POLICY =
  `<nmg_policy>\n` +
  `NMG is durable memory. Automatically save stable facts, preferences, constraints, ` +
  `current states, significant events, and reusable strategies. Use a stable stateKey ` +
  `for changeable state. Preserve a short exact evidence excerpt. Do not save secrets, ` +
  `temporary chatter, duplicates, or unsupported assistant guesses. Automatic recall is ` +
  `a small working set. When it is incomplete, call nmg_search; call nmg_get before ` +
  `relying on exact values or source evidence.\n` +
  `</nmg_policy>`;

function configuredAutoRecallTier(): MemoryTier {
  const value = Number(process.env.NMG_AUTO_RECALL_TIER ?? 1);
  return Math.max(0, Math.min(3, Number.isFinite(value) ? Math.floor(value) : 1)) as MemoryTier;
}

function configuredAutoRecallLimit(): number {
  const value = Number(process.env.NMG_AUTO_RECALL_LIMIT ?? 8);
  return Math.max(1, Math.min(20, Number.isFinite(value) ? Math.floor(value) : 8));
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
    ...context.results.map(
      ({ memory, node }) =>
        `- memory=${memory.id}; node=${node.canonicalName}; type=${memory.memoryType}; ` +
        `tier=L${memory.tier}; preview=${excerpt(memory.statement, 160)}`,
    ),
    "Use nmg_get with selected memory IDs to load exact evidence.",
  ].join("\n");
}

export function formatMemoryContext(context: MemoryContext): string {
  return context.results
    .map(({ memory, node, evidence }) => {
      const source =
        evidence.content.trim() !== memory.statement.trim()
          ? `\n  SOURCE=${excerpt(evidence.content, 320)}`
          : "";
      return (
        `- ${memory.statement}\n  memory=${memory.id}; node=${node.canonicalName}; ` +
        `type=${memory.memoryType}; truth=${memory.truthStatus}; scope=${JSON.stringify(memory.scope)}` +
        source
      );
    })
    .join("\n");
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
