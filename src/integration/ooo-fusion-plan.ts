/**
 * Fusion planning: the one move a session may make at a run boundary, and the ceiling an offline
 * measurement puts on how few sessions a plan can need.
 *
 * Legality is not decided here. `sharedSessionLegal` in `src/integration/ooo-execution.ts` owns the
 * five conditions, and both halves below call it: the online move asks it about the facts the run
 * holds, and the offline graph asks it about an optimistic projection of the same plan. Nothing in
 * this file widens a legal pair; it orders legal pairs and prices them.
 *
 * The split is deliberate. A fused session is irreversible - two units that ran in one session cannot
 * be un-fused - so the online half makes one move about the current session and never rewrites a
 * committed one, while the offline half is free to compute a best case that no run may read as a
 * decision, because it is computed from facts the run does not have yet.
 */
import {
  fusionSuccessors,
  sharedSessionLegal,
  type DispatchTask,
  type SessionPlan,
} from "./ooo-execution.ts";

/**
 * The measured cost of starting one Agent session, from the D arm (2 units, `--slots 1`, 3 reps per
 * bound, deepseek-v4-flash): the fused bound was consistently about 1 900 ms faster with tokens flat,
 * which is what one avoided session startup is worth. A later measurement that prices startup
 * differently changes this constant, not the method.
 */
export const MEASURED_SESSION_STARTUP_MS = 1_900;

/**
 * The plan as fusion would see it if everything went well. The offline half prices the best case,
 * because a run's verdicts, cancellations and pending branches are facts it does not have yet; the
 * projection leaves only condition 1 (capability, authority, visibility) and the pair identity to
 * `sharedSessionLegal`.
 */
export function optimisticPlan(plan: SessionPlan): SessionPlan {
  return {
    tasks: plan.tasks.map((task) => ({
      ...task,
      accepted: true,
      cancelled: false,
      externalReady: true,
    })),
    declarations: plan.declarations,
  };
}

/** Every unit `id` transitively depends on, so a chain never runs a unit before what it needs. */
function dependenciesOf(byId: ReadonlyMap<string, DispatchTask>, id: string): Set<string> {
  const found = new Set<string>();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const dependency of byId.get(current)?.dependencies ?? []) {
      if (found.has(dependency)) continue;
      found.add(dependency);
      queue.push(dependency);
    }
  }
  return found;
}

export interface FusionGraph {
  /** The plan's units, in plan order - the order the driver walks and the tie-break it uses. */
  readonly units: readonly string[];
  /** `edges.get(a)` = the units that may continue `a`'s session, in plan order. */
  readonly edges: ReadonlyMap<string, readonly string[]>;
  /** Whether the successor relation is transitive, which is what makes the chain-cover floor apply. */
  readonly transitive: boolean;
}

/**
 * The successor relation with the run's own facts projected away: the graph the offline half prices.
 *
 * Two restrictions make it a graph a chain cover can be computed on, and both are properties of the
 * problem rather than conveniences:
 *
 * - a chain is a linear extension, so a unit may not be followed by one it transitively depends on;
 * - a chain follows plan order, which is the order the driver walks its candidates in. The relation on
 *   its own is not a partial order: two independent units with compatible declarations may each follow
 *   the other, so it has two-cycles and Dilworth needs an acyclic restriction. Plan order is that
 *   restriction, and it is why the floor bounds order-respecting schedules.
 */
export function fusionGraph(plan: SessionPlan): FusionGraph {
  const view = optimisticPlan(plan);
  const byId = new Map(plan.tasks.map((task) => [task.id, task]));
  const units = view.tasks.map((task) => task.id);
  const index = new Map(units.map((id, position) => [id, position]));
  const edges = new Map<string, readonly string[]>();
  for (const before of units) {
    const needed = dependenciesOf(byId, before);
    edges.set(
      before,
      units.filter(
        (after) =>
          after !== before &&
          index.get(after)! > index.get(before)! &&
          !needed.has(after) &&
          sharedSessionLegal(before, after, view),
      ),
    );
  }
  let transitive = true;
  for (const [before, successors] of edges) {
    for (const middle of successors) {
      for (const after of edges.get(middle) ?? []) {
        if (after !== before && !successors.includes(after)) transitive = false;
      }
    }
  }
  return { units, edges, transitive };
}

