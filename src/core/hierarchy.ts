import type { MemoryTier } from "./types.ts";

export interface WeightedMemory {
  id: string;
  weight: number;
}

export function huffmanDepths(items: WeightedMemory[]): Map<string, number> {
  if (items.length === 0) return new Map();
  if (items.length === 1) return new Map([[items[0]!.id, 0]]);
  const queue = items.map((item) => ({
    ids: [item.id],
    weight: Math.max(Number.EPSILON, item.weight),
  }));
  const depths = new Map(items.map((item) => [item.id, 0]));
  while (queue.length > 1) {
    queue.sort((left, right) => left.weight - right.weight);
    const left = queue.shift()!;
    const right = queue.shift()!;
    for (const id of [...left.ids, ...right.ids]) {
      depths.set(id, (depths.get(id) ?? 0) + 1);
    }
    queue.push({ ids: [...left.ids, ...right.ids], weight: left.weight + right.weight });
  }
  return depths;
}

export function blockTiers(
  depths: Map<string, number>,
  capacities: readonly [number, number, number],
): Map<string, MemoryTier> {
  const ordered = [...depths].sort(
    ([leftId, leftDepth], [rightId, rightDepth]) =>
      leftDepth - rightDepth || leftId.localeCompare(rightId),
  );
  const boundaries = [capacities[0], capacities[0] + capacities[1],
    capacities[0] + capacities[1] + capacities[2]];
  return new Map(ordered.map(([id], index) => [
    id,
    (index < boundaries[0]! ? 0 : index < boundaries[1]! ? 1 :
      index < boundaries[2]! ? 2 : 3) as MemoryTier,
  ]));
}
