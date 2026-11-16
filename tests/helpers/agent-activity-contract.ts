import assert from "node:assert/strict";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

export async function assertAgentActivityContract(
  callState: (args: Record<string, unknown>) => Promise<string>,
): Promise<void> {
  const operation = "agentActivity";
  const read = { space: "board", action: "read", operation };
  const write = { space: "board", action: "write", operation };
  await assert.rejects(callState({ ...read, space: "ag" }), /agentActivity requires space=board/u);
  assert.match(await callState(read), /processing=unknown/u);
  const busy = await callState({
    ...write,
    activity: { state: "busy", capabilities: ["manual-coordination"] },
  });
  assert.match(busy, /processing=busy/u);
  const activity = await callState(read);
  assert.match(activity, /processing=busy/u);
  assert.match(activity, /manual-coordination/u);
  assert.match(await callState({ ...write, activity: { state: "idle" } }), /processing=idle/u);
  assert.match(await callState(read), /processing=idle/u);
}

export function mcpToolContractText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const blocks = result.content as Array<{ type: string; text?: string }>;
  const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  if (result.isError) throw new Error(text);
  return text;
}
