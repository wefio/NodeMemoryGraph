import assert from "node:assert/strict";
import test from "node:test";
import * as mechanism from "../../src/integration/ooo-session-mechanism.ts";
import type {
  SessionInput,
  SessionState,
  SessionRunner,
  PiRun,
} from "../../src/integration/ooo-session-mechanism.ts";
import { workDigest } from "../../src/integration/work-identity.ts";

test("generic session input and state need no patch interpretation or tool policy", async () => {
  const input: SessionInput = {
    prompt: "sum these values",
    snapshot: "2,3",
    maxArtifact: 256,
    limits: { turns: 2, reads: 0, timeoutMs: 100 },
  };
  const state: SessionState = {
    snapshot: input.snapshot,
    limits: input.limits,
    maxArtifact: input.maxArtifact,
    reads: { value: 0 },
    runs: { value: 0 },
    turns: 0,
    calls: [],
    artifact: null,
    artifactError: null,
    report: null,
    abort() {},
  };
  const opaque: Extract<keyof SessionState, "frozen" | "check" | "pushback"> extends never
    ? true
    : false = true;
  assert.equal(opaque, true);
  const runner: SessionRunner = {
    sessionId: "numeric-session",
    async runUnit(admitted): Promise<PiRun> {
      state.turns++;
      state.artifact = String(
        admitted.snapshot
          .split(",")
          .map(Number)
          .reduce((a, b) => a + b, 0),
      );
      return {
        artifact: state.artifact,
        sessionId: this.sessionId,
        provider: "local-control",
        model: "numeric-fixture",
        reads: 0,
        turns: 1,
        checks: 0,
        tokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        promptDigest: workDigest(admitted.prompt),
      };
    },
    dispose() {
      state.abort();
    },
  };
  const result = await runner.runUnit(input);
  assert.equal(result.artifact, "5");
  assert.equal(state.turns, 1);
  assert.equal(state.reads.value, 0);
  runner.dispose();
});

test("generic completion enforces the caller's bounds, not an implicit snapshot-read minimum", () => {
  const bounds = { minTurns: 1, maxTurns: 2, minReads: 0, maxReads: 2 };
  assert.equal(typeof mechanism.completionAllowed, "function");
  assert.equal(mechanism.completionAllowed(true, false, 1, 0, bounds), true);
  assert.equal(mechanism.completionAllowed(true, false, 1, 0, { ...bounds, minReads: 1 }), false);
  assert.equal(mechanism.completionAllowed(true, true, 1, 0, bounds), false);
  assert.equal(mechanism.completionAllowed(false, false, 1, 0, bounds), false);
  assert.equal(mechanism.completionAllowed(true, false, 3, 0, bounds), false);
  assert.equal(mechanism.completionAllowed(true, false, 1, 3, bounds), false);
  assert.equal(
    mechanism.piCompletionAllowed("stop", false, 1, 0),
    false,
    "default policy keeps its read requirement",
  );
});

test("the compatibility facade exposes the default adapter's actual functions, not a second implementation", async () => {
  const patch = await import("../../src/integration/ooo-patch-session.ts");
  assert.equal(mechanism.patchSessionInput, patch.patchSessionInput);
  assert.equal(mechanism.artifactEnvelope, patch.artifactEnvelope);
  assert.equal(mechanism.artifactFromText, patch.artifactFromText);
  assert.equal(mechanism.piCompletionAllowed, patch.piCompletionAllowed);
});
