// S3: a round is described by data, not by editing a research script. The spec is the round's
// declared input; the runner freezes it, and everything the round hands a worker is
// digest-bound, so a spec that changes the verifier or the baseline is a different round and a
// replay refuses it by name (round-log.ts compareFrozen).
//
// Parsing is fail-closed: an unknown key, a missing required key, an absolute or escaping
// path, or a worker kind that is not supported is a named error, never a silently ignored
// field. A spec that is half-understood would run a round nobody declared.
import type { CandidateCheck } from "../../src/integration/ooo-candidate.ts";
import type { ConclusionKind } from "../../src/integration/ooo-patch.ts";
import type { CaseRule, Requirement } from "../../src/integration/ooo-cycle.ts";
import type { Mutation } from "../../src/integration/ooo-mutation.ts";

export type SpecWorker =
  | { kind: "pi"; provider: string; model: string }
  /** Replays a recorded round: no model call, the same host checks. */
  | { kind: "replay"; log: string };

export interface RoundSpec {
  revision: string;
  baseline: readonly string[];
  checks: readonly CandidateCheck[];
  a: { instruction: string; editable: readonly string[]; visible?: readonly string[] };
  b: { instruction: string; editable: readonly string[]; visible?: readonly string[] };
  worker: SpecWorker;
  noChangeCases?: Partial<Record<"A" | "B", readonly CaseRule[]>>;
  mutations?: Partial<Record<"A" | "B", readonly Mutation[]>>;
  visible?: Partial<Record<"A" | "B" | "C", readonly string[]>>;
  admitted?: Partial<Record<"A" | "B" | "C", readonly ConclusionKind[]>>;
  requires?: Partial<Record<"A" | "B" | "C", readonly Requirement[]>>;
  budget?: { perFile: number; output: number };
  limits?: { turns: number; reads: number; timeoutMs: number };
  maxReopens?: number;
  checkRuns?: number;
}

const KEYS = [
  "revision",
  "baseline",
  "checks",
  "a",
  "b",
  "worker",
  "noChangeCases",
  "mutations",
  "visible",
  "admitted",
  "requires",
  "budget",
  "limits",
  "maxReopens",
  "checkRuns",
];

/** Repository-relative, no escape: a spec may not name a path outside the frozen tree. */
function relativePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a path`);
  const path = value.trim();
  if (
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    path.includes("\\") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error(`${field} must be a repository-relative path without escapes: ${path}`);
  return path;
}

function paths(value: unknown, field: string, required: boolean): string[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value) || !value.length) throw new Error(`${field} must be a non-empty array`);
  return value.map((item, index) => relativePath(item, `${field}[${index}]`));
}

function stringField(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a string`);
  return value;
}

function positive(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0)
    throw new Error(`${field} must be a positive integer`);
  return Number(value);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[], field: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) throw new Error(`${field} has an unknown key: ${key}`);
}

function parseWorker(value: unknown): SpecWorker {
  const worker = object(value, "worker");
  const kind = stringField(worker.kind, "worker.kind");
  if (kind === "pi") {
    rejectUnknown(worker, ["kind", "provider", "model"], "worker");
    return {
      kind: "pi",
      provider: stringField(worker.provider, "worker.provider"),
      model: stringField(worker.model, "worker.model"),
    };
  }
  if (kind === "replay") {
    rejectUnknown(worker, ["kind", "log"], "worker");
    // A recorded log is a reference to an artifact, not part of the frozen envelope, so it may
    // live outside the repository (a temp directory, an archived run). The paths that *are*
    // frozen stay repository-relative, because those have to mean the same thing on any machine.
    return { kind: "replay", log: stringField(worker.log, "worker.log") };
  }
  throw new Error(`worker.kind must be "pi" or "replay", got ${kind}`);
}

function parseTask(value: unknown, field: string) {
  const task = object(value, field);
  rejectUnknown(task, ["instruction", "editable", "visible"], field);
  const visible = task.visible === undefined ? null : paths(task.visible, `${field}.visible`, true);
  return {
    instruction: stringField(task.instruction, `${field}.instruction`),
    editable: paths(task.editable, `${field}.editable`, true),
    ...(visible ? { visible } : {}),
  };
}

function parseChecks(value: unknown): CandidateCheck[] {
  if (!Array.isArray(value) || !value.length) throw new Error("checks must be a non-empty array");
  return value.map((item, index) => {
    const check = object(item, `checks[${index}]`);
    rejectUnknown(check, ["label", "command", "args"], `checks[${index}]`);
    const args = check.args;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
      throw new Error(`checks[${index}].args must be an array of strings`);
    return {
      label: stringField(check.label, `checks[${index}].label`),
      command: stringField(check.command, `checks[${index}].command`),
      args: args as string[],
    };
  });
}

