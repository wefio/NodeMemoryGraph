import assert from "node:assert/strict";
import test from "node:test";

import { Router } from "../../src/core/router.ts";

test("hierarchical activation keeps temporal state isolated per session", () => {
  const router = new Router({
    dimensions: 2,
    embed: () => [1, 0],
  });
  const first = router.ensureHA(2, "session-a");
  const again = router.ensureHA(2, "session-a");
  const other = router.ensureHA(2, "session-b");

  assert.equal(first, again);
  assert.notEqual(first, other);
  first.propagate(new Float32Array([1, 0]), [{ nodeId: "a", vector: new Float32Array([1, 0]) }]);
  assert.notDeepEqual(first.toJSON().h1State, other.toJSON().h1State);
  assert.equal(router.clearSession("session-a"), true);
  assert.notEqual(router.ensureHA(2, "session-a"), first);
});
