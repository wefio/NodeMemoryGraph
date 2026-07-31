/**
 * Perf — per-phase timing for core NMG operations.
 *
 * Each instrumented operation records a flat map of section -> ms (wall time),
 * plus a total. Sections may nest by name (start/stop pairs, guarded against
 * misordered stops); nested time is counted inside the parent because both
 * appear in the flat map.
 *
 * Zero-cost when disabled: an off timer records nothing and `measure` runs the
 * function directly, so callers can gate whole pipelines on one boolean.
 */
export interface FlatTimings {
  [section: string]: number;
}

export interface PerfSnapshot {
  /** Per-section wall time in milliseconds (2 decimal places). */
  timings: FlatTimings;
  /** Total wall time for the instrumented operation, in ms. */
  totalMs: number;
}

export class PerfTimer {
  #enabled = true;
  #sections = new Map<string, number>();
  #started = new Map<string, number>();
  #totalMs = 0;

  get enabled(): boolean {
    return this.#enabled;
  }

  set enabled(value: boolean) {
    this.#enabled = value;
    if (!value) this.clear();
  }

  clear(): void {
    this.#sections.clear();
    this.#started.clear();
    this.#totalMs = 0;
  }

  start(section: string): void {
    if (!this.#enabled) return;
    this.#started.set(section, performance.now());
  }

  /** Stop a section and accumulate its wall time. Nested same-name sections
   *  are unsupported within one phase (sequential reuse is the norm). */
  stop(section: string): void {
    if (!this.#enabled) return;
    const startedAt = this.#started.get(section);
    if (startedAt === undefined) return;
    this.#started.delete(section);
    const ms = performance.now() - startedAt;
    this.#sections.set(section, (this.#sections.get(section) ?? 0) + ms);
  }

  /** Record an external span (e.g. an async call) directly, in ms. */
  add(section: string, ms: number): void {
    if (!this.#enabled) return;
    this.#sections.set(section, (this.#sections.get(section) ?? 0) + ms);
  }

  /** Run fn while recording `section`; returns fn's value. */
  measure<T>(section: string, fn: () => T): T {
    if (!this.#enabled) return fn();
    this.start(section);
    try {
      return fn();
    } finally {
      this.stop(section);
    }
  }

  /** Total wall time since the first instrumented section started. */
  get totalMs(): number {
    return this.#totalMs;
  }

  /** Fix the total after a top-level operation completes. */
  setTotal(totalMs: number): void {
    if (!this.#enabled) return;
    this.#totalMs = totalMs;
  }

  snapshot(): PerfSnapshot {
    const timings: FlatTimings = {};
    for (const [section, ms] of this.#sections) timings[section] = roundMs(ms);
    return { timings, totalMs: roundMs(this.#totalMs) };
  }
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sub-millisecond wall-clock mark (Date.now() truncates to whole ms). */
export function nowMs(): number {
  return performance.now();
}

/** Section names used across the store, kept in one place so docs and traces
 *  share the vocabulary. */
export const SECTION = {
  searchDirect: "search.direct",
  relations: "relations",
  relatedExpansion: "search.related",
  secondPass: "search.secondPass",
  selection: "selection",
  edges: "edges",
  trace: "trace",
  write: "write",
} as const;

export type Section = (typeof SECTION)[keyof typeof SECTION];
