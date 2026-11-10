import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("an existing registry migrates without reviving withdrawn identities on reopen", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-presence-migrate-"));
  const path = join(directory, "nmg.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`CREATE TABLE task_board_agents (
    id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, description TEXT, version TEXT,
    url TEXT, capabilities TEXT, skills TEXT, supported_interfaces TEXT,
    last_seen_at TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  const now = new Date().toISOString();
  database
    .prepare("INSERT INTO task_board_agents(id,agent_name,last_seen_at,created_at) VALUES(?,?,?,?)")
    .run("legacy", "Legacy identity", now, now);
  database.close();
  let service = new NmgService({ dataDirectory: directory, environment: {} });
  const roster = () =>
    service.invoke("taskBoard", { action: "discover", taskId: "default", agentId: "observer" });
  try {
    const before = await roster();
    assert.ok(before.action === "discover" && before.agents.some((agent) => agent.id === "legacy"));
    await service.invoke("taskBoard", {
      action: "put",
      taskId: "history",
      agentId: "legacy",
      content: "Historical attribution",
      kind: "note",
    });
    await service.invoke("taskBoard", { action: "unregisterAgent", id: "legacy" });
    await service.invoke("taskBoard", { action: "heartbeat", id: "legacy" });
    service.close();
    service = new NmgService({ dataDirectory: directory, environment: {} });
    const after = await roster();
    assert.ok(after.action === "discover" && after.agents.length === 0);
    const history = await service.invoke("taskBoard", {
      action: "read",
      taskId: "history",
      agentId: "observer",
    });
    assert.ok(history.action === "read" && history.entries[0]?.agentId === "legacy");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("board presence retirement preserves identity and fences old session callbacks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-presence-"));
  const service = new NmgService({ dataDirectory: directory, environment: {} });
  const register = (presenceToken: string) =>
    service.invoke("taskBoard", {
      action: "registerAgent",
      id: "session-a",
      agentName: "Reviewer",
      presenceToken,
    });
  const discover = async () => {
    const result = await service.invoke("taskBoard", {
      action: "discover",
      agentId: "observer",
      taskId: "default",
    });
    if (result.action !== "discover") throw Error("Missing roster");
    return result.agents;
  };
  try {
    await register("old");
    await service.invoke("state", {
      space: "board",
      action: "write",
      operation: "agentStatus",
      agentId: "session-a",
      text: "Review context",
    });
    await register("current");
    await service.invoke("taskBoard", {
      action: "unregisterAgent",
      id: "session-a",
      presenceToken: "old",
    });
    assert.equal((await discover()).length, 1);
    await service.invoke("taskBoard", { action: "unregisterAgent", id: "session-a" });
    assert.equal((await discover()).length, 1);
    await service.invoke("taskBoard", {
      action: "unregisterAgent",
      id: "session-a",
      presenceToken: "current",
    });
    assert.deepEqual(await discover(), []);
    await service.invoke("taskBoard", {
      action: "heartbeat",
      id: "session-a",
      presenceToken: "current",
    });
    assert.deepEqual(await discover(), []);
    await register("replacement");
    assert.equal((await discover())[0]?.statusNote, "Review context");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
