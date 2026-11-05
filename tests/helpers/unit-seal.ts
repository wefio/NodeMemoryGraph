/**
 * The unit layer's contract, enforced instead of inferred.
 *
 * `tools/test-layers.ts` reads a test's source to decide its layer, so a test that reaches
 * `spawn` through a helper still reads as unit until someone notices. The seal closes that gap
 * at run time: the unit tier starts with this module preloaded, and leaving the process,
 * opening a socket or opening a real database throws with the rule it broke.
 *
 * It only arms inside a test-runner child process. The runner itself spawns the children that
 * run the files, so sealing the parent would stop the tier from starting at all.
 */
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);

/** Each entry is a builtin, the calls it must not make, and the layer those calls belong to. */
const SEALED: ReadonlyArray<readonly [string, readonly string[], string]> = [
  [
    "node:child_process",
    ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
    "starting a process is the end-to-end boundary",
  ],
  ["node:sqlite", ["DatabaseSync"], "a real database file is the integration boundary"],
  ["node:net", ["connect", "createConnection"], "a socket is the integration boundary"],
];

function seal(moduleName: string, names: readonly string[], reason: string): void {
  let builtin: Record<string, unknown>;
  try {
    builtin = require(moduleName) as Record<string, unknown>;
  } catch {
    return; // The builtin does not exist on this Node version; nothing to seal.
  }
  for (const name of names) {
    if (typeof builtin[name] !== "function") continue;
    // A function expression, not an arrow: `new DatabaseSync()` must reach the message
    // instead of failing with "not a constructor".
    builtin[name] = function sealed(): never {
      throw new Error(
        `unit layer: ${moduleName}.${name} is sealed - ${reason}. Move the test to the next ` +
          `layer up, or teach tools/test-layers.ts why this file is the exception.`,
      );
    };
  }
}

if (process.env.NODE_TEST_CONTEXT) {
  for (const [moduleName, names, reason] of SEALED) seal(moduleName, names, reason);
  syncBuiltinESMExports();
}
