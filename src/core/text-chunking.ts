export const DEFAULT_EMBED_CHUNK_CHARS = 2000;
export const MAX_EMBED_WINDOWS = 10;

const MIN_EMBED_CHUNK_CHARS = 128;
const MAX_EMBED_CHUNK_CHARS = 16_384;
const SNAP_BOUNDARIES = ["\n", ". ", "? ", "! ", "。", "；", "，"];

/** Resolves the configured character window for blind-spot sub-chunking (`0` disables splitting). */
export function resolveEmbedChunkChars(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.NMG_EMBED_CHUNK_CHARS?.trim();
  if (!raw) return DEFAULT_EMBED_CHUNK_CHARS;
  const parsed = Number(raw);
  if (parsed === 0) return 0;
  if (
    Number.isInteger(parsed) &&
    parsed >= MIN_EMBED_CHUNK_CHARS &&
    parsed <= MAX_EMBED_CHUNK_CHARS
  ) {
    return parsed;
  }
  return DEFAULT_EMBED_CHUNK_CHARS;
}

/** Splits English and CJK text into normalized non-empty sentence units in order. */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\r\n/gu, "\n").trim();
  if (!normalized) return [];
  const sentences: string[] = [];
  for (const paragraph of normalized.split(/\n+/u)) {
    const cleanParagraph = paragraph.replace(/\s+/gu, " ").trim();
    if (!cleanParagraph) continue;
    for (const part of cleanParagraph.split(/(?<=[.!?。！？；])(?:\s+|$)/u)) {
      const cleanPart = part.trim();
      if (cleanPart) sentences.push(cleanPart);
    }
  }
  return sentences;
}

function snapCut(text: string, ideal: number, previous: number, end: number): number {
  const ceiling = Math.min(end - 1, ideal + 400);
  for (let at = Math.max(ideal, previous + 1); at <= ceiling; at += 1) {
    const slice = text.slice(at, at + 2);
    if (SNAP_BOUNDARIES.some((boundary) => slice.startsWith(boundary))) return at + 1;
  }
  return Math.min(Math.max(ideal, previous + 1), ceiling);
}

/**
 * Geometric boundary-snapped blind-spot windows matching `planQueryWindows`.
 * Drops window 0 because the primary memory vector already covers the opening.
 */
export function planEmbeddingWindows(
  text: string,
  options: { windowChars?: number; maxWindows?: number } = {},
): string[] {
  const trimmed = text.trim();
  const windowChars = options.windowChars ?? DEFAULT_EMBED_CHUNK_CHARS;
  if (!trimmed || windowChars <= 0 || trimmed.length <= windowChars) return [];

  const maxWindows = Math.max(2, options.maxWindows ?? MAX_EMBED_WINDOWS);
  const length = trimmed.length;
  const count = Math.min(Math.ceil(length / windowChars), maxWindows);
  if (length <= count * windowChars) {
    const cuts = [0];
    for (let index = 1; index < count; index += 1) {
      cuts.push(snapCut(trimmed, Math.round((index * length) / count), cuts[index - 1]!, length));
    }
    cuts.push(length);
    return cuts
      .slice(1)
      .map((end, index) => trimmed.slice(cuts[index]!, end).trim())
      .filter(Boolean)
      .slice(1);
  }

  const stride = (length - count * windowChars) / (count - 1) + windowChars;
  const windows: string[] = [];
  for (let index = 1; index < count; index += 1) {
    const start = index === count - 1 ? length - windowChars : Math.round(index * stride);
    const piece = trimmed.slice(start, start + windowChars).trim();
    if (piece) windows.push(piece);
  }
  return windows;
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "；"]);

function lastSentenceBoundary(head: string, minIndex: number): number {
  for (let i = head.length - 1; i >= minIndex; i -= 1) {
    if (SENTENCE_TERMINATORS.has(head[i]!)) return i;
  }
  return -1;
}

/**
 * Clips long preview text on sentence boundaries (falling back to word boundaries)
 * so key facts are not cut mid-word or mid-clause unnecessarily.
 */
export function sentenceAlignedPreview(text: string, maxCodePoints: number): string {
  const characters = Array.from(text);
  if (characters.length <= maxCodePoints) return text;
  const head = characters.slice(0, Math.max(1, maxCodePoints - 1)).join("");
  const sentenceEnd = lastSentenceBoundary(head, Math.floor(head.length * 0.55));
  if (sentenceEnd >= 0) return `${head.slice(0, sentenceEnd + 1).trimEnd()}…`;
  const spaceEnd = head.lastIndexOf(" ");
  if (spaceEnd >= Math.floor(head.length * 0.75)) {
    return `${head.slice(0, spaceEnd).trimEnd()}…`;
  }
  return `${head.trimEnd()}…`;
}
