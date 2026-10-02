/** Default patch-session policy: rendering, tool vocabulary and artifact interpretation.
 * The session mechanism carries its rendered input and accounting without requiring this shape. */
import {
  patchCandidate,
  patchPrompt,
  DEFAULT_PATCH_LIMITS,
  type FrozenPatchWork,
  type PatchLimits,
} from "./ooo-patch.ts";
import { completionAllowed } from "./ooo-session-mechanism.ts";
import type {
  SessionInput,
  SessionState,
  SessionRunner,
  PushbackSpec,
} from "./ooo-session-mechanism.ts";

export const SNAPSHOT_LIMITS: PatchLimits = DEFAULT_PATCH_LIMITS;

/** Host-owned check exposure. The worker cannot select a command or a path outside its envelope. */
export interface CheckTool {
  label: string;
  maxRuns: number;
  run: (
    files: { path: string; content: string }[],
  ) => Promise<{ verdict: "accept" | "reject" | "undecidable"; log: string }>;
}

export function checkToolCandidate(
  frozen: FrozenPatchWork,
  files: { path: string; content: string }[],
): Readonly<Record<string, string>> {
  return patchCandidate(frozen, JSON.stringify({ digest: frozen.digest, files }));
}

export type ArtifactParams = {
  digest: string;
  files?: { path: string; content: string }[];
  conclusion?: string;
  summary?: string;
  evidence?: string;
  citations?: { case: string; test: string }[];
};

/** Sampling constraints do not replace host validation; values obey the same artifact contract. */
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

export interface PatchExecOptions {
  check?: CheckTool;
  pushback?: PushbackSpec;
  /** A fixed chain surface cannot sample a different literal union for each unit. */
  looseConclusion?: boolean;
}

export const ARTIFACT_TOOL = "submit_artifact";

/** Render one declaration once, shared by the single-unit and chain paths. */
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
  // A chain's fixed tools and loosened conclusion schema make these per-unit restrictions prompt-owned.
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

/** The default policy requires one snapshot read; other adopters declare their own bounds. */
export function piCompletionAllowed(
  stopReason: string | undefined,
  timedOut: boolean,
  turns: number,
  reads: number,
  limits: PatchLimits = SNAPSHOT_LIMITS,
): boolean {
  return completionAllowed(stopReason === "stop", timedOut, turns, reads, {
    minTurns: 1,
    maxTurns: limits.turns,
    minReads: 1,
    maxReads: limits.reads,
  });
}

/** Send only the readable subset; hidden baseline content must not enter the prompt. */
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

/** A text answer follows the same contract as the artifact tool; it is not a weaker fallback. */
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

/** Default tool vocabulary, derived from the features enabled by the host. */
export function toolNames(hasCheck: boolean, hasPushback: boolean, hasArtifact: boolean) {
  return [
    "read_snapshot",
    ...(hasCheck ? ["run_check"] : []),
    ...(hasPushback ? ["report_dependency_failure"] : []),
    ...(hasArtifact ? [ARTIFACT_TOOL] : []),
  ];
}

/** Patch state is an adopter extension, not a required property of the session mechanism. */
export interface UnitState extends SessionState {
  frozen?: FrozenPatchWork;
  check?: CheckTool;
  pushback?: PushbackSpec;
}

export interface SessionRunInput extends SessionInput {
  looseConclusion?: boolean;
  check?: CheckTool;
  frozen?: FrozenPatchWork;
  pushback?: PushbackSpec;
}

export type PiSessionRunner = SessionRunner<SessionRunInput>;
