import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { NmgService } from "../../src/cli/service.ts";
import type { NmgMethodResult } from "../../src/cli/protocol.ts";
import { benchmarkCredentialEnvironment } from "../local-env.ts";
import type { AgentExtractedMemory, AgentExtractionRow } from "./agent-extract.ts";

type DialogueTurn = { role: string; content: string; timestamp?: string };
type CandidateVote = {
  candidateId: string;
  outcome: "supported" | "contradicted";
  evidence: string;
};

type Candidate = {
  candidateId: string;
  originSession: number;
  memory: AgentExtractedMemory;
  memoryId: string;
  originEvidenceTurn: number;
  votes: CandidateVote[];
};

export type PromotionAuditReport = {
  uuid: string;
  originSessions: { start: number; end: number };
  observationThroughSession: number;
  admittedCandidates: number;
  rejectedAssistantOrUnattributable: number;
  independentVotes: number;
  eligibleCandidates: number;
  candidates: Array<{
    candidateId: string;
    originSession: number;
    statement: string;
    memoryId: string;
    originEvidenceTurn: number;
    votes: CandidateVote[];
    posterior: NmgMethodResult["recordClaimOutcomes"]["posteriors"][number] | null;
    eligible: boolean;
  }>;
};

const SYSTEM_PREFIX = `You are auditing later-session evidence for provisional NMG memories.
For each candidate, inspect only the supplied current-session USER messages.
Return a vote only when one exact user excerpt independently and directly supports or contradicts
the candidate. Topic similarity, assistant statements, silence, repetition inside the candidate,
and plausible inference are not evidence. Omit candidates with no decisive evidence.

Return one JSON object and no prose:
{"votes":[{"candidateId":"...","outcome":"supported|contradicted","evidence":"smallest exact user excerpt"}]}`;

export function parsePromotionVotes(
  raw: string,
  candidateIds: ReadonlySet<string>,
  dialogue: readonly DialogueTurn[],
): CandidateVote[] {
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/iu.exec(raw.trim());
  const source = fenced?.[1] ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(source) as { votes?: unknown };
  if (!Array.isArray(parsed.votes)) throw new Error("promotion audit response must contain votes[]");
  const seen = new Set<string>();
  return parsed.votes.map((value, index) => {
    const row = value as Record<string, unknown>;
    const candidateId = String(row.candidateId ?? "").trim();
    const outcome = String(row.outcome ?? "").trim();
    const evidence = String(row.evidence ?? "").trim();
    if (
      !candidateIds.has(candidateId) ||
      (outcome !== "supported" && outcome !== "contradicted") ||
      !evidence ||
      seen.has(candidateId)
    ) {
      throw new Error(`invalid promotion vote at index ${index}`);
    }
    const attributable = dialogue.some(
      (turn) => turn.role === "user" && turn.content.includes(evidence),
    );
    if (!attributable) throw new Error(`vote evidence is not an exact user excerpt: ${candidateId}`);
    seen.add(candidateId);
    return { candidateId, outcome, evidence };
  });
}

