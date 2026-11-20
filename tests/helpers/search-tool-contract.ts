import assert from "node:assert/strict";

export function searchCandidateKeys(text: string): string[] {
  return [...text.matchAll(/^- (?:\[[^\r\n\]]+\] )*`([^`\r\n]+)`/gmu)].map((match) => match[1]!);
}

export async function assertSearchToolContract(
  call: (args: Record<string, unknown>) => Promise<string>,
  query: string,
  expectedPreview: RegExp,
): Promise<string> {
  const text = await call({ query, limit: 4 });
  assert.match(text, expectedPreview);
  const keys = searchCandidateKeys(text);
  assert.ok(keys.length >= 1 && keys.length <= 4);
  assert.match(text, /nmg_get with key \+ activeGraphId/u);
  assert.match(text, /^activeGraphId=[0-9a-f]{8}$/mu);
  return text;
}
