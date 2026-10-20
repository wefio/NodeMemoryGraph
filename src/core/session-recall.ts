import { recallTermDecision } from "./gate.ts";
import { RecallPool } from "./recall-pool.ts";
import { type RecallTerm, RECALL_VOCABULARY, RECALL_POOL_CAPACITY } from "./recall-vocabulary.ts";
import { recallInput, normalizeRecallPhrase, literalPositions } from "./recall-matcher.ts";
import type { MemoryGateDecision } from "./types.ts";
import { containsSecret } from "./write-policy.ts";

export interface SessionRecallCue {
  phrase: string;
  reason: string;
  sourceQuery: string;
  sourceRevision: number;
  origin?: "seed" | "learned";
  protected?: boolean;
  mode?: RecallTerm["mode"];
}

export interface SessionRecallPreparation {
  status: "unchanged" | "skipped" | "hint";
  revision: number;
  decision: MemoryGateDecision;
  phrase?: string;
}

export interface SessionRecallHints {
  generation: number;
  /** Opaque recall-owner fence, independent of the resettable disclosure clock. */
  turn: number;
  phrases: string[];
}

export interface SessionRecallEvent {
  kind: "admitted" | "reintroduced" | "removed" | "evicted";
  phrase: string;
  at: string;
  via?: "explicit_correction" | "supplemental_search";
  sourceRevision?: number;
  sourceTurn?: number;
}

interface SessionRecallState {
  projectDir: string;
  generation: number;
  turn: number;
  events: SessionRecallEvent[];
  query: string;
  revision: number;
  skipped: boolean;
  cues: SessionRecallCue[];
  pool: RecallPool;
}

/** Operational weak hints, never facts, relevance labels or executable regexes.
 * The service owns the lease; this bounded cache has no file/store dependency.
 */
export class SessionRecallTrial {
  readonly #sessions = new Map<string, SessionRecallState>();
  #revision = 0;
  #generation = 0;
  readonly #seeds: readonly RecallTerm[];
  readonly #capacity: number;

  constructor(seeds: readonly RecallTerm[] = RECALL_VOCABULARY, capacity = RECALL_POOL_CAPACITY) {
    this.#seeds = seeds;
    this.#capacity = capacity;
  }

  snapshot(sessionId: string, projectDir: string): SessionRecallHints {
    const state = this.#state(sessionId, projectDir);
    return {
      generation: state.generation,
      turn: state.turn,
      phrases: state.cues.map((cue) => cue.phrase),
    };
  }

  beginTurn(sessionId: string): void {
    const state = this.#sessions.get(sessionId);
    if (!state) return;
    state.query = "";
    state.skipped = false;
    state.turn = ++this.#revision;
  }

  offerFromSearch(
    sessionId: string,
    projectDir: string,
    prompt: string,
    phrase: string,
    sourceTurn?: number,
  ): boolean {
    if (!canProposeSessionRecallCue(prompt, phrase)) return false;
    const prepared = this.prepare(sessionId, projectDir, prompt, false, sourceTurn);
    return this.offerPrepared(sessionId, prepared.revision, phrase, sourceTurn);
  }

  offerPrepared(sessionId: string, revision: number, phrase: string, sourceTurn?: number): boolean {
    const state = this.#sessions.get(sessionId);
    if (
      !state?.skipped ||
      state.revision !== revision ||
      !canProposeSessionRecallCue(state.query, phrase)
    )
      return false;
    this.correct(
      sessionId,
      revision,
      phrase,
      "Supplemental memory search proposal (weak signal)",
      sourceTurn,
      "supplemental_search",
    );
    return true;
  }

  events(sessionId: string): SessionRecallEvent[] {
    return (this.#sessions.get(sessionId)?.events ?? []).map((event) => ({ ...event }));
  }

  #state(sessionId: string, projectDir: string): SessionRecallState {
    let state = this.#sessions.get(sessionId);
    if (!state || state.projectDir !== projectDir) {
      state = {
        projectDir,
        generation: ++this.#generation,
        turn: 0,
        query: "",
        revision: 0,
        skipped: false,
        cues: [],
        events: [],
        pool: new RecallPool(this.#seeds, this.#capacity),
      };
    }
    this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, state);
    if (this.#sessions.size > 32) this.#sessions.delete(this.#sessions.keys().next().value!);
    return state;
  }

  #event(state: SessionRecallState, event: Omit<SessionRecallEvent, "at">): void {
    state.events.push({ ...event, at: new Date().toISOString() });
    if (state.events.length > 16) state.events.shift();
  }

