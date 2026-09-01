import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionActiveGraphRuntime } from "../../src/core/session-active-graph.ts";
import { NmgStore } from "../../src/core/store.ts";
import { memoryDisclosureEntries } from "../../src/integration/search-projection.ts";

const directory = mkdtempSync(join(tmpdir(), "nmg-disclosure-eval-"));
const store = new NmgStore(join(directory, "nmg.sqlite"));

try {
  for (let index = 0; index < 32; index += 1) {
    store.remember({
      statement:
        `Atlas archive calibration record ${index}. ` +
        `The checksum observation is channel-${index}; repeated operational detail `.repeat(4),
      nodeName: "Atlas archive calibration",
      memoryType: "event",
      tier: 1,
      importance: 0.5,
      eventTime: `2026-07-${String((index % 28) + 1).padStart(2, "0")}`,
    });
  }

  const common = {
    sessionId: "eval-session",
    maxTier: 1 as const,
    limit: 32,
    activeGraphBudget: { maxTokens: 20_000, maxEvidence: 32, maxLocalTier: 1 as const },
  };
  const full = store.searchContext("Atlas archive calibration checksum", {
    ...common,
    progressiveWarmDisclosure: false,
  });
  const progressive = store.searchContext("Atlas archive calibration checksum", {
    ...common,
    progressiveWarmDisclosure: true,
  });

  const runtime = new SessionActiveGraphRuntime();
  const projection = runtime.registerProjection(progressive.activeGraph!, []);
  runtime.beginDisclosureTurn("eval-session");
  const entries = memoryDisclosureEntries(progressive, "header");
  const first = runtime.disclose({
    sessionId: "eval-session",
    projectionId: projection.projectionId,
    disclosure: "header",
    entries,
  });
  runtime.beginDisclosureTurn("eval-session");
  const repeated = runtime.disclose({
    sessionId: "eval-session",
    projectionId: projection.projectionId,
    disclosure: "header",
    entries,
  });
  const firstInjection = progressive.results
    .filter((result) => first.freshMemoryIds.includes(result.memory.id))
    .map((result) => result.memory.statement)
    .join("\n");
  const repeatedInjection = repeated.foldedMemoryIds.join("\n");

  console.log(
    JSON.stringify(
      {
        corpus: { tier1Records: 32 },
        full: {
          records: full.results.length,
          estimatedTokens: full.activeGraph?.usage.estimatedTokens ?? 0,
        },
        progressive: {
          records: progressive.results.length,
          estimatedTokens: progressive.activeGraph?.usage.estimatedTokens ?? 0,
          disclosure: progressive.progressiveDisclosure ?? null,
        },
        sessionWindow: {
          firstHeaderCharacters: firstInjection.length,
          repeatedHeaderCharacters: repeatedInjection.length,
          savedCharacters: firstInjection.length - repeatedInjection.length,
          repeatedUsesReferencesOnly: !repeatedInjection.includes("checksum observation"),
        },
        limitation:
          "Synthetic deterministic workload measures disclosure mechanics, not answer quality or provider tokenization.",
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
