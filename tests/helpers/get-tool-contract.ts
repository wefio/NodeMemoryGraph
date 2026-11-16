import assert from "node:assert/strict";

export async function assertGetToolContract(
  call: (args: Record<string, unknown>) => Promise<string>,
  memoryId: string,
  evidence: RegExp,
  activeGraphId?: string,
): Promise<string> {
  const text = await call({
    memoryIds: [memoryId],
    ...(activeGraphId ? { activeGraphId } : {}),
  });
  assert.match(text, /NMG selected evidence:/u);
  assert.match(text, evidence);
  return text;
}
