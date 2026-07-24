/**
 * End-to-end test: Python tokenizer → Node.js ONNX embedder → verify against Python ONNX.
 *
 * Run: node --experimental-strip-types scripts/test-embedder.ts
 */

import { OnnxMiniMindEmbedder } from "../src/core/onnx-minimind-embedder.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const MODEL = resolve("minimind-nmg/out/onnx/encoder.onnx");
const MAPPING = resolve("minimind-nmg/out/tokenizer/old_to_new.json");
const DATA = resolve("minimind-nmg/out/data/test_tokenized.json");

async function main() {
  // ── 1. Load embedder ──
  console.time("load");
  const embedder = await OnnxMiniMindEmbedder.create(MODEL, MAPPING);
  console.timeEnd("load");
  console.log(`Output dim: ${embedder.outputDim}`);

  // ── 2. Load pre-tokenized test data (from Python) ──
  const cases: { text: string; ids: number[]; mask: number[] }[] =
    JSON.parse(readFileSync(DATA, "utf-8"));

  const tokenIds = cases.map((c) => c.ids);
  const masks = cases.map((c) => c.mask);

  // ── 3. Run inference ──
  console.time("embed");
  const emb = await embedder.embed(tokenIds, masks);
  console.timeEnd("embed");

  const dim = embedder.outputDim;
  for (let i = 0; i < cases.length; i++) {
    const start = i * dim;
    let norm = 0;
    for (let j = start; j < start + dim; j++) norm += emb[j]! ** 2;
    console.log(`  [${i}] "${cases[i]!.text.slice(0, 40)}" → L2=${Math.sqrt(norm).toFixed(6)}`);
  }

  // ── 4. Cosine similarity matrix ──
  console.log("\nCosine similarities:");
  for (let i = 0; i < cases.length; i++) {
    for (let j = i + 1; j < cases.length; j++) {
      const a = emb.subarray(i * dim, (i + 1) * dim);
      const b = emb.subarray(j * dim, (j + 1) * dim);
      let dot = 0;
      for (let k = 0; k < dim; k++) dot += a[k]! * b[k]!;
      console.log(
        `  [${i}]-[${j}]: ${dot.toFixed(4)}  "${cases[i]!.text.slice(0, 25)}" ↔ "${cases[j]!.text.slice(0, 25)}"`,
      );
    }
  }

  // ── 5. Compare with Python ONNX output ──
  // The test data was generated with this Python script:
  //   encoded = tokenizer(texts, max_length=64, ...)
  //   s = ort.InferenceSession(...)
  //   emb_py = s.run(None, {'input_ids': remapped_ids, 'attention_mask': masks})[0]
  //
  // If you have saved python_emb.json, load and compare:
  try {
    const pyEmb = JSON.parse(
      readFileSync(resolve("minimind-nmg/out/data/test_python_emb.json"), "utf-8"),
    ) as number[][];
    const flatPy = new Float32Array(pyEmb.flat());
    let maxDiff = 0;
    for (let i = 0; i < Math.min(flatPy.length, emb.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(emb[i]! - flatPy[i]!));
    }
    console.log(`\nMax diff vs Python ONNX: ${maxDiff.toExponential(3)}`);
    if (maxDiff < 1e-6) console.log("✅ Node.js === Python ONNX");
    else console.log("⚠️ Mismatch detected");
  } catch {
    console.log("\n(skip Python comparison — no test_python_emb.json found)");
  }

  await embedder.dispose();
}

main().catch(console.error);
