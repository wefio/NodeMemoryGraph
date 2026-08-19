/**
 * Node-level semantic summaries: an external LLM writes one retrieval-index
 * text per node (cluster), built from the node's leaf-block summaries rather
 * than raw memories. The store (LLM-free) persists it via setNodeSummary and
 * routes queries over it (node FTS tier above leaf blocks). The summary is
 * index metadata under hysteresis — matched against queries to pull the node's
 * blocks into the context, never surfaced as a result itself.
 *
 * Refresh is hysteresis-driven, not fingerprint-strict: pendingNodeSummaries
 * collects nodes whose summary is missing, or with enough new members since
 * generation, or aged past a refresh window with any membership change. A
 * slightly stale node summary costs a little recall, never correctness, so
 * generation never chases every write.
 *
 * Trigger discipline mirrors leaf summaries: generation runs on the
 * remember-triggered maintenance drain (daemon) — the same helper in
 * production and benchmark, so both exercise the same code path.
 *
 * Provider pattern mirrors the embedding/judge clients: NMG ships no model,
 * the caller configures an OpenAI-compatible endpoint via NMG_SUMMARY_*
 * (falling back to NMG_JUDGE_* / EVAL_* / ANSWER_*).
 */

import type { NmgStore } from "../core/store.ts";
import type { NodeSummaryProvider } from "../core/types.ts";

/** Bump when the prompt changes; recorded in benchmark manifests. */
export const NODE_SUMMARY_PROMPT_VERSION = "node-summary-v1";

const NODE_SUMMARY_SYSTEM_PROMPT = `You are building a retrieval index for a personal memory store.
Below are semantic summaries of the blocks in one cluster (node). Write a
compact node-level index summary whose ONLY job is to make future queries
find this node's blocks.

Rules:
- Preserve every specific entity name, date, number, preference, plan and
  decision verbatim across the blocks — those are what future questions ask.
- Cover the distinct facets and topics present across the blocks; do not
  collapse them into one generic theme.
- Omit only redundancy; never trade specifics for fluent prose.
- Use noun phrases and short statements, not paragraphs.
- Optionally append up to 3 likely future questions this node answers,
  each on its own line prefixed with "Q:".
- At most 200 words, plain text only.`;

export interface OpenAiNodeSummaryOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs?: number;
  /** Hard output budget (max_tokens); the 200-word cap needs ~280 tokens. */
  maxTokens?: number;
  /** Injectable fetch for tests. */
  fetch?: typeof fetch;
}

export class OpenAiNodeSummaryProvider implements NodeSummaryProvider {
  readonly model: string;
  readonly baseUrl: string;
  readonly #apiKey?: string;
  readonly #timeoutMs: number;
  readonly #maxTokens: number;
  readonly #fetch: typeof fetch;

  constructor(options: OpenAiNodeSummaryOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.model = options.model;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#maxTokens = options.maxTokens ?? 600;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async summarize(input: {
    nodeName: string;
    statements: readonly string[];
  }): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: "system", content: NODE_SUMMARY_SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            `Cluster: ${input.nodeName}`,
            "",
            "Block summaries:",
            ...input.statements.map((statement) => `- ${statement}`),
          ].join("\n"),
        },
      ],
      stream: false,
      max_tokens: this.#maxTokens,
    };
    const deepSeekRequest = /deepseek/i.test(this.baseUrl) || /deepseek/i.test(this.model);
    if (deepSeekRequest) {
      // Same rationale as the judge/summary clients: disable server-side
      // thinking so content is never left empty by reasoning-only responses.
      body.temperature = 0;
      body.thinking = { type: "disabled" };
    } else {
      body.temperature = 0;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`summary endpoint HTTP ${response.status}`);
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string | null } }>;
      };
      const content = payload.choices?.[0]?.message?.content?.trim();
      if (!content) throw new Error("summary endpoint returned empty content");
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createNodeSummaryProviderFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): NodeSummaryProvider | undefined {
  const firstNonEmpty = (...values: Array<string | undefined>): string | undefined =>
    values.find((v) => v && v.trim().length > 0)?.trim();
  const disabledRaw = environment.NMG_SUMMARY_DISABLED?.trim().toLowerCase();
  if (disabledRaw === "1" || disabledRaw === "true") return undefined;
  const baseUrl = firstNonEmpty(
    environment.NMG_SUMMARY_BASE_URL,
    environment.NMG_JUDGE_BASE_URL,
    environment.EVAL_BASE_URL,
    environment.ANSWER_BASE_URL,
  );
  if (!baseUrl) return undefined;
  const maxTokensRaw = Number(environment.NMG_SUMMARY_MAX_TOKENS?.trim());
  return new OpenAiNodeSummaryProvider({
    baseUrl,
    apiKey: firstNonEmpty(
      environment.NMG_SUMMARY_API_KEY,
      environment.NMG_JUDGE_API_KEY,
      environment.EVAL_API_KEY,
      environment.ANSWER_API_KEY,
    ),
    model:
      firstNonEmpty(
        environment.NMG_SUMMARY_MODEL,
        environment.NMG_JUDGE_MODEL,
        environment.EVAL_MODEL,
        environment.ANSWER_MODEL,
      ) ?? "deepseek-chat",
    timeoutMs: Number(environment.NMG_SUMMARY_TIMEOUT_MS) || 30_000,
    ...(Number.isInteger(maxTokensRaw) && maxTokensRaw > 0 ? { maxTokens: maxTokensRaw } : {}),
  });
}

export interface NodeSummaryDrainResult {
  summarized: number;
  /** LLM failures (node summaries have no stale rejection). */
  failed: number;
  /** True when pendingNodeSummaries still has work after this drain. */
  truncated: boolean;
}

/** Summarize every pending node, bounded per call. LLM calls run with bounded
 *  concurrency; the small setNodeSummary writes stay serial. A round in which
 *  every task failed is treated as systematic (endpoint down) and stops the
 *  drain instead of hot-looping. */
export async function drainNodeSummaries(
  store: NmgStore,
  provider: NodeSummaryProvider,
  options: {
    batch?: number;
    concurrency?: number;
    maxCalls?: number;
    /** Pending-node collection threshold: minimum summarized blocks before a
     *  node becomes pending. Passed through to pendingNodeSummaries. */
    minBlocks?: number;
  } = {},
): Promise<NodeSummaryDrainResult> {
  const batch = Math.max(1, Math.min(options.batch ?? 32, 256));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 32));
  const maxCalls = Math.max(1, options.maxCalls ?? Number.POSITIVE_INFINITY);
  const pendingOptions =
    options.minBlocks === undefined ? {} : { minBlocks: options.minBlocks };
  let summarized = 0;
  let failed = 0;
  let calls = 0;
  let truncated = false;
  for (;;) {
    const remainingBudget = maxCalls - calls;
    if (remainingBudget <= 0) {
      truncated = true;
      break;
    }
    const tasks = store.pendingNodeSummaries({
      limit: Math.min(batch, remainingBudget),
      ...pendingOptions,
    });
    if (tasks.length === 0) break;
    calls += tasks.length;
    let roundSummarized = 0;
    for (let offset = 0; offset < tasks.length; offset += concurrency) {
      const slice = tasks.slice(offset, offset + concurrency);
      const summaries = await Promise.all(
        slice.map((task) =>
          provider
            .summarize({ nodeName: task.nodeName, statements: task.statements })
            .then((text) => text.trim())
            .catch(() => ""),
        ),
      );
      for (const [index, task] of slice.entries()) {
        const text = summaries[index]!;
        if (!text) {
          failed += 1;
          continue;
        }
        if (store.setNodeSummary(task.nodeId, text, provider.model, task.memberCount)) {
          summarized += 1;
          roundSummarized += 1;
        }
      }
    }
    // No progress at all (endpoint down): stop instead of hot-looping the same
    // pending set.
    if (roundSummarized === 0) {
      truncated = true;
      break;
    }
  }
  return { summarized, failed, truncated };
}
