/**
 * Evidence driver: deliver an artifact to an entry through the board protocol, from the
 * process that holds the claim. Refuses if the claim is not this agent's, and
 * asserts that the daemon recorded exactly the digest this process computed.
 *
 * It reaches the board through the daemon that serves the round's store (`--daemon <store path>`),
 * as a client: the drivers do not open a database of their own.
 *
 * Usage:
 *   node --experimental-strip-types evals/ooo-execution/board-deliver.ts \
 *     --daemon <round store path> --channel <taskId> --entry <id> --agent <holder> \
 *     --digest <sha256> [--ref <path-or-url>] [--summary <text>]
 */
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { boardCall, roundDaemon } from "./round-client.ts";
import { workDigest } from "../../src/integration/work-identity.ts";

// node:util owns flag parsing; an unknown flag or a repeated one is an error rather
// than something this script silently ignores.
const { values } = parseArgs({
  options: {
    channel: { type: "string" },
    entry: { type: "string" },
    daemon: { type: "string" },
    agent: { type: "string" },
    ref: { type: "string" },
    digest: { type: "string" },
    summary: { type: "string" },
  },
});

const channel = flag("channel", values.channel);
const entryId = flag("entry", values.entry);
const agentId = flag("agent", values.agent);
const ref = values.ref;
/** One required flag, refused by name. A loop over an object of them cannot narrow any of them, which is
 *  why this returns the value it checked instead of only rejecting a missing one. */
function flag(name: string, value: string | undefined): string {
  if (!value) throw new Error(`--${name} is required`);
  return value;
}
if (!values.daemon) {
  throw new Error("--daemon is required: the store path whose daemon serves this round's board");
}

const state = roundDaemon(resolve(values.daemon));
{
  const read = await boardCall(state, { action: "read", taskId: channel!, agentId, limit: 200 });
  if (read.action !== "read") throw new Error("the board did not answer a read with entries");
  const entry = read.entries.find((candidate) => candidate.id === entryId);
  if (!entry) throw new Error(`no entry ${entryId} in ${channel}`);
  if (entry.status !== "open") throw new Error(`entry ${entryId} is ${entry.status}`);
  if (entry.claimedBy !== agentId) {
    throw new Error(
      `only the live claim holder may deliver (holder: ${entry.claimedBy ?? "none"})`,
    );
  }

  // If the artifact is a readable file, never trust the caller's digest: recompute.
  const digest =
    ref && statSync(ref, { throwIfNoEntry: false })?.isFile()
      ? workDigest(readFileSync(ref))
      : values.digest;
  if (!digest) throw new Error("--digest is required when --ref is not a readable file");
  if (values.digest && values.digest !== digest) {
    throw new Error(`--digest does not match the bytes at ${ref} (${digest})`);
  }

  const result = await boardCall(state, {
    action: "deliver",
    taskId: channel!,
    entryId: entryId!,
    agentId: agentId!,
    digest,
    ref,
    summary: values.summary,
  });
  if (result.action !== "deliver") throw new Error("the board did not answer a delivery");
  const delivered = result.entry;
  if (delivered.deliverableDigest !== digest) {
    throw new Error(`the daemon recorded ${delivered.deliverableDigest}, computed ${digest}`);
  }
  console.log(
    JSON.stringify({
      entryId: delivered.id,
      deliveredBy: delivered.deliveredBy,
      deliverableDigest: delivered.deliverableDigest,
      deliverableRef: delivered.deliverableRef ?? null,
      deliverableSummary: delivered.deliverableSummary ?? null,
      digestRecomputedFromRef: Boolean(ref && statSync(ref, { throwIfNoEntry: false })?.isFile()),
      verdict: delivered.verdict ?? null,
      delivererPid: process.pid,
    }),
  );
}
