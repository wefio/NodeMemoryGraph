/* eslint-disable no-console -- the trace is log output by definition */
/* Memory self-reporting.
 *
 * The 2026-10-29 incident has 220 invocations that died at the 120 s ceiling carrying
 * 762-1014 MB, and nothing in the log says which component that was. Every one of those
 * rows is a *killed* request, so the sample is conditioned on the outcome: it cannot
 * separate a container baseline from a heap that grew inside a warm instance, and it
 * cannot tell how much of the number the request accumulated before it was killed.
 *
 * These lines are what separates them, at the cost of one `process.memoryUsage()` per
 * sampled request:
 *
 * - `baseline` is taken when this module is first evaluated, before SQLite exists. If it
 *   is already large, the platform figure includes the container and the V8 reservation,
 *   and every allocation we could optimise is noise against it.
 * - `seq` counts requests in this instance, so a trend can be read against request number
 *   instead of wall time. A leak only means something inside one warm instance.
 * - the breakdown (`heapUsed` vs `external`/`arrayBuffers`) says whether the growth is JS
 *   objects - a manifest or a JSON body - or byte buffers, which is where a WASM linear
 *   memory that only grows would show up.
 *
 * Sampling: `NMG_MEM_TRACE=0` disables, `=1` logs every request, unset logs one in
 * `SAMPLE_EVERY`. Fast requests are sampled on purpose: a sample that only contains
 * hung requests cannot be compared with anything.
 */
const MB = (bytes) => Math.round((bytes ?? 0) / 10485.76) / 100;
/** Captured at module evaluation: the earliest point our code runs, before SQLite. */
const baseline = (() => {
  const m = process.memoryUsage();
  return { rss: MB(m.rss), heapTotal: MB(m.heapTotal), uptime_s: Math.round(process.uptime()) };
})();
const SAMPLE_EVERY = 20;
let seq = 0;

const mode = () => (process.env.NMG_MEM_TRACE ?? "").trim();
const disabled = () => mode() === "0";
const every = () => (mode() === "1" ? 1 : SAMPLE_EVERY);
/** `NMG_MEM_TRACE=1` samples every request, which `n % 1` would never select. */
const due = (n) => {
  const step = every();
  return step <= 1 || n % step === 1;
};

function memUsage() {
  const m = process.memoryUsage();
  return {
    rss: MB(m.rss),
    heapUsed: MB(m.heapUsed),
    heapTotal: MB(m.heapTotal),
    external: MB(m.external),
    arrayBuffers: MB(m.arrayBuffers),
  };
}

/** Fields for a report that is emitted anyway (the slow-request line): never sampled,
 *  so a slow request always carries its memory and its instance position. */
export function memFields(extra = {}) {
  return {
    mem: memUsage(),
    instance: { seq, uptime_s: Math.round(process.uptime()), baseline_rss: baseline.rss },
    ...extra,
  };
}

/** Allocates this request's sequence number and logs the entry sample when it is due. */
export function memRequestStarted(route, extra = {}) {
  seq += 1;
  if (disabled() || !due(seq)) return seq;
  console.log(
    JSON.stringify({
      event: "nmg_mem_sample",
      phase: "enter",
      at: new Date().toISOString(),
      route,
      ...memFields(extra),
    }),
  );
  return seq;
}

/** Logs one more sample for the current request when the policy allows it. */
export function memLog(phase, route, extra = {}) {
  if (disabled() || !due(seq)) return;
  console.log(
    JSON.stringify({
      event: "nmg_mem_sample",
      phase,
      at: new Date().toISOString(),
      route,
      ...memFields(extra),
    }),
  );
}

/** Exposed for tests: the baseline captured at module evaluation. */
export function baselineMemory() {
  return { ...baseline };
}
