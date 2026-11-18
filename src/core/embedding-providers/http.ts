import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

const RETRY_DELAYS_MS = [150, 500];
const transports = new Map<string, EmbeddingHttpTransport>();

export function embeddingHttpTransport(url: string, key: string | undefined, concurrency: number) {
  const identity = createHash("sha256")
    .update(JSON.stringify([new URL(url).origin, key ?? "", concurrency]))
    .digest("hex");
  const transport = transports.get(identity) ?? new EmbeddingHttpTransport(concurrency);
  transports.set(identity, transport);
  return transport;
}

type RequestOptions = {
  timeoutMs: number;
  signal?: AbortSignal;
  background: boolean;
  retry?: boolean;
};

type Waiter = {
  start: () => void;
};

class EmbeddingHttpError extends Error {
  readonly status: number;
  readonly retryable: boolean;

  constructor(status: number, detail: string, retryable = true) {
    super(`embedding server returned ${status}: ${detail}`);
    this.status = status;
    this.retryable = retryable;
  }
}

/** Shares provider capacity and throttling across clients with the same transport settings. */
class EmbeddingHttpTransport {
  private readonly concurrency: number;
  private active = 0;
  private background = 0;
  private throttleUntil = 0;
  private readonly queries = new Set<Waiter>();
  private readonly documents = new Set<Waiter>();

  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  async json<T>(url: string, init: RequestInit, options: RequestOptions): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.request<T>(url, init, options, RETRY_DELAYS_MS[attempt] ?? 500);
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (
          delay === undefined ||
          options.retry === false ||
          options.signal?.aborted ||
          !retryable(error)
        )
          throw error;
        // A 429 already put the whole transport on hold.
        if (!(error instanceof EmbeddingHttpError && error.status === 429))
          await sleep(delay, undefined, { signal: options.signal });
      }
    }
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    options: RequestOptions,
    retryDelay: number,
  ): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    for (;;) {
      const release = await this.acquire(options.background, signal);
      let backoff: number;
      try {
        signal.throwIfAborted();
        backoff = this.throttleUntil - Date.now();
        if (backoff <= 0)
          return await abortable(this.fetchJson<T>(url, init, signal, retryDelay), signal);
        if (backoff >= options.timeoutMs)
          throw new EmbeddingHttpError(
            429,
            "provider Retry-After exceeds the request timeout",
            false,
          );
      } finally {
        release();
      }
      await sleep(backoff, undefined, { signal });
    }
  }

  private async fetchJson<T>(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    retryDelay: number,
  ): Promise<T> {
    const response = await fetch(url, { ...init, signal });
    if (response.ok) return (await response.json()) as T;
    if (response.status === 429) {
      const delay = retryAfterMs(response.headers.get("retry-after")) ?? retryDelay;
      this.throttleUntil = Math.max(this.throttleUntil, Date.now() + delay);
    }
    const detail = await response.text();
    throw new EmbeddingHttpError(response.status, detail);
  }

  private acquire(background: boolean, signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    const queue = background ? this.documents : this.queries;
    return new Promise((resolve, reject) => {
      const abort = () => {
        queue.delete(waiter);
        reject(signal.reason);
      };
      const waiter: Waiter = {
        start: () => {
          signal.removeEventListener("abort", abort);
          this.active++;
          if (background) this.background++;
          resolve(() => {
            this.active--;
            if (background) this.background--;
            this.dispatch();
          });
        },
      };
      queue.add(waiter);
      signal.addEventListener("abort", abort, { once: true });
      this.dispatch();
    });
  }

  private dispatch(): void {
    while (this.active < this.concurrency) {
      if (this.startFirst(this.queries)) continue;
      // Reserve one lane for recall when the provider allows concurrent requests.
      if (this.background >= Math.max(1, this.concurrency - 1)) return;
      if (!this.startFirst(this.documents)) return;
    }
  }

  private startFirst(queue: Set<Waiter>): boolean {
    const next = queue.values().next().value;
    if (!next) return false;
    queue.delete(next);
    next.start();
    return true;
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function retryable(error: unknown): boolean {
  if (error instanceof EmbeddingHttpError)
    return error.retryable && (error.status === 429 || error.status >= 500);
  return error instanceof TypeError;
}

function retryAfterMs(header: string | null): number | undefined {
  if (!header?.trim()) return undefined;
  if (/^\d+$/u.test(header)) {
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}
