import { decideMemoryLoad } from "./gate.ts";
import type { MemoryGateDecision } from "./types.ts";
import { containsSecret } from "./write-policy.ts";

export interface SessionRecallCue {
  phrase: string;
  reason: string;
  sourceQuery: string;
  sourceRevision: number;
}

export interface SessionRecallPreparation {
  status: "unchanged" | "skipped" | "hint";
  revision: number;
  decision: MemoryGateDecision;
  phrase?: string;
}

interface SessionRecallState {
  projectDir: string;
  query: string;
  revision: number;
  skipped: boolean;
  cues: SessionRecallCue[];
}

/** Operational weak hints, never facts, relevance labels or executable regexes.
 * The service owns the lease; this bounded cache has no file/store dependency.
 */
export class SessionRecallTrial {
  readonly #sessions = new Map<string, SessionRecallState>();
  #revision = 0;

  prepare(
    sessionId: string,
    projectDir: string,
    prompt: string,
    alreadyScheduled = false,
  ): SessionRecallPreparation {
    let state = this.#sessions.get(sessionId);
    if (!state || state.projectDir !== projectDir) {
      state = { projectDir, query: "", revision: 0, skipped: false, cues: [] };
    }
    // Bound both capture and matching work. Long inputs still use the ordinary gate.
    state.query = prompt.length <= 4096 ? cueText(prompt) : "";
    state.revision = ++this.#revision;
    const decision = decideMemoryLoad(prompt);
    state.skipped = !alreadyScheduled && decision.mode === "none";
    this.#sessions.delete(sessionId);
    this.#sessions.set(sessionId, state);
    if (this.#sessions.size > 32) this.#sessions.delete(this.#sessions.keys().next().value!);
    if (!state.skipped) return { status: "unchanged", revision: state.revision, decision };
    const cue = state.cues.find((entry) => literalMatch(state.query, entry.phrase));
    if (!cue) return { status: "skipped", revision: state.revision, decision };
    state.skipped = false;
    return {
      status: "hint",
      revision: state.revision,
      phrase: cue.phrase,
      decision: decideMemoryLoad(prompt, { sessionCue: true }),
    };
  }

  correct(sessionId: string, revision: number, phrase: string, reason: string): SessionRecallCue {
    const state = this.#sessions.get(sessionId);
    if (!state?.skipped || state.revision !== revision) {
      throw new Error("recall correction requires the current skipped-query revision");
    }
    const normalized = normalizePhrase(phrase);
    if (
      normalized.length < 3 ||
      normalized.length > 80 ||
      !/^[\p{L}\p{N}][\p{L}\p{N} '\u2019-]*[\p{L}\p{N}]$/u.test(normalized)
    ) {
      throw new Error("recall phrase must be 3..80 literal word characters, not a regex");
    }
    if (!literalMatch(state.query, normalized)) {
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
    state.cues = state.cues.filter((entry) => entry.phrase !== normalized);
    state.cues.push(cue);
    if (state.cues.length > 8) state.cues.shift();
    return { ...cue };
  }

  list(sessionId: string): SessionRecallCue[] {
    return (this.#sessions.get(sessionId)?.cues ?? []).map((cue) => ({ ...cue }));
  }

  remove(sessionId: string, phrase: string): boolean {
    const state = this.#sessions.get(sessionId);
    if (!state) return false;
    const before = state.cues.length;
    state.cues = state.cues.filter((cue) => cue.phrase !== normalizePhrase(phrase));
    return state.cues.length !== before;
  }

  clear(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }
}

function normalizePhrase(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}

function cueText(prompt: string): string {
  prompt = prompt.normalize("NFKC");
  if (prompt.length > 4096 || containsSecret(prompt)) return "";
  // Conservative pilot exclusions, not a semantic intent classifier.
  if (
    /(?:翻译|字符串|打印|translate|literal string|print)/iu.test(prompt) ||
    /(?:不要|不用|不需要|别).{0,8}(?:记忆|回忆|检索)|\b(?:without|no|don't use|do not use)\s+memory\b/iu.test(
      prompt,
    )
  )
    return "";
  return normalizePhrase(
    prompt
      .replace(/```[\s\S]*?(?:```|$)/gu, " ")
      .replace(/`[^`\n]*(?:`|$)|“[^”]*”|「[^」]*」|"[^"\n]*"|'[^'\n]*'/gu, " "),
  );
}

function literalMatch(text: string, phrase: string): boolean {
  let position = text.indexOf(phrase);
  while (position >= 0) {
    const left = text[position - 1] ?? "";
    const right = text[position + phrase.length] ?? "";
    const leftBoundary =
      !/^[\p{Script=Latin}\p{N}_]/u.test(phrase) || !/[\p{Script=Latin}\p{N}_]/u.test(left);
    const rightBoundary =
      !/[\p{Script=Latin}\p{N}_]$/u.test(phrase) || !/[\p{Script=Latin}\p{N}_]/u.test(right);
    if (leftBoundary && rightBoundary) return true;
    position = text.indexOf(phrase, position + 1);
  }
  return false;
}
