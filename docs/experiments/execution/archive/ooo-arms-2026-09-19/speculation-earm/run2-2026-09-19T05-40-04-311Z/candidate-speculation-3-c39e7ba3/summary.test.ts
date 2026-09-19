import assert from "node:assert/strict";
import test from "node:test";

import type { Section } from "./interface.ts";
import { summarySection } from "./summary.ts";

/** The summary's own acceptance needs the frozen shape and nothing else: which sections it is handed
 *  is the composition's business, and the composed check is where the real builders meet. */
const section = (id: string, title: string): Section => ({ id, title, lines: [] });

test("the summary lists the sections it was given, in the order they were given", () => {
  assert.deepEqual(summarySection([section("alpha", "Alpha"), section("beta", "Beta")]), {
    id: "summary",
    title: "Summary",
    lines: ["- Alpha", "- Beta"],
  });
  assert.deepEqual(summarySection([section("gamma", "Gamma"), section("alpha", "Alpha")]), {
    id: "summary",
    title: "Summary",
    lines: ["- Gamma", "- Alpha"],
  });
});
