import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isContextDecisionValid } from "./context-intervention.ts";
import type { ContextTrialEvent } from "./context-trial.ts";

/** Single-writer local trial journal. An exclusive lock is held for its lifetime.
 * A leftover lock after a crash requires operator inspection; never auto-steal.
 * Torn/corrupt records fail closed. This is local durability, not attestation.
 */
export class ContextTrialJournal {
  readonly #path: string;
  readonly #lock: string;
  readonly #limit: number;
  readonly #latest = new Map<string, ContextTrialEvent>();
  #fd: number | undefined;
  #bytes = 0;
  #poisoned = false;

  constructor(path: string, maxBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("invalid journal limit");
    this.#path = path;
    this.#lock = `${path}.lock`;
    this.#limit = maxBytes;
    mkdirSync(dirname(path), { recursive: true });
    const lockFd = openSync(this.#lock, "wx");
    closeSync(lockFd);
    try {
      this.#load();
      this.#fd = openSync(path, "a");
    } catch (error) {
      unlinkSync(this.#lock);
      throw error;
    }
  }

  append(event: ContextTrialEvent): void {
    if (this.#fd === undefined || this.#poisoned) throw new Error("journal unavailable");
    const snapshot = structuredClone(event);
    validateTransition(this.#latest.get(snapshot.sample.decisionId), snapshot);
    const data = Buffer.from(JSON.stringify(snapshot) + "\n", "utf8");
    if (data.length > 64 * 1024 || this.#bytes + data.length > this.#limit) {
      throw new Error("journal capacity exceeded; rotate explicitly before another trial");
    }
    try {
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(this.#fd, data, offset, data.length - offset);
        if (written <= 0) throw new Error("journal write made no progress");
        offset += written;
      }
      fsyncSync(this.#fd);
    } catch (error) {
      this.#poisoned = true;
      throw error;
    }
    this.#bytes += data.length;
    this.#latest.set(snapshot.sample.decisionId, snapshot);
  }

  /** Latest revision snapshots. Reopened rows remain visible and non-admissible. */
  entries(): ContextTrialEvent[] {
    if (this.#poisoned) throw new Error("journal state uncertain after a failed write");
    return structuredClone([...this.#latest.values()]);
  }

  close(): void {
    if (this.#fd === undefined) return;
    closeSync(this.#fd);
    this.#fd = undefined;
    unlinkSync(this.#lock);
  }

  #load(): void {
    if (!existsSync(this.#path)) return;
    this.#bytes = statSync(this.#path).size;
    if (this.#bytes > this.#limit) throw new Error("journal capacity exceeded");
    const text = readFileSync(this.#path, "utf8");
    if (text && !text.endsWith("\n")) throw new Error("torn journal tail; inspection required");
    for (const line of text.split("\n").filter(Boolean)) {
      const event = JSON.parse(line) as ContextTrialEvent;
      validateTransition(this.#latest.get(event.sample.decisionId), event);
      this.#latest.set(event.sample.decisionId, event);
    }
  }
}

function decisionIdentity(event: ContextTrialEvent): string {
  const decision = structuredClone(event.sample);
  delete decision.execution;
  delete decision.outcome;
  return JSON.stringify(decision);
}

function validateTransition(
  previous: ContextTrialEvent | undefined,
  next: ContextTrialEvent,
): void {
  if (!isContextDecisionValid(next.sample)) throw new Error("invalid journal decision");
  if (!previous) {
    if (next.phase !== "decision" || next.sample.execution || next.sample.outcome) {
      throw new Error("first journal event must be a fresh decision");
    }
    return;
  }
  if (next.phase === "decision") throw new Error("decision already reserved; do not re-execute");
  if (decisionIdentity(previous) !== decisionIdentity(next))
    throw new Error("decision identity drift");
  if (
    previous.sample.execution &&
    JSON.stringify(previous.sample.execution) !== JSON.stringify(next.sample.execution)
  ) {
    throw new Error("execution identity drift");
  }
  validatePhase(previous, next);
}

function validatePhase(previous: ContextTrialEvent, next: ContextTrialEvent): void {
  if (previous.phase === "error") throw new Error("failed trial is terminal");
  if (previous.phase === "outcome") {
    if (next.phase !== "outcome" || next.sample.outcome?.status !== "reopened") {
      throw new Error("only reopening may revise a completed outcome");
    }
    return;
  }
  if (next.phase === "error") return;
  if (next.phase === "execution" && previous.phase === "decision" && next.sample.execution) return;
  if (next.phase === "outcome" && previous.phase === "execution" && next.sample.outcome) return;
  throw new Error("invalid trial phase transition");
}
