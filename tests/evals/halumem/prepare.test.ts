import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { extractUserName, prepareHaluMem } from "../../../evals/halumem/prepare.ts";

test("HaluMem adapter emits official extraction/update fields without QA", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-halumem-"));
  const input = join(root, "input.jsonl");
  const output = join(root, "output.jsonl");
  writeFileSync(
    input,
    `${JSON.stringify({
      uuid: "u1",
      persona_info: "Name: Ada Lovelace; Gender: Female; Location: London;",
      sessions: [
        {
          dialogue: [
            { role: "user", content: "I now live in Paris.", timestamp: "2026-01-01" },
            { role: "assistant", content: "Thanks, I will remember that." },
          ],
          memory_points: [
            {
              memory_content: "Ada now lives in Paris",
              is_update: "True",
              original_memories: ["Ada lived in London"],
              memory_source: "system",
              importance: 1,
              memory_type: "Persona Memory",
            },
          ],
          questions: [{ question: "Where?" }],
        },
      ],
    })}\n`,
    "utf8",
  );
  try {
    const summary = await prepareHaluMem({
      input,
      output,
      dataDir: join(root, "store"),
      reset: true,
    });
    assert.equal(summary.users, 1);
    assert.equal(summary.sessions, 1);
    assert.equal(summary.extractedMemories, 2);
    assert.equal(summary.updateQueries, 1);

    const result = JSON.parse(readFileSync(output, "utf8").trim()) as {
      user_name: string;
      sessions: Array<Record<string, unknown>>;
    };
    assert.equal(result.user_name, "Ada Lovelace");
    assert.deepEqual(result.sessions[0].extracted_memories, [
      "I now live in Paris.",
      "Thanks, I will remember that.",
    ]);
    assert.equal("questions" in result.sessions[0], false);
    const points = result.sessions[0].memory_points as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(points[0].memories_from_system));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HaluMem name extraction follows the official persona field", () => {
  assert.equal(extractUserName("Name: Martin Mark; Gender: Male;"), "Martin Mark");
  assert.throws(() => extractUserName("No structured name"), /does not contain a name/);
});

test("HaluMem slice replays prior sessions without scoring them", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-halumem-slice-"));
  const input = join(root, "input.jsonl");
  const output = join(root, "output.jsonl");
  const session = (content: string) => ({
    dialogue: [{ role: "user", content }],
    memory_points: [],
  });
  writeFileSync(
    input,
    `${JSON.stringify({
      uuid: "u2",
      persona_info: "Name: Grace Hopper; Gender: Female;",
      sessions: [session("Earlier evidence."), session("Selected evidence.")],
    })}\n`,
  );
  try {
    const summary = await prepareHaluMem({
      input,
      output,
      dataDir: join(root, "store"),
      sessionStart: 2,
      maxSessions: 1,
      reset: true,
    });
    assert.equal(summary.sessions, 1);
    assert.equal(summary.extractedMemories, 1);
    const result = JSON.parse(readFileSync(output, "utf8").trim()) as {
      sessions: Array<{ extracted_memories: string[] }>;
    };
    assert.deepEqual(result.sessions[0].extracted_memories, ["Selected evidence."]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HaluMem prepare can score agent-filtered candidates instead of raw turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "nmg-halumem-agent-"));
  const input = join(root, "input.jsonl");
  const extractions = join(root, "extractions.jsonl");
  const output = join(root, "output.jsonl");
  writeFileSync(
    input,
    `${JSON.stringify({
      uuid: "u3",
      persona_info: "Name: Katherine Johnson; Gender: Female;",
      sessions: [
        {
          dialogue: [
            { role: "user", content: "I prefer exact calculations." },
            { role: "assistant", content: "You should buy a telescope." },
          ],
          memory_points: [],
        },
      ],
    })}\n`,
  );
  writeFileSync(
    extractions,
    `${JSON.stringify({
      uuid: "u3",
      sessionIndex: 1,
      memories: [{ statement: "The user prefers exact calculations." }],
    })}\n`,
  );
  try {
    await prepareHaluMem({
      input,
      output,
      dataDir: join(root, "store"),
      agentExtractions: extractions,
      reset: true,
    });
    const result = JSON.parse(readFileSync(output, "utf8").trim()) as {
      sessions: Array<{ extracted_memories: string[] }>;
    };
    assert.deepEqual(result.sessions[0].extracted_memories, [
      "The user prefers exact calculations.",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
