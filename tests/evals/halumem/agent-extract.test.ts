import assert from "node:assert/strict";
import test from "node:test";

import { parseAgentExtraction } from "../../../evals/halumem/agent-extract.ts";

test("agent extraction parser accepts bare and fenced durable memories", () => {
  const object = {
    memories: [
      {
        statement: "The user prefers tea.",
        memoryType: "preference",
        evidence: "I prefer tea.",
      },
    ],
  };
  assert.deepEqual(parseAgentExtraction(JSON.stringify(object)), object.memories);
  assert.deepEqual(parseAgentExtraction(`\`\`\`json\n${JSON.stringify(object)}\n\`\`\``), object.memories);
});

test("agent extraction parser fails closed on unsupported or unattributed output", () => {
  assert.throws(
    () =>
      parseAgentExtraction(
        JSON.stringify({ memories: [{ statement: "Maybe useful", memoryType: "guess" }] }),
      ),
    /invalid memory/,
  );
});

test("agent extraction maps only documented semantic aliases", () => {
  assert.equal(
    parseAgentExtraction(
      JSON.stringify({
        memories: [{ statement: "The user aims to help.", memoryType: "goal", evidence: "I aim to help." }],
      }),
    )[0]?.memoryType,
    "fact",
  );
});
