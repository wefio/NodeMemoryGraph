/**
 * Finite offline execution model over the task-semantics compiler. No model call, no
 * database, no clock: it enumerates the legal settlement orders of a declared plan and
 * counts the two costs a round actually pays — units that had to wait for a dependency's
 * verdict, and units whose speculative work was voided because that verdict was not
 * "accepted".
 *
 * This is the analysis half of the design's first slice (docs/design/task-unit-semantics.md,
 * "共享纯数据编译器 + 有限离线执行模型"). It is not a runtime capability: nothing here
 * dispatches, verifies, or publishes, and it is deliberately capped at four units.
 */
import { compileTaskUnits, type CompileInput, type TaskUnit } from "./task-semantics.ts";

/** The design's cap for enumeration. Above it the model refuses rather than grows. */
export const MAX_MODEL_UNITS = 4;

export type RoundMode = "ordered" | "out-of-order" | "fused";
export type Outcome = "accepted" | "rejected" | "undecidable";

export interface ModelInput extends CompileInput {
  /** Declared per-task result, because the model has no worker to run. */
  outcomes: Readonly<Record<string, Outcome>>;
}

export interface ExecutionPlan {
  mode: RoundMode;
  /** The order in which units settle. Non-fused modes put every dependency first. */
  order: readonly string[];
  /** Units that had to wait for a dependency's verdict before starting. */
  waits: number;
  /** Units whose speculative start was voided by a dependency that was not accepted. */
  rollbacks: number;
  /** Re-runs caused by those rollbacks. */
  retries: number;
  accepted: readonly string[];
}

export interface ModeComparison {
  mode: RoundMode;
  orders: number;
  /** Across the legal orders of this mode: the spread, not a single best case. */
  minWaits: number;
  maxWaits: number;
  minRollbacks: number;
  maxRollbacks: number;
}

export interface ModeReport {
  comparison: readonly ModeComparison[];
  plans: readonly ExecutionPlan[];
  refused?: string;
  digest: string;
}

function permutations(ids: readonly string[]): string[][] {
  if (ids.length <= 1) return [[...ids]];
  return ids.flatMap((id, index) =>
    permutations(ids.filter((_, other) => other !== index)).map((rest) => [id, ...rest]),
  );
}

/** Dependency closure: a unit is accepted only if it was accepted itself and none of
 *  the units it read from was rejected or undecidable. */
function acceptedClosure(
  units: readonly TaskUnit[],
  outcomes: ModelInput["outcomes"],
): Set<string> {
  const accepted = new Set<string>();
  const own = (id: string) => (outcomes[id] ?? "undecidable") === "accepted";
  let changed = true;
  while (changed) {
    changed = false;
    for (const unit of units) {
      const ok =
        own(unit.id) && unit.inputs.dependencies.every((dependency) => accepted.has(dependency));
      if (ok && !accepted.has(unit.id)) {
        accepted.add(unit.id);
        changed = true;
      }
    }
  }
  return accepted;
}

function run(
  order: readonly string[],
  units: readonly TaskUnit[],
  input: ModelInput,
  mode: RoundMode,
): ExecutionPlan {
  const position = new Map(order.map((id, index) => [id, index]));
  const byId = new Map(units.map((unit) => [unit.id, unit]));
  let waits = 0;
  let rollbacks = 0;
  let retries = 0;
  for (const [index, id] of order.entries()) {
    const dependencies = byId.get(id)?.inputs.dependencies ?? [];
    if (!dependencies.length) continue;
    const settled = dependencies.filter((dependency) => (position.get(dependency) ?? -1) < index);
    if (settled.length === dependencies.length) {
      waits += 1; // it waited for a verdict rather than speculating on delivery
      continue;
    }
    if (mode !== "fused") continue;
    const blocked = dependencies.filter((dependency) => !settled.includes(dependency));
    if (
      blocked.some((dependency) => (input.outcomes[dependency] ?? "undecidable") !== "accepted")
    ) {
      rollbacks += 1;
      retries += 1;
    }
  }
  return {
    mode,
    order: [...order],
    waits,
    rollbacks,
    retries,
    accepted: [...acceptedClosure(units, input.outcomes)].sort(),
  };
}

/** Non-fused modes may not start a unit before its dependencies settle, so their orders
 *  are exactly the topological orders of the plan. Fusion may start anywhere. The ordered
 *  mode is the declared plan order and nothing else; that is what makes it the baseline. */
function settlementOrders(units: readonly TaskUnit[], mode: RoundMode): string[][] {
  const ids = units.map((unit) => unit.id);
  if (mode === "ordered") return [[...ids]];
  const orders = permutations(ids);
  if (mode === "fused") return orders;
  return orders.filter((order) =>
    units.every((unit) => {
      const index = order.indexOf(unit.id);
      return unit.inputs.dependencies.every((dependency) => order.indexOf(dependency) < index);
    }),
  );
}

/** Named so that what the model does not cover is visible rather than silently absent. The
 *  design's first discriminating case asks that two concurrent candidates on the same file
 *  not become mergeable by themselves, and that units can be *prepared* before their
 *  dependencies settle; neither is modelled here, so neither may be assumed. */
export const UNMODELLED_BY_MODEL = [
  "external-waits",
  "real-verification",
  "wall-clock",
  "mergeability",
  "preparation",
] as const;

/** Compare the three modes over the same declared plan and outcomes. */
export function compareModes(input: ModelInput): ModeReport {
  const compiled = compileTaskUnits(input);
  if (!compiled.legal) {
    return {
      comparison: [],
      plans: [],
      refused: `refused: the plan has ${compiled.refusals.length} refusal(s), so no order is legal`,
      digest: compiled.digest,
    };
  }
  if (compiled.units.length > MAX_MODEL_UNITS) {
    return {
      comparison: [],
      plans: [],
      refused: `refused: ${compiled.units.length} units exceeds the offline model's cap of ${MAX_MODEL_UNITS}`,
      digest: compiled.digest,
    };
  }
  const modes: RoundMode[] = ["ordered", "out-of-order", "fused"];
  const comparison: ModeComparison[] = [];
  const plans: ExecutionPlan[] = [];
  for (const mode of modes) {
    const runs = settlementOrders(compiled.units, mode).map((order) =>
      run(order, compiled.units, input, mode),
    );
    plans.push(...runs);
    comparison.push({
      mode,
      orders: runs.length,
      minWaits: Math.min(...runs.map((entry) => entry.waits)),
      maxWaits: Math.max(...runs.map((entry) => entry.waits)),
      minRollbacks: Math.min(...runs.map((entry) => entry.rollbacks)),
      maxRollbacks: Math.max(...runs.map((entry) => entry.rollbacks)),
    });
  }
  return { comparison, plans, digest: compiled.digest };
}