function perTask<T>(
  value: unknown,
  field: string,
  parse: (item: unknown, key: string) => T,
): Partial<Record<string, T>> {
  const source = object(value, field);
  const result: Record<string, T> = {};
  for (const [key, item] of Object.entries(source)) {
    if (!["A", "B", "C"].includes(key)) throw new Error(`${field} has an unknown task: ${key}`);
    result[key] = parse(item, `${field}.${key}`);
  }
  return result as Partial<Record<string, T>>;
}

function parseCases(value: unknown, key: string): readonly CaseRule[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${key} must be a non-empty array`);
  return value.map((item, index) => {
    const rule = object(item, `${key}[${index}]`);
    rejectUnknown(rule, ["name", "token"], `${key}[${index}]`);
    return {
      name: stringField(rule.name, `${key}[${index}].name`),
      token: stringField(rule.token, `${key}[${index}].token`),
    };
  });
}

function parseMutations(value: unknown, key: string): readonly Mutation[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${key} must be a non-empty array`);
  return value.map((item, index) => {
    const mutation = object(item, `${key}[${index}]`);
    rejectUnknown(mutation, ["id", "path", "from", "to"], `${key}[${index}]`);
    return {
      id: stringField(mutation.id, `${key}[${index}].id`),
      path: relativePath(mutation.path, `${key}[${index}].path`),
      from: stringField(mutation.from, `${key}[${index}].from`),
      to: typeof mutation.to === "string" ? mutation.to : "",
    };
  });
}

function parseAdmitted(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${key} must be a non-empty array`);
  return value.map((item, index) => stringField(item, `${key}[${index}]`));
}

function parseRequirements(value: unknown, key: string): readonly Requirement[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${key} must be a non-empty array`);
  return value.map((item, index) => {
    const requirement = object(item, `${key}[${index}]`);
    rejectUnknown(requirement, ["kind", "task", "id", "token"], `${key}[${index}]`);
    if (requirement.id === undefined && requirement.token === undefined)
      throw new Error(`${key}[${index}] needs an id or a token`);
    return {
      kind: stringField(requirement.kind, `${key}[${index}].kind`),
      task: stringField(requirement.task, `${key}[${index}].task`),
      ...(requirement.id === undefined ? {} : { id: String(requirement.id) }),
      ...(requirement.token === undefined ? {} : { token: String(requirement.token) }),
    } as Requirement;
  });
}

/** Parses a round spec, refusing anything it does not fully understand. */
export function parseRoundSpec(value: unknown): RoundSpec {
  const spec = object(value, "spec");
  rejectUnknown(spec, KEYS, "spec");
  const budget = spec.budget === undefined ? null : object(spec.budget, "budget");
  if (budget) rejectUnknown(budget, ["perFile", "output"], "budget");
  const limits = spec.limits === undefined ? null : object(spec.limits, "limits");
  if (limits) rejectUnknown(limits, ["turns", "reads", "timeoutMs"], "limits");
  return {
    revision: spec.revision === undefined ? "HEAD" : stringField(spec.revision, "revision"),
    baseline: paths(spec.baseline, "baseline", true),
    checks: parseChecks(spec.checks),
    a: parseTask(spec.a, "a"),
    b: parseTask(spec.b, "b"),
    worker: parseWorker(spec.worker),
    ...(spec.noChangeCases === undefined
      ? {}
      : { noChangeCases: perTask(spec.noChangeCases, "noChangeCases", parseCases) }),
    ...(spec.mutations === undefined
      ? {}
      : { mutations: perTask(spec.mutations, "mutations", parseMutations) }),
    ...(spec.visible === undefined
      ? {}
      : {
          visible: perTask(spec.visible, "visible", (item, key) => paths(item, key, true)),
        }),
    ...(spec.admitted === undefined
      ? {}
      : { admitted: perTask(spec.admitted, "admitted", parseAdmitted) }),
    ...(spec.requires === undefined
      ? {}
      : { requires: perTask(spec.requires, "requires", parseRequirements) }),
    ...(budget
      ? {
          budget: {
            perFile: positive(budget.perFile, "budget.perFile"),
            output: positive(budget.output, "budget.output"),
          },
        }
      : {}),
    ...(limits
      ? {
          limits: {
            turns: positive(limits.turns, "limits.turns"),
            reads: positive(limits.reads, "limits.reads"),
            timeoutMs: positive(limits.timeoutMs, "limits.timeoutMs"),
          },
        }
      : {}),
    ...(spec.maxReopens === undefined
      ? {}
      : { maxReopens: positive(spec.maxReopens, "maxReopens") }),
    ...(spec.checkRuns === undefined ? {} : { checkRuns: positive(spec.checkRuns, "checkRuns") }),
  } as RoundSpec;
}
