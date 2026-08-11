import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

import { benchmarkCredentialEnvironment } from "../local-env.ts";
import { loadPrompts } from "../../src/prompts/load.ts";

export type AgentExtractedMemory = {
  statement: string;
  memoryType: "constraint" | "event" | "fact" | "preference" | "state" | "strategy";
  evidence: string;
  eventTime?: string;
  stateKey?: string;
};

export type AgentExtractionRow = {
  uuid: string;
  sessionIndex: number;
  dialogueHash: string;
  policyHash: string;
  model: string;
  memories: AgentExtractedMemory[];
};

const SYSTEM_PREFIX = `You are executing the NMG durable-memory write policy.
Review one conversation session and return only durable, attributable memory candidates.

Rules:
- Automatically retain stable user facts, preferences, constraints, current states,
  significant events, and reusable strategies.
- Do not retain casual chatter, questions, repetitions, transient instructions,
  secrets, unsupported guesses, or routine assistant coaching.
- An assistant proposal is not a user fact unless the user clearly confirms or adopts it.
- Keep independently changeable facts separate. Use state plus a stable stateKey only
  for a single replaceable property; use event for something that happened.
- Each statement must be self-contained and preserve subject, scope, time, polarity,
  quantities, and exceptions when they change meaning.
- evidence must be the smallest exact excerpt from the dialogue supporting the statement.
- Do not infer from benchmark expectations or outside knowledge.

Return one JSON object and no prose:
{"memories":[{"statement":"...","memoryType":"fact|preference|constraint|state|event|strategy","evidence":"exact excerpt","eventTime":"optional source timestamp","stateKey":"optional stable property key"}]}
Return {"memories":[]} when nothing qualifies.`;

export function parseAgentExtraction(raw: string): AgentExtractedMemory[] {
  const fenced = /```(?:json)?\s*(\{[\s\S]*\})\s*```/iu.exec(raw.trim());
  const source = fenced?.[1] ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  const parsed = JSON.parse(source) as { memories?: unknown };
  if (!Array.isArray(parsed.memories)) throw new Error("agent extraction must contain memories[]");
  const allowed = new Set(["constraint", "event", "fact", "preference", "state", "strategy"]);
  return parsed.memories.map((value, index) => {
    const row = value as Record<string, unknown>;
    const statement = String(row.statement ?? "").trim();
    const evidence = String(row.evidence ?? "").trim();
    const rawMemoryType = String(row.memoryType ?? "").trim().toLowerCase();
    const memoryType =
      ({ goal: "fact", decision: "fact", persona: "fact", relationship: "fact", procedure: "strategy" } as Record<
        string,
        string
      >)[rawMemoryType] ?? rawMemoryType;
    if (!statement || !evidence || !allowed.has(memoryType)) {
      throw new Error(`invalid memory at index ${index}`);
    }
    return {
      statement,
      evidence,
      memoryType: memoryType as AgentExtractedMemory["memoryType"],
      ...(row.eventTime ? { eventTime: String(row.eventTime) } : {}),
      ...(row.stateKey ? { stateKey: String(row.stateKey) } : {}),
    };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(import.meta.dirname, "../..");
  const input = resolve(
    args.input ?? ".benchmarks/official/OmniMemEval/data/halumem/HaluMem-Medium.jsonl",
  );
  const output = resolve(
    args.output ?? ".benchmarks/halumem-nmg/results/agent-extractions.jsonl",
  );
  const cacheDir = resolve(args.cacheDir ?? ".benchmarks/halumem-nmg/extraction-cache");
  const maxUsers = positive(args.users, 1);
  const throughSession = positive(args.throughSession, 1);
  const model = args.model ?? process.env.NMG_HALUMEM_EXTRACT_MODEL ?? "deepseek-chat";
  const credentials = benchmarkCredentialEnvironment(root);
  const apiKey = process.env.DEEPSEEK_API_KEY ?? credentials.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is required for agent extraction");
  const baseUrl = (process.env.NMG_HALUMEM_EXTRACT_BASE_URL ?? "https://api.deepseek.com").replace(
    /\/+$/u,
    "",
  );
  const policy = loadPrompts().memory_policy;
  const policyHash = digest(`${SYSTEM_PREFIX}\n${policy}`);
  mkdirSync(cacheDir, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });

  const rows: AgentExtractionRow[] = [];
  const lines = createInterface({ input: createReadStream(input, "utf8"), crlfDelay: Infinity });
  let users = 0;
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (users >= maxUsers) break;
    const user = JSON.parse(line) as {
      uuid: string;
      sessions: Array<{
        dialogue: Array<{ role: string; content: string; timestamp?: string }>;
      }>;
    };
    for (let index = 0; index < Math.min(throughSession, user.sessions.length); index += 1) {
      const dialogue = user.sessions[index]!.dialogue;
      const dialogueHash = digest(JSON.stringify(dialogue));
      const cachePath = resolve(cacheDir, `${digest(`${model}\0${policyHash}\0${dialogueHash}`)}.json`);
      let memories: AgentExtractedMemory[];
      if (existsSync(cachePath)) {
        memories = JSON.parse(readFileSync(cachePath, "utf8")) as AgentExtractedMemory[];
      } else {
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: `${SYSTEM_PREFIX}\n\nNMG runtime policy:\n${policy}` },
              { role: "user", content: renderDialogue(dialogue) },
            ],
            temperature: 0,
            thinking: { type: "disabled" },
            stream: false,
          }),
        });
        if (!response.ok) throw new Error(`agent extraction failed with HTTP ${response.status}`);
        const payload = (await response.json()) as {
          choices?: Array<{ message?: { content?: string | null } }>;
        };
        const raw = payload.choices?.[0]?.message?.content ?? "";
        try {
          memories = parseAgentExtraction(raw);
        } catch (error) {
          const failurePath = resolve(cacheDir, `rejected-${dialogueHash}.txt`);
          writeFileSync(failurePath, raw, "utf8");
          throw new Error(
            `${error instanceof Error ? error.message : String(error)}; raw response saved to ${failurePath}`,
          );
        }
        writeFileSync(cachePath, JSON.stringify(memories, null, 2), "utf8");
      }
      rows.push({ uuid: user.uuid, sessionIndex: index + 1, dialogueHash, policyHash, model, memories });
    }
    users += 1;
  }
  writeFileSync(output, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({ users, sessions: rows.length, memories: rows.reduce((n, r) => n + r.memories.length, 0), model, policyHash, output }, null, 2)}\n`,
  );
}

function renderDialogue(
  dialogue: Array<{ role: string; content: string; timestamp?: string }>,
): string {
  return dialogue
    .map((turn) => `[${turn.timestamp ?? "time unknown"}] ${turn.role}: ${turn.content}`)
    .join("\n");
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
