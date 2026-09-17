// Explicit --live required: one real Pi patch proposal against frozen OoO source.
// Requires PI_PROVIDER and PI_MODEL. Shared source files are never modified.
// Host verifies the exact rename and parses it in a disposable candidate directory.
// This is S0 evidence only: check-event admission and A/B/C integration remain open.
import { writeFileSync, mkdirSync } from "node:fs";
import { patchCandidate, preparePatchWork } from "../../src/integration/ooo-patch.ts";
import { executePiPatch } from "../../.pi/extensions/nmg/ooo-execution.ts";
import { verifyRenameCandidate } from "../../src/integration/ooo-verifier.ts";
import { expectedRenameOf, RENAME_TARGET, renameSource } from "./rename-probe.ts";
import { randomUUID } from "node:crypto";

const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
if (!process.argv.includes("--live"))
  throw new Error("pass --live explicitly: this calls the configured model");
if (!provider || !model) throw new Error("Set PI_PROVIDER and PI_MODEL explicitly");

// The probe's frozen target, not a live product file: the candidate is the whole file and a
// dependent task carries it inside a snapshot, where the shared work contract bounds it.
const path = RENAME_TARGET;
const source = renameSource();
const expected = expectedRenameOf(source);
const startedAt = new Date().toISOString();
const frozen = preparePatchWork({
  taskId: `s0-patch-probe:${randomUUID()}`,
  attempt: 1,
  instruction:
    "Inside the function nextTask only, rename the local constant `byId` to `planIndex` at every use. Change nothing else.",
  files: { [path]: source },
  editable: [path],
});
const execution = await executePiPatch(frozen, provider, model);
const candidate = patchCandidate(frozen, execution.artifact);
const text = candidate[path]!;
const renamed = text === expected;
const verification = await verifyRenameCandidate(source, text);
const report = {
  startedAt,
  finishedAt: new Date().toISOString(),
  verifier: "exact-nextTask-rename-v1",
  provider,
  model,
  path,
  sourceDigest: frozen.digest,
  sessionId: execution.sessionId,
  reads: execution.reads,
  turns: execution.turns,
  tokens: execution.tokens,
  artifactBytes: Buffer.byteLength(execution.artifact, "utf8"),
  renamed,
  verification,
};
mkdirSync(".nmg/ooo-live", { recursive: true });
writeFileSync(".nmg/ooo-live/patch-probe.json", JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (verification.verdict !== "accept")
  throw new Error("patch proposal failed independent verification");
