import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CodexSessionStore } from "../../codex-plugin/session-store.ts";
import { codexHookBinding } from "../../codex-plugin/session.ts";

const a = "00000000-0000-7000-8000-000000000001";
const b = "00000000-0000-7000-8000-000000000002";
const turn = "00000000-0000-7000-8000-000000000003";
const next = "00000000-0000-7000-8000-000000000004";
const binding = (id = a, turnId = turn) => codexHookBinding({ session_id: id, turn_id: turnId });

test("Codex routing survives restart and isolates concurrent chats and projects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-codex-routing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CodexSessionStore(directory);
  const [first, second] = await Promise.all([
    store.admit(binding(), resolve(directory, "A")),
    store.admit(binding(b), resolve(directory, "B")),
  ]);
  assert.notEqual(first.sessionId, second.sessionId);
  const reopened = new CodexSessionStore(directory);
  assert.deepEqual(await reopened.resolve(binding()), first);
  await assert.rejects(store.admit(binding(), resolve(directory, "B")), /Conflicting/);
  assert.equal((await store.resolve(binding(b))).projectDir, second.projectDir);
  const record = JSON.parse(await readFile(join(store.directory, `${a}.json`), "utf8"));
  assert.equal(record.turns.length, 1);
});

test("Codex clear fences old turns, retains identity, clears nudges and admits a new generation", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-codex-clear-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CodexSessionStore(directory);
  const original = await store.admit(binding(), directory);
  await store.nudge(original);
  await store.reset(binding());
  await assert.rejects(store.resolve(binding()), /Obsolete/);
  await assert.rejects(store.resolve(binding(a, next)), /admission/);
  await assert.rejects(store.admit(binding(), directory), /obsolete/);
  const fresh = await store.admit(binding(a, next), directory);
  assert.notEqual(fresh.sessionId, original.sessionId);
  assert.equal(fresh.agentId, original.agentId);
  assert.equal(await store.nudge(fresh, true), false);
  assert.deepEqual(await store.current(binding()), fresh);
});

test("Codex tools without hook admission keep project scope unknown and refuse corrupt records", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-codex-no-hook-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new CodexSessionStore(directory);
  assert.deepEqual(await store.resolve(binding()), binding());
  await store.admit(binding(), directory);
  await writeFile(join(store.directory, `${a}.json`), "{}");
  await assert.rejects(store.resolve(binding()), /Invalid/);
});
