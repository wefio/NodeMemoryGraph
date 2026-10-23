import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Retry observability for benchmark LLM calls.
//
// The official client retries a failed call up to `max_retries` times (default
// 4, so five attempts) and prints `⚠ [ANSWER] LLM retry k/N: ...` for each
// retry. Only the successful attempt reaches TokenTracker, so a retry that the
// provider already billed — a client timeout after generation, or a 502 on the
// response path — leaves no trace in the token report. This module counts the
// printed warnings so a run records how many attempts it actually made.
//
// Counting is deliberately textual: the retry loop lives in the pinned upstream
// checkout, and the warning line is its public surface. The capture therefore
// tees the child's output instead of modifying official code.

export type RetryModuleReport = {
  /** Retried attempts observed for this module (not including successes). */
  retries: number;
  /** Highest retry index seen, i.e. the most attempts a single call needed. */
  maxAttemptSeen: number;
  /** Successful calls, when the caller can supply them. */
  calls?: number;
  /** (calls + retries) / calls, rounded; null when calls is unknown or zero. */
  attemptsPerCall?: number | null;
};

export type RetryReport = {
  totalRetries: number;
  byModule: Record<string, RetryModuleReport>;
  /** Overall attempts per successful call; null when call counts are unknown. */
  attemptsPerCall: number | null;
  /** First few raw retry lines, for the failure that caused them. */
  samples: string[];
};

/** Write the retry report to `<resultDir>/retry_report.json`. Same location and
 * failure policy as the resource report: diagnostic only. */
export function writeRetryReport(report: RetryReport, resultDir: string): string {
  const path = join(resultDir, "retry_report.json");
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}

export type RetryCapture = {
  /** Feed one output chunk. Warnings split across chunks are buffered. */
  push(chunk: string): void;
  /** Count anything left in the buffer without a trailing newline. */
  flush(): void;
  /** Current report; optional successful-call counts per module. */
  report(calls?: Record<string, number>): RetryReport;
};

const RETRY_LINE = /\[([A-Za-z0-9_]+)\]\s+LLM retry\s+(\d+)\/(\d+)/u;
const MAX_SAMPLES = 5;

export function createRetryCapture(): RetryCapture {
  let pending = "";
  let totalRetries = 0;
  const modules = new Map<string, { retries: number; maxAttemptSeen: number }>();
  const samples: string[] = [];

  const consume = (line: string): void => {
    const match = RETRY_LINE.exec(line);
    if (!match) return;
    const module = match[1].toUpperCase();
    const attempt = Number(match[2]);
    const entry = modules.get(module) ?? { retries: 0, maxAttemptSeen: 0 };
    entry.retries += 1;
    entry.maxAttemptSeen = Math.max(entry.maxAttemptSeen, attempt);
    modules.set(module, entry);
    totalRetries += 1;
    if (samples.length < MAX_SAMPLES) samples.push(line.trim().slice(0, 300));
  };

  const drain = (): void => {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      const line = pending.slice(0, newline).replace(/\r$/u, "");
      pending = pending.slice(newline + 1);
      consume(line);
    }
  };

  return {
    push(chunk: string): void {
      pending += chunk;
      drain();
    },
    flush(): void {
      if (pending) {
        consume(pending.replace(/\r$/u, ""));
        pending = "";
      }
    },
    report(calls?: Record<string, number>): RetryReport {
      const byModule: Record<string, RetryModuleReport> = {};
      let totalCalls = 0;
      let countedCalls = 0;
      for (const [module, entry] of modules) {
        const moduleCalls = calls?.[module];
        byModule[module] = {
          retries: entry.retries,
          maxAttemptSeen: entry.maxAttemptSeen,
          ...(moduleCalls === undefined
            ? {}
            : {
                calls: moduleCalls,
                attemptsPerCall:
                  moduleCalls > 0
                    ? Math.round(((moduleCalls + entry.retries) / moduleCalls) * 10_000) / 10_000
                    : null,
              }),
        };
        if (moduleCalls !== undefined && moduleCalls > 0) {
          totalCalls += moduleCalls;
          countedCalls += moduleCalls;
        }
      }
      return {
        totalRetries,
        byModule,
        attemptsPerCall:
          countedCalls > 0
            ? Math.round(((totalCalls + totalRetries) / totalCalls) * 10_000) / 10_000
            : null,
        samples: [...samples],
      };
    },
  };
}
