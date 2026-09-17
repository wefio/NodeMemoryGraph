// Advisory offline cost model for the granularity / concurrency arms of the main verification
// (`docs/design/task-unit-semantics.md`, "主验证：粒度、并发与融合").
//
// The design orders this before any paid call: "离线模型先覆盖不同粒度、依赖密度、共享上下文、事实
// 命中率及验证成本；它只能发现逻辑错误和成本转折点，不能预测真实模型质量". Two consequences are
// built in rather than promised:
//
//   - **It simulates cost only.** There is no quality term, because nothing here may stand in for
//     the parent check passing: a simulated pass rate is not a measured one.
//   - **Every term is a declared parameter, not a fitted constant.** The terms that stand for a real
//     quantity name it; the ones that are assumptions say so and are meant to be swept.
//
// What it computes for one plan shape and one cost vector:
//
//   - the dependency graph, derived from (units, density, seed) rather than hand-written, so a
//     "gain" cannot come from a graph picked to produce one;
//   - the makespan under `slots` execution slots and a *single* host check queue (the host runs one
//     candidate check at a time, which is the term the design says dominates every round);
//   - the coarse arm's own makespan on the same vector, so the two arms differ only in shape;
//   - the time concurrency actually bought, and the slot time nobody could use.
//
// Self-checks (`assertModelProperties`, all throwing): one slot reproduces the serial order and
// buys nothing; independent work on enough slots finishes in one unit plus as many checks as there
// are units; a chain buys nothing however many slots it has, and still pays the extra boundaries;
// and more dependencies never buy more overlap. The first version of this file failed the second
// check, because it forgot that the host queue serialises the checks.
//
// Usage:
//   node --experimental-strip-types evals/ooo-execution/cost-model.ts --units 4 --density 0.2 \
//     --work-ms 8000 --rederive-ms 6000 --hit-rate 0.5 --verify-ms 1500 --context-ms 1200 \
//     --coarse-context-saving 0.5 --slots 3 --out <file>
//   node --experimental-strip-types evals/ooo-execution/cost-model.ts --sweep --out <file>

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The plan's shape. `density` is the fraction of the possible forward edges that exist, so 0 is
 *  fully independent work and 1 is a chain. */
export interface PlanShape {
  units: number;
  density: number;
  seed: number;
}

/** The cost vector. Bracketed names say which real quantity a term stands for; `assumed` marks a
 *  term with no measurement behind it, which the sweep varies instead of fixing. */
export interface CostParams {
  /** Model work for one unit that has nothing to re-derive. [per-call latency] */
  workMs: number;
  /** The work a fact hit removes: re-deriving an artifact that is already accepted.
   *  [fact hit rate] */
  rederiveMs: number;
  hitRate: number;
  /** One candidate check on the host, run one at a time. [host cost] */
  verifyMs: number;
  /** A legal session boundary: re-establishing context for the next unit. [handoff cost] */
  contextMsPerUnit: number;
  /** How much the parent's single session saves by not paying that boundary per unit.
   *  `assumed`: the coarse arm is not free either, and this is the term an operator must justify. */
  coarseContextSaving: number;
  slots: number;
}

export interface Simulated {
  units: number;
  edges: number;
  /** Wall time of the fine plan: model work plus host checks on one host queue. */
  makespanMs: number;
  /** The same plan on one slot: the no-concurrency bound. */
  serialMs: number;
  /** Wall time of the coarse arm (one session doing the same work) on the same vector. */
  coarseMs: number;
  /** Host time spent checking candidates. Serial by construction. */
  hostMs: number;
  /** What concurrency bought: `serialMs - makespanMs`, and it is zero for a chain. */
  savedMs: number;
  /** The longest dependency chain, which is the floor no number of slots goes below. The design's
   *  question for the C arm is how much of this the schedule actually needs. */
  criticalPathMs: number;
  /** Slot time not spent on model work, including slots deliberately left unused. */
  unusedSlotMs: number;
  /** `busySlotMs / (makespanMs * slots)`: how much of the capacity bought was used. */
  slotUtilisation: number;
}

