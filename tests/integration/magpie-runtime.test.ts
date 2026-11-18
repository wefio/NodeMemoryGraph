import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MagpieRuntime } from "../../magpie-plugin/runtime.ts";
import type { MagpieHookContext, MagpieInvoke } from "../../magpie-plugin/types.ts";
import { NmgService } from "../../src/cli/service.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../../src/integration/adapter-capability-catalog.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

const capabilities = ADAPTER_CAPABILITY_CATALOG.magpie.capabilities;

test("Magpie tools and gateway share admitted sessions, preserve state and reject foreign arguments", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-magpie-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const invoke: MagpieInvoke = (method, params) => {
    requests.push({ method, params });
    return service.invoke(method, params);
  };
  const runtime = new MagpieRuntime(directory, invoke, capabilities, { coordination: false });
  try {
    await runtime.ready;
    await service.invoke("remember", {
      statement: "Atlas archival backups use cobalt mirrors.",
      nodeName: "Atlas",
    });
    const a = await runtime.sessions.admit({
      origin: "local",
      agent: "codex",
      session: "a",
      cwd: directory,
    });
    const b = await runtime.sessions.admit({
      origin: "local",
      agent: "codex",
      session: "b",
      cwd: directory,
    });
    assert.ok(a && b);
    const state = runtime.tools.nmg_state!;
    await state.execute(
      {
        binding: a.handle,
        action: "write",
        space: "ag",
        operation: "enable",
        reason: "Track Atlas task",
      },
      {},
    );
    await state.execute(
      {
        binding: a.handle,
        action: "write",
        space: "ag",
        operation: "replace",
        text: "OwnerInvariantMarker\nKeep the complete invariant.",
      },
      {},
    );
    const ctx: MagpieHookContext = {
      origin: "local",
      agent: "codex",
      session: "a",
      cwd: directory,
      protocol: "responses",
      query: "What did we decide about Atlas archival backups?",
      state: {},
    };
    const body = {
      model: "fixture",
      stream: true,
      tools: [{ type: "function", name: "existing_tool" }],
      input: [{ role: "user", content: ctx.query }],
    };
    const admitted = await runtime.onRequest(body, ctx);
    assert.ok(admitted);
    assert.deepEqual(admitted.input, body.input);
    assert.deepEqual(admitted.tools, body.tools);
    assert.match(String(admitted.instructions), /OwnerInvariantMarker/);
    assert.match(String(admitted.instructions), /Keep the complete invariant/);
    assert.match(String(admitted.instructions), /NMG_BINDING=/);
    assert.match(String(admitted.instructions), /cobalt mirrors/);
    assert.equal(
      (
        await runtime.sessions.resolve(
          String(admitted.instructions).match(/NMG_BINDING=(\S+)/)![1]!,
        )
      ).sessionId,
      a.sessionId,
    );
    const other = await state.execute({ binding: b.handle, action: "read", space: "ag" }, {});
    assert.doesNotMatch(other, /OwnerInvariantMarker/);
    await assert.rejects(
      state.execute({ binding: b.handle, action: "read", space: "ag", sessionId: a.sessionId }, {}),
      /arguments/,
    );
    const searchText = await runtime.tools.nmg_search!.execute(
      { binding: a.handle, query: "Atlas archival backups" },
      {},
    );
    assert.match(searchText, /cobalt|Atlas/);
    assert.ok(
      requests.some(
        (request) => request.method === "search" && request.params.sessionId === a.sessionId,
      ),
    );
    ctx.request = admitted;
    ctx.success = true;
    await runtime.onResponse(
      {
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "The backups use cobalt mirrors." }],
          },
        ],
      },
      ctx,
    );
    assert.ok(requests.some((request) => request.method === "recordActiveGraphAttribution"));
    assert.equal(
      await runtime.onRequest(body, { ...ctx, origin: "gateway-key", state: {} }),
      undefined,
    );
  } finally {
    await service.close();
  }
});

test("native lifecycle ownership suppresses gateway effects while retaining standalone tools", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-magpie-owners-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  const methods: string[] = [];
  const runtime = new MagpieRuntime(
    directory,
    (method, params) => {
      methods.push(method);
      return service.invoke(method, params);
    },
    capabilities,
    {
      coordination: false,
      nativeCapabilities: {
        codex: [
          "automatic-recall",
          "state-context",
          "tool-observation",
          "answer-attribution",
          "board-delivery",
          "completion-nudge",
        ],
      },
    },
  );
  try {
    await runtime.ready;
    const ctx: MagpieHookContext = {
      origin: "local",
      agent: "codex",
      session: "a",
      protocol: "chat",
      query: "Recall Atlas",
      state: {},
    };
    const body = await runtime.onRequest(
      { model: "fixture", messages: [{ role: "user", content: ctx.query }] },
      ctx,
    );
    assert.ok(body);
    assert.ok(runtime.tools.nmg_search && runtime.tools.nmg_get && runtime.tools.nmg_remember);
    assert.deepEqual(methods, ["hello"]);
    const opened = JSON.parse(await runtime.tools.nmg_session!.execute({ action: "open" }, {}));
    assert.ok(opened.handle);
  } finally {
    await service.close();
  }
});
