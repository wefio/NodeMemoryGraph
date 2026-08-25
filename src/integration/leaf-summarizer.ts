/**
 * Leaf-block semantic summaries: an external LLM writes retrieval-index text
 * for each leaf block; the store (LLM-free) persists it via setLeafSummary and
 * routes queries over it (block FTS + leaf embeddings). The summary is index
 * metadata — matched against queries to pull the block's verbatim members into
 * the context, never surfaced as a result itself.
 *
 * Trigger discipline: generation runs on the remember-triggered maintenance
 * drain (daemon) and on the benchmark's post-ingest pass — the same helper in
 * both, so production and benchmark exercise the same code path. Write-time
 * remember stays LLM-free and cheap.
 *
 * Provider pattern mirrors the embedding/judge clients: NMG ships no model,
 * the caller configures an OpenAI-compatible endpoint via NMG_SUMMARY_*
 * (falling back to NMG_JUDGE_* / EVAL_* / ANSWER_*).
 */

import type { NmgStore } from "../core/store.ts";
import type { LeafSummaryProvider } from "../core/types.ts";
import { OpenAiCompletionClient, type OpenAiCompletionOptions } from "./openai-completion.ts";
import { drainSummaryTasks, type SummaryDrainResult } from "./summary-drain.ts";

/** Bump when the prompt changes; recorded in benchmark manifests. */
export const LEAF_SUMMARY_PROMPT_VERSION = "leaf-summary-v1";

const LEAF_SUMMARY_SYSTEM_PROMPT = `You are building a retrieval index for a personal memory store.
Below is a block of related memories from one cluster. Write a compact index
summary whose ONLY job is to make future queries find this block.

Rules:
- Preserve every specific entity name, date, number, preference, plan and
  decision verbatim — those are what future questions ask about.
- Omit only redundancy; never trade specifics for fluent prose.
- Use noun phrases and short statements, not paragraphs.
- Optionally append up to 3 likely future questions this block answers,
  each on its own line prefixed with "Q:".
- At most 180 words, plain text only.`;

export type OpenAiLeafSummaryOptions = OpenAiCompletionOptions;

export class OpenAiLeafSummaryProvider implements LeafSummaryProvider {
  readonly model: string;
  readonly baseUrl: string;
  readonly #client: OpenAiCompletionClient;

  constructor(options: OpenAiLeafSummaryOptions) {
    this.#client = new OpenAiCompletionClient(options);
    this.baseUrl = this.#client.baseUrl;
    this.model = this.#client.model;
  }

  async summarize(input: { nodeName: string; statements: readonly string[] }): Promise<string> {
    return this.#client.complete(
      LEAF_SUMMARY_SYSTEM_PROMPT,
      [
        `Cluster: ${input.nodeName}`,
        "",
        "Memories:",
        ...input.statements.map((statement) => `- ${statement}`),
      ].join("\n"),
    );
  }
}

export function createLeafSummaryProviderFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): LeafSummaryProvider | undefined {
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
  return new OpenAiLeafSummaryProvider({
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

export type LeafSummaryDrainResult = SummaryDrainResult;

/** Summarize every pending block, bounded per call. LLM calls run with
 *  bounded concurrency; the small setLeafSummary writes stay serial. A round
 *  in which every task failed is treated as systematic (endpoint down) and
 *  stops the drain instead of hot-looping. */
export async function drainLeafSummaries(
  store: NmgStore,
  provider: LeafSummaryProvider,
  options: { batch?: number; concurrency?: number; maxCalls?: number } = {},
): Promise<LeafSummaryDrainResult> {
  return drainSummaryTasks({
    ...options,
    pull: (limit) => store.pendingLeafSummaries({ limit }),
    summarize: (task) =>
      provider.summarize({ nodeName: task.nodeName, statements: task.statements }),
    commit: (task, summary) =>
      store.setLeafSummary(task.blockId, summary, provider.model, task.membersKey),
  });
}
