import assert from "node:assert/strict";
import { homedir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { resolveNmgDataDir } from "../../src/cli/data-path.ts";

test("ordinary clients default to the user-level NMG store", () => {
  assert.equal(resolveNmgDataDir({}), resolve(homedir(), ".nmg"));
});

test("an explicit NMG_DATA_DIR overrides the fallback", () => {
  assert.equal(
    resolveNmgDataDir({ NMG_DATA_DIR: "C:/state/nmg" }, "C:/project/.nmg"),
    resolve("C:/state/nmg"),
  );
});

test("controlled clients can supply a project-local fallback", () => {
  assert.equal(resolveNmgDataDir({}, "C:/project/.nmg"), resolve("C:/project/.nmg"));
  assert.equal(resolveNmgDataDir({ NMG_DATA_DIR: "   " }, "C:/project/.nmg"), resolve("C:/project/.nmg"));
});
