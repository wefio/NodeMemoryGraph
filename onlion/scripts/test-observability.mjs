// Two invariants from docs/design/search-time-budget-design.md that must hold in code, not only in
// prose:
//
//   8. A cancel signal is not a bound - a dependency call that never settles must still cost a
//      bounded amount of a request (undici's own backstop is 300 s, past the 120 s ceiling).
//   9. A stage name is not evidence; its age is - a report that names a stage must say how long
//      that stage has been entered, so "blocked here" and "entered here" stop looking the same.
//
// Neither test needs a worker or a network: both are properties of the helpers, and a helper that
// only holds inside Miniflare would not hold in the invocation that gets killed.
import assert from "node:assert/strict";
import fs from "node:fs";
import { hardDeadline } from "../backend/monitoring.mjs";
import { measure, currentStage, currentStageAgeMs } from "../backend/diagnostics.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const passed = [];
function pass(what) {
  passed.push(what);
  process.stdout.write("PASS: " + what + "\n");
}

// 1. A promise that never settles is rejected on the caller's deadline, not left to the platform.
{
  const started = Date.now();
  await assert.rejects(
    hardDeadline(() => new Promise(() => {}), 60, "embedding"),
    (error) => {
      assert.equal(error.code, "embedding_deadline");
      assert.match(error.message, /did not settle within 60 ms/);
      return true;
    },
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 50 && elapsed < 2000, `deadline fired at ${elapsed} ms`);
  pass("a promise that never settles is rejected on the caller's deadline (embedding_deadline)");
}

// 2. It must not change the healthy path: a value passes through, an error keeps its own identity.
{
  assert.equal(await hardDeadline(() => 7, 50, "x"), 7);
  const own = Object.assign(new Error("provider said no"), { code: "embedding_http_400" });
  await assert.rejects(
    hardDeadline(() => Promise.reject(own), 50, "x"),
    (error) => {
      assert.equal(error, own, "the caller's own error must not be replaced by the deadline");
      return true;
    },
  );
  // A slow-but-finishing call must not be cut: the deadline is a net, not a throttle.
  assert.equal(
    await hardDeadline(async () => {
      await sleep(30);
      return "done";
    }, 200, "x"),
    "done",
  );
  pass("the deadline passes values through, keeps the caller's error, and does not cut slow-but-finishing work");
}

// 3. Stage age separates the two faults a name cannot.
{
  assert.equal(currentStage(), null);
  assert.equal(currentStageAgeMs(), null);
  let seen;
  await measure("embedding", async () => {
    await sleep(30);
    seen = { stage: currentStage(), age: currentStageAgeMs() };
  });
  assert.equal(seen.stage, "embedding");
  assert.ok(seen.age >= 25, `age inside the stage was ${seen.age} ms`);
  assert.equal(currentStage(), null, "a finished stage must not stay current");
  assert.equal(currentStageAgeMs(), null);
  pass("a stage reports its own age while running, and stops being current when it ends");
}

// 4. Nested stages restore the outer one, age included - otherwise a watchdog line can name a stage
//    that ended long ago, which is exactly how "stuck in embedding" got read into a 60 s report.
{
  let inner;
  await measure("outer", async () => {
    await sleep(10);
    await measure("inner", async () => {
      await sleep(10);
      inner = { stage: currentStage(), age: currentStageAgeMs() };
    });
    const after = { stage: currentStage(), age: currentStageAgeMs() };
    assert.equal(after.stage, "outer");
    assert.ok(after.age >= 20, `outer age after inner finished was ${after.age} ms`);
  });
  assert.equal(inner.stage, "inner");
  assert.ok(inner.age >= 5 && inner.age < 1_000, `inner age was ${inner.age} ms`);
  pass("nested stages restore the outer stage with its own age");
}

// 5. Structural pin: inside the embedding client, every provider call must go through the single
//    helper that applies the caller deadline.
//
//    Deliberately a source check, not a behavioural one. A behavioural test needs a provider that
//    ignores its abort; workerd aborts the fetch in the harness, so an uncovered call site keeps
//    passing any such test. That is exactly how the miss shipped: three of four call sites were
//    covered, and the uncovered one - the query embedding - was the path that hung for 60 s in
//    production while the covered three were fine.
{
  const source = fs.readFileSync(new URL("../backend/worker.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function embeddingClient(");
  assert.ok(start > 0, "embeddingClient must exist");
  const nextTop = source.indexOf("\nfunction ", start + 10);
  const body = source.slice(start, nextTop > 0 ? nextTop : undefined);
  const direct = body.match(/embeddingOperation\(/g) ?? [];
  const through = body.match(/throughProvider\(/g) ?? [];
  assert.equal(
    direct.length,
    1,
    "embeddingOperation must appear once inside embeddingClient, in throughProvider; found " +
      direct.length,
  );
  assert.ok(
    through.length >= 4,
    "every provider call must go through throughProvider; found " + through.length,
  );
  for (const name of ["embedQueries", "embedDocumentsDirect", "embedDocuments", "embed("])
    assert.ok(body.includes(name), "call path must still be present: " + name);
  pass("every provider call inside the embedding client goes through one deadline-applying helper");
}

process.stdout.write(`PASS: observability - ${passed.length} checks.\n`);
