/**
 * The patch probe's frozen rename target, in one place.
 *
 * The probe's candidate is the whole file, and a dependent probe task carries it inside a snapshot,
 * where the shared work contract bounds a dependency's serialized bytes at 8 KB. Pointing the probe at
 * a live product file made its own limits depend on how big that file had grown, which is how a
 * correct rename once came back as `rejected`; the fixture is frozen and small instead, and its own
 * comment states the shape the oracle requires. Both suites that exercise the probe share this, so the
 * path and the expected answer have one home.
 */
import { readFileSync } from "node:fs";

import { expectedRename } from "../../src/integration/ooo-verifier.ts";

/** The path the probe's spec, artifact and verify all agree on. */
export const RENAME_TARGET = "fixtures/rename-baseline.ts";

/** The frozen file the worker is asked to rename inside. */
export const renameSource = (): string =>
  readFileSync(new URL("./fixtures/rename-baseline.ts", import.meta.url), "utf8");

/** The host oracle's answer: the exact rename of `byId` to `planIndex` in the frozen file. */
export const expectedRenameOf = (source: string): string => expectedRename(source);
