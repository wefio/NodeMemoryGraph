/**
 * The session mechanism, shared.
 *
 * Which unit runs under which session, what a unit's state is, and when its work is complete:
 * none of it talks to a harness, so all of it is decided the same way whoever is running - pi
 * today, DSH next. The adapter holds the runner objects and calls the model; everything here is
 * the part that must not differ between them. Moved out of .pi/extensions/nmg/ooo-execution.ts,
 * whose consumers used to import a harness to reach a shared mechanism.
 */
import {
  patchCandidate,
  patchPrompt,
  type FrozenPatchWork,
  type PatchLimits,
} from "./ooo-patch.ts";

export const SNAPSHOT_LIMITS: PatchLimits = Object.freeze({
  turns: 3,
  reads: 2,
  timeoutMs: 45_000,
});

/** Host-owned check exposure for patch tasks. The worker may run the round's own
 *  fixed check on its proposed files, bounded by `maxRuns`; it cannot choose a
 *  command, reach a path outside the frozen editable list, or see anything else.
 *  Every live round so far failed because a worker could not verify its own patch. */
export interface CheckTool {
  label: string;
  maxRuns: number;
  run: (
    files: { path: string; content: string }[],
  ) => Promise<{ verdict: "accept" | "reject" | "undecidable"; log: string }>;
}

/** Validates proposed files through the same shared contract as a submission, so a
 *  check call cannot smuggle a path, exceed a budget, or assert an unchanged file. */
export function checkToolCandidate(
  frozen: FrozenPatchWork,
  files: { path: string; content: string }[],
): Readonly<Record<string, string>> {
  return patchCandidate(frozen, JSON.stringify({ digest: frozen.digest, files }));
}

/** The artifact contract as one flat parameter set, so the shape can be enforced at
 *  sampling time instead of described in prose. */
export type ArtifactParams = {
  digest: string;
  files?: { path: string; content: string }[];
  conclusion?: string;
  summary?: string;
  evidence?: string;
  citations?: { case: string; test: string }[];
};

/** Builds the exact JSON envelope the shared contract expects, or explains what is
 *  wrong so the model can correct it inside the same attempt. Presence is not enough:
 *  a live round answered with `kind: "no-change"` and a prose `conclusion`, which the
 *  envelope passed through to a host rejection. Values are checked here too, and the
 *  host still validates the result: constrained decoding removes syntax failures only. */
export function artifactEnvelope(
  frozen: FrozenPatchWork,
  params: ArtifactParams,
): { ok: true; json: string } | { ok: false; error: string } {
  if (params.digest !== frozen.digest)
    return { ok: false, error: `digest must be exactly ${frozen.digest}` };
  const files = params.files ?? [];
  return files.length ? patchEnvelope(params, files) : conclusionEnvelope(frozen, params);
}

function patchEnvelope(
  params: ArtifactParams,
  files: { path: string; content: string }[],
): { ok: true; json: string } | { ok: false; error: string } {
  if (params.conclusion || params.summary || params.evidence)
    return { ok: false, error: "a patch carries files only; it cannot also carry a conclusion" };
  return { ok: true, json: JSON.stringify({ digest: params.digest, files }) };
}

function conclusionEnvelope(
  frozen: FrozenPatchWork,
  params: ArtifactParams,
): { ok: true; json: string } | { ok: false; error: string } {
  const missing = (["conclusion", "summary", "evidence"] as const).filter(
    (key) => !params[key]?.trim(),
  );
  if (missing.length)
    return {
      ok: false,
      error:
        "provide files, or a conclusion with conclusion, summary and evidence; " +
        `missing or empty ${missing.join(", ")}`,
    };
  const admitted = frozen.work.admittedConclusions;
  if (!(admitted as readonly string[]).includes(params.conclusion!))
    return {
      ok: false,
      error: `conclusion must be one of ${admitted.join(", ")}; got ${params.conclusion}`,
    };
  const citations = params.citations ?? [];
  if (citations.length > 16) return { ok: false, error: "at most 16 citations" };
  for (const entry of citations)
    if (!entry?.case?.trim() || !entry?.test?.trim())
      return { ok: false, error: "every citation needs a non-empty case and test" };
  return {
    ok: true,
    json: JSON.stringify({
      digest: params.digest,
      kind: "conclusion",
      conclusion: params.conclusion,
      summary: params.summary,
      evidence: params.evidence,
      citations,
    }),
  };
}

/** What the current task may push back on. A worker may report that a declared
 *  requirement on a dependency does not hold in what it actually received, which ends
 *  the attempt instead of letting it finish work on an input it cannot use. */
export interface PushbackSpec {
  requirements: readonly { task: string; requirement: string }[];
}

export interface PushbackReport {
  dependency: string;
  requirement: string;
  evidence: string;
}

export interface PatchExecOptions {
  check?: CheckTool;
  pushback?: PushbackSpec;
  /**
   * Set by a caller whose session loosened the artifact schema's conclusion to a plain string. A chain
   * fixes its tool surface when the session is created, so a per-unit literal union cannot be sampled
   * there; the admitted kinds then have to be named in the prompt, because the schema no longer can.
   */
  looseConclusion?: boolean;
}

