// S2: a round can be replayed from its log instead of re-run.
//
// The durable-execution split this repository already relies on elsewhere is that
// orchestration must be deterministic and every uncertain side effect is an activity
// whose *result* is recorded. A model call is exactly such an activity: replaying a
// round must not call a model again, and the acceptance decisions must follow from the
// frozen inputs plus the recorded artifacts.
//
// Two properties are deliberately not claimed:
//   - the log is not trusted. A replayed artifact goes back through the same host
//     contract and the same host checks, so an edited or truncated log produces a
//     rejection or an explicit failure, never a reproduced verdict.
//   - model calls are not re-executed. A different worker answer is a different round,
//     which is why the log records the answer rather than the prompt that produced it.
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import type { CheckTicket } from "./ooo-check.ts";
import type { CycleWorker, WorkerMetrics } from "./ooo-cycle.ts";

/** One recorded round event, in the order the round produced it. */
export type RoundEvent =
  | {
      kind: "plan";
      at: string;
      tasks: string[];
      checks: string[];
      /** The revision the round's candidate worktrees are checked out from, so a replay
       *  verifies what the round verified instead of whatever `HEAD` happens to be now. */
      revision?: string;
      /** The frozen verification rules. They are not part of any task's frozen work, so
       *  without this a replay could verify a differently-defined check and still report a
       *  reproduction: the verifier has to be frozen by the round, not by the process. */
      checkDigest?: string;
      /** Dispatch order the round ran under. A replay of a sequential round as an out-of-order
       *  one is not the same round, so the mode is part of the identity too. */
      mode?: string;
    }
  | { kind: "check-issued"; at: string; taskId: string; ticket: CheckTicket }
  | {
      kind: "check-result";
      at: string;
      taskId: string;
      verdict: string;
      outcomes: { label: string; status: string }[];
    }
  | { kind: "claim"; at: string; taskId: string; attempt: number; digest: string; owner: string }
  | {
      kind: "artifact";
      at: string;
      taskId: string;
      attempt: number;
      artifact: string;
      metrics?: WorkerMetrics;
    }
  | { kind: "worker-failed"; at: string; taskId: string; attempt: number; reason: string }
  | {
      kind: "pushback";
      at: string;
      taskId: string;
      dependency: string;
      requirement: string;
      evidence: string;
    }
  | { kind: "verdict"; at: string; taskId: string; attempt: number; verdict: string }
  | {
      kind: "mutant";
      at: string;
      taskId: string;
      id: string;
      /** `unmeasured` is not a verdict about the fault: the check could not run, so the
       *  premise is unproven rather than false. */
      outcome: "killed" | "survived" | "unmeasured";
    }
  | { kind: "reopen"; at: string; taskId: string; requirement: string; invalidated: string[] }
  | {
      kind: "terminal";
      at: string;
      accepted: Record<string, string>;
      verdicts: Record<string, string>;
      composed: { verdict: string; files: string[] };
      /** The round's explicit terminal decision, when it was not a normal completion. */
      cancelled?: string;
    };

/** `Omit` over a discriminated union collapses to the properties every member shares, so
 *  an event without its timestamp has to be distributed over the members first. Without
 *  this, every `{ kind: "claim", taskId }` literal is rejected for an unknown property. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type RoundEventInput = DistributiveOmit<RoundEvent, "at">;

const KINDS = new Set([
  "plan",
  "check-issued",
  "check-result",
  "claim",
  "artifact",
  "worker-failed",
  "pushback",
  "verdict",
  "mutant",
  "reopen",
  "terminal",
]);

/** Appends round events as JSON lines. Append-only within one round: a truncated or edited
 *  line is visible when the log is read back, and replay does not repair it. A new round
 *  starts a fresh file unless the caller asks to continue one (`append: true`), because a
 *  file that accumulates several rounds replays as a mixture of all of them. */
