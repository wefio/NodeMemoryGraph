export interface IndependentRowIdentity {
  semanticTaskId: string;
  sessionId: string;
  recordedAt: string;
}

export interface IndependentGroup {
  id: string;
  rowIndexes: number[];
  firstRecordedAt: number;
}

/**
 * Build connected components over the session <-> semantic-task bipartite graph.
 * A split may never separate rows sharing either identity, including transitive
 * links (session A -> task X -> session B).
 */
export function independentGroups(
  rows: readonly IndependentRowIdentity[],
): IndependentGroup[] {
  const parent = rows.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parent[rightRoot] = leftRoot;
  };
  const sessionOwner = new Map<string, number>();
  const taskOwner = new Map<string, number>();
  rows.forEach((row, index) => {
    const session = sessionOwner.get(row.sessionId);
    if (session === undefined) sessionOwner.set(row.sessionId, index);
    else union(index, session);
    const task = taskOwner.get(row.semanticTaskId);
    if (task === undefined) taskOwner.set(row.semanticTaskId, index);
    else union(index, task);
  });

  const grouped = new Map<number, number[]>();
  rows.forEach((_, index) => {
    const root = find(index);
    const members = grouped.get(root) ?? [];
    members.push(index);
    grouped.set(root, members);
  });
  return [...grouped.values()]
    .map((rowIndexes) => ({
      id: rowIndexes
        .map((index) => `${rows[index]!.sessionId}\u0000${rows[index]!.semanticTaskId}`)
        .sort()[0]!,
      rowIndexes,
      firstRecordedAt: Math.min(...rowIndexes.map((index) => Date.parse(rows[index]!.recordedAt))),
    }))
    .sort(
      (left, right) =>
        left.firstRecordedAt - right.firstRecordedAt || left.id.localeCompare(right.id),
    );
}
