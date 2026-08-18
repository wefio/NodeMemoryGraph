/**
 * Ingestion profiling diagnostic: where does bridge `add` time go?
 *
 * 1. Replays the first N LongMemEval users through the real bridge and times
 *    each `add` call (conversation), reporting totals and the slowest calls.
 * 2. Runs a synthetic same-scope `remember` loop on one store and samples
 *    per-call latency as the store grows — a rising curve means the per-write
 *    candidate scans dominate (O(N) per write), a flat curve points at fixed
 *    per-call costs (transactions, FTS inserts).
 *
 * Usage: node --experimental-strip-types evals/retrieval/profile-ingest.ts [users] [syntheticN]
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NmgStore } from "../../src/core/store.ts";
import { OmniMemEvalBridge } from "../omnimemeval/bridge.ts";
import { loadDataset } from "./datasets.ts";

const userCount = Number(process.argv[2] ?? 3);
const syntheticN = Number(process.argv[3] ?? 2000);

async function profileBridge(): Promise<void> {
  const spec = loadDataset("longmemeval", { limit: userCount });
  const root = mkdtempSync(join(tmpdir(), "nmg-profile-"));
  const bridge = new OmniMemEvalBridge(root);
  const durations: number[] = [];
  let messages = 0;
  try {
    for (const conversation of spec.conversations) {
      messages += conversation.messages.length;
      const startedAt = performance.now();
      await bridge.handle({
        id: 0,
        op: "add",
        userId: conversation.userId,
        conversationId: conversation.conversationId,
        messages: conversation.messages,
      });
      durations.push(performance.now() - startedAt);
    }
  } finally {
    bridge.close();
    rmSync(root, { recursive: true, force: true });
  }
  const total = durations.reduce((sum, value) => sum + value, 0);
  const sorted = [...durations].sort((a, b) => b - a);
  console.log(
    `[bridge] ${spec.conversations.length} conversations, ${messages} messages, ` +
      `total ${(total / 1000).toFixed(1)}s, mean ${(total / durations.length).toFixed(1)}ms/conv, ` +
      `p50 ${sorted[Math.floor(sorted.length / 2)]!.toFixed(1)}ms, slowest ${sorted.slice(0, 5).map((v) => v.toFixed(0)).join("/")}ms`,
  );
  // Time growth within a user: split per-user durations into halves.
  const perUser = new Map<string, number[]>();
  for (const [index, conversation] of spec.conversations.entries()) {
    const list = perUser.get(conversation.userId) ?? [];
    list.push(durations[index]!);
    perUser.set(conversation.userId, list);
  }
  for (const [userId, list] of perUser) {
    const mid = Math.floor(list.length / 2);
    const first = list.slice(0, mid).reduce((s, v) => s + v, 0) / Math.max(1, mid);
    const second = list.slice(mid).reduce((s, v) => s + v, 0) / Math.max(1, list.length - mid);
    console.log(
      `  ${userId}: ${list.length} convs, first-half mean ${first.toFixed(1)}ms, second-half mean ${second.toFixed(1)}ms`,
    );
  }
}

function profileRemember(): void {
  for (const supersedeScan of [true, false] as const) {
    const root = mkdtempSync(join(tmpdir(), "nmg-profile-raw-"));
    const dbPath = join(root, "raw.sqlite");
    const store = new NmgStore(dbPath);
    try {
      const samples: Array<[number, number]> = [];
      let sinceLast = 0;
      let calls = 0;
      for (let index = 0; index < syntheticN; index += 1) {
        const startedAt = performance.now();
        store.remember({
          statement: `Synthetic message ${index}: user discussed topic ${index % 37} with detail ${index}.`,
          nodeName: `Synthetic node ${index % 50}`,
          nodeSummary: "Synthetic profiling node.",
          memoryType: "conversation_evidence",
          sourceActor: "user",
          truthStatus: "asserted",
          evidence: `Synthetic message ${index} content.`,
          tier: 2,
          scope: { benchmark: "profile", user: "u" },
          supersedeScan,
        });
        sinceLast += performance.now() - startedAt;
        calls += 1;
        if (calls === 100) {
          samples.push([index + 1, sinceLast / calls]);
          sinceLast = 0;
          calls = 0;
        }
      }
      console.log(
        `[remember supersedeScan=${supersedeScan}] ${syntheticN} same-scope writes, per-100-call mean ms:`,
      );
      console.log(samples.map(([n, ms]) => `  ${n}: ${ms.toFixed(2)}ms`).join("\n"));
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
}

await profileBridge();
profileRemember();
