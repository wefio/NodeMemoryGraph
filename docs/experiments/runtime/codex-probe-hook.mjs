// Source-bound native-host fixture, not a production Codex session mapper.
import { appendFile } from "node:fs/promises";
import { assembleAdapterCapabilities } from "../../../src/integration/adapter-capability-assembly.ts";
import { compatibleLease, rpcCall } from "../../../src/integration/lease-transport.ts";
import { compactSearchContext } from "../../../src/integration/search-projection.ts";
import { prepareInformationOutput } from "../../../src/integration/information-output.ts";

let prepareRecall;
let stateViews;
const assembly = assembleAdapterCapabilities(["automatic-recall", "state-context"], {
  "automatic-recall": ({ prepare }) => {
    prepareRecall = prepare;
  },
  "state-context": ({ views }) => {
    stateViews = views;
  },
});
await assembly.ready;
let input = "";
for await (const chunk of process.stdin) input += chunk;
const payload = JSON.parse(input || "{}");
const event = payload.hook_event_name;
await appendFile(
  process.env.NMG_PROBE_HOOK_LOG,
  JSON.stringify({
    event,
    sessionId: payload.session_id,
    turnId: payload.turn_id,
    tool: payload.tool_name,
    inputKeys: Object.keys(payload),
  }) + "\n",
);
if (event === "UserPromptSubmit") {
  const lease = await compatibleLease(process.env.NMG_DATA_DIR);
  if (!lease) throw new Error("Private NMG fixture is unavailable");
  // The operator binds one private probe conversation to this same MCP session.
  // This explicit fixture does not infer a production identity from prompt text.
  const sessionId = process.env.NMG_SESSION_ID;
  const state = await rpcCall(lease, "state", { action: "read", space: "ag", sessionId });
  const context = await rpcCall(lease, "search", {
    query: payload.prompt,
    autoRecall: true,
    tieredDisclosure: true,
    limit: 13,
    sessionId,
    projectDir: payload.cwd,
  });
  const output = prepareInformationOutput(
    [
      ...stateViews(state.result.snapshot, sessionId),
      ...prepareRecall(compactSearchContext(context), { preamble: "NmgCodexPluginHookMarker" })
        .views,
    ],
    { format: "context" },
  );
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event,
        additionalContext: output.text,
      },
    }),
  );
}
