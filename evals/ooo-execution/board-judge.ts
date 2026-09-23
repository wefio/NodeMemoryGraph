/**
 * Evidence driver: judge a delivered artifact from a *different* agent than the deliverer, on the
 * evidence rather than on the claim. It recomputes the artifact digest from the bytes at
 * `ref` and refuses to accept when it does not match what was delivered.
 *
 * It reaches the board through the daemon that serves the round's store (`--daemon <store path>`),
 * as a client: the drivers do not open a database of their own.
 *
 * Usage:
 *   node --experimental-strip-types evals/ooo-execution/board-judge.ts \
 *     --daemon <round store path> --channel ooo-probe:<runId> --entry <id> --agent coordinator \
 *     --verdict accepted|rejected|undecidable --reason "..."
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { boardCall, roundDaemon } from "./round-client.ts";

// node:util owns flag parsing; an unknown flag or a repeated one is an error rather
// than something this script silently ignores.
const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    entry: { type: "string" },
    daemon: { type: "string" },
    agent: { type: "string" },
    verdict: { type: "string" },
    reason: { type: "string" },
  },
});

const channel = flag("channel", values.channel);
const entryId = flag("entry", values.entry);
const agentId = flag("agent", values.agent);
const verdict = flag("verdict", values.verdict) as "accepted" | "rejected" | "undecidable";
const reason = flag("reason", values.reason);
/** One required flag, refused by name. A loop over an object of them cannot narrow any of them, which is
 *  why this returns the value it checked instead of only rejecting a missing one. */
function flag(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
if (!["accepted", "rejected", "undecidable"].includes(verdict)) {
  throw new Error(`--verdict must be accepted | rejected | undecidable, got ${verdict}`);
}
if (!values.daemon) {
  throw new Error("--daemon is required: the store path whose daemon serves this round's board");
}

const state = roundDaemon(resolve(values.daemon));
{
  const read = await boardCall(state, { action: "read", taskId: channel, agentId, limit: 200 });
  if (read.action !== "read") throw new Error("the board did not answer a read with entries");
  const entry = read.entries.find((candidate) => candidate.id === entryId);
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

  const result = await boardCall(state, {
    action: "judge",
    taskId: channel!,
    entryId: entryId!,
    agentId: agentId!,
    verdict: verdict!,
    reason: reason!,
  });
  if (result.action !== "judge") throw new Error("the board did not answer a judgement");
  const judged = result.entry;
  console.log(
    JSON.stringify({
      entryId: judged.id,
      verdict: judged.verdict,
      judgedBy: judged.judgedBy,
      deliveryVerified: observed === entry.deliverableDigest,
      reason: judged.verdictReason,
    }),
  );
}
