import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  ReasoningWorkspace,
  type AddReasoningNodeInput,
  type ReasoningCheckpoint,
  type ReasoningEdge,
  type ReasoningEdgeKind,
  type ReasoningNode,
  type ReasoningStatus,
  type ReasoningWorkspaceState,
} from "../../../src/lab/reasoning-workspace.ts";

/**
 * File-backed, session-private owner for the optional Pi reasoning scratchpad.
 * Writes are atomic and never touch the semantic memory daemon. A separate
 * marker survives extension restarts when Pi compacts a session before the next
 * turn can consume its checkpoint.
 */
export class PiReasoningWorkspaces {
  readonly directory: string;
  readonly #open = new Map<string, ReasoningWorkspace>();

  constructor(directory: string) {
    this.directory = directory;
  }

  add(sessionId: string, input: AddReasoningNodeInput): ReasoningNode {
    const workspace = this.#workspace(sessionId, true)!;
    const node = workspace.addNode(input);
    this.#save(workspace);
    return node;
  }

  update(
    sessionId: string,
    nodeId: string,
    update: { content?: string; status?: ReasoningStatus; importance?: number },
  ): ReasoningNode {
    const workspace = this.#workspace(sessionId, true)!;
    const node = workspace.updateNode(nodeId, update);
    this.#save(workspace);
    return node;
  }

  link(
    sessionId: string,
    sourceId: string,
    targetId: string,
    type: ReasoningEdgeKind,
  ): ReasoningEdge {
    const workspace = this.#workspace(sessionId, true)!;
    const edge = workspace.link(sourceId, targetId, type);
    this.#save(workspace);
    return edge;
  }

  checkpoint(
    sessionId: string,
    options: { maxNodes?: number; maxChars?: number } = {},
  ): ReasoningCheckpoint {
    return this.#workspace(sessionId, true)!.checkpoint(options);
  }

  /** Mark an existing workspace for one bounded injection after Pi compaction. */
  markCompacted(sessionId: string): boolean {
    const workspace = this.#workspace(sessionId, false);
    if (!workspace || workspace.toJSON().nodes.length === 0) return false;
    mkdirSync(this.directory, { recursive: true });
    this.#writeAtomic(this.#pendingPath(sessionId), sessionId);
    return true;
  }

  /** Consume the durable compaction marker exactly once. */
  consumeCompactionCheckpoint(
    sessionId: string,
    options: { maxNodes?: number; maxChars?: number } = {},
  ): ReasoningCheckpoint | null {
    const pendingPath = this.#pendingPath(sessionId);
    if (!existsSync(pendingPath)) return null;
    const recordedSessionId = readFileSync(pendingPath, "utf8");
    if (recordedSessionId !== sessionId) {
      throw new Error("Reasoning checkpoint marker belongs to a different session");
    }
    const workspace = this.#workspace(sessionId, false);
    if (!workspace) return null;
    const checkpoint = workspace.checkpoint(options);
    rmSync(pendingPath, { force: true });
    return checkpoint;
  }

  clear(sessionId: string): void {
    this.#open.delete(sessionId);
    rmSync(this.#statePath(sessionId), { force: true });
    rmSync(this.#pendingPath(sessionId), { force: true });
  }

  /** Drop only the in-process cache; the session scratchpad remains resumable. */
  release(sessionId: string): void {
    this.#open.delete(sessionId);
  }

  statePath(sessionId: string): string {
    return this.#statePath(sessionId);
  }

  #workspace(sessionId: string, create: boolean): ReasoningWorkspace | null {
    if (!sessionId.trim()) throw new Error("Reasoning workspace requires a session ID");
    const cached = this.#open.get(sessionId);
    if (cached) return cached;
    const path = this.#statePath(sessionId);
    let workspace: ReasoningWorkspace;
    if (existsSync(path)) {
      const state = JSON.parse(readFileSync(path, "utf8")) as ReasoningWorkspaceState;
      workspace = ReasoningWorkspace.fromJSON(state);
      if (workspace.sessionId !== sessionId) {
        throw new Error("Reasoning workspace file belongs to a different session");
      }
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
