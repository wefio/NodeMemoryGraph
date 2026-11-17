import assert from "node:assert/strict";

export async function assertSearchToolContract(
  call: (args: Record<string, unknown>) => Promise<string>,
  query: string,
  expectedPreview: RegExp,
): Promise<string> {
  const text = await call({ query, limit: 4 });
  assert.match(text, expectedPreview);
  assert.match(text, /count=[1-4]\b/u);
  assert.match(text, /Use nmg_get with selected IDs and activeGraphId/u);
  assert.match(text, /activeGraphId=[^\s]+/u);
  return text;
}
