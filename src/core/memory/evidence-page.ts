/** Limits of the source-evidence page. Exact record reads have their own contract. */
export const MAX_RANKED_EVIDENCE_RECORDS = 20;
export const MAX_RANKED_EVIDENCE_CHARACTERS = 2_500;

const SEPARATOR_LENGTH = 2;
const CHARACTER_BUCKET = 4;

export interface EvidencePackItem<T> {
  key: string;
  value: T;
  text: string;
  /** Estimated probability that the source supports the question. */
  utility: number;
}

export interface PackedEvidence<T> {
  values: readonly T[];
  characters: number;
}

interface MeasuredItem<T> extends EvidencePackItem<T> {
  characters: number;
  cost: number;
}

export function evidenceCharacterCount(text: string): number {
  let count = text.length;
  for (const character of text) if (character.length === 2) count--;
  return count;
}

/** Select whole records by utility under both bounds. */
export function packRankedEvidence<T>(
  ranked: readonly EvidencePackItem<T>[],
  limit = MAX_RANKED_EVIDENCE_RECORDS,
  budget = MAX_RANKED_EVIDENCE_CHARACTERS,
): PackedEvidence<T> {
  const maxItems = Math.min(limit, MAX_RANKED_EVIDENCE_RECORDS);
  const maxCharacters = Math.min(budget, MAX_RANKED_EVIDENCE_CHARACTERS);
  if (maxItems <= 0 || maxCharacters < 0) return { values: [], characters: 0 };

  const candidates = measurableItems(ranked, maxCharacters);
  const [bestSingle] = candidates;
  if (!bestSingle) return { values: [], characters: 0 };
  if (maxItems === 1) return { values: [bestSingle.value], characters: bestSingle.characters };

  const buckets = Math.floor((maxCharacters + SEPARATOR_LENGTH) / CHARACTER_BUCKET);
  const selected = chooseEvidence(candidates, maxItems, buckets);
  const totalUtility = selected.reduce((sum, item) => sum + item.utility, 0);
  // An exact-fit record can exceed the budget after rounding to a character bucket.
  if (bestSingle.utility > totalUtility) {
    return { values: [bestSingle.value], characters: bestSingle.characters };
  }
  const characters =
    selected.reduce((sum, item) => sum + item.characters, 0) +
    (selected.length - 1) * SEPARATOR_LENGTH;
  return { values: selected.map((item) => item.value), characters };
}

function measurableItems<T>(
  ranked: readonly EvidencePackItem<T>[],
  maxCharacters: number,
): MeasuredItem<T>[] {
  const byKey = new Map<string, MeasuredItem<T>>();
  for (const item of ranked) {
    if (!(item.utility > 0) || !Number.isFinite(item.utility)) continue;
    const previous = byKey.get(item.key);
    if (previous && previous.utility >= item.utility) continue;
    const characters = evidenceCharacterCount(item.text);
    if (characters > maxCharacters) continue;
    const cost = Math.ceil((characters + SEPARATOR_LENGTH) / CHARACTER_BUCKET);
    byKey.set(item.key, { ...item, characters, cost });
  }
  return [...byKey.values()].sort((a, b) => b.utility - a.utility);
}

function chooseEvidence<T>(
  items: readonly MeasuredItem<T>[],
  slots: number,
  buckets: number,
): MeasuredItem<T>[] {
  const width = buckets + 1;
  const cells = (slots + 1) * width;
  const values = new Float32Array(cells).fill(-Infinity);
  values[0] = 0;
  const choices = items.map((item, index) =>
    addEvidenceItem(values, item, width, Math.min(index + 1, slots), cells),
  );
  let best = 0;
  for (let i = 1; i < cells; i++) if (values[i]! > values[best]!) best = i;
  const selected: MeasuredItem<T>[] = [];
  for (let index = items.length - 1; index >= 0; index--) {
    if (!wasChosen(choices[index]!, best)) continue;
    const item = items[index]!;
    selected.push(item);
    best -= width + item.cost;
  }
  return selected.reverse();
}

function addEvidenceItem<T>(
  values: Float32Array,
  item: MeasuredItem<T>,
  width: number,
  maxSlots: number,
  cells: number,
): Uint32Array {
  const choices = new Uint32Array(Math.ceil(cells / 32));
  for (let count = maxSlots; count > 0; count--) {
    const start = count * width + item.cost;
    for (let cell = start; cell < (count + 1) * width; cell++) {
      const previous = values[cell - width - item.cost]!;
      const candidate = Math.fround(previous + item.utility);
      if (candidate <= values[cell]!) continue;
      values[cell] = candidate;
      choices[cell >>> 5]! |= 1 << (cell & 31);
    }
  }
  return choices;
}

function wasChosen(choices: Uint32Array, cell: number): boolean {
  return (choices[cell >>> 5]! & (1 << (cell & 31))) !== 0;
}
