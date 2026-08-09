import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { resolvePiControlPaths } from "../../scripts/pi-paths.ts";

test("headless Pi defaults every writable path to the project", () => {
  const root = resolve("C:/work/nmg");
  const paths = resolvePiControlPaths(root, {});
  assert.equal(paths.agentDirectory, resolve(root, ".nmg/pi-agent"));
  assert.equal(paths.dataDirectory, resolve(root, ".nmg"));
  assert.equal(paths.projectDirectory, root);
});

test("headless Pi respects explicit path overrides", () => {
  const root = resolve("C:/work/nmg");
  const paths = resolvePiControlPaths(root, {
    NMG_PI_AGENT_DIR: "C:/state/pi",
    NMG_DATA_DIR: "C:/state/nmg",
    NMG_PROJECT_DIR: "C:/project",
  });
  assert.equal(paths.agentDirectory, resolve("C:/state/pi"));
  assert.equal(paths.dataDirectory, resolve("C:/state/nmg"));
  assert.equal(paths.projectDirectory, resolve("C:/project"));
});
