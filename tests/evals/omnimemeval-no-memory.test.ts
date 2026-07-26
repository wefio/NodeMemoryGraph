import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareNoMemoryResults } from "../../evals/omnimemeval/prepare-no-memory.ts";

test("no-memory baseline preserves matched questions while removing retrieved context", () => {
  const directory = mkdtempSync(join(tmpdir(), "omnimemeval-no-memory-"));
  const source = join(directory, "source.json");
  const target = join(directory, "target", "results.json");
  writeFileSync(
    source,
    JSON.stringify({
      user_0: [
        {
          query: "What happened?",
          context: "retrieved evidence",
          raw_context: ["internal evidence"],
          reflect_answer: "backend answer",
          duration_ms: 42,
          status: "success",
          trace: { candidateCount: 4 },
        },
      ],
    }),
    "utf8",
  );

  try {
    assert.deepEqual(prepareNoMemoryResults(source, target), { groups: 1, questions: 1 });
    const output = JSON.parse(readFileSync(target, "utf8"));
    assert.deepEqual(output.user_0[0], {
      query: "What happened?",
      context: "",
      raw_context: "",
      reflect_answer: null,
      duration_ms: 0,
      status: "success_empty",
      trace: { candidateCount: 4 },
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
