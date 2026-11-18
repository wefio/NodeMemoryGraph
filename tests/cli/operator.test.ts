import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { NmgService } from "../../src/cli/service.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("operator metrics survive reopen and managed embedding activation fences revisions and redacts keys", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nmg-operator-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        data: body.input.map((_: unknown, index: number) => ({ index, embedding: [0.2, 0.8] })),
      }),
    );
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const port = (server.address() as { port: number }).port;
  let service = new NmgService({ dataDirectory: directory, environment: {} });
  try {
    await service.invoke("remember", {
      statement: "Atlas uses SQLite for archival records.",
      nodeName: "Atlas",
    });
    await service.invoke("search", { query: "Atlas", sessionId: "owner", autoRecall: true });
    await service.invoke("search", { query: "Atlas", sessionId: "owner" });
    const initial = await service.invoke("operator", { action: "snapshot" });
    assert.equal((initial.counts as { memories: number }).memories, 1);
    assert.ok(JSON.stringify(initial.activity).includes("automaticRecall"));
    const saved = await service.invoke("operator", {
      action: "saveCandidate",
      revision: 0,
      config: {
        provider: "openai",
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "fixture",
        apiKey: "PrivateKeyMustStayHidden",
        dimensions: 2,
      },
    });
    assert.doesNotMatch(JSON.stringify(saved), /PrivateKeyMustStayHidden/);
    await assert.rejects(
      service.invoke("operator", { action: "saveCandidate", revision: 0, config: {} }),
      /revision/,
    );
    const tested = await service.invoke("operator", { action: "testCandidate", revision: 1 });
    assert.equal(tested.ok, true);
    await assert.rejects(
      service.invoke("operator", { action: "activateCandidate", revision: 1, useManaged: true }),
      /ready/,
    );
    await service.invoke("operator", { action: "buildCandidate", revision: 1 });
    let snapshot: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 100; attempt++) {
      snapshot = await service.invoke("operator", { action: "snapshot" });
      if ((snapshot.configuration as { job: { state: string } }).job.state !== "running") break;
      await new Promise((done) => setTimeout(done, 10));
    }
    assert.equal((snapshot.configuration as { job: { state: string } }).job.state, "ready");
    await assert.rejects(
      service.invoke("operator", { action: "activateCandidate", revision: 1 }),
      /useManaged/,
    );
    await service.invoke("operator", {
      action: "activateCandidate",
      revision: 1,
      useManaged: true,
    });
    const status = await service.invoke("status", {});
    assert.equal(status.embedding.provider, "openai");
    assert.match(status.embedding.indexId!, /managed-/);
    await service.close();
    service = new NmgService({ dataDirectory: directory, environment: {} });
    const recovered = await service.invoke("operator", { action: "snapshot" });
    assert.doesNotMatch(JSON.stringify(recovered), /PrivateKeyMustStayHidden/);
    assert.equal((recovered.configuration as { source: string }).source, "managed");
    assert.deepEqual(recovered.activity, initial.activity);
  } finally {
    await service.close();
  }
});
