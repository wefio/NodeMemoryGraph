import { randomUUID } from "node:crypto";

export const FIRST_RESPONSE_TIMING_ENTRY = "nmg-first-response-timing";
export type FirstResponsePhase =
  | "input"
  | "nmg_start"
  | "nmg_end"
  | "agent_start"
  | "provider_request"
  | "provider_headers"
  | "provider_response"
  | "provider_event"
  | "assistant_start"
  | "first_thinking"
  | "first_text"
  | "first_tool"
  | "compaction"
  | "queued_input"
  | "attempt_error"
  | "attempt_aborted"
  | "attempt_length"
  | "end";
export type FirstResponseOutcome =
  | "pending"
  | "stop"
  | "length"
  | "error"
  | "aborted"
  | "superseded"
  | "disabled"
  | "session_shutdown";

export interface FirstResponseTimingEvent {
  version: 1;
  traceId: string;
  sessionId: string;
  source: "interactive" | "rpc" | "extension";
  phase: FirstResponsePhase;
  at: string;
  elapsedMs: number;
  excluded: boolean;
  outcome: FirstResponseOutcome;
}

export interface FirstResponseClock {
  now(): number;
  wall(): string;
  id(): string;
}
const CLOCK: FirstResponseClock = {
  now: () => performance.now(),
  wall: () => new Date().toISOString(),
  id: randomUUID,
};

/** Host observations only: no content, provider calls, UI-TTFT inference or deadline changes. */
export class FirstResponseTiming {
  #enabled = false;
  #failed = false;
  #started = 0;
  #outcome: FirstResponseOutcome = "pending";
  #excluded = false;
  #identity: Pick<FirstResponseTimingEvent, "traceId" | "sessionId" | "source"> | undefined;
  #phases = new Map<FirstResponsePhase, number>();

  private readonly emit: (event: FirstResponseTimingEvent) => void;
  private readonly clock: FirstResponseClock;

  constructor(emit: (event: FirstResponseTimingEvent) => void, clock: FirstResponseClock = CLOCK) {
    this.emit = emit;
    this.clock = clock;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  setEnabled(enabled: boolean): void {
    if (!enabled) this.end("disabled");
    this.#enabled = enabled;
    if (enabled) this.#failed = false;
  }

  begin(sessionId: string, source: FirstResponseTimingEvent["source"]): void {
    if (!this.#enabled) return;
    this.end("superseded");
    if (!this.#enabled) return;
    try {
      this.#identity = { traceId: this.clock.id(), sessionId, source };
      this.#started = this.clock.now();
      this.#outcome = "pending";
      this.#excluded = false;
      this.#phases.clear();
      this.mark("input");
    } catch {
      this.#disableFailed();
    }
  }

  mark(phase: FirstResponsePhase): void {
    if (!this.#enabled || !this.#identity || this.#phases.has(phase)) return;
    if (
      this.#outcome !== "pending" &&
      phase !== "compaction" &&
      phase !== "queued_input" &&
      phase !== "end"
    )
      return;
    try {
      const elapsedMs = this.clock.now() - this.#started;
      if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
        this.#disableFailed();
        return;
      }
      this.#phases.set(phase, elapsedMs);
      this.emit({
        version: 1,
        ...this.#identity,
        phase,
        at: this.clock.wall(),
        elapsedMs,
        excluded: this.#excluded,
        outcome: this.#outcome,
      });
    } catch {
      // A diagnostic sink must not break the host; status exposes the failure, not its contents.
      this.#disableFailed();
    }
  }

  exclude(phase: "compaction" | "queued_input"): void {
    this.#excluded = true;
    this.mark(phase);
  }

  end(outcome: Exclude<FirstResponseOutcome, "pending">): void {
    if (!this.#identity || this.#outcome !== "pending") return;
    this.#outcome = outcome;
    this.mark("end");
  }

  reset(): void {
    this.end("session_shutdown");
    this.#enabled = false;
    this.#failed = false;
    this.#identity = undefined;
    this.#outcome = "pending";
    this.#excluded = false;
    this.#phases.clear();
  }

  snapshot(): {
    enabled: boolean;
    failed: boolean;
    traceId?: string;
    excluded: boolean;
    outcome: FirstResponseOutcome;
    phases: Partial<Record<FirstResponsePhase, number>>;
  } {
    return {
      enabled: this.#enabled,
      failed: this.#failed,
      traceId: this.#identity?.traceId,
      excluded: this.#excluded,
      outcome: this.#outcome,
      phases: Object.fromEntries(this.#phases),
    };
  }

  #disableFailed(): void {
    this.#enabled = false;
    this.#failed = true;
  }
}