export class RoundLog {
  private readonly events: RoundEvent[] = [];
  /** Written as a field, not a constructor parameter property: this repository's scripts
   *  run under Node's strip-only TypeScript mode, which does not support them. */
  private readonly path?: string;

  constructor(path?: string, options: { append?: boolean } = {}) {
    this.path = path;
    if (path && !options.append) writeFileSync(path, "", "utf8");
  }

  append(event: RoundEvent): void {
    this.events.push(event);
    if (this.path) appendFileSync(this.path, JSON.stringify(event) + "\n", "utf8");
  }

  recorded(): readonly RoundEvent[] {
    return this.path ? readRoundLog(readFileSync(this.path, "utf8")) : this.events;
  }

  /** The artifact a task produced for a given attempt, or null when the log does not
   *  contain one. Absence is never treated as "no artifact needed". */
  artifactFor(taskId: string, attempt: number): string | null {
    const event = this.recorded().find(
      (item) => item.kind === "artifact" && item.taskId === taskId && item.attempt === attempt,
    );
    return event?.kind === "artifact" ? event.artifact : null;
  }
}

/** Reads a log back, refusing anything that is not a well-formed round event. A log the
 *  reader only half understands must fail loudly: a silently dropped event would make a
 *  replay look like a round that simply happened to differ. */
export function readRoundLog(text: string): RoundEvent[] {
  const events: RoundEvent[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`round log line ${index + 1} is not JSON`);
    }
    if (!parsed || typeof parsed !== "object")
      throw new Error(`round log line ${index + 1} is not an event`);
    const event = parsed as { kind?: unknown; at?: unknown };
    if (typeof event.kind !== "string" || !KINDS.has(event.kind))
      throw new Error(`round log line ${index + 1} has unknown kind ${String(event.kind)}`);
    if (typeof event.at !== "string" || !event.at)
      throw new Error(`round log line ${index + 1} has no timestamp`);
    events.push(parsed as RoundEvent);
  });
  return events;
}

/** The terminal event, or null while the round has no recorded end. */
export function terminalEvent(
  events: readonly RoundEvent[],
): Extract<RoundEvent, { kind: "terminal" }> | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!;
    if (event.kind === "terminal") return event;
  }
  return null;
}

/** A worker that answers from the log instead of from a model. Anything the log does not
 *  contain fails the replay rather than being invented: a replay that guesses is not
 *  evidence about the round it claims to reproduce. */
export function recordedWorker(events: readonly RoundEvent[]): CycleWorker {
  const artifacts = new Map<string, string>();
  const failures = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "artifact")
      artifacts.set(`${event.taskId}#${event.attempt}`, event.artifact);
    if (event.kind === "worker-failed")
      failures.set(`${event.taskId}#${event.attempt}`, event.reason);
  }
  return async (taskId, frozen) => {
    // The attempt comes from the frozen envelope the worker was handed, never from a call
    // counter: reopened tasks interleave, and counting would silently pair the wrong
    // attempt with the wrong artifact.
    const attempt = frozen.work.attempt;
    const failure = failures.get(`${taskId}#${attempt}`);
    if (failure) throw new Error(failure);
    const artifact = artifacts.get(`${taskId}#${attempt}`);
    if (artifact === undefined)
      throw new Error(`round log has no artifact for ${taskId} attempt ${attempt}`);
    return artifact;
  };
}

/** A digest of the verification rules a round runs under: the commands, their arguments and
 *  their labels. Computed the same way at record and replay time, from the same inputs. */
