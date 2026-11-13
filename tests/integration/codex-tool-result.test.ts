import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { normalizeCodexToolResult } from "../../codex-plugin/tool-result.ts";
import { codexHookBinding } from "../../codex-plugin/session.ts";
import { isSuccessfulCommit } from "../../src/integration/tool-observation.ts";

const session = "00000000-0000-7000-8000-000000000001";
const turn = "00000000-0000-7000-8000-000000000002";
const binding = codexHookBinding({ session_id: session, turn_id: turn });

test("Codex shell observations bind the native call, turn and transcript before trusting exit metadata", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-native-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "rollout.jsonl");
  const make = (id = session, nativeTurn = turn, code = 0) =>
    [
      { type: "session_meta", payload: { id } },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "native-call",
          output: `Chunk ID: abc\nWall time: 0.3 seconds\nProcess exited with code ${code}\nOutput:\ncommit text`,
          internal_chat_message_metadata_passthrough: { turn_id: nativeTurn },
        },
        metadata: { client_authored: false },
      },
    ]
      .map((item) => JSON.stringify(item))
      .join("\n") + "\n";
  const payload = {
    tool_name: "Bash",
    tool_use_id: "native-call",
    transcript_path: path,
    tool_input: { command: "git commit -m test" },
    tool_response: "commit text",
  };
  await writeFile(path, make());
  const success = (await normalizeCodexToolResult(payload, binding))!;
  assert.equal(success.outcomeKnown, true);
  assert.equal(isSuccessfulCommit(success), true);
  await writeFile(path, make(session, turn, 1));
  assert.equal(isSuccessfulCommit((await normalizeCodexToolResult(payload, binding))!), false);
  await writeFile(path, make("00000000-0000-7000-8000-000000000003"));
  const unknown = (await normalizeCodexToolResult(payload, binding))!;
  assert.equal(unknown.outcomeKnown, false);
  assert.equal(isSuccessfulCommit(unknown), false);
  await writeFile(path, make(session, "00000000-0000-7000-8000-000000000003"));
  assert.equal((await normalizeCodexToolResult(payload, binding))!.outcomeKnown, false);
});
