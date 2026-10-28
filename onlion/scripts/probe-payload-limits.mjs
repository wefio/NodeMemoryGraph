/* eslint-disable no-console -- deliberate test/diagnostic output */
/** Manual probe: payload caps and long-query chunking, end to end.
 *
 * Runs the BUILT worker under Miniflare (same modules and compatibility target as
 * the API tests) against a local embedding server, so the request path is the one
 * a deployment runs. The server's batcher counters show how many texts actually
 * reached the embedder: a long query must send more than one text, a short one
 * exactly one.
 *
 * Requires a local OpenAI-compatible embedding server (see
 * `evals/omnimemeval/bge_server.py`) listening on EMBED_BASE. Not part of
 * `npm run verify`: CI has no embedding server, and these assertions are about a
 * running deployment rather than a unit.
 *
 *   node onlion/scripts/probe-payload-limits.mjs
 */
import { createWorkerFixture } from "./worker-fixture.mjs";

const BGE = process.env.NMG_PROBE_EMBED ?? "http://127.0.0.1:8000";
const auth = { authorization: "Bearer test-key", "content-type": "application/json" };

async function batcherTexts() {
  const health = await (await fetch(`${BGE}/health`)).json();
  return health.batcher.texts;
}

const fixture = createWorkerFixture({
  bindings: {
    NMG_EMBED_BASE_URL: `${BGE}/v1`,
    NMG_EMBED_MODEL: "bge-small-en-v1.5",
    NMG_EMBED_PROFILE: "bge-en",
    NMG_EMBED_API_KEY: "local",
  },
});
const worker = await fixture.getWorker("a");
const post = async (route, body) => {
  const started = Date.now();
  const response = await worker.fetch(`http://localhost${route}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed, ms: Date.now() - started };
};

const userId = "local-long-query";
let failures = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
};

try {
  const health = await (await worker.fetch("http://localhost/health")).json();
  console.log("health.limits =", JSON.stringify(health.limits));

  // Seed a few memories so retrieval has candidates.
  const turns = [
    "I went to a LGBTQ support group yesterday and it was so powerful.",
    "My sister Melanie painted a sunrise over the lake last weekend.",
    "I research regenerative agriculture at the university.",
    "We adopted a puppy named Biscuit in March.",
    "My commute to work takes about forty minutes by train.",
    "The spare key is kept under the blue ceramic planter on the balcony.",
  ];
  const added = await post("/add", {
    user_id: userId,
    session_id: "seed",
    request_id: "seed-1",
    messages: turns.map((content) => ({ role: "user", content })),
  });
  check("add seed messages", added.status === 200, `status=${added.status} ${added.ms}ms`);

  // Distractors, so a top-k page is a strict subset and a hit means ranking, not
  // "the store is smaller than the page".
  const distractors = Array.from(
    { length: 24 },
    (_unused, index) =>
      `Note ${index + 1}: I rewired the desk lamp, sorted the toolbox, and walked past the harbour at noon.`,
  );
  const noise = await post("/add", {
    user_id: userId,
    session_id: "noise",
    request_id: "noise-1",
    messages: distractors.map((content) => ({ role: "user", content })),
  });
  check("add distractor memories", noise.status === 200, `status=${noise.status}`);

  // 1. Short query: exactly one embedding text.
  let before = await batcherTexts();
  const short = await post("/search", { user_id: userId, query: "Where did I go yesterday?", top_k: 10 });
  let after = await batcherTexts();
  check("short query is accepted", short.status === 200, `status=${short.status} ${short.ms}ms`);
  check(
    "short query embeds one text",
    after - before === 1,
    `embedding texts +${after - before}`,
  );
  console.log(
    `      records=${short.body.data?.length ?? 0} mode=${short.body.retrieval_mode} totalMs=${short.body.timings?.totalMs}`,
  );

  // 2. Long query, previously rejected at 4096 characters.
  const longQuery = ("Where did I go yesterday and what did I research about agriculture? " + "context filler about the trip, the puppy, and the lake. ".repeat(120)).slice(0, 12000);
  console.log(`      long query chars=${longQuery.length}`);
  before = await batcherTexts();
  const long = await post("/search", { user_id: userId, query: longQuery, top_k: 10 });
  after = await batcherTexts();
  check("long query is accepted (no 413)", long.status === 200, `status=${long.status} ${long.ms}ms`);
  check(
    "long query is split into multiple embedding texts",
    after - before > 1,
    `embedding texts +${after - before}`,
  );
  check("long query is not the old 413", long.body.error?.code !== "content_too_large", JSON.stringify(long.body.error ?? ""));
  console.log(
    `      records=${long.body.data?.length ?? 0} mode=${long.body.retrieval_mode} totalMs=${long.body.timings?.totalMs} chunksEmbedded=${after - before}`,
  );

  // 3. A long query whose informative part sits past the model's window. The
  //    marker is only in the tail, so the whole-text feature alone cannot see it;
  //    the windowed features can. This is the behaviour per-feature fusion adds.
  const marker = "blue ceramic planter";
  const head = "Here is a long transcript of unrelated small talk. ".repeat(120);
  const tailQuery = `${head}
Where did I say I keep the spare key?`;
  const tail = await post("/search", { user_id: userId, query: tailQuery, top_k: 5 });
  const tailHit = (tail.body.data ?? []).some((item) =>
    String(item.content ?? "").includes(marker),
  );
  check(
    `a ${tailQuery.length}-character query finds evidence that only its tail mentions`,
    tail.status === 200 && tailHit,
    `status=${tail.status} hit=${tailHit} records=${tail.body.data?.length ?? 0}`,
  );

  // Control: the same shape without the marker must not surface that record, so
  // the hit above is not an artefact of the filler text.
  const controlQuery = `${head}
What did I say about the weather that afternoon?`;
  const control = await post("/search", { user_id: userId, query: controlQuery, top_k: 5 });
  const controlHit = (control.body.data ?? []).some((item) =>
    String(item.content ?? "").includes(marker),
  );
  check(
    "the same query shape without the marker does not surface it",
    control.status === 200 && !controlHit,
    `status=${control.status} hit=${controlHit}`,
  );

  // 4. A message above the old 128000-character cap.
  const bigMessage = ("This is a long turn about the trip. " + "detail ".repeat(10)).repeat(2000);
  const big = await post("/add", {
    user_id: userId,
    session_id: "big",
    request_id: "big-1",
    messages: [{ role: "user", content: bigMessage }],
  });
  check(
    `add a ${bigMessage.length}-character message (old cap 128000)`,
    big.status === 200,
    `status=${big.status} ${big.ms}ms ${JSON.stringify(big.body.error ?? "")}`,
  );

  // 5. Over the 6 MiB body limit must still be refused, and clearly.
  const huge = "x".repeat(7 * 1024 * 1024);
  const over = await post("/add", {
    user_id: userId,
    session_id: "huge",
    request_id: "huge-1",
    messages: [{ role: "user", content: huge }],
  });
  check(
    "a 7 MiB body is still refused",
    over.status === 413,
    `status=${over.status} code=${over.body.error?.code ?? "none"}`,
  );
} finally {
  await fixture.dispose();
}
console.log(failures === 0 ? "\nALL LOCAL CHECKS PASSED" : `\n${failures} LOCAL CHECK(S) FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
