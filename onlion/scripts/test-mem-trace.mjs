/* eslint-disable no-console -- deliberate test output */
/* The memory trace exists to answer one question the incident log cannot: whether the
 * reported 762-1014 MB is the container baseline or something the request accumulated. It
 * is only useful if it samples fast requests too, so the assertions here check the sampling
 * policy and the report shape rather than any particular number. */
import assert from "node:assert/strict";
import { memFields, memLog, memRequestStarted, baselineMemory } from "../backend/mem-trace.mjs";
import { sqliteStats } from "../backend/sqlite.mjs";

const lines = [];
const realLog = console.log;
console.log = (line) => lines.push(line);
function parse(line) {
  assert.equal(typeof line, "string", "the trace writes one JSON line per sample");
  return JSON.parse(line);
}

try {
  // Off means off: an operator disabling the trace must not pay for it.
  process.env.NMG_MEM_TRACE = "0";
  memRequestStarted("add");
  memLog("exit", "add", {});
  assert.equal(lines.length, 0, "NMG_MEM_TRACE=0 must emit nothing");

  // Every request, with the baseline captured before SQLite was loaded.
  process.env.NMG_MEM_TRACE = "1";
  memRequestStarted("search");
  const enter = parse(lines.at(-1));
  assert.equal(enter.event, "nmg_mem_sample");
  assert.equal(enter.phase, "enter");
  assert.equal(enter.route, "search");
  assert.ok(enter.instance.seq >= 1, "the sequence number counts requests in this instance");
  assert.equal(
    enter.instance.baseline_rss,
    baselineMemory().rss,
    "the baseline is the reading taken when the module loaded",
  );
  assert.ok(enter.instance.baseline_rss > 0);
  for (const key of ["rss", "heapUsed", "heapTotal", "external", "arrayBuffers"])
    assert.equal(typeof enter.mem[key], "number", `mem.${key} must be reported`);

  // A second request in the same instance advances the counter: a leak only means anything
  // per instance, so the sequence number is what a trend is read against.
  const before = parse(lines.at(-1)).instance.seq;
  memRequestStarted("add");
  assert.equal(parse(lines.at(-1)).instance.seq, before + 1, "each request advances by one");

  // The slow-request line is emitted anyway, so its fields must never be sampled away.
  const fields = memFields({ sqlite: sqliteStats() });
  for (const key of ["mem", "instance", "sqlite"])
    assert.ok(key in fields, `memFields must always carry ${key}`);
  assert.equal(typeof fields.sqlite.high_water_image_mb, "number");

  // Default policy samples, and samples the *first* request: a trace that only ever saw hung
  // requests could not be compared with anything.
  delete process.env.NMG_MEM_TRACE;
  lines.length = 0;
  // The counter is per instance and already advanced, so the window has to be measured
  // rather than assumed: twenty consecutive requests contain exactly one sample.
  for (let index = 0; index < 20; index += 1) memRequestStarted("add");
  assert.equal(lines.length, 1, "the default policy logs one request in twenty");
  assert.equal(parse(lines[0]).phase, "enter");
} finally {
  console.log = realLog;
}
console.log(
  "PASS: the memory trace samples fast requests, reports the instance baseline, and stays silent when disabled.",
);