/** The units reachable from each unit, itself included: the relation's transitive closure. */
function transitiveClosure(graph: FusionGraph): ReadonlyMap<string, ReadonlySet<string>> {
  const closure = new Map<string, ReadonlySet<string>>();
  for (const unit of graph.units) {
    const reached = new Set([unit]);
    const queue = [unit];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of graph.edges.get(current) ?? []) {
        if (reached.has(next)) continue;
        reached.add(next);
        queue.push(next);
      }
    }
    closure.set(unit, reached);
  }
  return closure;
}

/**
 * The least number of sessions the plan could need: the minimum chain cover of the relation, which by
 * Dilworth equals its maximum antichain, computed as `units - maximumMatching` over the bipartite
 * graph of the transitive closure (Konig). A floor, not a schedule - it is reached only when the
 * chains happen to be feasible for the cap.
 */
export function chainCoverFloor(graph: FusionGraph): number {
  const closure = transitiveClosure(graph);
  /** right -> left, the matching found so far. */
  const paired = new Map<string, string>();
  const augment = (left: string, visited: Set<string>): boolean => {
    for (const right of graph.units) {
      if (right === left || !closure.get(left)!.has(right) || visited.has(right)) continue;
      visited.add(right);
      const holder = paired.get(right);
      if (holder === undefined || augment(holder, visited)) {
        paired.set(right, left);
        return true;
      }
    }
    return false;
  };
  let matched = 0;
  for (const left of graph.units) if (augment(left, new Set())) matched += 1;
  return graph.units.length - matched;
}

/**
 * A feasible bound from greedy list scheduling at a declared per-session cap: walk the plan in order
 * and append each unit to the open session that may legally take it, preferring the fullest so few
 * sessions are opened. Feasible, not optimal - it is what this rule gets, and the gap to
 * `chainCoverFloor` is the honest measure of what the rule leaves on the table.
 */
export function listScheduleSessions(
  graph: FusionGraph,
  cap: number,
): readonly (readonly string[])[] {
  if (!Number.isInteger(cap) || cap < 1)
    throw new Error("a session cap must be a positive integer");
  const sessions: string[][] = [];
  for (const unit of graph.units) {
    let best: string[] | undefined;
    for (const session of sessions) {
      if (session.length >= cap) continue;
      if (!(graph.edges.get(session[session.length - 1]!) ?? []).includes(unit)) continue;
      if (!best || session.length > best.length) best = session;
    }
    if (best) best.push(unit);
    else sessions.push([unit]);
  }
  return sessions;
}

export interface SessionMoveInput {
  readonly plan: SessionPlan;
  /** The unit that just ran in this session. */
  readonly current: string;
  /** How many units this session has already carried. */
  readonly size: number;
  /** The declared bound on units per session. */
  readonly bound: number;
  /** The units the board still has on offer, in plan order. */
  readonly onOffer: readonly string[];
}

/** One move about the current session: admit the next legal successor, or close it by name. */
export type SessionMove =
  | { readonly kind: "admit"; readonly unit: string }
  | { readonly kind: "close"; readonly reason: string };

/**
 * Repair-first: the default is to continue the session that is already running, and a close carries
 * the condition that closed it. Only facts may end a session early - a rejected verdict shows up as
 * `current` not being accepted, a cancellation and an unmet dependency as `sharedSessionLegal`, and a
 * declared external wait as condition 4 - so this is a pure function of the plan and its facts, with
 * plan order breaking ties. Numeric optimisation belongs to the offline half and is not read here.
 */
export function nextSessionMove(input: SessionMoveInput): SessionMove {
  if (input.size >= input.bound) return { kind: "close", reason: "the declared bound is reached" };
  const successor = fusionSuccessors(input.current, input.plan).find((id) =>
    input.onOffer.includes(id),
  );
  if (successor === undefined) {
    return { kind: "close", reason: "no legal successor is on offer" };
  }
  return { kind: "admit", unit: successor };
}
