import assert from "node:assert/strict";

export async function assertLabToolContract(
  call: (args: Record<string, unknown>) => Promise<string>,
): Promise<void> {
  const capability = "reasoning_workspace";
  const catalog = await call({ action: "list" });
  assert.match(catalog, /"reasoning_workspace"/u);
  assert.match(catalog, /"controller_active"/u);
  assert.doesNotMatch(catalog, /"working_state"/u);
  await assert.rejects(call({ action: "enable", capability }), /enable requires reason/u);
  await assert.rejects(call({ action: "invoke", capability }), /invoke requires operation/u);
  await call({ action: "enable", capability, reason: "Test the shared Lab tool" });
  const added = await call({
    action: "invoke",
    capability,
    operation: "add",
    input: { kind: "goal", content: "Check the shared Lab tool contract." },
  });
  assert.match(added, /Check the shared Lab tool contract/u);
  await call({ action: "invoke", capability, operation: "clear" });
  await call({ action: "disable", capability });
}
