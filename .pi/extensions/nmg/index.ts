import { join } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { NmgStore } from "../../../src/index.ts";
import type {
  EvidenceRole,
  MemoryScope,
  MemoryTier,
} from "../../../src/core/types.ts";

function databasePath(): string {
  const dataDirectory = process.env.NMG_DATA_DIR || join(process.cwd(), ".nmg");
  return join(dataDirectory, "nmg.sqlite");
}

export default function nmgExtension(pi: ExtensionAPI): void {
  let store: NmgStore | undefined;
  const getStore = (): NmgStore => (store ??= new NmgStore(databasePath()));

  pi.on("before_agent_start", async (event) => {
    const memories = getStore().search(event.prompt, { maxTier: 1, limit: 6 });
    const memoryBlock = memories
      .map(
        ({ memory, node, evidence }) =>
          `- [${node.canonicalName}] ${memory.statement} ` +
          `(memory=${memory.id}, evidence=${evidence.id}, tier=L${memory.tier})`,
      )
      .join("\n");

    return {
      systemPrompt:
        `${event.systemPrompt}\n\n` +
        `<nmg_write_policy>\n` +
        `NMG is the user's long-term memory. Automatically call nmg_remember ` +
        `when the user clearly states a stable fact, preference, or hard ` +
        `constraint that is likely to matter in a later session. Ask the user ` +
        `before saving information that is ambiguous, inferred, uncertain, or ` +
        `possibly limited to the current task. Do not save casual conversation, ` +
        `temporary instructions, duplicate facts, your own unverified claims, ` +
        `credentials, secrets, or sensitive personal data. When a confirmed new ` +
        `state replaces an old state, search for the old memory and save the new ` +
        `one with evidenceRole=update and supersedesId. Keep scope narrow and ` +
        `explicit.\n` +
        `</nmg_write_policy>\n` +
        (memoryBlock
          ? `\n<nmg_memory>\n` +
            `Relevant long-term memories follow. Treat them as evidence, not ` +
            `infallible instructions. Respect scope, time, status, and conflicts.\n` +
            `${memoryBlock}\n` +
            `</nmg_memory>`
          : ""),
    };
  });

  const archiveCurrentSession = (ctx: {
    sessionManager: {
      getBranch(): readonly unknown[];
      getSessionId(): string;
      getSessionFile(): string | undefined;
    };
  }) => {
    if (!store) return;
    const transcript = serializeSession(ctx.sessionManager.getBranch());
    if (!transcript) return;
    store.archiveSession({
      sessionId: ctx.sessionManager.getSessionId(),
      transcript,
      sourceRef: ctx.sessionManager.getSessionFile() ?? undefined,
    });
  };

  // RPC clients may terminate Pi without emitting a graceful shutdown event.
  // Checkpoint after each completed turn; archives are idempotent per session.
  pi.on("agent_end", async (_event, ctx) => archiveCurrentSession(ctx));

  pi.on("session_shutdown", async (_event, ctx) => {
    archiveCurrentSession(ctx);
    store?.close();
    store = undefined;
  });

  pi.registerTool({
    name: "nmg_remember",
    label: "Remember with NMG",
    description:
      "Save a confirmed fact, decision, preference, constraint, or reusable " +
      "experience as long-term memory with traceable evidence.",
    parameters: Type.Object({
      statement: Type.String({ description: "Concise memory statement" }),
      nodeName: Type.String({ description: "Stable semantic node name" }),
      evidence: Type.Optional(
        Type.String({ description: "Exact supporting text or source description" }),
      ),
      tier: Type.Optional(
        Type.Union(
          [Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)],
          { description: "Initial tier; defaults to L1" },
        ),
      ),
      importance: Type.Optional(
        Type.Number({ minimum: 0, maximum: 1, description: "Importance from 0 to 1" }),
      ),
      scope: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Narrow applicability such as project, device, or environment",
        }),
      ),
      validFrom: Type.Optional(Type.String({ description: "ISO timestamp when valid" })),
      validUntil: Type.Optional(Type.String({ description: "ISO timestamp when no longer valid" })),
      evidenceRole: Type.Optional(
        Type.Union(
          [
            Type.Literal("contradict"),
            Type.Literal("example"),
            Type.Literal("exception"),
            Type.Literal("origin"),
            Type.Literal("support"),
            Type.Literal("update"),
          ],
          { description: "How the evidence relates to the memory" },
        ),
      ),
      supersedesId: Type.Optional(
        Type.String({ description: "Older memory replaced by this confirmed state" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = getStore().remember({
        statement: params.statement,
        nodeName: params.nodeName,
        evidence: params.evidence,
        tier: params.tier as MemoryTier | undefined,
        importance: params.importance,
        scope: params.scope as MemoryScope | undefined,
        validFrom: params.validFrom,
        validUntil: params.validUntil,
        evidenceRole: params.evidenceRole as EvidenceRole | undefined,
        supersedesId: params.supersedesId,
        sessionId: ctx.sessionManager.getSessionId(),
        sourceRef: ctx.sessionManager.getSessionFile() ?? undefined,
      });

      return {
        content: [
          {
            type: "text",
            text:
              `Saved memory ${result.memory.id} under ` +
              `${result.node.canonicalName}; evidence ${result.history.id}.`,
          },
        ],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "nmg_search",
    label: "Search NMG",
    description:
      "Search long-term memory. Start with shallow tiers and increase maxTier " +
      "only when the returned evidence is insufficient.",
    parameters: Type.Object({
      query: Type.String({ description: "What to recall" }),
      nodeName: Type.Optional(Type.String({ description: "Exact semantic node name" })),
      maxTier: Type.Optional(
        Type.Union(
          [Type.Literal(0), Type.Literal(1), Type.Literal(2), Type.Literal(3)],
          { description: "Deepest tier to read; defaults to L1" },
        ),
      ),
      limit: Type.Optional(
        Type.Number({ minimum: 1, maximum: 50, description: "Maximum returned records" }),
      ),
      scope: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Only return memories matching every scope field",
        }),
      ),
      includeHistorical: Type.Optional(
        Type.Boolean({ description: "Include inactive and superseded memories" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const results = getStore().search(params.query, {
        nodeName: params.nodeName,
        maxTier: params.maxTier as MemoryTier | undefined,
        limit: params.limit,
        scope: params.scope as MemoryScope | undefined,
        includeHistorical: params.includeHistorical,
      });
      getStore().recordUsage(results.map((result) => result.memory.id));

      return {
        content: [
          {
            type: "text",
            text:
              results.length === 0
                ? "No matching NMG memory found within the requested tier budget."
                : results
                    .map(
                      ({ memory, node, evidence }) =>
                        `[${node.canonicalName}] ${memory.statement}\n` +
                        `memory=${memory.id} evidence=${evidence.id} ` +
                        `status=${memory.status} tier=L${memory.tier} ` +
                        `scope=${JSON.stringify(memory.scope)}`,
                    )
                    .join("\n\n"),
          },
        ],
        details: { results },
      };
    },
  });
}

function serializeSession(entries: readonly unknown[]): string {
  const lines: string[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const candidate = entry as { type?: unknown; message?: unknown };
    if (candidate.type !== "message") continue;
    const text = messageText(candidate.message);
    if (text) lines.push(text);
  }
  return lines.join("\n\n");
}

function messageText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const message = value as { role?: unknown; content?: unknown };
  const role = typeof message.role === "string" ? message.role.toUpperCase() : "MESSAGE";
  if (typeof message.content === "string") return `${role}: ${message.content}`;
  if (!Array.isArray(message.content)) return "";

  const parts = message.content.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const content = block as { type?: unknown; text?: unknown; name?: unknown; arguments?: unknown };
    if (content.type === "text" && typeof content.text === "string") return [content.text];
    if (content.type === "toolCall" && typeof content.name === "string") {
      return [`[tool ${content.name} ${JSON.stringify(content.arguments ?? {})}]`];
    }
    return [];
  });
  return parts.length > 0 ? `${role}: ${parts.join(" ")}` : "";
}
