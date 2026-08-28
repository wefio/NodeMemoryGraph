import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const dockerfile = readFileSync(new URL("../../Dockerfile", import.meta.url), "utf8");
const entrypoint = readFileSync(
  new URL("../../docker/entrypoint.sh", import.meta.url),
  "utf8",
);

test("external target stays free of the bundled embedding environment", () => {
  const baseStart = dockerfile.indexOf("AS nmg-runtime");
  const externalStart = dockerfile.indexOf("FROM nmg-runtime AS external");
  const bgeStart = dockerfile.indexOf("FROM nmg-runtime AS bge");

  assert.ok(baseStart >= 0);
  assert.ok(externalStart > baseStart);
  assert.ok(bgeStart > externalStart);

  const lightweightRuntime = dockerfile.slice(baseStart, bgeStart);
  assert.doesNotMatch(lightweightRuntime, /python3|pip install|TORCH_INDEX_URL|BGE_MODEL/);
  assert.match(lightweightRuntime, /NMG_EMBED_LOCAL_SERVER=0/);
});

test("bundled embedding startup is explicitly gated", () => {
  assert.match(entrypoint, /NMG_EMBED_LOCAL_SERVER:-0/);
  assert.match(entrypoint, /python \/app\/evals\/omnimemeval\/bge_server\.py/);
  assert.match(dockerfile, /COPY evals\/omnimemeval\/embedding_batcher\.py/);
  assert.match(entrypoint, /wait "\$nmg_pid"/);
});
