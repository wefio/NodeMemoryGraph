export const AUTOMATIC_RECALL_BUDGET_MS = 5_000;

export class RecallDeadlineExceeded extends Error {
  constructor(milliseconds: number) {
    super(`automatic recall exceeded its ${milliseconds}ms total budget`);
    this.name = "RecallDeadlineExceeded";
  }
}

export interface RecallStageTiming {
  phase: string;
  elapsedMs: number;
  outcome: "completed" | "timeout" | "error";
}

/** One absolute deadline for the whole automatic hook, never a fresh budget per RPC. */
export class RecallBudget {
  readonly #startedAt = performance.now();
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout>;
  readonly #milliseconds: number;
  readonly stages: RecallStageTiming[] = [];
  readonly signal: AbortSignal;

  constructor(milliseconds = AUTOMATIC_RECALL_BUDGET_MS, parentSignal?: AbortSignal) {
    this.#milliseconds = milliseconds;
    this.signal = parentSignal
      ? AbortSignal.any([parentSignal, this.#controller.signal])
      : this.#controller.signal;
    this.#timer = setTimeout(() => this.#expire(), milliseconds);
  }

  get remainingMs(): number {
    return Math.max(0, this.#milliseconds - (performance.now() - this.#startedAt));
  }

  get expired(): boolean {
    return this.#controller.signal.aborted;
  }

  async run<T>(phase: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.remainingMs <= 0) this.#expire();
    this.signal.throwIfAborted();
    const startedAt = performance.now();
    let onAbort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
    });
    let outcome: RecallStageTiming["outcome"] = "completed";
    try {
      const value = await Promise.race([operation(this.signal), interrupted]);
      if (this.remainingMs <= 0) this.#expire();
      this.signal.throwIfAborted();
      return value;
    } catch (error) {
      outcome = this.expired ? "timeout" : "error";
      throw error;
    } finally {
      this.signal.removeEventListener("abort", onAbort);
      this.stages.push({ phase, elapsedMs: performance.now() - startedAt, outcome });
    }
  }

  close(): void {
    clearTimeout(this.#timer);
  }

  timing(): { budgetMs: number; elapsedMs: number; expired: boolean; stages: RecallStageTiming[] } {
    return {
      budgetMs: this.#milliseconds,
      elapsedMs: performance.now() - this.#startedAt,
      expired: this.expired,
      stages: [...this.stages],
    };
  }

  #expire(): void {
    this.#controller.abort(new RecallDeadlineExceeded(this.#milliseconds));
  }
}
