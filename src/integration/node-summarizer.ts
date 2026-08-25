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
import { OpenAiCompletionClient, type OpenAiCompletionOptions } from "./openai-completion.ts";
import { drainSummaryTasks, type SummaryDrainResult } from "./summary-drain.ts";

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

export type OpenAiNodeSummaryOptions = OpenAiCompletionOptions;

export class OpenAiNodeSummaryProvider implements NodeSummaryProvider {
  readonly model: string;
  readonly baseUrl: string;
  readonly #client: OpenAiCompletionClient;

  constructor(options: OpenAiNodeSummaryOptions) {
    this.#client = new OpenAiCompletionClient(options);
    this.baseUrl = this.#client.baseUrl;
    this.model = this.#client.model;
  }

  async summarize(input: { nodeName: string; statements: readonly string[] }): Promise<string> {
    return this.#client.complete(
      NODE_SUMMARY_SYSTEM_PROMPT,
      [
        `Cluster: ${input.nodeName}`,
        "",
        "Block summaries:",
        ...input.statements.map((statement) => `- ${statement}`),
      ].join("\n"),
    );
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

export type NodeSummaryDrainResult = SummaryDrainResult;

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
  const pendingOptions = options.minBlocks === undefined ? {} : { minBlocks: options.minBlocks };
  return drainSummaryTasks({
    batch: options.batch,
    concurrency: options.concurrency,
    maxCalls: options.maxCalls,
    pull: (limit) => store.pendingNodeSummaries({ limit, ...pendingOptions }),
    summarize: (task) =>
      provider.summarize({ nodeName: task.nodeName, statements: task.statements }),
    commit: (task, summary) =>
      store.setNodeSummary(task.nodeId, summary, provider.model, task.memberCount),
  });
}
