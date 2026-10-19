import type { NmgStore } from "../core/store.ts";
import type { TransactionPort } from "../core/store/base.ts";
import type { TaskUnitDeclaration } from "./task-unit-declaration-store.ts";
import { preparePatchWork, type FrozenPatchWork, type FrozenPatchTask } from "./ooo-patch.ts";

export const PATCH_INPUTS_FROZEN_FACT = "task-unit.patch-inputs-frozen";

interface FrozenInputs {
  version: 1;
  files: FrozenPatchTask["files"];
  budget: FrozenPatchTask["budget"];
  limits: FrozenPatchTask["limits"];
  admittedConclusions: FrozenPatchTask["admittedConclusions"];
  digest: string;
}

/** Persist only attempt inputs and normalization parameters, not another task definition. */
export function recordPatchInputs(
  store: NmgStore,
  runId: string,
  declaration: FrozenPatchWork,
  port: TransactionPort,
): void {
  const { work, digest } = declaration;
  const task = store.taskRunTasks(runId).find((candidate) => candidate.taskId === work.taskId);
  if (!task) throw new Error(`run ${runId} froze no task ${work.taskId}`);
  const payload: FrozenInputs = {
    version: 1,
    files: work.files,
    budget: work.budget,
    limits: work.limits,
    admittedConclusions: work.admittedConclusions,
    digest,
  };
  const result = store.appendTaskRunFact(
    {
      runId,
      kind: PATCH_INPUTS_FROZEN_FACT,
      taskId: work.taskId,
      attempt: work.attempt,
      payload: JSON.stringify(payload),
    },
    port,
  );
  if (!result.recorded) {
    const restored = restorePatchInputs(store, runId, task, work.attempt);
    if (restored?.digest !== digest)
      throw new Error("attempt already froze different patch inputs");
  }
}

function frozenInputs(payload: string | null): FrozenInputs {
  const parsed: unknown = JSON.parse(payload ?? "null");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("invalid frozen patch inputs");
  const value = parsed as Record<string, unknown>;
  const keys = ["version", "files", "budget", "limits", "admittedConclusions", "digest"];
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error("invalid frozen patch input fields");
  if (value.version !== 1) throw new Error("unsupported frozen patch input version");
  if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest))
    throw new Error("invalid frozen patch input digest");
  for (const key of ["files", "budget", "limits"]) {
    if (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))
      throw new Error(`invalid frozen patch input ${key}`);
  }
  if (!Array.isArray(value.admittedConclusions))
    throw new Error("invalid frozen patch input conclusions");
  return value as unknown as FrozenInputs;
}

/** Read-only reconstruction: missing input evidence never means "read today's workspace". */
export function restorePatchInputs(
  store: Pick<NmgStore, "taskRunFacts">,
  runId: string,
  task: TaskUnitDeclaration,
  attempt: number,
): FrozenPatchWork | null {
  const fact = store
    .taskRunFacts(runId)
    .find(
      (candidate) =>
        candidate.kind === PATCH_INPUTS_FROZEN_FACT &&
        candidate.taskId === task.taskId &&
        candidate.attempt === attempt,
    );
  if (!fact) return null;
  const inputs = frozenInputs(fact.payload);
  const declaration = preparePatchWork({
    taskId: task.taskId,
    attempt,
    instruction: task.input,
    files: inputs.files,
    editable: task.patchEditable ?? [],
    visible: task.patchFiles ?? [],
    budget: inputs.budget,
    limits: inputs.limits,
    admittedConclusions: inputs.admittedConclusions,
  });
  if (declaration.digest !== inputs.digest) throw new Error("frozen patch input digest mismatch");
  return declaration;
}
