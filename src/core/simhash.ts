/**
 * SimHash document fingerprint — a 64-bit locality-sensitive hash used to tell
 * whether two *files* are near-identical (small edits, moved file), NOT whether
 * two short snippets are semantically similar.
 *
 * Ticket-8 context: measured on real repo files (5–60 KB), near-duplicates sit
 * at Hamming 1–3 and unrelated documents at ~24, so threshold ≤ 6 cleanly
 * separates (100% recall / 0.24% false positive). The same fingerprint has no
 * discriminative power below document scale and is never applied to snippets.
 *
 * Zero-dependency. Storage uses a 16-hex TEXT (see schema notes): the full
 * unsigned 64-bit range cannot round-trip through SQLite INTEGER bindings
 * (node:sqlite rejects values > 2^63−1 and cannot read back > 2^53 exactly).
 */

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over a UTF-16 code-unit stream (matches how we tokenize). */
export function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** Tokenize file text for fingerprinting: contiguous word runs and code-like
 *  identifiers, with each Han ideograph as its own token (files in this repo
 *  mix English prose, code and CJK comments). */
export function simhashTokens(value: string): string[] {
  const tokens: string[] = [];
  for (const match of value.matchAll(/[\p{Script=Han}]|[\p{L}\p{N}_]+/gu)) {
    const token = match[0];
    tokens.push(token.length === 1 && /\p{Script=Han}/u.test(token) ? token : token.toLowerCase());
  }
  return tokens;
}

/** 64-bit SimHash of a document. Token weight is raw frequency — enough for
 *  the document-scale separation this fingerprint is used for. */
export function simhash64(value: string): bigint {
  const weights = new Map<string, number>();
  for (const token of simhashTokens(value)) {
    weights.set(token, (weights.get(token) ?? 0) + 1);
  }
  // Per-bit accumulator: +weight when the token's hash bit is 1, −weight when 0.
  const accumulators = new Array<number>(64).fill(0);
  for (const [token, weight] of weights) {
    const hash = fnv1a64(token);
    for (let bit = 0; bit < 64; bit += 1) {
      const delta = ((hash >> BigInt(bit)) & 1n) === 1n ? weight : -weight;
      accumulators[bit] += delta;
    }
  }
  let result = 0n;
  for (let bit = 0; bit < 64; bit += 1) {
    if (accumulators[bit] > 0) result |= 1n << BigInt(bit);
  }
  return result;
}

/** Hamming distance between two 64-bit fingerprints. */
export function hammingDistance(left: bigint, right: bigint): number {
  let diff = left ^ right;
  let distance = 0;
  while (diff !== 0n) {
    diff &= diff - 1n; // clear the lowest set bit
    distance += 1;
  }
  return distance;
}

/** 16 lowercase hex chars — the canonical storage form (TEXT column). */
export function simhashToHex(fingerprint: bigint): string {
  return fingerprint.toString(16).padStart(16, "0");
}

export function simhashFromHex(hex: string): bigint {
  return BigInt(`0x${hex}`);
}
