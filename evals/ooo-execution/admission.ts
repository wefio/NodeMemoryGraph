import { createHash, randomUUID } from "node:crypto";

export interface Task {
  id: string;
  revision: string;
  input: string;
  dependencies: string[];
  verify: (
    artifact: string,
    input: string,
    dependencies: Readonly<Record<string, string>>,
  ) => boolean;
}

export interface Ticket {
  runId: string;
  taskId: string;
  revision: string;
  inputDigest: string;
  attempt: number;
}

type Verdict = "accepted" | "duplicate" | "stale" | "rejected";

/** Research only. Plan/verifiers and issue() belong to the trusted coordinator;
 * workers only submit JSON data. This is not a sandbox or a durable scheduler. */
export function createAdmissionGate(plan: Task[]) {
  const tasks = admitPlan(plan);
  const runId = randomUUID();
  const attempts = new Map<string, Ticket>();
  const completed = new Map<string, string>();
  const dependenciesReady = (task: Readonly<Task>) =>
    task.dependencies.every((id) => completed.has(id));
  const dependencyResults = (task: Readonly<Task>) =>
    Object.freeze(Object.fromEntries(task.dependencies.map((id) => [id, completed.get(id)!])));
  const matches = (ticket: Ticket) => {
    const current = attempts.get(ticket.taskId);
    return (
      current !== undefined &&
      current.runId === ticket.runId &&
      current.revision === ticket.revision &&
      current.attempt === ticket.attempt &&
      current.inputDigest === ticket.inputDigest
    );
  };

  return {
    // ponytail: scan the small probe plan; maintain an incremental ready set if scale warrants it.
    ready(): string[] {
      return [...tasks.values()]
        .filter((task) => !attempts.has(task.id) && dependenciesReady(task))
        .map((task) => task.id);
    },
    /** Coordinator-only: reissue deliberately revokes the previous attempt. */
    issue(taskId: string): Readonly<Ticket> {
      const task = tasks.get(taskId);
      if (!task) throw new Error("unknown task");
      if (completed.has(taskId)) throw new Error("task completed");
      if (!dependenciesReady(task)) throw new Error("unfulfilled dependencies");
      const attempt = (attempts.get(taskId)?.attempt ?? 0) + 1;
      if (!Number.isSafeInteger(attempt)) throw new Error("attempt exhausted");
      const inputDigest = createHash("sha256")
        .update(JSON.stringify([task.revision, task.input, dependencyResults(task)]))
        .digest("hex");
      const ticket = Object.freeze({
        runId,
        taskId,
        revision: task.revision,
        inputDigest,
        attempt,
      });
      attempts.set(taskId, ticket);
      return ticket;
    },
    submit(candidate: unknown): Verdict {
      const parsed = parseSubmission(candidate);
      if (!parsed) return "rejected";
      const { ticket, artifact } = parsed;
      // Snapshot caller-owned data before invoking the coordinator's check.
      const binding = { ...ticket };
      // The fence is checked before the check and again before the commit: a reentrant
      // verifier may have revoked this attempt while it ran.
      const settled = this.settle(binding, artifact);
      if (settled) return settled;
      if (!(this.verified(binding, artifact) === true)) return "rejected";
      return this.settle(binding, artifact) ?? this.commit(binding, artifact);
    },
    /** The verdict of a task that is already done or already fenced, if any. */
    settle(binding: Ticket, artifact: string): Verdict | null {
      if (!matches(binding)) return "stale";
      if (!completed.has(binding.taskId)) return null;
      return completed.get(binding.taskId) === artifact ? "duplicate" : "rejected";
    },
    /** The coordinator's check. A verifier that throws or abstains rejects the attempt;
     *  only an explicit `true` accepts it. */
    verified(binding: Ticket, artifact: string): boolean {
      const task = tasks.get(binding.taskId)!;
      try {
        return task.verify(artifact, task.input, dependencyResults(task)) === true;
      } catch {
        return false;
      }
    },
    commit(binding: Ticket, artifact: string): Verdict {
      completed.set(binding.taskId, artifact);
      return "accepted";
    },
  };
}

/** Copies and validates the plan: identity, shape, uniqueness, known dependencies and
 *  acyclicity. Caller-owned objects are never retained. */
function admitPlan(plan: Task[]): Map<string, Readonly<Task>> {
  if (!plan.length) throw new Error("empty plan");
  const tasks = new Map<string, Readonly<Task>>();
  for (const task of plan) {
    if (!validTask(task)) throw new Error("invalid task");
    if (tasks.has(task.id)) throw new Error("duplicate task");
    tasks.set(task.id, Object.freeze({ ...task, dependencies: [...new Set(task.dependencies)] }));
  }
  if (hasCycle(tasks)) throw new Error("cyclic dependencies");
  return tasks;
}

function validTask(task: Task): boolean {
  return (
    !!task.id?.trim() &&
    !!task.revision?.trim() &&
    typeof task.input === "string" &&
    typeof task.verify === "function" &&
    Array.isArray(task.dependencies)
  );
}

/** Kahn, as in memory-chain ordering, but include isolated tasks and reject cycles. */
function hasCycle(tasks: Map<string, Readonly<Task>>): boolean {
  const indegree = new Map<string, number>();
  const successors = new Map<string, string[]>();
  for (const task of tasks.values()) {
    indegree.set(task.id, task.dependencies.length);
    for (const dependency of task.dependencies) {
      if (!tasks.has(dependency)) throw new Error("unknown dependency");
      const next = successors.get(dependency) ?? [];
      next.push(task.id);
      successors.set(dependency, next);
    }
  }
  const queue = [...tasks.keys()].filter((id) => indegree.get(id) === 0);
  for (let i = 0; i < queue.length; i++) {
    for (const id of successors.get(queue[i]!) ?? []) {
      const remaining = indegree.get(id)! - 1;
      indegree.set(id, remaining);
      if (!remaining) queue.push(id);
    }
  }
  return queue.length !== tasks.size;
}

/** A worker submission is admitted only when it carries a well-formed ticket and a
 *  string artifact. Everything else is rejected as data, never as an exception. */
function parseSubmission(candidate: unknown): { ticket: Ticket; artifact: string } | null {
  if (!candidate || typeof candidate !== "object") return null;
  const { ticket, artifact } = candidate as { ticket?: Ticket; artifact?: unknown };
  if (!ticket || typeof ticket !== "object" || typeof artifact !== "string") return null;
  if (!validTicket(ticket)) return null;
  return { ticket, artifact };
}

function validTicket(ticket: Ticket): boolean {
  const strings = [ticket.taskId, ticket.runId, ticket.revision, ticket.inputDigest];
  return (
    strings.every((value) => typeof value === "string") &&
    Number.isSafeInteger(ticket.attempt) &&
    ticket.attempt >= 1
  );
}
