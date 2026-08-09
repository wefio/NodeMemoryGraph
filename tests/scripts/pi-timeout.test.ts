import assert from "node:assert/strict";
import test from "node:test";

import { hardTimeout } from "../../scripts/pi-timeout.ts";

test("hardTimeout bounds an RPC that never settles", async () => {
  let timedOut = false;
  await assert.rejects(
    hardTimeout(new Promise<never>(() => undefined), 5, () => {
      timedOut = true;
    }),
    /Pi prompt exceeded the 5ms evaluation timeout/u,
  );
  assert.equal(timedOut, true);
});

test("hardTimeout clears its timer after an operation completes", async () => {
  let timedOut = false;
  const result = await hardTimeout(Promise.resolve("ok"), 5, () => {
    timedOut = true;
  });
  assert.equal(result, "ok");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(timedOut, false);
});
