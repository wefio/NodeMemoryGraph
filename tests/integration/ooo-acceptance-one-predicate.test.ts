import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { acceptedFact, isAccepted, type TaskUnit } from "../../src/integration/task-semantics.ts";

const root = new URL("../../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (relative: string) => readFileSync(join(root, relative), "utf8");

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(join(root, directory))) {
    const relative = `${directory}/${name}`;
    if (statSync(join(root, relative)).isDirectory()) sourceFiles(relative, found);
    else if (name.endsWith(".ts")) found.push(relative);
  }
  return found;
}

const count = (source: string, needle: string) => source.split(needle).length - 1;

/** The rule the design states as "接受查询与依赖解锁必须调用同一谓词". A document
 *  cannot fail a build; a second copy of the rule can drift, so the rule is pinned
 *  here mechanically and the two callers are shown to agree case by case.
 *
 *  These checks count occurrences instead of slicing a function body. A slice whose
 *  end boundary is not found silently runs to the end of the file, which once made
 *  this very test pass while the call site underneath it had been renamed. */
test("acceptance has one home, and both readers reach it", () => {
  const semantics = read("src/integration/task-semantics.ts");
  const board = read("src/integration/ooo-board.ts");

  // One home: the predicate is defined once in the whole integration layer.
  const definitions = sourceFiles("src").filter((file) =>
    read(file).includes("export function acceptedFact("),
  );
  assert.deepEqual(definitions, ["src/integration/task-semantics.ts"]);

  // Both readers call it rather than carrying their own copy of the decision.
  assert.equal(count(board, "acceptedFact({"), 1, "the board's read path must call the predicate");
  assert.equal(count(semantics, "acceptedFact({"), 1, "the derived view must call the predicate");

  // The comparison the predicate owns is written down once, inside the predicate.
  assert.equal(count(semantics, "judgedDigest === fact.digest"), 1, "one place decides acceptance");
  assert.equal(count(board, "judgedDigest === fact.digest"), 0, "ooo-board.ts decides on its own");
  assert.equal(count(board, "verdict ==="), 0, "ooo-board.ts decides on its own");
});

/** Agreement over one facts snapshot: the status query (the board's read) and
 *  dependency release (the derived view) must not disagree about the same row. */
test("the two readers agree over the same recorded facts", () => {
  const unit: TaskUnit = { id: "T", revision: "rev-1" } as TaskUnit;
  const cases = [
    {
      name: "delivered and judged",
      verdict: { verdict: "accepted", digest: "rev-1" },
      expected: true,
    },
    {
      name: "verdict about another digest",
      verdict: { verdict: "accepted", digest: "rev-1-old" },
      expected: false,
    },
    { name: "rejected", verdict: { verdict: "rejected", digest: "rev-1" }, expected: false },
    { name: "no verdict at all", verdict: undefined, expected: false },
    {
      name: "undecidable is not acceptance",
      verdict: { verdict: "undecidable", digest: "rev-1" },
      expected: false,
    },
  ] as const;

  for (const item of cases) {
    const facts = {
      artifacts: { T: "rev-1" },
      revisions: { T: "rev-1" },
      verdicts: item.verdict ? { T: item.verdict } : {},
    };
    const derived = isAccepted(unit, facts);
    const asked = acceptedFact({
      artifact: "rev-1",
      digest: "rev-1",
      verdict: item.verdict?.verdict ?? null,
      judgedDigest: item.verdict?.digest ?? null,
      currentRevision: true,
      cancelled: false,
    });
    assert.equal(derived, item.expected, `derived view: ${item.name}`);
    assert.equal(asked, item.expected, `predicate: ${item.name}`);
  }

  // The case the design calls out by name: bytes on disk are not acceptance.
  const bytes = { artifacts: { T: "rev-1" }, revisions: { T: "rev-1" } };
  assert.equal(isAccepted(unit, bytes), false, "an artifact with no verdict is not accepted");

  // Revision drift, and cancellation, withdraw acceptance on both paths.
  assert.equal(
    isAccepted(unit, {
      artifacts: { T: "rev-1" },
      revisions: { T: "rev-2" },
      verdicts: { T: { verdict: "accepted", digest: "rev-1" } },
    }),
    false,
    "an artifact built from a superseded revision is not accepted",
  );
  assert.equal(
    isAccepted(unit, {
      artifacts: { T: "rev-1" },
      revisions: { T: "rev-1" },
      verdicts: { T: { verdict: "accepted", digest: "rev-1" } },
      cancellations: ["T"],
    }),
    false,
    "a cancelled run accepts nothing",
  );
});