export function exactUserEvidenceTurn(
  dialogue: readonly DialogueTurn[],
  evidence: string,
): number | null {
  const index = dialogue.findIndex(
    (turn) => turn.role === "user" && turn.content.includes(evidence.trim()),
  );
  return index < 0 ? null : index;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(import.meta.dirname, "../..");
  const input = resolve(
    args.input ?? ".benchmarks/official/OmniMemEval/data/halumem/HaluMem-Medium.jsonl",
  );
  const extractionsPath = resolve(
    args.agentExtractions ?? ".benchmarks/halumem-nmg/results/agent-extractions.jsonl",
  );
  const output = resolve(
    args.output ?? ".benchmarks/halumem-nmg/results/promotion-qualified-extractions.jsonl",
  );
  const reportPath = resolve(
    args.report ?? ".benchmarks/halumem-nmg/results/promotion-audit.json",
  );
  const cacheDir = resolve(args.cacheDir ?? ".benchmarks/halumem-nmg/promotion-cache");
  const dataDir = resolve(args.dataDir ?? ".benchmarks/halumem-nmg/promotion-store");
  const originStart = positive(args.originStart, 1);
  const originEnd = positive(args.originEnd, originStart);
  const observeThrough = positive(args.observeThrough, originEnd);
  if (originEnd < originStart || observeThrough < originEnd) {
    throw new Error("expected origin-start <= origin-end <= observe-through");
  }
  const model = args.model ?? process.env.NMG_HALUMEM_EXTRACT_MODEL ?? "deepseek-chat";
  const credentials = benchmarkCredentialEnvironment(root);
  const apiKey = process.env.DEEPSEEK_API_KEY ?? credentials.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for promotion evidence audit");
  const baseUrl = (process.env.NMG_HALUMEM_EXTRACT_BASE_URL ?? "https://api.deepseek.com").replace(
    /\/+$/u,
    "",
  );
  const users = readFileSync(input, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { uuid: string; sessions: Array<{ dialogue: DialogueTurn[] }> });
  const user = users[positive(args.user, 1) - 1];
  if (!user) throw new Error("requested user does not exist");
  const extractionRows = readFileSync(extractionsPath, "utf8")
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AgentExtractionRow)
    .filter((row) => row.uuid === user.uuid);
  const bySession = new Map(extractionRows.map((row) => [row.sessionIndex, row]));
  for (let session = originStart; session <= originEnd; session += 1) {
    if (!bySession.has(session)) throw new Error(`missing agent extraction for session ${session}`);
  }

  if (args.reset === "1") rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });
  mkdirSync(dirname(reportPath), { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const projectDir = resolve(dataDir, `project-${user.uuid}`);
  mkdirSync(projectDir, { recursive: true });
  const service = new NmgService({ databasePath: resolve(dataDir, "ltg.sqlite"), environment: {} });
  const candidates: Candidate[] = [];
  const posteriorByMemory = new Map<
    string,
    NmgMethodResult["recordClaimOutcomes"]["posteriors"][number]
  >();
  const eligibleMemoryIds = new Set<string>();
  let rejected = 0;
  try {
    for (let origin = originStart; origin <= originEnd; origin += 1) {
      const dialogue = user.sessions[origin - 1]?.dialogue ?? [];
      const row = bySession.get(origin)!;
      for (const [index, memory] of row.memories.entries()) {
        const evidenceTurn = exactUserEvidenceTurn(dialogue, memory.evidence);
        if (evidenceTurn === null) {
          rejected += 1;
          continue;
        }
        const candidateId = `s${origin}-m${index + 1}`;
        const remembered = await service.invoke("remember", {
          statement: memory.statement,
          nodeName: `HaluMem session ${origin} candidate`,
          memoryType: memory.memoryType,
          stateKey: memory.stateKey,
          eventTime: memory.eventTime,
          sourceActor: "user",
          truthStatus: "asserted",
          evidence: memory.evidence,
          sourceRef: `halumem:${user.uuid}:session-${origin}:turn-${evidenceTurn + 1}`,
          residence: "stg",
          projectDir,
          sessionId: `origin-${origin}`,
          scope: { benchmark: "HaluMem", user: user.uuid },
          writeReason: "halumem_agent_candidate",
        });
        candidates.push({
          candidateId,
          originSession: origin,
          memory,
          memoryId: remembered.memory.id,
          originEvidenceTurn: evidenceTurn,
          votes: [],
        });
      }
    }

    for (let session = originEnd + 1; session <= observeThrough; session += 1) {
      const dialogue = user.sessions[session - 1]?.dialogue ?? [];
      if (dialogue.length === 0 || candidates.length === 0) continue;
      const votes = await auditSession({
        model,
        baseUrl,
        apiKey,
        cacheDir,
        candidates,
        dialogue,
        session,
      });
      for (const vote of votes) {
        candidates.find((candidate) => candidate.candidateId === vote.candidateId)!.votes.push(vote);
      }
      const byOrigin = new Map<number, CandidateVote[]>();
      for (const vote of votes) {
        const candidate = candidates.find((item) => item.candidateId === vote.candidateId)!;
        const bucket = byOrigin.get(candidate.originSession) ?? [];
        bucket.push(vote);
        byOrigin.set(candidate.originSession, bucket);
      }
      for (const [origin, originVotes] of byOrigin) {
        const result = await service.invoke("recordClaimOutcomes", {
          projectDir,
          sessionId: `origin-${origin}`,
          semanticTaskId: `halumem-later-session-${session}`,
          votes: originVotes.map((vote) => {
            const candidate = candidates.find((item) => item.candidateId === vote.candidateId)!;
            return {
              memoryId: candidate.memoryId,
              outcome: vote.outcome,
              source: "user" as const,
              sourceLineage: `halumem:${user.uuid}:session-${session}:${digest(vote.evidence).slice(0, 16)}`,
            };
          }),
        });
        for (const posterior of result.posteriors) {
          posteriorByMemory.set(posterior.memoryId, posterior);
          if (result.consolidationCandidates.includes(posterior.memoryId)) {
            eligibleMemoryIds.add(posterior.memoryId);
          } else {
            eligibleMemoryIds.delete(posterior.memoryId);
          }
        }
      }
    }

    const candidateReports: PromotionAuditReport["candidates"] = [];
    const qualifiedBySession = new Map<number, AgentExtractedMemory[]>();
    for (const candidate of candidates) {
      const posterior = posteriorByMemory.get(candidate.memoryId) ?? null;
      const eligible = eligibleMemoryIds.has(candidate.memoryId);
      if (eligible) {
        const bucket = qualifiedBySession.get(candidate.originSession) ?? [];
        bucket.push(candidate.memory);
        qualifiedBySession.set(candidate.originSession, bucket);
      }
      candidateReports.push({
        candidateId: candidate.candidateId,
        originSession: candidate.originSession,
        statement: candidate.memory.statement,
        memoryId: candidate.memoryId,
        originEvidenceTurn: candidate.originEvidenceTurn,
        votes: candidate.votes,
        posterior,
        eligible,
      });
    }
    const report: PromotionAuditReport = {
      uuid: user.uuid,
      originSessions: { start: originStart, end: originEnd },
      observationThroughSession: observeThrough,
      admittedCandidates: candidates.length,
      rejectedAssistantOrUnattributable: rejected,
      independentVotes: candidates.reduce((sum, candidate) => sum + candidate.votes.length, 0),
      eligibleCandidates: candidateReports.filter((candidate) => candidate.eligible).length,
      candidates: candidateReports,
    };
    const qualifiedRows = extractionRows
      .filter((row) => row.sessionIndex <= originEnd)
      .map((row) => ({
        ...row,
        memories:
          row.sessionIndex >= originStart
            ? (qualifiedBySession.get(row.sessionIndex) ?? [])
            : [],
      }));
    writeFileSync(output, `${qualifiedRows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, candidates: undefined, output, report: reportPath }, null, 2)}\n`);
  } finally {
    service.close();
  }
}

async function auditSession(input: {
  model: string;
  baseUrl: string;
  apiKey: string;
  cacheDir: string;
  candidates: readonly Candidate[];
  dialogue: readonly DialogueTurn[];
  session: number;
}): Promise<CandidateVote[]> {
  const userDialogue = input.dialogue.filter((turn) => turn.role === "user");
  const candidatePayload = input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    statement: candidate.memory.statement,
  }));
  const payload = JSON.stringify({ candidates: candidatePayload, userMessages: userDialogue });
  const cachePath = resolve(input.cacheDir, `${digest(`${input.model}\0${SYSTEM_PREFIX}\0${payload}`)}.json`);
  if (existsSync(cachePath)) return JSON.parse(readFileSync(cachePath, "utf8")) as CandidateVote[];
  const response = await fetch(`${input.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.apiKey}` },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: SYSTEM_PREFIX },
        { role: "user", content: payload },
      ],
      temperature: 0,
      thinking: { type: "disabled" },
      stream: false,
    }),
  });
  if (!response.ok) throw new Error(`promotion audit failed with HTTP ${response.status}`);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
  const votes = parsePromotionVotes(
    body.choices?.[0]?.message?.content ?? "",
    new Set(input.candidates.map((candidate) => candidate.candidateId)),
    input.dialogue,
  );
  writeFileSync(cachePath, JSON.stringify(votes, null, 2), "utf8");
  return votes;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("limits must be positive integers");
  return parsed;
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error(`invalid argument near ${key ?? "end"}`);
    result[key.slice(2).replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
