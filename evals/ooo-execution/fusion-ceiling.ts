/**
 * Fusion ceiling: how few sessions a plan could need, and what the caps the repository can actually
 * declare would get.
 *
 * This is the offline half of fusion planning (`docs/design/ooo-fusion-planning.md`). It costs no
 * model calls and it is not a policy: a run may never read these numbers to decide a move, because
 * they price an optimistic projection of the plan - every unit accepted, nothing cancelled, no
 * external wait pending - instead of the facts a run holds.
 *
 * Usage: node --experimental-strip-types evals/ooo-execution/fusion-ceiling.ts [--spec <path>]
 *
 * It prints, per plan: the unit count, whether the successor relation is transitive, the
 * chain-cover floor (the least number of sessions any order-respecting schedule could use), the
 * sessions greedy list scheduling actually opens at each cap, and the milliseconds that saves against
 * running one unit per session at the measured ~1_900 ms startup. Not modelled: the union tool
 * surface's extra first-unit turn and the context a longer chain resends.
 */
import { readFileSync } from "node:fs";
import {
  chainCoverFloor,
  fusionGraph,
  listScheduleSessions,
  MEASURED_SESSION_STARTUP_MS,
} from "../../src/integration/ooo-fusion-plan.ts";
import type { DispatchTask, SessionPlan } from "../../src/integration/ooo-execution.ts";

const DEFAULT_SPEC = "evals/ooo-execution/fixtures/report/fine.spec.json";

interface SpecRow {
  id: string;
  effect?: string;
  dependencies?: readonly string[];
}

interface SpecFile {
  plan: readonly SpecRow[];
  units: Readonly<Record<string, { visible?: readonly string[] }>>;
  revision?: string;
  fusion?: {
    declarations?: Readonly<Record<string, { capability?: string; authority?: string }>>;
  };
}

function readSpec(path: string): SpecFile {
  const spec = JSON.parse(readFileSync(path, "utf8")) as SpecFile;
  if (!Array.isArray(spec.plan) || spec.plan.length === 0)
    throw new Error("spec.plan must be non-empty");
  return spec;
}

/**
 * The plan as the offline half sees it: every unit accepted and ready. The projection is deliberate -
 * a run's verdicts, cancellations and pending branches are facts it does not have yet - and it leaves
 * the five legality conditions to `sharedSessionLegal`, which still decides condition 1.
 */
function planFrom(spec: SpecFile): SessionPlan {
  const revision = spec.revision ?? "v1";
  const tasks: DispatchTask[] = spec.plan.map((row) => ({
    id: row.id,
    effect: row.effect ?? "isolated-artifact",
    sourceVersion: revision,
    observedVersion: revision,
    dependencies: [...(row.dependencies ?? [])],
    accepted: true,
    claimed: false,
    externalReady: true,
  }));
  const declarations = Object.fromEntries(
    spec.plan.map((row) => [
      row.id,
      {
        capability: spec.fusion?.declarations?.[row.id]?.capability ?? "patch",
        authority: spec.fusion?.declarations?.[row.id]?.authority ?? "host",
        visible: spec.units[row.id]?.visible ?? [],
      },
    ]),
  );
  return { tasks, declarations };
}

function report(path: string): Record<string, unknown> {
  const spec = readSpec(path);
  const plan = planFrom(spec);
  const graph = fusionGraph(plan);
  const floor = chainCoverFloor(graph);
  const caps = Array.from({ length: graph.units.length }, (_, index) => index + 1);
  const perCap = caps.map((cap) => {
    const sessions = listScheduleSessions(graph, cap);
    return {
      cap,
      sessions: sessions.length,
      savedStartupMs: (graph.units.length - sessions.length) * MEASURED_SESSION_STARTUP_MS,
      sizes: sessions.map((session) => session.length),
    };
  });
  if (perCap.some((row) => row.sessions < floor)) {
    throw new Error(
      `${path}: a schedule used fewer sessions than the floor, so the floor is wrong`,
    );
  }
  return {
    spec: path,
    units: graph.units.length,
    transitive: graph.transitive,
    chainCoverFloor: floor,
    oneUnitPerSession: graph.units.length,
    perCap,
    note: "savedStartupMs is against one unit per session, at the measured ~1_900 ms startup; the union tool surface's extra turn and a longer chain's context are not modelled",
  };
}

const argument = process.argv.indexOf("--spec");
const paths = argument === -1 ? [DEFAULT_SPEC] : [process.argv[argument + 1] ?? DEFAULT_SPEC];
console.log(JSON.stringify(paths.map(report), null, 2));
