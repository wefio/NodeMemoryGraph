import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadDataset } from "../../evals/retrieval/datasets.ts";

function fixtureRoot(): string {
  return mkdtempSync(join(tmpdir(), "nmg-retrieval-datasets-"));
}

test("PersonaMem loader preserves official related snippets as exact retrieval gold", () => {
  const root = fixtureRoot();
  const base = join(root, "personamem_v2", "benchmark", "text");
  const chatDir = join(root, "personamem_v2", "data", "chat_history_32k");
  mkdirSync(base, { recursive: true });
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(
    join(chatDir, "persona-1.json"),
    JSON.stringify({
      metadata: { persona_id: "persona-1" },
      chat_history: [
        { role: "system", content: "private benchmark instruction" },
        { role: "user", content: "I prefer jasmine tea." },
        { role: "assistant", content: "I will remember that." },
      ],
    }),
  );
  const snippet = JSON.stringify([{ role: "user", content: "I prefer jasmine tea." }]);
  const escapedSnippet = `"${snippet.replaceAll('"', '""')}"`;
  writeFileSync(
    join(base, "benchmark.csv"),
    [
      "persona_id,chat_history_32k_link,user_query,pref_type,related_conversation_snippet",
      `persona-1,data/chat_history_32k/persona-1.json,What tea do I prefer?,explicit,${escapedSnippet}`,
    ].join("\n"),
  );

  const dataset = loadDataset("personamem", { full: true }, root);
  assert.equal(dataset.direction, "gold-in-candidate");
  assert.deepEqual(dataset.questions[0]?.golds, ["I prefer jasmine tea."]);
  assert.deepEqual(
    dataset.conversations[0]?.messages.map((message) => message.content),
    ["I prefer jasmine tea.", "I will remember that."],
  );
});

test("HaluMem loader exposes an explicit gold-memory retrieval arm", () => {
  const root = fixtureRoot();
  const base = join(root, "halumem");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, "HaluMem-Medium.jsonl"),
    `${JSON.stringify({
      uuid: "user-1",
      sessions: [
        {
          session_id: "session-1",
          memory_points: [
            {
              memory_content: "Martin Mark's birth date is 1996-08-02",
              memory_type: "Personal Information",
            },
          ],
          dialogue: [{ role: "user", content: "I was born on 1996-08-02." }],
          questions: [
            {
              question: "When was Martin Mark born?",
              question_type: "Memory Retrieval",
              evidence: [
                {
                  memory_content: "Martin Mark's birth date is 1996-08-02",
                  memory_type: "Personal Information",
                },
              ],
            },
            { question: "What is not known?", question_type: "Memory Boundary", evidence: [] },
          ],
        },
      ],
    })}\n`,
  );

  const dataset = loadDataset("halumem", { full: true }, root);
  assert.equal(dataset.direction, "gold-in-candidate");
  assert.match(dataset.sampleNote, /gold-memory retrieval arm/);
  assert.deepEqual(
    dataset.conversations[0]?.messages.map((message) => message.content),
    ["Martin Mark's birth date is 1996-08-02"],
  );
  assert.deepEqual(dataset.questions[0]?.golds, ["Martin Mark's birth date is 1996-08-02"]);
  assert.deepEqual(dataset.questions[1]?.golds, []);
});

test("LoCoMo loader converts its natural-language session time to an ISO timestamp", () => {
  const root = fixtureRoot();
  const base = join(root, "locomo");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    join(base, "locomo10.json"),
    JSON.stringify([
      {
        conversation: {
          speaker_a: "Alice",
          speaker_b: "Bob",
          session_1_date_time: "1:56 pm on 8 May, 2023",
          session_1: [{ speaker: "Alice", dia_id: "D1:1", text: "I bought a telescope." }],
        },
        qa: [{ question: "What did Alice buy?", evidence: ["D1:1"], category: 1 }],
      },
    ]),
  );

  const dataset = loadDataset("locomo", { full: true }, root);
  assert.equal(dataset.conversations[0]?.messages[0]?.chat_time, "2023-05-08T13:56:00.000Z");
});