/** Deterministic forward edges from (units, density, seed): a split's shape is swept, not chosen. */
export function planEdges(shape: PlanShape): [number, number][] {
  if (!Number.isInteger(shape.units) || shape.units < 1)
    throw new Error(`units must be a positive integer, got ${shape.units}`);
  if (!(shape.density >= 0 && shape.density <= 1))
    throw new Error(`density must be within [0,1], got ${shape.density}`);
  const edges: [number, number][] = [];
  let state = shape.seed >>> 0;
  const random = () => {
    // xorshift32: reproducible from the seed, and the seed is recorded in the output.
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
  for (let from = 0; from < shape.units; from += 1)
    for (let to = from + 1; to < shape.units; to += 1)
      if (random() < shape.density) edges.push([from, to]);
  return edges;
}

function unitCost(shape: PlanShape, params: CostParams, withContext: boolean): number {
  return (
    params.workMs +
    (1 - params.hitRate) * params.rederiveMs +
    (withContext ? params.contextMsPerUnit : 0)
  );
}

/**
 * Greedy list scheduling over `slots` for model work, followed by one host queue for the checks.
 * A dependency is satisfied by an *accepted* artifact, so a unit waits for its predecessor's check,
 * not for its model call — which is the difference an out-of-order round exists to exploit.
 */
function schedule(
  shape: PlanShape,
  params: CostParams,
  edges: readonly [number, number][],
): {
  makespanMs: number;
  hostMs: number;
  unusedSlotMs: number;
  slotUtilisation: number;
} {
  const perUnit = unitCost(shape, params, true);
  const prerequisites = new Map<number, number[]>();
  for (const [from, to] of edges) prerequisites.set(to, [...(prerequisites.get(to) ?? []), from]);

  const slotFree = Array.from({ length: params.slots }, () => 0);
  const startedAt = new Map<number, number>();
  const modelEnd = new Map<number, number>();
  const doneAt = new Map<number, number>();
  let hostFree = 0;
  let hostMs = 0;

  const units = Array.from({ length: shape.units }, (_, unit) => unit);
  for (let guard = 0; doneAt.size < shape.units; guard += 1) {
    if (guard > shape.units + 2) throw new Error("the schedule made no progress");
    // Start every unit whose predecessors are accepted, as early as a slot allows. Choosing the
    // slot with the smallest `max(slot free, ready time)` is optimal for this greedy order.
    const startable = units.filter(
      (unit) =>
        !startedAt.has(unit) && (prerequisites.get(unit) ?? []).every((from) => doneAt.has(from)),
    );
    for (const unit of startable) {
      const readyAt = Math.max(
        0,
        ...(prerequisites.get(unit) ?? []).map((from) => doneAt.get(from)!),
      );
      let best = 0;
      let bestAt = Number.POSITIVE_INFINITY;
      for (let slot = 0; slot < slotFree.length; slot += 1) {
        const at = Math.max(slotFree[slot]!, readyAt);
        if (at < bestAt) {
          bestAt = at;
          best = slot;
        }
      }
      startedAt.set(unit, bestAt);
      modelEnd.set(unit, bestAt + perUnit);
      slotFree[best] = bestAt + perUnit;
    }
    // The host checks finished work in the order it finished, one at a time.
    const finishedWork = units
      .filter((unit) => modelEnd.has(unit) && !doneAt.has(unit))
      .sort((left, right) => modelEnd.get(left)! - modelEnd.get(right)!);
    for (const unit of finishedWork) {
      hostFree = Math.max(hostFree, modelEnd.get(unit)!) + params.verifyMs;
      hostMs += params.verifyMs;
      doneAt.set(unit, hostFree);
    }
  }
  const busyMs = shape.units * perUnit;
  const makespanMs = Math.max(...doneAt.values(), ...slotFree);
  const capacityMs = makespanMs * params.slots;
  return {
    makespanMs,
    hostMs,
    unusedSlotMs: Math.max(0, capacityMs - busyMs),
    slotUtilisation: capacityMs === 0 ? 0 : busyMs / capacityMs,
  };
}

function checkParams(params: CostParams): void {
  if (!Number.isInteger(params.slots) || params.slots < 1)
    throw new Error(`slots must be a positive integer, got ${params.slots}`);
  for (const [name, value] of [
    ["hit-rate", params.hitRate],
    ["coarse-context-saving", params.coarseContextSaving],
  ] as const)
    if (!(value >= 0 && value <= 1)) throw new Error(`${name} must be within [0,1], got ${value}`);
  for (const [name, value] of [
    ["work-ms", params.workMs],
    ["rederive-ms", params.rederiveMs],
    ["verify-ms", params.verifyMs],
    ["context-ms", params.contextMsPerUnit],
  ] as const)
    if (!(value >= 0) || !Number.isFinite(value))
      throw new Error(`${name} must be a finite non-negative number, got ${value}`);
}

/** The longest chain through the plan, by unit index (every edge points forward). This is the floor
 *  the makespan approaches as slots grow, so a report can say how much of the wait is structural. */
function criticalPathMs(
  shape: PlanShape,
  params: CostParams,
  edges: readonly [number, number][],
): number {
  // Each unit on the chain costs its model work plus its own check: checks are serial and a
  // dependent waits for an accepted artifact. Adding every check here would count them twice.
  const perUnit = unitCost(shape, params, true) + params.verifyMs;
  const longest = Array.from({ length: shape.units }, () => perUnit);
  for (const [from, to] of edges) longest[to] = Math.max(longest[to]!, longest[from]! + perUnit);
  return Math.max(...longest);
}

export function simulatePlan(shape: PlanShape, params: CostParams): Simulated {
  checkParams(params);
  const edges = planEdges(shape);
  const fine = schedule(shape, params, edges);
  const serial = schedule(shape, { ...params, slots: 1 }, edges);
  // The coarse arm: one session doing the same work, and the same one check per unit of work, less
  // whatever the single session saved by not paying a session boundary per unit.
  const coarseMs =
    shape.units *
      (params.workMs +
        (1 - params.hitRate) * params.rederiveMs -
        params.contextMsPerUnit * params.coarseContextSaving) +
    shape.units * params.verifyMs;
  return {
    units: shape.units,
    edges: edges.length,
    makespanMs: fine.makespanMs,
    serialMs: serial.makespanMs,
    coarseMs,
    hostMs: fine.hostMs,
    savedMs: serial.makespanMs - fine.makespanMs,
    criticalPathMs: criticalPathMs(shape, params, edges),
    unusedSlotMs: fine.unusedSlotMs,
    slotUtilisation: fine.slotUtilisation,
  };
}

/** Properties the design would be wrong to violate, so a violation is a broken instrument rather
 *  than a finding. Throws; never warns. */
export function assertModelProperties(params: CostParams): void {
  const independent: PlanShape = { units: 4, density: 0, seed: 7 };
  const chain: PlanShape = { units: 4, density: 1, seed: 7 };
  const perUnit = unitCost(independent, params, true);

  const one = simulatePlan(independent, { ...params, slots: 1 });
  const wide = simulatePlan(independent, { ...params, slots: 4 });
  if (wide.makespanMs > one.makespanMs)
    throw new Error("more slots made an independent plan slower; the scheduler is wrong");
  if (one.savedMs !== 0) throw new Error("one slot reported a saving; nothing can overlap there");
  // One unit of work plus four serial checks. Forgetting the host queue is how this model first
  // produced a wrong number, so the check names it.
  const expected = perUnit + 4 * params.verifyMs;
  if (Math.abs(wide.makespanMs - expected) > 1e-6)
    throw new Error(
      `four independent units on four slots should finish in ${expected}, got ${wide.makespanMs}`,
    );

  const chained = simulatePlan(chain, { ...params, slots: 4 });
  if (chained.savedMs !== 0)
    throw new Error(
      `splitting a chain reported ${chained.savedMs}ms saved; a chain has nothing to overlap`,
    );
  if (chained.makespanMs < chained.coarseMs)
    throw new Error(
      "the coarse arm lost to a chain: the same work with fewer session boundaries cannot lose",
    );

  // More dependencies cannot create more overlap, and the floor never falls below the longest path.
  let previous = Number.POSITIVE_INFINITY;
  for (const density of [0, 0.25, 0.5, 1]) {
    const plan = simulatePlan({ units: 8, density, seed: 7 }, { ...params, slots: 4 });
    if (plan.savedMs > previous + 1e-6)
      throw new Error(`density ${density} saved more than a sparser plan; overlap is not monotone`);
    if (plan.makespanMs < plan.criticalPathMs - 1e-6)
      throw new Error(`a schedule finished below its own critical path at density ${density}`);
    if (plan.slotUtilisation > 1)
      throw new Error(`slot utilisation above 1 at density ${density}: ${plan.slotUtilisation}`);
    previous = plan.savedMs;
  }
}

const USAGE = `usage:
  cost-model.ts --units <n> --density <0..1> --work-ms <ms> --rederive-ms <ms> --hit-rate <0..1>
                --verify-ms <ms> --context-ms <ms> --coarse-context-saving <0..1> --slots <n>
                [--seed <n>] [--out <file>]
  cost-model.ts --sweep [--out <file>]`;

function number(values: Record<string, unknown>, name: string): number {
  const raw = values[name];
  if (typeof raw !== "string") throw new Error(`--${name} is required and must be a number`);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`--${name} is not a number: ${raw}`);
  return parsed;
}

