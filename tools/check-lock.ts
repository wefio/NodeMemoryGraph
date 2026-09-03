/**
 * Verify the root package-lock.json is in sync with package.json.
 *
 * Rationale: the root lockfile is tracked (a configuration artifact, not a
 * regenerable build output). A dependency edit that forgets to sync the lock
 * passes local builds but fails CI's `npm ci`, so catching it in the shared
 * verification chain saves a CI round-trip. The check is a local diff of the
 * root manifest's dependency specifiers against the lockfile's root entry —
 * no network, no install.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8")) as {
  packages?: Record<string, { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> }>;
};

const lockRoot = lock.packages?.[""];
if (!lockRoot) {
  process.stderr.write("check:lock — package-lock.json has no root package entry\n");
  process.exitCode = 1;
} else {
  const expected = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
  };
  const locked = {
    ...(lockRoot.dependencies ?? {}),
    ...(lockRoot.devDependencies ?? {}),
    ...(lockRoot.optionalDependencies ?? {}),
    ...(lockRoot.peerDependencies ?? {}),
  };
  const drift: string[] = [];
  for (const [name, spec] of Object.entries(expected)) {
    if (locked[name] !== spec) drift.push(`${name}: package.json "${spec}" != lock "${locked[name] ?? "(missing)"}"`);
  }
  for (const name of Object.keys(locked)) {
    if (!(name in expected)) drift.push(`${name}: present in lock but not in package.json`);
  }
  if (drift.length > 0) {
    process.stderr.write("check:lock — package-lock.json is stale; run `npm install --package-lock-only`:\n" + drift.map((line) => `  - ${line}`).join("\n") + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(`check:lock ok: ${Object.keys(expected).length} root dependency specifiers match package-lock.json\n`);
  }
}
