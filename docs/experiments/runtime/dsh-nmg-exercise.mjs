import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply } from "../../../dsh/dsh-nmg/src/plugin/index.ts";
import { privateNmg } from "./native-nmg-fixture.mjs";

/** Real installed Cordis/prompt/tools services, with a private NMG owner. */
export async function exerciseDshNmg(ctx, renderContextSnapshot) {
  const directory = await mkdtemp(join(tmpdir(), "nmg-dsh-native-"));
  let nmg;
  let previous = {};
  let dispose;
  try {
    nmg = await privateNmg(directory);
    const overrides = {
      NMG_DATA_DIR: nmg.dataDirectory,
      NMG_PROJECT_DIR: directory,
      NMG_ENABLE_COORDINATION: "0",
    };
    previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    ctx.provide("subprocess", {
      spawn() {
        throw new Error("No subprocess fallback in native probe");
      },
    });
    ctx.provide("sandboxPolicy", { workspaceRoot: directory });
    dispose = apply(ctx);
    const agent = { id: "native-dsh-session" };
    const signal = new AbortController().signal;
    const tool = async (name, args) => {
      const result = await ctx.tools.execute({
        agent,
        signal,
        callId: "probe-" + name,
        name,
        arguments: args,
      });
      assert.equal(result.isError, false, JSON.stringify(result));
      return result;
    };
    await tool("nmg_state", {
      space: "ag",
      action: "write",
      operation: "enable",
      reason: "Native probe",
    });
    await tool("nmg_state", {
      space: "ag",
      action: "write",
      operation: "replace",
      text: "NmgNativeDshStateMarker\nPreserve the entire invariant.",
    });
    const payload = {
      agent,
      turn: 1,
      message: {
        content: [{ type: "text", text: "What did we decide about Atlas SQLite storage?" }],
      },
    };
    ctx.emit("agent/inbox/inserted", payload);
    ctx.emit("agent/inbox/claimed", payload);
    const config = await ctx.waterfall(
      "agent/request",
      { agent, turn: 1, step: 1, signal },
      async () => ({ model: "offline-probe" }),
    );
    assert.deepEqual(config, { model: "offline-probe" });
    const rendered = renderContextSnapshot(await ctx.systemPrompt.assemble({ agent }));
    assert.match(rendered, /NmgNativeDshStateMarker/);
    assert.match(rendered, /Preserve the entire invariant/);
    assert.match(rendered, /Atlas uses SQLite/);
    await tool("nmg_search", { query: "Atlas SQLite storage" });
    await tool("nmg_get", { memoryIds: [nmg.memoryId] });
    await ctx.parallel(
      "session/event",
      { id: agent.id },
      {
        type: "assistant/message",
        data: { turn: 1, message: { content: "Atlas uses SQLite storage." } },
      },
    );
    await ctx.parallel(
      "session/event",
      { id: agent.id },
      { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    );
    assert.ok(nmg.requests.some((request) => request.method === "recordActiveGraphAttribution"));
    return {
      checks: [
        "NMG native tool execution",
        "admission and real context assembly",
        "complete maintained state",
        "recall and exact get",
        "completed-turn diagnostic attribution",
      ],
      modelCalls: 0,
    };
  } finally {
    try {
      await dispose?.();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        await nmg?.close();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}
