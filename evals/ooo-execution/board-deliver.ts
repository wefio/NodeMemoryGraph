/**
 * Evidence driver: deliver an artifact to an entry through the board protocol, from the
 * process that holds the claim. Refuses if the claim is not this agent's, and
 * asserts that the store recorded exactly the digest this process computed.
 *
 * Usage:
 *   node --experimental-strip-types evals/ooo-execution/board-deliver.ts \
 *     --channel <taskId> --entry <id> --agent <holder> --digest <sha256> \
 *     [--ref <path-or-url>] [--summary <text>] [--store <path>]
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
    ref: { type: "string" },
    digest: { type: "string" },
    summary: { type: "string" },
  },
});

const channel = values.channel;
const entryId = values.entry;
const agentId = values.agent;
const ref = values.ref;
for (const [name, value] of Object.entries({ channel, entry: entryId, agent: agentId })) {
  if (!value) throw new Error(`--${name} is required`);
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
  if (entry.status !== "open") throw new Error(`entry ${entryId} is ${entry.status}`);
  if (entry.claimedBy !== agentId) {
    throw new Error(
      `only the live claim holder may deliver (holder: ${entry.claimedBy ?? "none"})`,
    );
  }

  // If the artifact is a readable file, never trust the caller's digest: recompute.
  const digest =
    ref && statSync(ref, { throwIfNoEntry: false })?.isFile()
      ? createHash("sha256").update(readFileSync(ref)).digest("hex")
      : values.digest;
  if (!digest) throw new Error("--digest is required when --ref is not a readable file");
  if (values.digest && values.digest !== digest) {
    throw new Error(`--digest does not match the bytes at ${ref} (${digest})`);
  }

  const delivered = store.deliverTaskBoardEntry({
    taskId: channel!,
    entryId: entryId!,
    agentId: agentId!,
    digest,
    ref,
    summary: values.summary,
  });
  if (delivered.deliverableDigest !== digest) {
    throw new Error(`store recorded ${delivered.deliverableDigest}, computed ${digest}`);
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
} finally {
  store.close();
}
