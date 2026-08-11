import { createReadStream, createWriteStream, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { OmniMemEvalBridge, type OmniMessage } from "../omnimemeval/bridge.ts";

type HaluMemoryPoint = {
  memory_content: string;
  is_update: string;
  original_memories?: string[];
  memories_from_system?: string[];
  [key: string]: unknown;
};

type HaluSession = {
  dialogue: Array<{ role: string; content: string; timestamp?: string }>;
  memory_points: HaluMemoryPoint[];
  is_generated_qa_session?: boolean;
  [key: string]: unknown;
};

type HaluUser = {
  uuid: string;
  persona_info: string;
  sessions: HaluSession[];
};

export interface PrepareOptions {
  input: string;
  output: string;
  dataDir: string;
  maxUsers?: number;
  maxSessions?: number;
  sessionStart?: number;
  updateTopK?: number;
  reset?: boolean;
  agentExtractions?: string;
}

export interface PreparedSummary {
  users: number;
  sessions: number;
  extractedMemories: number;
  updateQueries: number;
  output: string;
}

/**
 * Produce the official HaluMem extraction/update artifact without answering QA.
 *
 * This intentionally measures NMG's current benchmark ingress: every accepted
 * dialogue message becomes conversation evidence. It does not insert a hidden
 * LLM extractor or rewrite product policy to improve the benchmark score.
 */
export async function prepareHaluMem(options: PrepareOptions): Promise<PreparedSummary> {
  const input = resolve(options.input);
  const output = resolve(options.output);
  const dataDir = resolve(options.dataDir);
  const maxUsers = positiveInteger(options.maxUsers, Number.POSITIVE_INFINITY);
  const maxSessions = positiveInteger(options.maxSessions, Number.POSITIVE_INFINITY);
  const sessionStart = positiveInteger(options.sessionStart, 1);
  const updateTopK = positiveInteger(options.updateTopK, 10);
  const agentExtractions = options.agentExtractions
    ? loadAgentExtractions(resolve(options.agentExtractions))
    : undefined;
  if (options.reset) rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });

  const bridge = new OmniMemEvalBridge(dataDir);
  const writer = createWriteStream(output, { encoding: "utf8" });
  const summary: PreparedSummary = {
    users: 0,
    sessions: 0,
    extractedMemories: 0,
    updateQueries: 0,
    output,
  };
  try {
    const lines = createInterface({ input: createReadStream(input, "utf8"), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      if (summary.users >= maxUsers) break;
      const user = JSON.parse(line) as HaluUser;
      const userName = extractUserName(user.persona_info);
      const userId = `${userName}_${user.uuid}`;
      const preparedSessions: Record<string, unknown>[] = [];
      for (const [sessionIndex, session] of user.sessions.entries()) {
        if (preparedSessions.length >= maxSessions) break;
        const extracted = agentExtractions?.get(`${user.uuid}:${sessionIndex + 1}`);
        if (agentExtractions && !extracted) {
          throw new Error(`missing agent extraction for ${user.uuid} session ${sessionIndex + 1}`);
        }
        const dialogue = (extracted ?? session.dialogue).map<OmniMessage>((turn) => ({
          ...(typeof turn === "string"
            ? { role: "user", content: turn }
            : {
          role: turn.role,
          content: turn.content,
          chat_time: turn.timestamp,
              }),
        }));
        const started = performance.now();
        const added = (await bridge.handle({
          id: `${user.uuid}:add:${sessionIndex}`,
          op: "add",
          userId,
          conversationId: `${sessionIndex + 1}_${userId}`,
          messages: dialogue,
        })) as { added: number; memories: string[] };

        // Earlier sessions are replayed to establish the correct memory state,
        // but a bounded slice may choose not to score them.
        if (sessionIndex + 1 < sessionStart) continue;

        if (session.is_generated_qa_session) {
          preparedSessions.push({
            is_generated_qa_session: true,
            add_dialogue_duration_ms: performance.now() - started,
          });
          continue;
        }

        const memoryPoints = structuredClone(session.memory_points);
        for (const point of memoryPoints) {
          if (point.is_update !== "True" || !(point.original_memories?.length ?? 0)) continue;
          const searched = (await bridge.handle({
            id: `${user.uuid}:update:${sessionIndex}:${summary.updateQueries}`,
            op: "search",
            userId,
            query: point.memory_content,
            topK: updateTopK,
          })) as { memories: Array<{ statement: string }> };
          point.memories_from_system = searched.memories.map((memory) => memory.statement);
          summary.updateQueries += 1;
        }
        preparedSessions.push({
          memory_points: memoryPoints,
          dialogue: session.dialogue,
          extracted_memories: added.memories,
          add_dialogue_duration_ms: performance.now() - started,
          conv_id: `${sessionIndex + 1}_${userId}`,
        });
        summary.extractedMemories += added.memories.length;
      }
      writer.write(
        `${JSON.stringify({ uuid: user.uuid, user_name: userName, sessions: preparedSessions })}\n`,
      );
      summary.users += 1;
      summary.sessions += preparedSessions.length;
    }
  } finally {
    bridge.close();
    await new Promise<void>((resolveEnd, reject) => {
      writer.once("error", reject);
      writer.end(resolveEnd);
    });
  }
  return summary;
}

export function extractUserName(personaInfo: string): string {
  const match = /Name:\s*(.*?);\s*Gender:/u.exec(personaInfo);
  if (!match?.[1]?.trim()) throw new Error("HaluMem persona_info does not contain a name");
  return match[1].trim();
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error("limits must be positive integers");
  return Math.trunc(value);
}

function parseArguments(argv: readonly string[]): PrepareOptions {
  const values = new Map<string, string>();
  let reset = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--reset") {
      reset = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  return {
    input:
      values.get("--input") ??
      ".benchmarks/official/OmniMemEval/data/halumem/HaluMem-Medium.jsonl",
    output: values.get("--output") ?? ".benchmarks/halumem-nmg/results/nmg_eval_results.jsonl",
    dataDir: values.get("--data-dir") ?? ".benchmarks/halumem-nmg/store",
    maxUsers: values.has("--users") ? Number(values.get("--users")) : undefined,
    maxSessions: values.has("--sessions") ? Number(values.get("--sessions")) : undefined,
    sessionStart: values.has("--session-start")
      ? Number(values.get("--session-start"))
      : undefined,
    updateTopK: values.has("--update-top-k") ? Number(values.get("--update-top-k")) : undefined,
    reset,
    agentExtractions: values.get("--agent-extractions"),
  };
}

function loadAgentExtractions(path: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as {
      uuid: string;
      sessionIndex: number;
      memories: Array<{ statement: string }>;
    };
    result.set(`${row.uuid}:${row.sessionIndex}`, row.memories.map((memory) => memory.statement));
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  prepareHaluMem(parseArguments(process.argv.slice(2)))
    .then((summary) => process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