/** Tool the artifact is delivered through. Structural prevention of prose: the schema
 *  is the contract and the parameters are validated by our own code, so a text answer
 *  cannot be mistaken for a submission. */
export const ARTIFACT_TOOL = "submit_artifact";

/** Produces an untrusted proposal, never applies files or marks a task accepted. */
/** The single-unit input `executePiPatch` runs, exposed so a chain can drive the same work through one
 *  session: the prompt, the snapshot and the bounds are built here once, and both paths read them from
 *  here rather than each describing the task again. */
export function patchSessionInput(
  frozen: FrozenPatchWork,
  options: PatchExecOptions = {},
): SessionRunInput {
  const { check, pushback } = options;
  const note = check
    ? `\nYou may call ${check.label} with your proposed files to run the round's fixed check before answering; at most ${check.maxRuns} calls are allowed. It runs only that check and never writes to the repository.`
    : "";
  const pushbackNote = pushback?.requirements.length
    ? `\nIf what you received cannot satisfy one of these declared requirements, call report_dependency_failure with the exact task and requirement instead of finishing the work: ` +
      JSON.stringify(pushback.requirements)
    : "";
  // What a fixed surface costs, said in the one place that can say it. A chain registers the tools of
  // every unit it will run, so this unit is shown tools it cannot use, and its artifact schema had to
  // loosen the conclusion to a string. Both rules are the prompt's now, because the surface cannot
  // shrink per unit and the schema can no longer name the kinds. Measured, not assumed: without this,
  // a live fused unit spent its turn budget on a run_check it has no check for and on a submission
  // that carried files and a conclusion at once, which the envelope refuses.
  const looseNote = options.looseConclusion
    ? `\nThis session exposes the tools of every unit it will run, and this unit has ${
        check ? `the check ${check.label}` : "no check"
      } and ${
        pushback?.requirements.length ? "a declared requirement" : "no declared requirement"
      }, so call only read_snapshot${check ? ", run_check" : ""}${
        pushback?.requirements.length ? ", report_dependency_failure" : ""
      } and ${ARTIFACT_TOOL}.\n` +
      `Answer with files, or with a conclusion whose kind is one of ${JSON.stringify(
        frozen.work.admittedConclusions,
      )}, exactly as written - never both, and a kind outside that list is refused.`
    : "";
  return {
    prompt: patchPrompt(frozen, ARTIFACT_TOOL) + note + pushbackNote + looseNote,
    snapshot: snapshotText(frozen),
    maxArtifact: frozen.work.budget.output,
    limits: frozen.work.limits,
    looseConclusion: options.looseConclusion === true,
    ...(check !== undefined ? { check } : {}),
    frozen,
    ...(pushback !== undefined ? { pushback } : {}),
  };
}

export function piCompletionAllowed(
  stopReason: string | undefined,
  timedOut: boolean,
  turns: number,
  reads: number,
  limits: PatchLimits = SNAPSHOT_LIMITS,
): boolean {
  return (
    stopReason === "stop" &&
    !timedOut &&
    turns >= 1 &&
    turns <= limits.turns &&
    reads >= 1 &&
    reads <= limits.reads
  );
}

/** One bounded Pi execution. `pushback` is present only when the worker ended the
 *  attempt by reporting that a dependency cannot satisfy a declared requirement. */
export interface PiRun {
  artifact: string;
  pushback?: PushbackReport;
  sessionId: string;
  provider: string;
  model: string;
  reads: number;
  turns: number;
  checks: number;
  tokens: number;
  /** Provider-reported cache accounting: without it a re-sent snapshot and a cached one
   *  look identical in the token total, and the cost question cannot be answered. */
  cacheRead: number;
  cacheWrite: number;
  /** The session's cumulative totals. In a chain `tokens`/`cacheRead`/`cacheWrite` are this unit's
   *  own spend and these are the session's, which is what fusion's delta claim is read from; for a
   *  single-unit runner the two are equal. */
  sessionTokens?: number;
  sessionCacheRead?: number;
  sessionCacheWrite?: number;
}

/** One unit's mutable state, held by the tool set. The tools read this object at call time rather
 *  than closing over its values, which is what lets a fused chain keep one session and one tool surface
 *  while each unit gets its own snapshot, check, budget and counters. The single-unit path builds one
 *  box and never re-points it, so both paths are the same code. */
export interface UnitState {
  snapshot: string;
  limits: PatchLimits;
  maxArtifact: number;
  frozen?: FrozenPatchWork;
  check?: CheckTool;
  pushback?: PushbackSpec;
  reads: { value: number };
  runs: { value: number };
  turns: number;
  /** The tools this unit actually called, in order. What fills a turn budget is a fact worth reading:
   *  a chain registers a tool its current unit cannot use, and only the calls say whether that cost a
   *  turn - the counters for reads and checks do not move when a tool refuses the call. */
  calls: string[];
  artifact: string | null;
  /** Why the last submission was refused, when it was: the envelope's own words. A unit that ran out of
   *  turns after submitting has its reason here, and without it the only visible symptom is "no artifact". */
  artifactError: string | null;
  report: PushbackReport | null;
  /** Ends the current unit's attempt; re-pointed per unit by a chain. */
  abort: () => void;
}

