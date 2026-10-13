import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { runCli } from "../../src/cli/main.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("reload fences new work, drains accepted requests and reports drain failure without stopping", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-drain-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    const pending = service.invoke("search", { query: "reload drain", limit: 1 });
    assert.equal(service.inFlight, 1);
    await assert.rejects(service.prepareReload(0), /still in flight/u);
    await pending;
    assert.equal(service.shutdownRequested, false, "a refused reload leaves the owner running");
    await service.invoke("hello");

    const accepted = service.invoke("search", { query: "reload again", limit: 1 });
    const draining = service.prepareReload();
    await assert.rejects(service.invoke("hello"), /takes no new work/u);
    await accepted;
    await draining;
    assert.equal(service.inFlight, 0);
    service.close();
  } finally {
    await service.drain();
    service.close();
    removeTempDirectory(directory);
  }
});

test("daemon reload is an explicit command and refuses to start a stopped daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-reload-command-"));
  let error = "";
  try {
    const exit = await runCli(["daemon", "reload", "--data-dir", directory, "--json"], {
      stdout: {
        write() {
          return true;
        },
      },
      stderr: {
        write(text) {
          error += String(text);
          return true;
        },
      },
    });
    assert.equal(exit, 1);
    assert.match(error, /running daemon/u);
  } finally {
    removeTempDirectory(directory);
  }
});
