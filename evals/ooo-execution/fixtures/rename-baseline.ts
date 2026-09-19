/**
 * The patch probe's frozen rename target.
 *
 * This was the live `src/integration/ooo-execution.ts` until that file outgrew the bounds this probe
 * passes its artifact through: the patch artifact is the whole file, and a dependent probe task
 * carries it inside its snapshot, where the shared work contract bounds a dependency's serialized
 * bytes at 8 KB. Both limits are deliberate - the probe just has to stay inside them, and pointing it
 * at a growing product file made its own limits depend on how big that file had grown (it was within
 * about a kilobyte of the second one when a legitimate edit crossed it, and a correct rename was then
 * reported as "rejected").
 *
 * The probe asserts a mechanism, not the identity of the file: an exact local rename is what the host
 * accepts, and anything else is refused. So it freezes a small self-contained copy.
 *
 * The host's oracle (`expectedRename`) requires this shape: exactly one exported `nextTask`, the local
 * map identifier declared inside it (the one the probe renames), no `planIndex` anywhere, and no
 * further export after it. The comment deliberately avoids naming that identifier: the oracle renames
 * only inside the target function, so a mention up here would survive the rename and make a candidate
 * that is correct look wrong.
 */
export interface FrozenDispatchTask {
  id: string;
  effect: string;
  sourceVersion?: string;
  observedVersion?: string;
  dependencies: readonly string[];
  accepted: boolean;
  claimed: boolean;
  delivered: boolean;
  externalEvent?: string;
  externalReady?: boolean;
  cancelled: boolean;
}

export function nextTask(plan: readonly FrozenDispatchTask[]): string | null {
  const byId = new Map(plan.map((task) => [task.id, task]));
  if (byId.size !== plan.length) throw new Error("duplicate task");
  const current = (task: FrozenDispatchTask) =>
    !!task.sourceVersion && task.sourceVersion === task.observedVersion;
  const valid = (id: string, visiting = new Set<string>()): boolean => {
    const task = byId.get(id);
    if (!task || !task.accepted || task.cancelled || !current(task) || visiting.has(id))
      return false;
    const path = new Set(visiting).add(id);
    return task.dependencies.every((dependency) => valid(dependency, path));
  };
  const waiting = (task: FrozenDispatchTask) => !!task.externalEvent && !task.externalReady;
  const ready = (task: FrozenDispatchTask) =>
    current(task) &&
    !task.cancelled &&
    !waiting(task) &&
    ["read-only", "isolated-artifact"].includes(task.effect) &&
    task.dependencies.every((id) => valid(id));
  const selectable = plan.filter((task) => task.accepted || !task.delivered);
  const pending = selectable.filter((task) => !valid(task.id));
  if (pending.some((task) => task.claimed) || pending.filter(waiting).length > 1) return null;
  const first = pending[0];
  if (!first) return null;
  if (ready(first)) return first.id;
  if (!current(first) || !waiting(first)) return null;
  return pending.slice(1).find(ready)?.id ?? null;
}
