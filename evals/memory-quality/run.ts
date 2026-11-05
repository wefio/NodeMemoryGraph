import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { NmgStore } from "../../src/core/store.ts";
import { assessMemoryWrite } from "../../src/core/write-policy.ts";

interface Result {
  category: string;
  passed: boolean;
  latencyMs: number;
  detail: string;
  /** An expected failure: the case asserts the behaviour we want, not the one
   *  the code has. It stays green only while the defect exists. */
  knownGap?: boolean;
  /** A known-gap case that started passing: the defect is fixed and the marker
   *  must be removed, so this fails the run instead of silently going quiet. */
  unexpectedPass?: boolean;
}

const directory = mkdtempSync(join(tmpdir(), "nmg-quality-eval-"));
const store = new NmgStore(join(directory, "nmg.sqlite"));
const results: Result[] = [];

try {
  measure("temporal", () => {
    const oldState = store.remember({
      statement: "Project Atlas currently uses Python 3.11",
      nodeName: "Atlas Python version",
      memoryType: "state",
      stateKey: "runtime.python",
      scope: { project: "Atlas" },
      validFrom: "2026-01-01T00:00:00.000Z",
    });
    const currentState = store.remember({
      statement: "Project Atlas currently uses Python 3.12",
      nodeName: "Atlas Python version",
      memoryType: "state",
      stateKey: "runtime.python",
      scope: { project: "Atlas" },
      validFrom: "2026-07-01T00:00:00.000Z",
    });
    const current = store.search("Atlas current Python", { maxTier: 3, limit: 5 });
    return {
      passed:
        current.some((item) => item.memory.id === currentState.memory.id) &&
        !current.some((item) => item.memory.id === oldState.memory.id),
      detail: "new state supersedes the old state in ordinary retrieval",
    };
  });

  measure("aggregation", () => {
    const boots = store.remember({
      statement: "The user returned hiking boots",
      nodeName: "Shopping returns",
      memoryType: "event",
    });
    const mug = store.remember({
      statement: "The user returned a ceramic mug",
      nodeName: "Shopping returns",
      memoryType: "event",
    });
    const aggregate = store.deriveMemory({
      statement: "The user returned two items: hiking boots and a ceramic mug",
      nodeName: "Shopping return summary",
      sourceMemoryIds: [boots.memory.id, mug.memory.id],
      derivation: "Aggregation of two independently recorded return events",
    });
    return {
      passed:
        aggregate.memory.evidenceIds.length >= 2 &&
        store.search("two returned items", { maxTier: 3 })[0]?.memory.id === aggregate.memory.id,
      detail: "derived memory preserves both source evidence chains",
    };
  });

  measure("conflict", () => {
    const left = store.remember({
      statement: "The deployment region is Frankfurt",
      nodeName: "Deployment region A",
    });
    const right = store.remember({
      statement: "The deployment region is Singapore",
      nodeName: "Deployment region B",
      evidenceRole: "contradict",
    });
    store.linkNodes({
      sourceNodeId: left.node.id,
      targetNodeId: right.node.id,
      type: "contradicts",
      evidenceIds: [left.history.id, right.history.id],
    });
    const context = store.searchContext("deployment region", {
      maxTier: 3,
      limit: 6,
      graphHops: 1,
    });
    return {
      passed:
        context.results.some((item) => item.memory.id === left.memory.id) &&
        context.results.some((item) => item.memory.id === right.memory.id) &&
        context.relations.some((relation) => relation.type === "contradicts"),
      detail: "both claims and their typed contradiction remain visible",
    };
  });

  measure("multi-hop", () => {
    const project = store.remember({ statement: "Project Comet", nodeName: "Comet" });
    const simulator = store.remember({ statement: "Comet uses Gazebo", nodeName: "Gazebo" });
    const incident = store.remember({
      statement: "Gazebo recovered with software rendering",
      nodeName: "Rendering incident",
      tier: 2,
    });
    store.linkNodes({
      sourceNodeId: project.node.id,
      targetNodeId: simulator.node.id,
      type: "depends_on",
    });
    store.linkNodes({
      sourceNodeId: simulator.node.id,
      targetNodeId: incident.node.id,
      type: "related_to",
    });
    const relations = store.getRelations([project.node.id], 2);
    return {
      passed: relations.some((edge) => edge.targetNodeId === incident.node.id),
      detail: "two-hop graph traversal reaches indirectly related evidence",
    };
  });

  measure("exact-detail", () => {
    for (let index = 0; index < 550; index += 1) {
      store.remember({
        statement: `Routine filler note ${index}`,
        nodeName: `Filler ${index}`,
        tier: 0,
      });
    }
    const target = store.remember({
      statement: "The retired internal codename was opaline-cicada-7429",
      nodeName: "Retired codename",
      tier: 3,
    });
    const found = store.search("opaline-cicada-7429", {
      maxTier: 3,
      limit: 2,
      retrievalMode: "fts5",
    });
    return {
      passed: found[0]?.memory.id === target.memory.id,
      detail: "FTS retrieves an exact cold detail beyond the hot candidate window",
    };
  });

  measure("privacy", () => {
    const assessment = assessMemoryWrite({
      statement: "The API key is sk-test-nmg-123456",
      memoryType: "fact",
    });
    return {
      passed: !assessment.allowed && assessment.reason === "secret",
      detail: "deterministic harness policy rejects credential-like semantic writes",
    };
  });

  measure("memory-pollution", () => {
    const transient = assessMemoryWrite({
      statement: "For this response only, answer briefly.",
      memoryType: "preference",
    });
    const stable = assessMemoryWrite({
      statement: "The user prefers concise answers in future sessions.",
      memoryType: "preference",
    });
    return {
      passed: !transient.allowed && stable.allowed,
      detail: "temporary instructions are rejected while durable preferences pass",
    };
  });
  measure("write-gate-boundary", () => {
    const corpus = [
      // Durable rules that merely mention process vocabulary stay recordable.
      {
        statement: "合并必须通过门禁；发布顺序是暂存再生产。",
        memoryType: "constraint",
        expected: "allowed",
      },
      {
        statement: "Merges require a green gate; the release order is staging then production.",
        memoryType: "constraint",
        expected: "allowed",
      },
      // Live positions are refused in both languages, including the bare-noun
      // form that the `to land` pattern alone missed.
      {
        statement: "Pushed 16 commits, waiting for the PR.",
        memoryType: "state",
        expected: "refused",
      },
      { statement: "PR #71 已推送，等待 review。", memoryType: "state", expected: "refused" },
      { statement: "The gate is pending checks.", memoryType: "state", expected: "refused" },
      // The durable preference that merely contains 暂时 is NOT here: it is a
      // known gap asserted as the behaviour we want in write-gate-known-gap
      // below, so fixing the pattern shows up as an unexpected pass.
    ] as const;
    const mismatches = corpus.filter(
      (item) =>
        assessMemoryWrite({ statement: item.statement, memoryType: item.memoryType }).allowed !==
        (item.expected === "allowed"),
    );
    // The refusal is only half the contract: the same statement must stay
    // recordable through the explicit hatch. Asserting only the refusal would
    // keep this case green if the hatch itself broke.
    const hatched = assessMemoryWrite({
      statement: "用户暂时不想用 Tailwind，偏好原生 CSS。",
      memoryType: "preference",
      bypass: true,
    });
    return {
      passed: mismatches.length === 0 && hatched.allowed,
      detail:
        mismatches.length > 0
          ? `gate boundary drifted: ${mismatches.map((item) => item.statement).join(" | ")}`
          : hatched.allowed
            ? "the gate admits durable rules, refuses live positions, and keeps the hatch open"
            : "the unsafe hatch no longer re-admits a wording false positive",
    };
  });

  measure(
    "write-gate-known-gap",
    () => {
      // Desired behaviour: 暂时 modifying a preference verb is not a transient
      // instruction. The pattern at write-policy.ts:34 makes the instruction
      // noun optional, so the noun-less form is refused. While that holds this
      // case is an expected failure; when the pattern is narrowed it passes and
      // the run fails until the marker is removed. The narrowing change must
      // also move this statement into write-gate-boundary's allowed corpus in
      // the same commit: otherwise this zone loses its guard at the moment it
      // becomes legal.
      const assessment = assessMemoryWrite({
        statement: "用户暂时不想用 Tailwind，偏好原生 CSS。",
        memoryType: "preference",
      });
      return {
        passed: assessment.allowed,
        detail: assessment.allowed
          ? "the 暂时 false positive is fixed; remove the known-gap marker"
          : `still refused (${assessment.reason}) by /(?:临时|暂时)(?:要求|指令|使用)?/u`,
      };
    },
    "write-policy.ts:34 transient pattern rejects a durable preference containing 暂时",
  );

  measure("write-miss-evidence", () => {
    // A storage miss is only assertable retrospectively, so the refusal itself
    // must leave a session-anchored trace with its policy reason.
    store.recordRejectedWrite({
      policyReason: "coordination_state",
      writeReason: "eval_write_miss_evidence",
      sessionId: "eval-write-miss-session",
      memoryType: "state",
    });
    const event = store
      .memoryWriteEvents()
      .find((item) => item.writeReason === "eval_write_miss_evidence");
    return {
      passed:
        event?.decision === "rejected" &&
        event.policyReason === "coordination_state" &&
        event.sessionId === "eval-write-miss-session",
      detail: "a refused write leaves a session-anchored event for a later miss judgement",
    };
  });

  measure("memory-granularity", () => {
    // The vague predecessor must stay readable after refinement; otherwise a
    // later "this record was too vague" judgement has nothing to point at.
    // A dedicated store keeps the 550 filler notes above out of this case's
    // candidate window: this case is about write/refine semantics, not recall
    // under load. The window is the real limit, not embeddings: search ranks at
    // most MAX_SEARCH_CANDIDATES (500) rows ordered by tier, so 500 tier-0
    // records hide every tier>=1 memory when FTS cannot match the query. That
    // starvation is a separate defect, not something this fixture should encode.
    const local = new NmgStore(join(directory, "nmg-granularity.sqlite"));
    try {
      const vague = local.remember({
        statement: "用户喜欢喝咖啡",
        nodeName: "Coffee intake limit",
        memoryType: "preference",
      });
      const precise = local.remember({
        statement: "用户每天不超过两杯咖啡，下午不喝",
        nodeName: "Coffee intake limit",
        memoryType: "preference",
      });
      local.applySupersession({
        newMemoryId: precise.memory.id,
        supersededMemoryId: vague.memory.id,
      });
      const found = local.search("咖啡因摄入限制", { maxTier: 3, limit: 5 });
      const predecessor = local.getMemory(vague.memory.id);
      return {
        passed:
          found.some((item) => item.memory.id === precise.memory.id) &&
          predecessor?.status === "superseded",
        detail: "a refined record supersedes the vague one, which stays readable",
      };
    } finally {
      local.close();
    }
  });
  // Candidate-window starvation. Search takes at most MAX_SEARCH_CANDIDATES
  // rows ordered by tier before it scores anything, so a deeper record becomes
  // invisible once the shallow tier alone reaches the window. The control pins
  // that the boundary is the window and not a broken search; the gap case
  // tracks the defect itself.
  const starvation = new NmgStore(join(directory, "nmg-starvation.sqlite"));
  try {
    // This fixture depends on the deeper record being the only lexical match, so
    // the filler vocabulary is declared here and checked against the query
    // tokens. A filler that shares a query token would make the case pass or
    // fail for a reason unrelated to the candidate window, and a comment alone
    // would not stop a later edit from breaking it silently.
    const fillerVocabulary = ["shallow", "note"];
    const fillerStatement = (index: number): string => `${fillerVocabulary.join(" ")} ${index}`;
    const query = "violet-heron-9182";
    const queryTokens = new Set(query.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
    // An empty token set would make `every` vacuously true and the guard would
    // report a pass without checking anything. A non-Latin query is exactly that
    // shape, and word-token disjointness is the wrong invariant for it anyway
    // (CJK rank is decided by 2-grams), so refuse to validate instead.
    const fillerIsDisjoint =
      queryTokens.size > 0 && fillerVocabulary.every((word) => !queryTokens.has(word));

    for (let index = 0; index < 499; index += 1) {
      starvation.remember({
        statement: fillerStatement(index),
        nodeName: `Shallow ${index}`,
        tier: 0,
      });
    }
    const deep = starvation.remember({
      statement: "The retired codename is violet-heron-9182",
      nodeName: "Retired codename",
      tier: 1,
    });
    const reachesDeep = (): boolean =>
      starvation
        .search(query, { maxTier: 3, limit: 5 })
        .some((item) => item.memory.id === deep.memory.id);

    measure("legacy-candidate-control", () => ({
      passed: fillerIsDisjoint && reachesDeep(),
      detail:
        queryTokens.size === 0
          ? "fixture invalid: the query has no tokens this check can compare against"
          : fillerIsDisjoint
            ? "499 shallow records leave the deeper record reachable"
            : "fixture invalid: the filler vocabulary shares a query token",
    }));

    starvation.remember({ statement: fillerStatement(499), nodeName: "Shallow 499", tier: 0 });

    // What this pins is the missing legacy candidate union, not the window on
    // its own. Legacy computes no ftsIds (retrieval.ts:2037), so it ranks a
    // tier-ordered 500-row window before scoring; hybrid rescues a lexical match
    // through its OR-union, which is why fix (2) turns this case green while the
    // window itself is unchanged. A zero-overlap paraphrase case would not be an
    // honest guard for the window here: with hashing vectors, unrelated fillers
    // score exactly 0 and are dropped by combinedScore > 0, so which of them
    // survive depends on collisions with the query tokens. Varying only the
    // filler wording moves the surviving count between 2 and 11 and the target's
    // rank between 1 and 10 (measured with 10 tier-0 fillers, limit 50), and the
    // same query passes at limit 5 for one filler text and fails for another.
    //
    // Fix constraints, so a later fix does not trade one bug for another:
    // - `m.tier = ?` in the deeper pass alone drops every shallower tier: `direct`
    //   is replaced each iteration (retrieval.ts:361) and feeds relations and seed
    //   activations (:370-380), so the deeper pass must union the opened tiers by
    //   memory id and keep the first-pass ordering.
    // - legacy, the default, gets neither hybrid's candidate clause nor its
    //   FTS-first ordering; giving legacy that ordering without vectors is the
    //   smaller change.
    measure(
      "legacy-candidate-union",
      () => {
        const reached = reachesDeep();
        return {
          passed: reached,
          detail: reached
            ? "legacy now reaches a lexical match past a full shallow window"
            : "500 shallow records hide the deeper record from legacy search",
        };
      },
      "legacy has no ftsIds union (retrieval.ts:2037) and ranks a tier-ordered 500-row window (retrieval.ts:95, :2140) before scoring",
    );
  } finally {
    starvation.close();
  }
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}

const report = {
  cases: results.length,
  passed: results.filter((result) => result.passed && !result.knownGap).length,
  knownGaps: results.filter((result) => result.knownGap).length,
  failures: results.filter((result) => !result.passed && !result.knownGap).length,
  unexpectedPasses: results.filter((result) => result.unexpectedPass).length,
  results,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.failures > 0 || report.unexpectedPasses > 0) process.exitCode = 1;

function measure(
  category: string,
  run: () => { passed: boolean; detail: string },
  knownGapReason?: string,
): void {
  const started = performance.now();
  const result = run();
  const knownGap = knownGapReason !== undefined && !result.passed;
  const unexpectedPass = knownGapReason !== undefined && result.passed;
  results.push({
    category,
    passed: result.passed,
    latencyMs: performance.now() - started,
    detail: knownGap ? `known gap: ${knownGapReason} — ${result.detail}` : result.detail,
    knownGap,
    unexpectedPass,
  });
}
