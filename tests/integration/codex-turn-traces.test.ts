import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexTurnTraces } from "../../codex-plugin/turn-traces.ts";
import { codexHookBinding } from "../../codex-plugin/session.ts";
import type { MemoryContext } from "../../src/core/types.ts";

const nativeId = randomUUID();
const binding = codexHookBinding({ session_id: nativeId, turn_id: randomUUID() });
const context = (id: string = randomUUID()) =>
  ({
    activeGraph: { id },
    results: [{ memory: { id: randomUUID(), statement: "PrivateStatementMustStayInDaemon" } }],
  }) as unknown as MemoryContext;

test("Codex concurrent turn traces retain only versioned IDs and finish once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-codex-versions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const traces = new CodexTurnTraces(directory);
  const contexts = Array.from({ length: 16 }, () => context());
  await Promise.all(contexts.map((item) => traces.note(binding, item)));
  const root = join(traces.directory, nativeId);
  const generation = (await readdir(root))[0]!;
  const scope = join(root, generation, binding.turnId!);
  for (const name of await readdir(scope))
    assert.doesNotMatch(await readFile(join(scope, name), "utf8"), /PrivateStatement/);
  const ids = new Set<string>();
  await traces.finish(binding, async (item) => {
    ids.add(item.activeGraphId);
  });
  assert.equal(ids.size, 16);
  await traces.finish(binding, async () => {
    assert.fail("A finished trace was replayed");
  });
  await assert.rejects(traces.note(binding, context("../other")), /identifier/);
  await Promise.all(Array.from({ length: 64 }, () => traces.note(binding, context())));
  let count = 0;
  await traces.finish(binding, async () => {
    count++;
  });
  assert.equal(count, 32);
});

test("Codex interrupted and old-generation traces cannot attribute a new answer", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-codex-cancel-traces-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const traces = new CodexTurnTraces(directory);
  await traces.note(binding, context());
  const fresh = { ...binding, sessionId: `${binding.sessionId}-${randomUUID()}` };
  await traces.finish(fresh, async () => {
    assert.fail("A different generation was consumed");
  });
  await traces.cancel(binding);
  await traces.note(binding, context());
  await traces.finish(binding, async () => {
    assert.fail("Interrupted turn was attributed");
  });
  assert.equal(await traces.continued(binding), false);
  await traces.continued(binding, true);
  assert.equal(await traces.continued(binding), true);
  assert.equal(await traces.continued(fresh), false);
});
