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
  if (!plan.length) throw new Error("empty plan");
  const tasks = new Map<string, Readonly<Task>>();
  for (const task of plan) {
    if (
      !task.id?.trim() ||
      !task.revision?.trim() ||
      typeof task.input !== "string" ||
      typeof task.verify !== "function" ||
      !Array.isArray(task.dependencies)
    ) {
      throw new Error("invalid task");
    }
    if (tasks.has(task.id)) throw new Error("duplicate task");
    tasks.set(task.id, Object.freeze({ ...task, dependencies: [...new Set(task.dependencies)] }));
  }
  // Kahn, as in memory-chain ordering, but include isolated tasks and reject cycles.
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
  if (queue.length !== tasks.size) throw new Error("cyclic dependencies");

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
      if (!candidate || typeof candidate !== "object") return "rejected";
      const { ticket, artifact } = candidate as { ticket?: Ticket; artifact?: unknown };
      if (
        !ticket ||
        typeof ticket !== "object" ||
        typeof artifact !== "string" ||
        typeof ticket.taskId !== "string" ||
        typeof ticket.runId !== "string" ||
        typeof ticket.revision !== "string" ||
        typeof ticket.inputDigest !== "string" ||
        !Number.isSafeInteger(ticket.attempt) ||
        ticket.attempt < 1
      )
        return "rejected";
      // Snapshot caller-owned data before invoking the coordinator's check.
      const binding = { ...ticket };
      if (!matches(binding)) return "stale";
      if (completed.has(binding.taskId)) {
        return completed.get(binding.taskId) === artifact ? "duplicate" : "rejected";
      }
      const task = tasks.get(binding.taskId)!;
      try {
        if (task.verify(artifact, task.input, dependencyResults(task)) !== true) return "rejected";
      } catch {
        return "rejected";
      }
      // Check and commit without await. Reentrant verifier code may have revoked this attempt.
      if (!matches(binding)) return "stale";
      if (completed.has(binding.taskId)) {
        return completed.get(binding.taskId) === artifact ? "duplicate" : "rejected";
      }
      completed.set(binding.taskId, artifact);
      return "accepted";
    },
  };
}
