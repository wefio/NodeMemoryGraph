import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildNamesakesCandidates,
  loadNamesakesEntities,
  namesakesStreamingAudit,
  namesakesThresholdCurve,
  type NamesakesEntity,
} from "../../../evals/topology/namesakes.ts";

test("Namesakes adapter streams official JSONL shape and honours the entity limit", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-namesakes-"));
  const path = join(directory, "entities.jsonl");
  try {
    writeFileSync(path, `${JSON.stringify(fixture("1"))}\n${JSON.stringify(fixture("2"))}\n`);
    const rows = await loadNamesakesEntities(path, 1);
    assert.equal(rows.length, 1);
    assert.equal(String(rows[0]!.pageid), "1");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Namesakes candidate report separates alias positives and exact-name negatives", () => {
  const candidates = buildNamesakesCandidates([fixture("1")], 40);
  assert.equal(candidates.length, 3);
  assert.equal(candidates.filter((item) => item.tag === "Same").length, 2);
  assert.equal(candidates.filter((item) => item.aliasPositive).length, 1);
  assert.equal(candidates.filter((item) => item.exactNameNegative).length, 1);

  const [all] = namesakesThresholdCurve(candidates, [-1]);
  assert.equal(all!.recall, 1);
  assert.equal(all!.precision, 2 / 3);
  assert.equal(all!.aliasRecall, 1);
  assert.equal(all!.exactNameNegativeRejection, 0);

  const [streaming] = namesakesStreamingAudit(candidates, [-1]);
  assert.deepEqual(streaming, {
    threshold: -1,
    incomingMentions: 3,
    proposals: 3,
    proposalRate: 1,
    entitiesWithProposal: 1,
    entitiesWithFalseProposal: 1,
    falseProposalEntityRate: 1,
    contaminatingMentions: 1,
    meanContaminationPerAffectedEntity: 1,
    maxContaminationPerEntity: 1,
  });
});

function fixture(pageid: string): NamesakesEntity {
  const parts = [
    "Jordan Lee founded the observatory and catalogued several comets.",
    "J. Lee later presented the observatory results to the astronomy society.",
    "Jordan Lee published the same astronomy catalogue the following year.",
    "Jordan Lee won a city tennis tournament; this athlete is a different person.",
  ];
  const text = parts.join(" ");
  let cursor = 0;
  const entities = parts.map((part, index) => {
    const mention = index === 1 ? "J. Lee" : "Jordan Lee";
    const start = text.indexOf(mention, cursor);
    cursor = start + mention.length;
    return {
      text: mention,
      start,
      end: cursor,
      tag: index === 3 ? "Other" as const : "Same" as const,
    };
  });
  return {
    pagename: "Jordan_Lee_(astronomer)",
    pageid,
    title: "Jordan Lee",
    url: `https://example.test/${pageid}`,
    text,
    entities,
  };
}
