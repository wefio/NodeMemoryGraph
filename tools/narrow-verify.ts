// Narrow per-domain verification for agent-verify.
//
// Principle: verification is a composition of lightweight primitives over one
// vocabulary. A change that is cleanly owned by one route's bounded domain runs
// that route's OWN tests (node --test <route.tests>) plus the always-run shared
// invariants; a change touching any shared / cross-cutting file falls back to
// the declared whole blocking set. When in doubt, run full — that is the whole
// safety rule. No new executor: the tools the scripts wrap already accept the
// narrow globs (route.tests), so this only adds route granularity + a coverage
// rule, not machinery.

export interface RouteLike {
  id: string;
  paths: string[];
  tests: string[];
  verify: { blocking: string[]; advisory: string[] };
}

export interface NarrowVerifyPlan {
  /** True when every changed scope maps to exactly one route and no scope is a
   *  shared/cross-cutting path. When false the caller must run the full gate. */
  narrow: boolean;
  /** The single owning route (only when narrow). */
  route?: RouteLike;
  /** Always-run shared invariants for any change. */
  shared: string[];
  /** node --test globs from the owning route's own tests (may be empty). */
  testGlobs: string[];
  /** Reason for escalation when not narrow. */
  escalationReason?: string;
}

/** Paths (or prefixes) with an unbounded blast radius: a change here can affect
 *  more than one domain, so narrowing to a single route's tests is unsafe. */
const SHARED_ROOTS = [
  "src/",
  "tests/",
  "scripts/",
  "tools/",
  ".github/",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "agent-context.yaml",
  "AGENTS.md",
];

/** Cross-platform root detection for a repository path. */
function underSharedRoot(scope: string): boolean {
  const normalized = scope.replace(/\\/g, "/").replace(/^\.\//, "");
  return SHARED_ROOTS.some(
    (root) =>
      normalized === root.replace(/\/$/, "") ||
      (root.endsWith("/") ? normalized.startsWith(root) : normalized.startsWith(`${root}/`) || normalized === root),
  );
}

/** Minimal glob check: a route path pattern matches a changed scope when the
 *  scope sits under the pattern's static prefix (mirrors RCP patternMayIntersect
 *  for single-file scopes). Handles ** and * by truncating at the wildcard. */
function routeMatches(routePath: string, scope: string): boolean {
  const p = routePath.replace(/\\/g, "/");
  const s = scope.replace(/\\/g, "/");
  const star = p.search(/[*?]/);
  const prefix = (star < 0 ? p : p.slice(0, star)).replace(/\/$/, "");
  return s === prefix || s.startsWith(`${prefix}/`);
}

/** Build the narrow/full verification decision for a set of changed scopes.
 *  Returns narrow=true only when EVERY scope is singly-owned by one route and
 *  none is a shared/cross-cutting path. */
export function planNarrowVerify(
  routes: RouteLike[],
  scopes: string[],
  opts: { sharedCommands?: string[] } = {},
): NarrowVerifyPlan {
  const shared = opts.sharedCommands ?? ["check"];
  const normalized = scopes.map((s) => s.replace(/\\/g, "/"));
  if (normalized.length === 0) {
    return { narrow: false, shared, testGlobs: [], escalationReason: "no changed paths given" };
  }
  const owners: Array<{ route: RouteLike; scope: string }> = [];
  for (const scope of normalized) {
    const matched = routes.filter((route) => route.paths.some((pattern) => routeMatches(pattern, scope)));
    if (underSharedRoot(scope)) {
      return {
        narrow: false,
        shared,
        testGlobs: [],
        escalationReason: `${scope} is a shared/cross-cutting path`,
      };
    }
    if (matched.length !== 1) {
      return {
        narrow: false,
        shared,
        testGlobs: [],
        escalationReason:
          matched.length === 0
            ? `no route owns ${scope}`
            : `${scope} is owned by ${matched.length} routes (ambiguous)`,
      };
    }
    owners.push({ route: matched[0]!, scope });
  }
  const ownerIds = new Set(owners.map((owner) => owner.route.id));
  if (ownerIds.size !== 1) {
    return {
      narrow: false,
      shared,
      testGlobs: [],
      escalationReason: `change spans multiple routes: ${[...ownerIds].join(", ")}`,
    };
  }
  const route = owners[0]!.route;
  return {
    narrow: true,
    route,
    shared,
    testGlobs: route.tests,
  };
}
