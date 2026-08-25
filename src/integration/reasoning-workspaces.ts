import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  ReasoningWorkspace,
  type AddReasoningNodeInput,
  type ReasoningEdgeKind,
  type ReasoningStatus,
  type ReasoningWorkspaceState,
} from "../lab/reasoning-workspace.ts";

/** Daemon-owned file persistence for session-private reasoning workspaces. */
export class ReasoningWorkspaces {
  readonly directory: string;
  readonly #open = new Map<string, ReasoningWorkspace>();

  constructor(directory: string) {
    this.directory = directory;
  }

  add(sessionId: string, input: AddReasoningNodeInput) {
    return this.#mutate(sessionId, (workspace) => workspace.addNode(input));
  }

  update(
    sessionId: string,
    nodeId: string,
    update: {
      content?: string;
      status?: ReasoningStatus;
      importance?: number;
      evidenceRefs?: string[];
    },
  ) {
    return this.#mutate(sessionId, (workspace) => workspace.updateNode(nodeId, update));
  }

  link(sessionId: string, sourceId: string, targetId: string, type: ReasoningEdgeKind) {
    return this.#mutate(sessionId, (workspace) => workspace.link(sourceId, targetId, type));
  }

  checkpoint(sessionId: string, options: { maxNodes?: number; maxChars?: number } = {}) {
    return this.#workspace(sessionId, true)!.checkpoint(options);
  }

  markCompacted(sessionId: string): boolean {
    const workspace = this.#workspace(sessionId, false);
    if (!workspace || workspace.toJSON().nodes.length === 0) return false;
    mkdirSync(this.directory, { recursive: true });
    this.#writeAtomic(this.#pendingPath(sessionId), sessionId);
    return true;
  }

  consumeCompactionCheckpoint(
    sessionId: string,
    options: { maxNodes?: number; maxChars?: number } = {},
  ) {
    const pending = this.#pendingPath(sessionId);
    if (!existsSync(pending)) return null;
    if (readFileSync(pending, "utf8") !== sessionId)
      throw new Error("Reasoning checkpoint marker belongs to a different session");
    const workspace = this.#workspace(sessionId, false);
    if (!workspace) return null;
    const checkpoint = workspace.checkpoint(options);
    rmSync(pending, { force: true });
    return checkpoint;
  }

  clear(sessionId: string): boolean {
    const existed = existsSync(this.#statePath(sessionId)) || this.#open.has(sessionId);
    this.#open.delete(sessionId);
    rmSync(this.#statePath(sessionId), { force: true });
    rmSync(this.#pendingPath(sessionId), { force: true });
    return existed;
  }

  release(sessionId: string): void {
    this.#open.delete(sessionId);
  }
  statePath(sessionId: string): string {
    return this.#statePath(sessionId);
  }

  pruneStale(maxIdleMs = 30 * 24 * 60 * 60 * 1_000, now = Date.now()): number {
    if (!existsSync(this.directory)) return 0;
    let removed = 0;
    for (const entry of readdirSync(this.directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const statePath = join(this.directory, entry.name);
      if (now - statSync(statePath).mtimeMs <= Math.max(0, maxIdleMs)) continue;
      try {
        const state = JSON.parse(
          readFileSync(statePath, "utf8"),
        ) as Partial<ReasoningWorkspaceState>;
        if (typeof state.sessionId === "string") this.#open.delete(state.sessionId);
      } catch {
        /* malformed stale Lab state is still safe to remove */
      }
      rmSync(statePath, { force: true });
      rmSync(join(this.directory, `${entry.name.slice(0, -5)}.pending`), { force: true });
      removed += 1;
    }
    return removed;
  }

  #mutate<T>(sessionId: string, operation: (workspace: ReasoningWorkspace) => T): T {
    const workspace = this.#workspace(sessionId, true)!;
    const result = operation(workspace);
    this.#save(workspace);
    return result;
  }

  #workspace(sessionId: string, create: boolean): ReasoningWorkspace | null {
    if (!sessionId.trim()) throw new Error("Reasoning workspace requires a session ID");
    const cached = this.#open.get(sessionId);
    if (cached) return cached;
    const path = this.#statePath(sessionId);
    let workspace: ReasoningWorkspace;
    if (existsSync(path)) {
      workspace = ReasoningWorkspace.fromJSON(
        JSON.parse(readFileSync(path, "utf8")) as ReasoningWorkspaceState,
      );
      if (workspace.sessionId !== sessionId)
        throw new Error("Reasoning workspace file belongs to a different session");
    } else {
      if (!create) return null;
      workspace = new ReasoningWorkspace(sessionId);
    }
    this.#open.set(sessionId, workspace);
    return workspace;
  }

  #save(workspace: ReasoningWorkspace): void {
    mkdirSync(this.directory, { recursive: true });
    this.#writeAtomic(
      this.#statePath(workspace.sessionId),
      JSON.stringify(workspace.toJSON(), null, 2),
    );
  }

  #writeAtomic(path: string, content: string): void {
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, content, "utf8");
    try {
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  }

  #statePath(sessionId: string): string {
    return join(this.directory, `${sessionFileKey(sessionId)}.json`);
  }
  #pendingPath(sessionId: string): string {
    return join(this.directory, `${sessionFileKey(sessionId)}.pending`);
  }
}

function sessionFileKey(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("base64url");
}
