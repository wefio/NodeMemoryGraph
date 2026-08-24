import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PiReasoningWorkspaces } from "../../../.pi/extensions/nmg/reasoning-workspace.ts";

test("Pi reasoning workspace persists typed scratch state across manager restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-reasoning-"));
  try {
    const first = new PiReasoningWorkspaces(directory);
    const observation = first.add("session-a", {
      kind: "observation",
      content: "The parser rejects empty records.",
      evidenceRefs: ["tool:test-parser"],
    });
    const hypothesis = first.add("session-a", {
      kind: "hypothesis",
      content: "Whitespace normalization runs too late.",
    });
    first.link("session-a", observation.id, hypothesis.id, "supports");
    first.release("session-a");

    const second = new PiReasoningWorkspaces(directory);
    const checkpoint = second.checkpoint("session-a");
    assert.equal(checkpoint.nodes.length, 2);
    assert.equal(checkpoint.edges.length, 1);
    assert.match(checkpoint.text, /parser rejects empty records/u);
    assert.match(checkpoint.text, /not verified fact/u);
    assert.match(checkpoint.text, /hypothesis\/active\/support=linked/u);

    const disk = JSON.parse(readFileSync(second.statePath("session-a"), "utf8")) as {
      sessionId: string;
      nodes: unknown[];
    };
    assert.equal(disk.sessionId, "session-a");
    assert.equal(disk.nodes.length, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("compaction checkpoint survives restart and is consumed exactly once", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-reasoning-compact-"));
  try {
    const first = new PiReasoningWorkspaces(directory);
    first.add("session-b", {
      kind: "decision",
      content: "Keep the reversible parser path.",
      status: "supported",
      evidenceRefs: ["memory-1"],
    });
    assert.equal(first.markCompacted("session-b"), true);
    first.release("session-b");

    const second = new PiReasoningWorkspaces(directory);
    const injected = second.consumeCompactionCheckpoint("session-b");
    assert.match(injected?.text ?? "", /Keep the reversible parser path/u);
    assert.equal(second.consumeCompactionCheckpoint("session-b"), null);
    assert.equal(existsSync(second.statePath("session-b")), true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clear removes only the selected session scratchpad", () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-pi-reasoning-clear-"));
  try {
    const manager = new PiReasoningWorkspaces(directory);
    manager.add("session-a", { kind: "goal", content: "Goal A" });
    manager.add("session-b", { kind: "goal", content: "Goal B" });
    manager.markCompacted("session-a");
    manager.clear("session-a");
    assert.equal(existsSync(manager.statePath("session-a")), false);
    assert.equal(existsSync(manager.statePath("session-b")), true);
    assert.match(manager.checkpoint("session-b").text, /Goal B/u);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
