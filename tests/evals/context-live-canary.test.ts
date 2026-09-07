import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// No-network test for the #000084 live-context canary: runs the python script
// in --dry-run (stdlib only — never imports the gitignored official modules,
// never calls a model, never touches the network) against a synthetic
// search/dataset artifact and asserts selection rule + run-dir uniqueness.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CANARY = join(
  REPO_ROOT,
  "evals",
  "omnimemeval",
  "research",
  "context-live-canary.py",
);

const PYTHON = process.env.PYTHON || "python";

function locomoRow(query: string, context: string, status = "success") {
  return { query, context, duration_ms: "1", status };
}

function runCanary(cfg: object, dir: string): string {
  const cfgPath = join(dir, "config.json");
  writeFileSync(cfgPath, JSON.stringify(cfg));
  return execFileSync(PYTHON, [CANARY, "--config", cfgPath, "--dry-run"], {
    encoding: "utf-8",
  });
}

test("research canary: dry-run selection follows order-first rule and filters cat5/long/failed", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-sel-"));
  try {
    // search groups 0..5; groups 0,1,2 each carry one filter to prove order-first.
    const search: Record<string, unknown> = {};
    search["locomo_exp_user_0"] = [
      locomoRow("q0_too_long", "X".repeat(13000)), // too long -> skip
      locomoRow("q0", "ctx0"), // valid -> picked (order-first after skip)
    ];
    search["locomo_exp_user_1"] = [
      locomoRow("q1_cat5", "c1"), // cat5 -> skip
      locomoRow("q1", "ctx1"), // valid -> picked
    ];
    search["locomo_exp_user_2"] = [
      locomoRow("q2", "c2", "failed"), // non-success -> skip
      locomoRow("q2", "ctx2"), // valid -> picked
    ];
    search["locomo_exp_user_3"] = [locomoRow("q3", "ctx3")];
    search["locomo_exp_user_4"] = [];
    search["locomo_exp_user_5"] = [locomoRow("q5", "")]; // empty context -> skip
    const searchFile = join(dir, "search.json");
    writeFileSync(searchFile, JSON.stringify(search));

    const dataset = Array.from({ length: 6 }, () => ({ qa: [] as unknown[] }));
    (dataset[0].qa as { question: string; answer: string; category: string }[]).push(
      { question: "q0", answer: "a0", category: "2" },
    );
    (dataset[1].qa as { question: string; answer: string; category: string }[]).push(
      { question: "q1_cat5", answer: "a", category: "5" },
      { question: "q1", answer: "a1", category: "3" },
    );
    (dataset[2].qa as { question: string; answer: string; category: string }[]).push(
      { question: "q2", answer: "a2", category: "4" },
    );
    (dataset[3].qa as { question: string; answer: string; category: string }[]).push(
      { question: "q3", answer: "a3", category: "1" },
    );
    const datasetFile = join(dir, "locomo10.json");
    writeFileSync(datasetFile, JSON.stringify(dataset));

    const outputDir = join(dir, "out");
    const cfg = {
      checkout: "test/checkout",
      source: "test-source",
      searchFile,
      datasetFile,
      outputDir,
      outputBase: "canary",
      maxContextChars: 12000,
      groups: 3,
      timeoutSeconds: 120,
    };
    runCanary(cfg, dir);

    const runs = readdirSync(outputDir);
    assert.equal(runs.length, 1, "exactly one run dir created");
    const runDir = join(outputDir, runs[0]);
    const meta = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf-8"));
    assert.equal(meta.mode, "dry-run");
    assert.deepEqual(meta.arms, ["none", "cue", "retrieve-replay"]);
    assert.equal(meta.chosen.length, 3);
    assert.deepEqual(
      meta.chosen.map((c: { group: number }) => c.group),
      [0, 1, 2],
    );
    // order-first: q0 (after too-long skip), q1 (after cat5 skip), q2 (after failed skip)
    assert.deepEqual(
      meta.chosen.map((c: { question: string }) => c.question),
      ["q0", "q1", "q2"],
    );
    assert.deepEqual(
      meta.chosen.map((c: { category: string }) => c.category),
      ["2", "3", "4"],
    );
    assert.ok(meta.chosen.every((c: { contextLen: number }) => c.contextLen <= 12000));
    // dry-run must not write records.jsonl (no model calls)
    assert.equal(existsSync(join(runDir, "records.jsonl")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("research canary: each dry-run creates a fresh (non-overwriting) run dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "canary-run-"));
  try {
    const search: Record<string, unknown> = {};
    search["locomo_exp_user_0"] = [locomoRow("q0", "ctx0")];
    const searchFile = join(dir, "search.json");
    writeFileSync(searchFile, JSON.stringify(search));
    const dataset = [{ qa: [{ question: "q0", answer: "a0", category: "1" }] }];
    const datasetFile = join(dir, "locomo10.json");
    writeFileSync(datasetFile, JSON.stringify(dataset));
    const outputDir = join(dir, "out");
    const cfg = {
      checkout: "t",
      source: "s",
      searchFile,
      datasetFile,
      outputDir,
      outputBase: "canary",
    };
    runCanary(cfg, dir);
    runCanary(cfg, dir); // second run must NOT overwrite the first
    const runs = readdirSync(outputDir);
    assert.equal(runs.length, 2, "two distinct run dirs, no overwrite");
    assert.notEqual(runs[0], runs[1]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
