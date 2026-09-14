/**
 * The design's D8: shutdown is a sequence, and the middle step needs an await.
 *
 * Stop new work is a synchronous decision and close() already made it. Letting the work in flight
 * finish is not, which is why it is a separate call: a close() that returned while calls it had
 * already accepted were still running would report a clean shutdown over writes that were answered
 * as accepted. So this asserts both halves - the drain waits, and the close refuses to skip it.
 */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NmgService } from "../../src/cli/service.ts";
import { removeTempDirectory } from "../helpers/temp-directory.ts";
import { stripProviderEnv } from "../helpers/test-env.ts";

stripProviderEnv();

test("drain lets the calls already accepted finish, and close refuses to skip that", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-cli-drain-"));
  const service = new NmgService({ databasePath: join(directory, "nmg.sqlite"), environment: {} });
  try {
    // Idle: there is nothing to wait for, and that is not the same as timing out.
    await service.drain();
    assert.equal(service.inFlight, 0);

    // A call that has been accepted and not yet answered. `search` opens the store on first use, so
    // at this line it is running rather than already finished - which is the whole point: the
    // counter has to see work that a synchronous close() could not.
    const call = service.invoke("search", { query: "anything", limit: 1 });
    assert.equal(service.inFlight, 1, "an accepted call is counted until it is answered");
    assert.throws(
      () => service.close(),
      /drain before closing/u,
      "closing over an accepted call is refused rather than reported as a clean shutdown",
    );
    await assert.rejects(
      () => service.drain(0),
      /still in flight/u,
      "a drain that cannot finish says so instead of returning quietly",
    );
    await call.catch(() => undefined);
    assert.equal(service.inFlight, 0, "and it stops being counted once it is answered");

    // Close stays one-way, and draining an already-closed service is not an error.
    service.close();
    await service.drain();
    await assert.rejects(() => service.invoke("hello"), /takes no new work/u);
  } finally {
    service.close();
    removeTempDirectory(directory);
  }
});
