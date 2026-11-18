import assert from "node:assert/strict";
import test from "node:test";
import {
  injectContext,
  completedAnswer,
  type GatewayProtocol,
} from "../../magpie-plugin/protocol.ts";

test("Magpie protocol injection preserves original user input, tool pairs and declarations", () => {
  const fixtures: Array<[GatewayProtocol, Record<string, unknown>]> = [
    [
      "chat",
      {
        messages: [
          { role: "user", content: "original" },
          { role: "assistant", tool_calls: [{ id: "call-a" }] },
          { role: "tool", tool_call_id: "call-a", content: "result" },
        ],
      },
    ],
    ["responses", { instructions: "Keep me", input: [{ role: "user", content: "original" }] }],
    [
      "anthropic",
      {
        system: [{ type: "text", text: "Keep me", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: "original" }],
      },
    ],
    [
      "gemini",
      {
        systemInstruction: { parts: [{ text: "Keep me" }] },
        contents: [{ role: "user", parts: [{ text: "original" }] }],
      },
    ],
  ];
  for (const [protocol, input] of fixtures) {
    const original: Record<string, unknown> = {
      model: "model",
      stream: true,
      tools: [{ name: "original_tool" }],
      tool_choice: "auto",
      ...input,
    };
    const snapshot = structuredClone(original);
    const first = injectContext(original, protocol, "First memory");
    const second = injectContext(first, protocol, "Current memory");
    assert.deepEqual(original, snapshot);
    assert.deepEqual(second.tools, original.tools);
    assert.equal(second.model, original.model);
    assert.equal(second.stream, original.stream);
    assert.equal(second.tool_choice, original.tool_choice);
    assert.doesNotMatch(JSON.stringify(second), /First memory/);
    assert.match(JSON.stringify(second), /Current memory/);
    if (protocol !== "chat")
      assert.deepEqual(
        second.messages ?? second.input ?? second.contents,
        original.messages ?? original.input ?? original.contents,
      );
    else assert.deepEqual((second.messages as unknown[]).slice(1), original.messages);
  }
  assert.equal(
    completedAnswer(
      {
        output: [
          { type: "message", role: "assistant", content: [{ type: "output_text", text: "Done" }] },
        ],
      },
      "responses",
    ),
    "Done",
  );
  assert.throws(() => injectContext({ instructions: [] }, "responses", "memory"));
});
