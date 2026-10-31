// End-to-end pin for search-time-budget invariant 8: a dependency that never settles must cost a
// bounded amount of a request.
//
// The provider below accepts every /embeddings call and never answers. Before the caller-enforced
// deadline existed, the only bound was the cancel signal, and behind it undici's own 300 s
// backstop - past the platform's 120 s ceiling, which is how a search could be killed with no
// answer at all.
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createWorkerFixture } from "./worker-fixture.mjs";

const storage = path.join(process.cwd(), ".runtime", "tests", "embedding-deadline");
fs.rmSync(storage, { recursive: true, force: true });

/** Never resolves: this is the provider that does not answer, not the provider that answers slowly. */
const hang = () => new Promise(() => {});
/** How many calls actually reached the never-answering path: without this the test could pass by
 *  never embedding the query at all. */
let hangCalls = 0;
/** Answers document embeddings (the fold needs them, or there is no partition to search) and never
 *  answers the query text, which is the path under test. */
const outboundService = async (request) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/embeddings")) return new Response("not found", { status: 404 });
  const body = await request.json();
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  // Only the query text hangs. A batch count would not work: the fold embeds a single record when
  // there is only one, so "one input" is not a synonym for "a query".
  if (inputs.some((text) => String(text).includes(QUERY_HANG))) {
    hangCalls += 1;
    return hang();
  }
  return new Response(
    JSON.stringify({
      data: inputs.map((_text, index) => ({ index, embedding: Array(8).fill(0.5) })),
    }),
    { headers: { "content-type": "application/json" } },
  );
};

const fixture = createWorkerFixture({
  storage,
  outboundService,
  bindings: {
    NMG_ADD_MODE: "log",
    NMG_DEBUG_ERRORS: "1",
    NMG_EMBED_BASE_URL: "https://embed.test/v1",
    NMG_EMBED_MODEL: "text-embedding-deadline",
    NMG_EMBED_DIMENSIONS: "8",
    // Small on purpose: the assertion is about the mechanism firing, not about a 10 s wait.
    NMG_EMBED_TIMEOUT_MS: "120",
    NMG_EMBED_DEADLINE_GRACE_MS: "60",
    NMG_ACCEPT_EMBED_MS: "80",
  },
});
const worker = await fixture.getWorker("a");
const OWNER = { "oai-authenticated-user-email": "owner@example.test", origin: "http://localhost" };
async function call(route, body, headers = {}) {
  const response = await worker.fetch("http://localhost" + route, {
    method: "POST",
    headers: { authorization: "Bearer test-key", "content-type": "application/json", ...headers },
    body: JSON.stringify(body ?? {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : {} };
}
const USER = "hung-provider";
const QUERY_HANG = "QUERYHANG sentinel";

// A write must not hang either: the accept's inline embedding loses its short race and the entry is
// stored vectorless, which is the designed degradation.
{
  const started = Date.now();
  const added = await call("/add", {
    user_id: USER,
    session_id: "hung",
    request_id: "hung-1",
    messages: [{ role: "user", content: "the hung provider test marker" }],
  });
  const elapsed = Date.now() - started;
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.ok(elapsed < 5_000, `an Add against a hung provider took ${elapsed} ms`);
  process.stdout.write("PASS: an Add against a never-answering provider returns in " + elapsed + " ms\n");
}

// Fold so the record lives in a partition: the read path only embeds when there is something to read.
{
  const folded = await call("/admin/fold?user_id=" + USER, {}, OWNER);
  assert.equal(folded.status, 200, JSON.stringify(folded.body));
}

{
  const started = Date.now();
  const searched = await call("/search", {
    user_id: USER,
    query: QUERY_HANG,
    top_k: 10,
  });
  const elapsed = Date.now() - started;
  assert.equal(searched.status, 200, JSON.stringify(searched.body));
  assert.ok(elapsed < 10_000, `a search against a hung provider took ${elapsed} ms`);
  // Either the signal reached its own timeout first, or the caller deadline did. Both are bounded
  // answers; only "no answer at all" is the failure this test exists for.
  assert.ok(hangCalls >= 1, "the query embedding must actually have been attempted and hung");
  const code = searched.body.degraded;
  // `undefined` means the vector path was skipped and the lexical path answered: that is the
  // designed degradation, and it is what a short page looks like when only the query vector is
  // missing rather than a whole partition.
  assert.ok(
    code === "embedding_timeout" || code === "embedding_deadline" || code === undefined,
    `unexpected degradation code ${code}`,
  );
  assert.ok(Array.isArray(searched.body.data), "a degraded answer is still a well-formed page");
  process.stdout.write(
    "PASS: a search against a never-answering provider returns 200 in " +
      elapsed +
      " ms (degraded=" +
      String(code) +
      "), not the platform ceiling.\n",
  );
}

await fixture.dispose();
