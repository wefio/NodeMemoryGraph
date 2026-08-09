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

/**
 * Fixed-size log-scale histogram for long-term percentile estimation.
 * 64 buckets span 0.05 ms to ~10 s on a log scale — wide enough for every
 * NMG section, constant memory per section (~64 counts). Percentiles are
 * estimated by linear interpolation inside the bucket containing the rank.
 * Kept here (not in types.ts) because store.ts only stores/reads counts;
 * estimation lives at the display boundary.
 */
export const HISTOGRAM_BUCKETS = 64;
const HISTOGRAM_MIN_MS = 0.05;
const HISTOGRAM_MAX_MS = 10_000;

export function histogramAdd(buckets: readonly number[], ms: number): number[] {
  const next = new Array<number>(HISTOGRAM_BUCKETS).fill(0);
  for (let index = 0; index < Math.min(HISTOGRAM_BUCKETS, buckets.length); index += 1) {
    const count = buckets[index];
    if (typeof count === "number" && Number.isFinite(count)) next[index] = count;
  }
  const clamped = Math.min(HISTOGRAM_MAX_MS, Math.max(HISTOGRAM_MIN_MS, ms));
  const logMin = Math.log(HISTOGRAM_MIN_MS);
  const logMax = Math.log(HISTOGRAM_MAX_MS);
  const index = Math.min(
    HISTOGRAM_BUCKETS - 1,
    Math.max(0, Math.floor(((Math.log(clamped) - logMin) / (logMax - logMin)) * HISTOGRAM_BUCKETS)),
  );
  next[index] = (next[index] ?? 0) + 1;
  return next;
}

/** Estimated quantile (0..1) from histogram counts. */
export function histogramQuantile(buckets: readonly number[], ratio: number): number {
  const total = buckets.reduce((sum, count) => sum + (count ?? 0), 0);
  if (total === 0) return 0;
  const target = ratio * total;
  const logMin = Math.log(HISTOGRAM_MIN_MS);
  const logMax = Math.log(HISTOGRAM_MAX_MS);
  let cumulative = 0;
  for (let index = 0; index < HISTOGRAM_BUCKETS; index += 1) {
    cumulative += buckets[index] ?? 0;
    if (cumulative >= target) {
      const lower = Math.exp(logMin + (index / HISTOGRAM_BUCKETS) * (logMax - logMin));
      const upper = Math.exp(logMin + ((index + 1) / HISTOGRAM_BUCKETS) * (logMax - logMin));
      const within = cumulative - (buckets[index] ?? 0);
      const fraction = within === cumulative ? 0 : (target - within) / (cumulative - within);
      return lower + fraction * (upper - lower);
    }
  }
  return HISTOGRAM_MAX_MS;
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
  maintenance: "maintenance.batch",
  maintenanceSemantic: "maintenance.semantic",
} as const;

export type Section = (typeof SECTION)[keyof typeof SECTION];
