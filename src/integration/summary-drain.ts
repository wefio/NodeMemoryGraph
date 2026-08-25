export interface SummaryDrainOptions<TTask> {
  batch?: number;
  concurrency?: number;
  maxCalls?: number;
  pull(limit: number): TTask[];
  summarize(task: TTask): Promise<string>;
  /** False means the task changed before commit. It remains pending but is not
   * counted as a provider failure. */
  commit(task: TTask, summary: string): boolean;
}

export interface SummaryDrainResult {
  summarized: number;
  failed: number;
  truncated: boolean;
}

/** Shared bounded runner: model calls are concurrent, durable writes serial. */
export async function drainSummaryTasks<TTask>(
  options: SummaryDrainOptions<TTask>,
): Promise<SummaryDrainResult> {
  const batch = Math.max(1, Math.min(options.batch ?? 32, 256));
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 8, 32));
  const maxCalls = Math.max(1, options.maxCalls ?? Number.POSITIVE_INFINITY);
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
    const tasks = options.pull(Math.min(batch, remainingBudget));
    if (tasks.length === 0) break;
    calls += tasks.length;
    let roundSummarized = 0;
    for (let offset = 0; offset < tasks.length; offset += concurrency) {
      const slice = tasks.slice(offset, offset + concurrency);
      const summaries = await Promise.all(
        slice.map((task) =>
          options
            .summarize(task)
            .then((text) => text.trim())
            .catch(() => ""),
        ),
      );
      for (const [index, task] of slice.entries()) {
        const summary = summaries[index]!;
        if (!summary) {
          failed += 1;
          continue;
        }
        if (options.commit(task, summary)) {
          summarized += 1;
          roundSummarized += 1;
        }
      }
    }
    if (roundSummarized === 0) {
      truncated = true;
      break;
    }
  }
  return { summarized, failed, truncated };
}
