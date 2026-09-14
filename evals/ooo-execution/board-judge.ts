/**
 * Evidence driver: judge a delivered artifact from a *different* agent than the deliverer, on the
 * evidence rather than on the claim. It recomputes the artifact digest from the bytes at
 * `ref` and refuses to accept when it does not match what was delivered.
 *
 * Usage:
 *   node --experimental-strip-types evals/ooo-execution/board-judge.ts \
 *     --channel ooo-probe:<runId> --entry <id> --agent coordinator \
 *     --verdict accepted|rejected|undecidable --reason "..." [--store <path>]
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const { NmgStoreBase } = await import("../../src/core/store/base.ts");

// node:util owns flag parsing; an unknown flag or a repeated one is an error rather
// than something this script silently ignores.
const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    entry: { type: "string" },
    store: { type: "string" },
    agent: { type: "string" },
    verdict: { type: "string" },
    reason: { type: "string" },
  },
});

const channel = values.channel;
const entryId = values.entry;
const agentId = values.agent;
const verdict = values.verdict as "accepted" | "rejected" | "undecidable" | undefined;
const reason = values.reason;
for (const [name, value] of Object.entries({
  channel,
  entry: entryId,
  agent: agentId,
  verdict,
  reason,
})) {
  if (!value) throw new Error(`--${name} is required`);
}
if (!["accepted", "rejected", "undecidable"].includes(verdict!)) {
  throw new Error(`--verdict must be accepted | rejected | undecidable, got ${verdict}`);
}

const storePath = resolve(
  values.store ?? join(process.env.NMG_DATA_DIR ?? join(homedir(), ".nmg"), "nmg.sqlite"),
);
const store = new NmgStoreBase(storePath);
try {
  const entry = store
    .readTaskBoard({ taskId: channel!, limit: 200 })
    .entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`no entry ${entryId} in ${channel}`);
  if (!entry.deliverableDigest) throw new Error(`entry ${entryId} carries no deliverable`);
  if (entry.deliveredBy === agentId) {
    throw new Error("refusing to judge my own deliverable: the judge must not be the deliverer");
  }

  // The evidence check: the artifact must still hash to what was delivered.
  const ref = entry.deliverableRef;
  let observed = "unavailable";
  if (ref) {
    const bytes = statSync(ref).size;
    observed = createHash("sha256").update(readFileSync(ref)).digest("hex");
    console.log(`[judge] ${ref} bytes=${bytes} digest=${observed}`);
  }
  if (verdict === "accepted" && observed !== entry.deliverableDigest) {
    throw new Error(
      `refusing to accept: artifact digest ${observed} != delivered ${entry.deliverableDigest}`,
    );
  }

  const judged = store.judgeTaskBoardEntry({
    taskId: channel!,
    entryId: entryId!,
    agentId: agentId!,
    verdict: verdict!,
    reason: reason!,
  });
  console.log(
    JSON.stringify({
      entryId: judged.id,
      verdict: judged.verdict,
      judgedBy: judged.judgedBy,
      deliveryVerified: observed === entry.deliverableDigest,
      reason: judged.verdictReason,
    }),
  );
} finally {
  store.close();
}