  prepare(
    sessionId: string,
    projectDir: string,
    prompt: string,
    alreadyScheduled = false,
    sourceTurn?: number,
  ): SessionRecallPreparation {
    const state = this.#state(sessionId, projectDir);
    state.query = recallInput(prompt);
    state.revision = ++this.#revision;
    const term = state.pool.observe(prompt, sourceTurn ?? state.revision);
    const decision = recallTermDecision(term?.mode, term?.origin === "learned");
    state.skipped = !alreadyScheduled && decision.mode === "none";
    if (alreadyScheduled || term?.origin === "seed")
      return { status: "unchanged", revision: state.revision, decision };
    if (!term) return { status: "skipped", revision: state.revision, decision };
    return { status: "hint", revision: state.revision, phrase: term.phrase, decision };
  }

  correct(
    sessionId: string,
    revision: number,
    phrase: string,
    reason: string,
    sourceTurn?: number,
    via: "explicit_correction" | "supplemental_search" = "explicit_correction",
  ): SessionRecallCue {
    const state = this.#sessions.get(sessionId);
    if (!state?.skipped || state.revision !== revision) {
      throw new Error("recall correction requires the current skipped-query revision");
    }
    const normalized = normalizeRecallPhrase(phrase);
    if (!isLiteralCuePhrase(normalized)) {
      throw new Error("recall phrase must be 3..80 literal word characters, not a regex");
    }
    if (!literalPositions(state.query, normalized).length) {
      throw new Error("recall phrase must occur in the current unquoted query");
    }
    if (!reason.trim() || reason.length > 240) {
      throw new Error("recall correction requires a reason of at most 240 characters");
    }
    if (containsSecret(reason.normalize("NFKC"))) {
      throw new Error("recall correction cannot contain secrets");
    }
    const position = state.query.indexOf(normalized);
    const cue: SessionRecallCue = {
      phrase: normalized,
      reason: reason.trim(),
      sourceQuery: state.query.slice(
        Math.max(0, position - 80),
        position + normalized.length + 160,
      ),
      sourceRevision: revision,
    };
    const reintroduced = state.events.some(
      (event) =>
        event.phrase === normalized && (event.kind === "removed" || event.kind === "evicted"),
    );
    state.cues = state.cues.filter((entry) => entry.phrase !== normalized);
    state.cues.push(cue);
    for (const retired of state.pool.add(
      { phrase: normalized, mode: "cue" },
      sourceTurn ?? state.revision,
    )) {
      state.cues = state.cues.filter((entry) => entry.phrase !== retired.phrase);
      this.#event(state, { kind: "evicted", phrase: retired.phrase });
    }
    this.#event(state, {
      kind: reintroduced ? "reintroduced" : "admitted",
      phrase: normalized,
      via,
      sourceRevision: revision,
      ...(sourceTurn === undefined ? {} : { sourceTurn }),
    });
    this.beginTurn(sessionId); // Consume the proposal fence; parallel/late calls cannot reteach it.
    return { ...cue };
  }

  list(sessionId: string): SessionRecallCue[] {
    const state = this.#sessions.get(sessionId);
    return (
      state?.pool.entries().map((entry) => ({
        phrase: entry.phrase,
        reason: "Seed vocabulary",
        sourceQuery: "",
        sourceRevision: 0,
        ...state.cues.find((cue) => cue.phrase === entry.phrase),
        origin: entry.origin,
        protected: entry.protected,
        mode: entry.mode,
      })) ?? []
    );
  }

  remove(sessionId: string, phrase: string): boolean {
    const state = this.#sessions.get(sessionId);
    if (!state) return false;
    const removed = state.pool.remove(phrase);
    state.cues = state.cues.filter((cue) => cue.phrase !== normalizeRecallPhrase(phrase));
    if (removed) {
      this.#event(state, { kind: "removed", phrase: normalizeRecallPhrase(phrase) });
      this.beginTurn(sessionId);
    }
    return removed;
  }

  clear(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }
}

export function matchSessionRecallCue(
  prompt: string,
  phrases: readonly string[],
): string | undefined {
  if (prompt.length > 4096) return undefined;
  const query = recallInput(prompt);
  return phrases
    .map(normalizeRecallPhrase)
    .find((phrase) => isLiteralCuePhrase(phrase) && literalPositions(query, phrase).length > 0);
}

export function canProposeSessionRecallCue(prompt: string, phrase: string): boolean {
  return matchSessionRecallCue(prompt, [phrase]) !== undefined;
}

function isLiteralCuePhrase(phrase: string): boolean {
  return (
    phrase.length >= 3 &&
    phrase.length <= 80 &&
    /^[\p{L}\p{N}][\p{L}\p{N} '\u2019-]*[\p{L}\p{N}]$/u.test(phrase)
  );
}
