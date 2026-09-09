/**
 * Canonical test environment — the single home for test-side environment
 * policy. Enforced by tests/support/test-env-guard.test.ts.
 *
 * Spawned daemons and MCP servers inherit the test process environment. An
 * ambient provider (e.g. `NMG_EMBED_PROVIDER=gemini` plus `GEMINI_API_KEY`)
 * makes recall call a live external service, so ranking/timing assertions
 * become slow and nondeterministic. Tests that need a provider must configure
 * it explicitly; ambient config never leaks in.
 *
 * Any test file that starts an NMG daemon — directly, through the pi extension
 * harness, or via a spawned script — calls `stripProviderEnv()` once at module
 * scope, before the daemon starts. See docs/design/ci-cd-and-quality.md §2.
 */
const PROVIDER_ENV_PREFIXES = ["NMG_EMBED", "NMG_SUMMARY", "NMG_JUDGE"] as const;

/**
 * Delete ambient provider configuration from `env` (defaults to `process.env`)
 * and return it, so it works both as a module-scope call and as an explicit
 * child-process `env` option.
 */
export function stripProviderEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const key of Object.keys(env)) {
    if (PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) delete env[key];
  }
  return env;
}
