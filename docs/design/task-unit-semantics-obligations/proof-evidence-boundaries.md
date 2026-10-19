# Where a proof lives: two evidence bases, and neither stands for the other

[中文](proof-evidence-boundaries.zh-CN.md) · [Terms used](proof-evidence-boundaries.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## Where a proof lives: two evidence bases, and neither stands for the other

The ledger draws from two evidence bases. Their storage and call paths differ, so evidence transfers only when a test exercises the path named by the claim.

**Product runtime.** Its run tables are `task_run_manifest`, `task_run_tasks` and `task_run_facts` in `src/core/store/base.ts`; `src/integration/task-coordinator.ts` owns managed-write fences and cancellation; `src/integration/ooo-session-facts.ts` and `src/integration/ooo-session-mechanism.ts` provide the session mechanism; an adapter talks to its host SDK. Product-path evidence includes `tests/core/store/task-runs.test.ts`, `tests/core/store/schema.test.ts`, `tests/cli/task-run-surface.test.ts` (through the daemon), `tests/integration/ooo-managed-write.test.ts`, `tests/integration/ooo-managed-adopt.test.ts` and the session-mechanism tests. A test name alone is not enough: inspect what it invokes and asserts.

**Research instrument.** `BoardAdmission` and its `ooo_probe_*` tables in `src/integration/ooo-board.ts`, with `task-semantics.ts`, `task-semantics-model.ts`, `task-semantics-interleavings.ts` and `task-advisers.ts`, are exercised by `evals/ooo-execution/**` and tests that construct the instrument directly. Those tests can prove its storage semantics and the offline model; they do not prove product runtime behavior merely because a filename says “board” or “ordinary.” The product path does not import these research entry points through `src/cli/` or `.pi/`.

Use import searches as a locator, not as proof:

```sh
rg -n 'ooo-board|task-semantics|ooo-advisers' src/cli/ .pi/
rg -n 'BoardAdmission' tests/integration/
```

A test may reach a research type or fixture while asserting on product code, so classify its assertion, not just its imports. The design does not require merging the two stores or making the research instrument authoritative for product behavior; no row should imply that migration.