/** The sweep's base vector: the terms with a real counterpart are set to values a live round has
 *  actually shown (a model call of seconds, a host check of ~1.5s); the two assumptions are varied
 *  in the report rather than trusted at one value. */
const SWEEP_BASE: CostParams = {
  workMs: 8_000,
  rederiveMs: 6_000,
  hitRate: 0.5,
  verifyMs: 1_500,
  contextMsPerUnit: 1_200,
  coarseContextSaving: 0.5,
  slots: 4,
};

function run(): void {
  const { values } = parseArgs({
    options: {
      units: { type: "string" },
      density: { type: "string" },
      seed: { type: "string" },
      "work-ms": { type: "string" },
      "rederive-ms": { type: "string" },
      "hit-rate": { type: "string" },
      "verify-ms": { type: "string" },
      "context-ms": { type: "string" },
      "coarse-context-saving": { type: "string" },
      slots: { type: "string" },
      sweep: { type: "boolean" },
      out: { type: "string" },
    },
    allowPositionals: false,
  });
  const output: Record<string, unknown> = {
    measuredAt: new Date().toISOString(),
    model: "advisory-cost-only",
  };

  if (values.sweep) {
    assertModelProperties(SWEEP_BASE);
    const rows: Record<string, unknown>[] = [];
    for (const density of [0, 0.25, 0.5, 1]) {
      for (const units of [1, 2, 4, 8]) {
        const shape: PlanShape = { units, density, seed: 7 };
        const fine = simulatePlan(shape, SWEEP_BASE);
        const serial = simulatePlan(shape, { ...SWEEP_BASE, slots: 1 });
        rows.push({
          units,
          density,
          edges: fine.edges,
          coarseMs: Math.round(fine.coarseMs),
          fineOneSlotMs: Math.round(serial.makespanMs),
          fineMultiSlotMs: Math.round(fine.makespanMs),
          hostMs: Math.round(fine.hostMs),
          savedMs: Math.round(fine.savedMs),
          criticalPathMs: Math.round(fine.criticalPathMs),
          unusedSlotMs: Math.round(fine.unusedSlotMs),
          slotUtilisation: Number(fine.slotUtilisation.toFixed(3)),
          // Positive means the finer split with several slots beat the coarse arm on this vector.
          gainVsCoarseMs: Math.round(fine.coarseMs - fine.makespanMs),
        });
      }
    }
    output.params = SWEEP_BASE;
    output.rows = rows;
    output.paysFrom = rows
      .filter((row) => Number(row.gainVsCoarseMs) > 0)
      .map((row) => `units=${row.units} density=${row.density}`);
  } else {
    const params: CostParams = {
      workMs: number(values, "work-ms"),
      rederiveMs: number(values, "rederive-ms"),
      hitRate: number(values, "hit-rate"),
      verifyMs: number(values, "verify-ms"),
      contextMsPerUnit: number(values, "context-ms"),
      coarseContextSaving: number(values, "coarse-context-saving"),
      slots: number(values, "slots"),
    };
    const shape: PlanShape = {
      units: number(values, "units"),
      density: number(values, "density"),
      seed: values.seed === undefined ? 7 : number(values, "seed"),
    };
    assertModelProperties(params);
    output.params = params;
    output.shape = shape;
    output.result = simulatePlan(shape, params);
  }
  output.caveat =
    "cost only: this model has no quality term, so it can show a cost turning point and cannot " +
    "show that a finer split keeps parent quality.";
  const text = JSON.stringify(output, null, 2);
  if (values.out) writeFileSync(values.out, `${text}\n`);
  console.log(text);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) run();

export { USAGE };