export function checksDigest(
  checks: readonly { label: string; command: string; args: readonly string[] }[],
): string {
  const canonical = checks
    .map((check) => ({ label: check.label, command: check.command, args: [...check.args] }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** A round's frozen work per task and attempt: the identity of everything the round was
 *  handed (baseline files, instruction, declared faults, budgets, limits). Every input
 *  change moves it, which is what makes it usable as the round's identity. */
export function frozenDigests(log: readonly RoundEvent[]): Map<string, string> {
  const digests = new Map<string, string>();
  for (const event of log)
    if (event.kind === "claim") digests.set(`${event.taskId}#${event.attempt}`, event.digest);
  return digests;
}

/** The recorded plan, or null when the log has none. */
export function recordedPlan(
  events: readonly RoundEvent[],
): Extract<RoundEvent, { kind: "plan" }> | null {
  return events.find((event) => event.kind === "plan") ?? null;
}

/** Whether a replay was handed the same frozen work the log recorded.
 *
 *  A replay given different inputs is a *different round*: it can still finish with the same
 *  verdicts by coincidence, and then the log looks reproduced when it was not. Comparing the
 *  frozen digests is the cheap check that names the difference instead: it covers the baseline
 *  files and every other input at once, because all of them feed the digest. */
export function compareFrozen(
  recorded: readonly RoundEvent[],
  replayed: readonly RoundEvent[],
): string[] {
  const before = frozenDigests(recorded);
  const after = frozenDigests(replayed);
  const differences: string[] = [];
  const checksBefore = recordedPlan(recorded)?.checkDigest;
  const checksAfter = recordedPlan(replayed)?.checkDigest;
  if (checksBefore !== checksAfter)
    differences.push(
      `verification rules: ${checksBefore?.slice(0, 12) ?? "not recorded"} -> ` +
        `${checksAfter?.slice(0, 12) ?? "not recorded"}`,
    );
  const modeBefore = recordedPlan(recorded)?.mode;
  const modeAfter = recordedPlan(replayed)?.mode;
  if (modeBefore !== modeAfter)
    differences.push(
      `dispatch order: ${modeBefore ?? "not recorded"} -> ${modeAfter ?? "not recorded"}`,
    );
  differences.push(...digestDifferences(before, after));
  return differences;
}

/** One line per task whose frozen work differs, naming both sides. */
function digestDifferences(before: Map<string, string>, after: Map<string, string>): string[] {
  const differences: string[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const left = before.get(key);
    const right = after.get(key);
    if (left === right) continue;
    if (left === undefined)
      differences.push(`${key}: not claimed in the log -> ${right!.slice(0, 12)}`);
    else if (right === undefined)
      differences.push(`${key}: ${left.slice(0, 12)} -> not claimed in the replay`);
    else differences.push(`${key}: ${left.slice(0, 12)} -> ${right.slice(0, 12)}`);
  }
  return differences;
}

/** Compares a replayed round with the terminal state its log recorded. Returns the
 *  differences in words, so a caller can print them instead of a bare false. */
export function compareTerminal(
  recorded: Extract<RoundEvent, { kind: "terminal" }>,
  replayed: {
    accepted: Record<string, string>;
    verdicts: Record<string, string>;
    composed: { verdict: string; files: string[] };
  },
): string[] {
  const differences: string[] = [];
  const keys = new Set([
    ...Object.keys(recorded.accepted),
    ...Object.keys(replayed.accepted),
    ...Object.keys(recorded.verdicts),
    ...Object.keys(replayed.verdicts),
  ]);
  for (const key of [...keys].sort()) {
    const before = `${recorded.verdicts[key] ?? "none"}/${recorded.accepted[key] !== undefined ? "accepted" : "not-accepted"}`;
    const after = `${replayed.verdicts[key] ?? "none"}/${replayed.accepted[key] !== undefined ? "accepted" : "not-accepted"}`;
    if (before !== after) differences.push(`${key}: ${before} -> ${after}`);
  }
  if (recorded.composed.verdict !== replayed.composed.verdict)
    differences.push(`composed: ${recorded.composed.verdict} -> ${replayed.composed.verdict}`);
  if (recorded.composed.files.join(",") !== replayed.composed.files.join(","))
    differences.push(
      `composed files: ${recorded.composed.files.join(",")} -> ${replayed.composed.files.join(",")}`,
    );
  return differences;
}
