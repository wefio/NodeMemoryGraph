// Explicit --live required: one real Pi patch proposal against frozen OoO source.
// Requires PI_PROVIDER and PI_MODEL. Shared source files are never modified.
// Host verifies the exact rename and parses it in a disposable candidate directory.
// This is S0 evidence only: check-event admission and A/B/C integration remain open.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { patchCandidate, preparePatchWork } from "../../src/integration/ooo-patch.ts";
import { executePiPatch } from "../../.pi/extensions/nmg/ooo-execution.ts";
import { expectedRename, verifyRenameCandidate } from "../../src/integration/ooo-verifier.ts";
import { randomUUID } from "node:crypto";

const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
if (!process.argv.includes("--live"))
  throw new Error("pass --live explicitly: this calls the configured model");
if (!provider || !model) throw new Error("Set PI_PROVIDER and PI_MODEL explicitly");

const path = "src/integration/ooo-execution.ts";
const source = readFileSync(path, "utf8");
const expected = expectedRename(source);
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
