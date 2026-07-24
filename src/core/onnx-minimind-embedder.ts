/**
 * MiniMind-NMG ONNX embedder — in-process, no HTTP.
 *
 * Tokenization is external (Python / WASM / pre-tokenized).  This module
 * takes already-remapped token IDs and runs ONNX inference in the same
 * Node.js process via onnxruntime-node.
 *
 *   text → [tokenizer] → token IDs → [old_to_new remap] → ONNX → Float32Array(256)
 *                                    ⬑ handled externally       ⬑ this module
 */

import * as ort from "onnxruntime-node";
import * as fs from "fs";
import * as path from "path";

/** Compact ONNX embedder — no tokenizer, no HTTP, just inference. */
export class OnnxMiniMindEmbedder {
  private session: ort.InferenceSession | null = null;
  private lookup: BigInt64Array | null = null;
  private maxOldId = 0;
  private dim = 256;
  private maxLength = 128;

  /** Load the ONNX model and vocab mapping. Call once at startup. */
  static async create(modelPath: string, mappingPath: string): Promise<OnnxMiniMindEmbedder> {
    const e = new OnnxMiniMindEmbedder();
    e.session = await ort.InferenceSession.create(modelPath);

    const raw = JSON.parse(fs.readFileSync(mappingPath, "utf-8")) as Record<string, number>;
    let maxOld = 0;
    for (const k of Object.keys(raw)) {
      const old = parseInt(k);
      if (old > maxOld) maxOld = old;
    }
    e.maxOldId = maxOld;
    e.lookup = new BigInt64Array(maxOld + 1);
    for (const [k, v] of Object.entries(raw)) {
      e.lookup[parseInt(k)] = BigInt(v);
    }
    return e;
  }

  /**
   * Embed a batch of pre-tokenized text as raw Qwen token IDs.
   *
   * @param tokenIds  [batch, seqLen] — raw Qwen tokenizer output (151K vocab)
   * @param masks     [batch, seqLen] — attention mask (1=real, 0=pad)
   * @returns L2-normalized Float32Array of [batch, dim]
   */
  async embed(tokenIds: number[][], masks: number[][]): Promise<Float32Array> {
    if (!this.session || !this.lookup) throw new Error("Not loaded");

    const batchSize = tokenIds.length;
    const seqLen = tokenIds[0]!.length;

    // Remap IDs
    const idsFlat = new BigInt64Array(batchSize * seqLen);
    const maskFlat = new BigInt64Array(batchSize * seqLen);
    for (let b = 0; b < batchSize; b++) {
      const base = b * seqLen;
      for (let i = 0; i < seqLen; i++) {
        const rawId = tokenIds[b]![i]!;
        idsFlat[base + i] = rawId <= this.maxOldId ? this.lookup[rawId]! : 0n;
        maskFlat[base + i] = BigInt(masks[b]![i]!);
      }
    }

    const feeds = {
      input_ids: new ort.Tensor("int64", idsFlat, [batchSize, seqLen]),
      attention_mask: new ort.Tensor("int64", maskFlat, [batchSize, seqLen]),
    };

    const results = await this.session.run(feeds);
    return results.embedding.data as Float32Array;
  }

  /** Embed a single text's token IDs. Convenience wrapper. */
  async embedOne(tokenIds: number[], mask: number[]): Promise<Float32Array> {
    return this.embed([tokenIds], [mask]);
  }

  get outputDim(): number {
    return this.dim;
  }

  /** Release ONNX session. */
  async dispose(): Promise<void> {
    await this.session?.release();
    this.session = null;
  }
}
