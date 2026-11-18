import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MagpieSessions } from "../../magpie-plugin/session.ts";

test("Magpie sessions isolate native chats and authenticate opaque tool handoffs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-magpie-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sessions = new MagpieSessions(directory);
  const a = await sessions.admit({
    origin: "local",
    agent: "codex",
    session: "native-a",
    cwd: directory,
  });
  const b = await sessions.admit({
    origin: "local",
    agent: "codex",
    session: "native-b",
    cwd: directory,
  });
  assert.ok(a && b);
  assert.notEqual(a.sessionId, b.sessionId);
  assert.equal((await sessions.resolve(a.handle)).sessionId, a.sessionId);
  assert.equal((await new MagpieSessions(directory).resolve(a.handle)).sessionId, a.sessionId);
  await assert.rejects(sessions.resolve(a.handle + "changed"));
  assert.equal(
    await sessions.admit({ origin: "remote", agent: "codex", session: "native-a" }),
    null,
  );
  assert.equal(await sessions.admit({ origin: "local", agent: "codex", session: "" }), null);
  assert.equal(
    await sessions.admit({
      origin: "local",
      agent: "codex",
      session: "native-a",
      kind: "subagent",
    }),
    null,
  );
  const isolated = await sessions.open();
  assert.notEqual(isolated.sessionId, a.sessionId);
});
