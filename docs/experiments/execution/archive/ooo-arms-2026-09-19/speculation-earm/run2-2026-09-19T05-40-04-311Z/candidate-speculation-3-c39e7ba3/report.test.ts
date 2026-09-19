import assert from "node:assert/strict";
import test from "node:test";

import { alphaSection } from "./alpha.ts";
import { betaSection } from "./beta.ts";
import { gammaSection } from "./gamma.ts";
import { render } from "./interface.ts";
import { summarySection } from "./summary.ts";

/** The composition's own acceptance: the frozen renderer over the composed sections. */
test("the composed report renders the frozen interface's shape", () => {
  const report = summarySection([
    alphaSection(["b=2", "a=1"]),
    betaSection(["x"]),
    gammaSection(["a", "a"]),
  ]);
  assert.equal(render(report), "## Summary\n- Alpha\n- Beta\n- Gamma\n");
});