/** Tokens the assistant actually spent in this fresh session. */
export function totalTokens(
  messages: readonly { role: string; usage?: { totalTokens: number } }[],
) {
  return messages.reduce(
    (total, item) => total + (item.role === "assistant" ? (item.usage?.totalTokens ?? 0) : 0),
    0,
  );
}

export function cacheTotals(
  messages: readonly { role: string; usage?: { cacheRead?: number; cacheWrite?: number } }[],
) {
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const item of messages) {
    if (item.role !== "assistant") continue;
    cacheRead += item.usage?.cacheRead ?? 0;
    cacheWrite += item.usage?.cacheWrite ?? 0;
  }
  return { cacheRead, cacheWrite };
}

/** The snapshot text: only the readable subset travels, because the whole baseline is
 *  re-sent on every turn and the visible set is digest-bound. */
export function snapshotText(frozen: FrozenPatchWork): string {
  const files = Object.fromEntries(
    frozen.work.visible.map((path) => [path, frozen.work.files[path]]),
  );
  const hidden = Object.keys(frozen.work.files).filter(
    (path) => !frozen.work.visible.includes(path),
  );
  return JSON.stringify({
    digest: frozen.digest,
    taskId: frozen.work.taskId,
    attempt: frozen.work.attempt,
    instruction: frozen.work.instruction,
    editable: frozen.work.editable,
    budget: frozen.work.budget,
    limits: frozen.work.limits,
    files,
    ...(hidden.length ? { hidden } : {}),
  });
}

/** The bounded text artifact of a finished attempt, or a reason it cannot be used. */
export function boundedArtifact(
  message: { content: readonly { type: string; text?: string }[] } | undefined,
  maxArtifact: number,
): string | null {
  if (!message) return null;
  const artifact = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("")
    .trim();
  return artifact && artifact.length <= maxArtifact ? artifact : null;
}

/** A patch attempt's answer written as text instead of through the artifact tool.
 *
 *  The text path must not be a second, weaker contract: a live round answered this way
 *  with a conclusion-shaped object and no files, and the host could only refuse the whole
 *  attempt as `invalid patch structure` after the model had been paid for. Validating
 *  through the same envelope the tool uses makes the text channel obey exactly the tool
 *  channel's rules, and turns an unshaped answer into a recorded failed attempt with the
 *  precise reason. */
export function artifactFromText(
  frozen: FrozenPatchWork,
  text: string,
): { ok: true; json: string } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, error: "the answer is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, error: "the answer is not a JSON object" };
  const candidate = parsed as ArtifactParams;
  return artifactEnvelope(frozen, {
    digest: candidate.digest,
    files: candidate.files,
    conclusion: candidate.conclusion,
    summary: candidate.summary,
    evidence: candidate.evidence,
    citations: candidate.citations,
  });
}

/** The name list the session must expose, derived from what the host enabled. */
export function toolNames(hasCheck: boolean, hasPushback: boolean, hasArtifact: boolean) {
  return [
    "read_snapshot",
    ...(hasCheck ? ["run_check"] : []),
    ...(hasPushback ? ["report_dependency_failure"] : []),
    ...(hasArtifact ? [ARTIFACT_TOOL] : []),
  ];
}

/** Tool surface for one patch attempt. Each tool is bounded, parameter-free where it
 *  must be, and reads only host-owned state: the worker cannot choose a command, a path
 *  outside the frozen editable list, or a requirement that was not declared to it. */
/** A turn-level error worth reporting, or null. Only assistant messages carry a
 *  stop reason, so the role check belongs here rather than in the session callback. */
export function turnError(event: {
  type: string;
  message: { role: string; stopReason?: string; errorMessage?: string };
}): string | null {
  if (event.type !== "turn_end" || event.message.role !== "assistant") return null;
  if (event.message.stopReason !== "error") return null;
  return `pi turn error: ${event.message.errorMessage}
`;
}

/** One unit's input into a session: everything its tools and its completion contract read. */
export interface SessionRunInput {
  prompt: string;
  snapshot: string;
  maxArtifact: number;
  limits: PatchLimits;
  /** Whether this input was built for a session whose artifact schema is loosened, so the prompt had to
   *  name the admitted conclusion kinds. The runner checks it against its own mode. */
  looseConclusion?: boolean;
  check?: CheckTool;
  frozen?: FrozenPatchWork;
  pushback?: PushbackSpec;
}

/** A session that can run more than one unit: the mechanism fusion's policy half needs.
 *
 *  `PiRun.tokens` is the **unit's own** spend (the session's total minus what it was when the unit
 *  started) and `sessionTokens` the session's cumulative total, because fusion's claim is about the
 *  delta: a later unit in a warm context should spend less than a fresh session on the same work. A
 *  single-unit runner reports the same numbers both ways, so nothing that reads `tokens` changes. */
export interface PiSessionRunner {
  sessionId: string;
  runUnit(input: SessionRunInput): Promise<PiRun>;
  dispose(): void;
}
