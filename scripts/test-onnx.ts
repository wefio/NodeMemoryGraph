/**
 * Node.js ONNX Runtime test for MiniMind-NMG encoder.
 *
 * Usage: node --experimental-strip-types scripts/test-onnx.ts
 */

import * as ort from "onnxruntime-node";
import * as fs from "fs";
import * as path from "path";

const MODEL_PATH = path.resolve("minimind-nmg/out/onnx/encoder.onnx");
const MAPPING_PATH = path.resolve("minimind-nmg/out/tokenizer/old_to_new.json");
const TEST_DATA = path.resolve("minimind-nmg/out/data/test_tokenized.json");

async function main() {
  // ── 1. Load vocab mapping ──
  const raw = JSON.parse(fs.readFileSync(MAPPING_PATH, "utf-8"));
  const oldToNew = new Map<number, number>();
  let maxOld = 0;
  for (const [k, v] of Object.entries(raw) as [string, number][]) {
    const oldId = parseInt(k);
    const newId = v;
    oldToNew.set(oldId, newId);
    if (oldId > maxOld) maxOld = oldId;
  }
  console.log(`Mapping: ${oldToNew.size} entries, max_old_id=${maxOld}`);

  // ── 2. Load ONNX session ──
  const session = await ort.InferenceSession.create(MODEL_PATH);
  console.log(`ONNX model loaded: ${MODEL_PATH}`);

  // ── 3. Test inputs (pre-tokenized from Python) ──
  // If test data exists, use it; otherwise generate dummy
  let testCases: { text: string; ids: number[]; mask: number[] }[];

  if (fs.existsSync(TEST_DATA)) {
    testCases = JSON.parse(fs.readFileSync(TEST_DATA, "utf-8"));
  } else {
    // Quick dummy: use random token IDs
    console.log("No pre-tokenized data, using random dummy inputs");
    const seqLen = 64;
    testCases = [
      { text: "[dummy-zh]", ids: randomIds(seqLen), mask: randomMask(seqLen, 12) },
      { text: "[dummy-en]", ids: randomIds(seqLen), mask: randomMask(seqLen, 20) },
    ];
  }

  // ── 4. Remap IDs → compact vocab ──
  const remapped = testCases.map((tc) => {
    const ids = new BigInt64Array(tc.ids.length);
    for (let i = 0; i < tc.ids.length; i++) {
      ids[i] = BigInt(oldToNew.get(tc.ids[i]) ?? 0);
    }
    const mask = new BigInt64Array(tc.mask.length);
    for (let i = 0; i < tc.mask.length; i++) {
      mask[i] = BigInt(tc.mask[i]);
    }
    return { text: tc.text, ids, mask };
  });

  // ── 5. Run inference ──
  const batchSize = remapped.length;
  const seqLen = remapped[0].ids.length;

  // Flatten batch
  const idsFlat = new BigInt64Array(batchSize * seqLen);
  const maskFlat = new BigInt64Array(batchSize * seqLen);
  for (let b = 0; b < batchSize; b++) {
    idsFlat.set(remapped[b].ids, b * seqLen);
    maskFlat.set(remapped[b].mask, b * seqLen);
  }

  // Reshape to [batch, seq]
  const feeds = {
    input_ids: new ort.Tensor("int64", idsFlat, [batchSize, seqLen]),
    attention_mask: new ort.Tensor("int64", maskFlat, [batchSize, seqLen]),
  };

  const t0 = performance.now();
  const results = await session.run(feeds);
  const elapsed = performance.now() - t0;

  const embedding = results.embedding.data as Float32Array;
  const embSize = embedding.length / batchSize;

  console.log(`\nInference: ${batchSize} texts × ${seqLen} tokens → ${elapsed.toFixed(2)}ms`);
  console.log(`Embedding dim: ${embSize}, L2 norms:`);

  for (let b = 0; b < batchSize; b++) {
    const start = b * embSize;
    let norm = 0;
    for (let i = start; i < start + embSize; i++) norm += embedding[i] ** 2;
    norm = Math.sqrt(norm);
    console.log(`  [${b}] "${testCases[b].text.slice(0, 50)}" → L2=${norm.toFixed(6)}`);
  }

  // Cosine similarities
  console.log("\nCosine similarities:");
  for (let i = 0; i < batchSize; i++) {
    for (let j = i + 1; j < batchSize; j++) {
      const a = embedding.subarray(i * embSize, (i + 1) * embSize);
      const b = embedding.subarray(j * embSize, (j + 1) * embSize);
      let dot = 0;
      for (let k = 0; k < embSize; k++) dot += a[k] * b[k];
      console.log(
        `  [${i}]-[${j}]: cos=${dot.toFixed(4)}  ` +
          `("${testCases[i].text.slice(0, 30)}" ↔ "${testCases[j].text.slice(0, 30)}")`,
      );
    }
  }

  console.log("\n✅ ONNX inference in Node.js works!");
  await session.release();
}

function randomIds(len: number): number[] {
  return Array.from({ length: len }, () => Math.floor(Math.random() * 32768));
}
function randomMask(len: number, real: number): number[] {
  return Array.from({ length: len }, (_, i) => (i < real ? 1 : 0));
}

main().catch(console.error);
