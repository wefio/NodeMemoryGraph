import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadBeam, loadLocomo, loadPersonaMem, stratifiedSample } from "./loaders.ts";

test("loads LoCoMo sessions, evidence ids, and QA categories", () => {
  withTempDirectory((directory) => {
    const path = join(directory, "locomo.json");
    writeFileSync(path, JSON.stringify([{
      sample_id: "conv-1",
      conversation: {
        speaker_a: "Alex",
        speaker_b: "Sam",
        session_1_date_time: "2026-01-01",
        session_1: [
          { speaker: "Alex", dia_id: "d1", text: "I prefer tea." },
          { speaker: "Sam", dia_id: "d2", text: "Noted." },
        ],
      },
      qa: [{ question: "What does Alex prefer?", answer: "tea", category: 1, evidence: ["d1"] }],
    }]));
    const [item] = loadLocomo(path);
    assert.equal(item?.question, "What does Alex prefer?");
    assert.equal(item?.sessions[0]?.turns[0]?.role, "user");
    assert.equal(item?.sessions[0]?.turns[0]?.speaker, "Alex");
    assert.deepEqual(item?.evidenceIds, ["d1"]);
  });
});

test("joins PersonaMem CSV questions to sliced JSONL contexts", () => {
  withTempDirectory((directory) => {
    const questions = join(directory, "questions.csv");
    const contexts = join(directory, "contexts.jsonl");
    writeFileSync(questions, [
      "persona_id,question_id,question_type,user_question_or_message,correct_answer,all_options,shared_context_id,end_index_in_shared_context",
      '1,q1,preference,"What should I drink?",(b),"[""(a) coffee"",""(b) tea""]",ctx,2',
    ].join("\n"));
    writeFileSync(contexts, `${JSON.stringify({
      shared_context_id: "ctx",
      messages: [
        { role: "user", content: "I prefer tea." },
        { role: "assistant", content: "Okay." },
        { role: "user", content: "This turn is after the question." },
      ],
    })}\n`);
    const [item] = loadPersonaMem(questions, contexts);
    assert.equal(item?.sessions[0]?.turns.length, 2);
    assert.deepEqual(item?.options, ["(a) coffee", "(b) tea"]);
    assert.equal(item?.reference, "(b)");
  });
});

test("loads BEAM directory chats and probing categories", () => {
  withTempDirectory((directory) => {
    const caseDirectory = join(directory, "1");
    const probingDirectory = join(caseDirectory, "probing_questions");
    mkdirSync(probingDirectory, { recursive: true });
    writeFileSync(join(caseDirectory, "chat.json"), JSON.stringify([{
      batch_number: 1,
      turns: [[
        { role: "user", id: 7, content: "My deadline is Friday." },
        { role: "assistant", id: 8, content: "Understood." },
      ]],
    }]));
    writeFileSync(join(probingDirectory, "probing_questions.json"), JSON.stringify({
      information_extraction: [{
        question: "When is the deadline?",
        ideal_answer: "Friday",
        source_chat_ids: [7],
      }],
      abstention: [{ question: "What is the budget?", ideal_response: "Unknown" }],
    }));
    const cases = loadBeam(directory);
    assert.equal(cases.length, 2);
    assert.equal(cases[0]?.sessions[0]?.turns[0]?.sourceId, "7");
    assert.deepEqual(cases[0]?.evidenceIds, ["7"]);
    assert.equal(stratifiedSample(cases, 1).length, 2);
  });
});

function withTempDirectory(action: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "nmg-benchmark-"));
  try {
    action(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
