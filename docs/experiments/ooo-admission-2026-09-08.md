# OoO result admission probes — 2026-09-08

## Question and scope

Can coordinator-owned verification admit out-of-order results without releasing
dependent work on self-reports, duplicate delivery, or obsolete executions,
including work moving between independent processes?

These are research probes, not a product design decision. The small-trusted-core
idea is borrowed from the external verification approach described in
[CI/RCP §7.13](../design/ci-cd-and-quality.md#713-fixed-trusted-baseline-verification).
These probes do not import RCP or inherit its fixed-installation isolation. No
default NMG protocol, Task Board semantics, AG, or host-session behavior changes.

## Reproduce

```sh
node --experimental-strip-types --test evals/ooo-execution/admission.test.ts evals/ooo-execution/narrow-dispatch.test.ts evals/ooo-execution/multiprocess.test.ts
```

These checks run explicitly, outside the product test gate. They need Node with
TypeScript stripping and SQLite support; no model, network provider, or installed
daemon is needed. Local HTTP is bound to loopback. Each process test owns a fresh
temporary database and kills only its own children, including on failure.

## Local admission probe

[admission.ts](../../evals/ooo-execution/admission.ts) and its
[checks](../../evals/ooo-execution/admission.test.ts) use a copied fixed plan,
coordinator-owned synchronous predicates, instance/revision/input/attempt-bound
tickets, and a recheck before local acceptance. The DAG preflight uses Kahn's
algorithm, also present in memory-chain ordering, but rejects cycles and includes
isolated tasks initially. This is not a general scheduler.

Local Maps are sufficient only for this probe. They provide no cross-process
ownership, durable acceptance, or restart recovery.

## Multi-process probe

Implementation: [board-admission.ts](../../evals/ooo-execution/board-admission.ts).
Process bootstrap: [process-fixture.ts](../../evals/ooo-execution/process-fixture.ts).
Scenario: [multiprocess.test.ts](../../evals/ooo-execution/multiprocess.test.ts).

The driver starts a separate daemon process and two distinct worker processes.
The daemon uses the real `NmgService`, `httpHandler`, and Task Board SQLite store.
Workers discover handoffs and publish result entries through the unchanged board
JSON-RPC endpoint. IPC only controls fixture actions/timing; jobs and candidate
results travel over HTTP and the board. Workers never open SQLite.

The fixture adds a loopback `/admission` endpoint, not a registered product RPC.
Its claim operation wraps the existing `claimTaskBoardEntry` together with a
persisted generation increment in one SQLite transaction. Mutable task state,
input binding, accepted output, and the run identity survive in probe tables in
the same database. A fixed three-task arithmetic plan is the trusted policy;
there is no general persisted DAG editor or task revision migration.

Candidate data is read from the worker-attributed board result. A worker's
`passed` flag is ignored. Verification occurs before the commit transaction;
inside `BEGIN IMMEDIATE`, the authority rereads generation, owner, input binding,
board claim identity and lease validity. Accepted task outputs are immutable.
An identical current-attempt result is a duplicate, not another completion.

Board `put` owns its own transaction. The probe therefore commits acceptance and
board resolution together, then publishes decisions and newly eligible handoffs.
Durable task rows represent pending publications. On restart/retry, the single
authority drains them; if publication committed before its task link was saved,
it adopts the existing matching board entry. This is a small transactional-outbox
pattern, not atomic delivery or an exactly-once external side-effect guarantee.

Lease expiry uses an explicit coordinator test clock advanced by 61 seconds.
The real board claim implementation receives its supported `now` argument and
uses its normal 60-second minimum lease. This is deterministic expiry injection,
not a wall-clock latency or production wake-loop measurement. Verifier/commit
barriers are also fixture-only IPC controls, inaccessible through worker HTTP.

## Narrow dispatch scope

The shared [OoO integration module](../../src/integration/ooo-execution.ts) selects the first
eligible task in fixed plan order. The coordinator, not the worker, owns effect
classes, input revisions and external-event declarations. A bypass is permitted
only when the first pending task is explicitly waiting for its external event;
missing/stale input is not permission to skip it. At most one unresolved external
wait and one live claimed task are allowed. Only `read-only` and
`isolated-artifact` tasks qualify; unknown/shared-write effects fail closed.

Selection runs inside the same claim transaction as the board lease and attempt
increment. An external event becoming ready does not preempt an existing runner.
Input versions are checked at selection and final admission; a changed version
blocks reuse and dependent work, without an automatic plan rewrite. Probe revision
observations are trusted fixture signals, not an implemented file-change monitor.

The narrowed process fixture starts with A waiting for `interface-response`, B
ready, and C dependent on both. Only the selected task is published as a handoff.
Publishing waiting A first would occupy the existing board serial outstanding
slot and prevent B's claim; this was observed while integrating the rules. The
probe does not bypass or alter that board protocol. Waiting task state stays in
SQLite; coordinator events, expiry refresh, completion and restart reconsider
publication. Existing handoffs are still checked against authoritative eligibility
at claim time. The v3 snapshot-work policy binds the seeded plan and rejects older/different
probe databases; tests use fresh ones.

These constraints govern this fixed arithmetic executor's admission. They do not
sandbox arbitrary tools or prove a worker's declared effects honest.

## Observed result

- Combined run: **12 tests passed, 0 failed** (six local admission checks, four
  shared dispatch/snapshot checks and two composite multi-process scenarios).
- Both multi-process scenarios passed **5 additional consecutive runs**.
- TypeScript LSP: **0 diagnostics** across the five files changed for narrow dispatch.

The admission/recovery multi-process scenario verifies:

1. The driver, daemon and two workers have distinct PIDs.
2. A cannot be claimed before the coordinator's external event. Competing B claims
   produce one winner; duplicate concurrent submissions produce one acceptance.
   After the event, A's incorrect artifact is rejected despite `passed`.
3. B completes while A is held, and no C handoff is published.
4. An expired A submission is rejected even before reassignment. After another
   worker obtains generation 2, a generation-1 candidate already past verification
   is rejected at the final transaction.
5. The daemon is killed after A's acceptance commits but before C's handoff is
   published. Restart publishes C once; old A remains stale and new A is duplicate.
6. A worker publishes C's result and is killed. The daemon is also killed before
   submission. Another worker finds the retained result and submits it.
7. The daemon is killed after C's acceptance commits but before its decision is
   published. Restart repairs publication; two resubmissions are both duplicates.
   Final accepted outputs are A=4, B=6, C=10 with exactly three decision entries.

The second multi-process scenario makes A ready while B runs and verifies that A
cannot preempt or acquire a second slot. It changes B's input revision after
verification but before commit: B's result is stale, C is not released, and B is
not automatically retried against the changed input. Direct worker claim requests
cannot bypass unpublished dependencies. Unknown external events are rejected.
Pure-rule checks cover fixed priority, multiple waiters, unknown/shared effects,
missing inputs, and transitive invalidation.

## Live Pi SDK run — 2026-09-09

Selection, input budgets, work instructions and exact artifact checking live in
[`src/integration/ooo-execution.ts`](../../src/integration/ooo-execution.ts), without
Pi dependencies. The [Pi adapter](../../.pi/extensions/nmg/ooo-execution.ts) only
constructs a fresh Pi SDK session and returns its artifact/usage. SQLite lifecycle
and board transport remain in the research coordinator, not in the Pi adapter.
This is an explicit SDK integration, not a registered slash command or automatic
replacement of the user's current Pi session.

The adapter loads no extensions, skills, AGENTS files or prompt templates. The
only active tool is `read_snapshot`, which accepts no paths/commands and returns
captured task data. It checks the active tool list, requires a successful tool
read, limits reads/turns and aborts a model run after 45 seconds. Final text still
requires coordinator acceptance. Contexts are fresh per task, not migrated AGs.

Explicit live entrypoint (model authentication stays in Pi's normal credential
store; no credentials belong in commands or the report):

```sh
# Set PI_PROVIDER / PI_MODEL to the intended configured model first.
node --experimental-strip-types evals/ooo-execution/live-pi.ts --live
```

Unlike unit tests, this invokes a real provider. The default test commands never
run it. It snapshots bounded text from `README.md` and the AG runtime document,
starts an isolated coordinator and two Pi worker processes, and writes local
metadata to `.nmg/ooo-live/latest.json`. Live requests use wall-clock claim time;
clock/commit fault controls are disabled for this run. The external-ready event
is deliberately controlled by the driver after B, not inferred by the model.

Observed with `openai-codex/gpt-6-astra`, 2026-09-09 14:25 UTC:

| Order | Task                                             | Accepted artifact            | Snapshot reads | Tokens | Worker execution ms |
| ----- | ------------------------------------------------ | ---------------------------- | -------------- | ------ | ------------------- |
| 1     | B: extract AG document heading                   | Session Active Graph runtime | 1              | 3924   | 8367                |
| 2     | A: extract README heading after external release | Node Memory Graph (NMG)      | 1              | 4094   | 11289               |
| 3     | C: join accepted A/B values                      | both headings, A then B      | 1              | 358    | 7749                |

All three artifacts passed exact checks, across two worker PIDs and three distinct
Pi session IDs. The trace records B completing while A remained blocked, then
A and C completing after explicit release. The run used 8376 reported tokens.
It demonstrates real model/tool execution through the shared contract. It is
not a speedup measurement: there is no matched sequential baseline, and the
external wait was controlled. Reading/extracting headings is not code-task quality
validation or autonomous task planning.

Validation after integration: 12 probe tests passed and LSP reported zero
diagnostics across eight changed TypeScript files. Scoped `agent:verify` passed
TypeScript, build, documentation and glossary checks, but its full product suite
was **not green**: 1163 passed, one failed. The failure was the dirty-worktree
complexity gate reporting unrelated `tools/recall-instance-judge.ts:191` (`main`,
complexity 16, limit 15). That file was not modified for this experiment. The
verification run ID was `aea26373-f431-4fcb-811c-19fefcfb11ab`.

## S0 patch-proposal probe — 2026-09-09

The first bootstrap seed slice adds a bounded patch-artifact contract next to the
snapshot contract, per the [bootstrap design](../design/ooo-execution-bootstrap.md):

- [`src/integration/ooo-patch.ts`](../../src/integration/ooo-patch.ts) freezes a
  host-owned work envelope (task identity, attempt, instruction, file set,
  editable allowlist) into a detached, frozen structure with a SHA-256 digest.
  `patchCandidate()` validates a worker proposal against the HOST's frozen copy:
  whole-file replacements only, editable paths only, budgets enforced, no worker
  `passed` flag accepted. It returns candidate text; disk application, semantic
  verdicts, leases and cancellation remain separate.
- The Pi adapter gained `executePiPatch()`: same fresh-session, snapshot-only-tool
  surface, now returning an untrusted JSON proposal instead of a final answer.
- Five contract/safety tests cover identity/attempt/instruction binding, digest
  staleness, path traversal and Windows device aliasing, case collisions, exact
  structure and unchanged-file rejection. All 17 OoO tests pass; LSP reports zero
  diagnostics.
- Explicit live probes (`evals/ooo-execution/live-patch.ts --live`, frozen
  `src/integration/ooo-execution.ts` as the only editable file):
  `google/gemini-3.5-flash` returned a valid whole-file proposal on the first try
  (2,901 tokens, one read, two turns); the configured `openai-codex` provider hit
  its usage limit on repeated calls. With the user-authorized `B.AI` provider
  (`glm-5.3-flash`), four calls were observed: provider 429, malformed JSON
  rejected by `patchCandidate`, timeout, then a structurally valid proposal
  (3,131 tokens, one read, two turns). The JSON parse error does not establish
  the cause of the malformed output. Both successful probes passed only a
  substring check for `planIndex` present and `byId` absent; they did **not**
  prove that nothing else changed. The latest metadata is in
  `.nmg/ooo-live/patch-probe.json`; it is not evidence for the stricter verifier.

The proposal was discarded: nothing was written to the working tree, and no task
was marked accepted.

Follow-up repair restores the Pi normal-stop requirement and adds negative
coverage for error/aborted/length/tool-use termination after a successful read.
The probe's host-owned oracle compares the complete candidate with the exact
expected rename, rejecting unrelated edits. Each invocation has a unique task
identity and records start and finish separately.

The probe now checks candidate text in a fresh disposable directory with a fixed
TypeScript syntax-check subprocess, bounded output and timeout, an empty child
environment, a unique check ID, and a real terminal timestamp. It parses but
never executes candidate code. Exact content is rechecked afterward and the
owned directory is removed. Syntax checking is not type checking or behavioral
verification. A local negative test caught this Node installation returning zero
for `--check` on malformed TypeScript; the fixed checker uses TypeScript parser
diagnostics instead.

On 2026-09-10, one authorized `deepseek/deepseek-v4-flash` live call passed the
repaired exact-rename oracle and isolated syntax check: 3,367 tokens, one read,
two turns, 4,149 artifact bytes. The check ID was
`a71ad776-cf44-4a57-af93-4898770804e3`; the candidate was discarded, not promoted.
The latest `.nmg/ooo-live/patch-probe.json` identifies verifier
`exact-nextTask-rename-v1`. Twenty targeted OoO tests passed and LSP was clean.
Scoped verification `b91fae49-c8f6-46f3-b42c-6dea37631867` passed type checking,
build and docs; product tests were 1,171 passed / one failed, with only the
unrelated `tools/recall-instance-judge.ts:191` complexity violation reported.

S0 remains in progress. A follow-up coordinator slice persists host-issued check
identity, input digest, attempt, owner and check lease in SQLite. Issuing a new
check fences the old one; cancellation and terminal admission use the existing
immediate transaction boundary. Duplicate terminal evidence is inert across
reopen. Stale input, expired leases and cancelled attempts cannot release A;
undecidable results retain the wait. A failed check can release a repair task,
but accepting check evidence never accepts that task or releases C. The legacy
fixture release method refuses waits managed by this protocol.

A local integration test binds a real syntax-check subprocess to a coordinator
check ticket and admits its terminal result. This is host-trusted plumbing, not
authenticated worker proof. It does not yet demonstrate the complete live
patch-worker A/B/C cycle, check-process recovery, or candidate promotion. The
fixed syntax checker remains a probe-specific host implementation.

The coordinator now also hosts patch tasks as first-class work items in the same
SQLite plan, rather than as a side channel:

- A patch task's frozen input (instruction, file set, editable allowlist) belongs
  to the host; the worker receives only a digest plus the readable snapshot.
- The host verifier is fixed at plan construction. A submitted proposal must
  first satisfy the frozen contract, then the host check; a worker `passed` field
  or `verdict` is rejected as an unknown field rather than trusted.
- Only an accepted candidate becomes the task's output, and dependents bind to
  the host-derived candidate text. Rejected proposals accept nothing, and a
  reissued attempt fences the previous worker's artifact by digest.
- A rejected attempt keeps its claim, matching the existing snapshot semantics:
  the same worker may correct it, and only lease expiry plus reissue (or a new
  attempt) supersedes it.

Twenty-eight targeted tests pass across the deterministic suites. S0's four exit
checks now have separate evidence: a real model patch under an exact oracle, a
candidate-directory syntax check, a bound external check event, and rejection of
stale or unverified artifacts. They have still not run as one live A/B/C cycle,
so this reports 引导 (bootstrap) evidence, not 自举.

## S1 round 1 — 2026-09-10

The first real A/B/C round ran through `evals/ooo-execution/live-cycle.ts --live` on
`deepseek/deepseek-v4-flash`, with the round baseline frozen to seven uncommitted
OoO files and one fixed check (the protocol regression test file pair). The host
started that check as a background process bound to a coordinator check ticket,
and every submission was verified by re-running the check in a disposable git
worktree of the frozen revision with a `node_modules` junction. The working tree
was never modified.

| Time (UTC)   | Step           | Detail                                                |
| ------------ | -------------- | ----------------------------------------------------- |
| 05:57:15.856 | check issued   | `1bd07fbe-035d-4780-a229-544cf10eafcc`                |
| 05:57:15.859 | B claimed      | attempt 1, digest `5d9b22626e35`                      |
| 05:57:19.946 | B accepted     | conclusion `no-change-needed`                         |
| 05:57:19.949 | check terminal | real check passed                                     |
| 05:57:19.950 | A dispatched   | coordinator selected A only after that event          |
| 05:57:27.338 | A attempt 1    | rejected: model returned prose, not the JSON envelope |
| 05:57:30.947 | A accepted     | attempt 2, conclusion `no-change-needed`              |
| 05:57:33.348 | composed check | passed (composed candidate is the baseline)           |
| 05:57:37.123 | C accepted     | conclusion `promote-candidate`                        |

The overlap is real: B completed 3.2 seconds before the background check did,
and A was not selectable while the check was unresolved. This is the round's
first conclusion, **legal out-of-order execution with no useful development
change**: all three tasks concluded that no change was justified, so the
composed candidate is byte-identical to the baseline and the round produced no
patch for a later round to adopt. It is not 自举.

Two failure modes the contract caught and one hole it did not:

- Both A and B first answered with Markdown prose instead of the envelope; the
  shared contract rejected it, and the host's reissued attempt reported the
  rejection back to the worker, after which the JSON form arrived.
- Conclusion evidence is only checked for being non-empty. B's claim that the
  existing tests already cover the six named cases was accepted on its prose,
  not verified. The design requires a checkable basis for a no-change
  conclusion, so this is a real gap the round exposed.

## S1 round 2 — 2026-09-10

Round 1 ended with a hole: a no-change conclusion was accepted for having non-empty
text. Round 2 first closed that hole, then ran four live rounds that each exposed a
different real defect in the round machinery itself. All runs used
`deepseek/deepseek-v4-flash`, the revision and check command round 1 used, and the
working tree was never modified.

**The contract changes the runs forced** (all in `evals/ooo-execution/cycle.ts`,
`src/integration/ooo-patch.ts`, `.pi/extensions/nmg/ooo-execution.ts`):

| Observed failure                                                                     | Change                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Non-empty prose accepted as a no-change basis                                        | A conclusion accepted only when every host-frozen case resolves to a citation whose exact title exists in the frozen sources; an invented, misquoted or missing citation fails closed. `cannot-complete` is a blocked report, so it stops the round instead of unlocking A or C. |
| Model replied with Markdown analysis instead of the envelope (B and A, twice)        | The prompt now pre-fills the real digest, the editable-path list and both JSON shapes; since then no run has replied with prose.                                                                                                                                                 |
| Model exceeded its output length and the guard rejected a truncated answer           | A worker that fails or returns truncated output is a recorded failed attempt with its reason, not a crashed round, and is never auto-retried.                                                                                                                                    |
| The host rejected B for a rule it never stated (a hidden "longest word" title token) | Case rules are now explicit host-frozen `{name, token}` pairs printed in the instruction.                                                                                                                                                                                        |
| A rejected submission was invisible: no reason reached the report                    | The driver records the shared contract's own parse error and keeps rejected artifacts (bounded) under `.nmg/ooo-live/rejections.json`.                                                                                                                                           |

**What the live rounds measured**

| Round | B's outcome                                           | A's outcome                       | Why                                                                               |
| ----- | ----------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------- |
| 1     | accepted, `no-change-needed`                          | accepted, `no-change-needed`      | Both conclusions carried no checkable basis; the round produced no patch.         |
| 2     | accepted, `no-change-needed`                          | rejected: prose, not the envelope | B's six citations all resolved to real titles in the frozen test file.            |
| 3     | rejected: worker hit its output length                | not reached                       | The truncation guard fired; the run produced no report at all.                    |
| 4     | rejected: real check failed in the candidate worktree | not reached                       | B's added test asserted behavior the protocol does not have. The check caught it. |

Rounds 2 and 4 again show real overlap: the background check finished while B was
still working, A was selectable only after the terminal event, and nothing was
preempted. The check's own result was `accept` in every round.

**State after round 2.** No round has produced a useful change that a later round
could adopt, so S1's exit condition is still unmet and this is not 自举. The round
machinery did reject every artifact that did not meet the frozen contract, including
one that genuinely failed the check, which is what the S1 gate was built to test.

**Open problem the runs exposed.** Resolving a case to a test _title_ proves a title
exists, not that the test asserts the case. Three of round 2's six tokens
(`cancellation`, `restart`, `never`, `escap`) appear in no frozen title, yet the
frozen suite does exercise cancellation and expiry under other wording. Asking a
worker to satisfy a title token therefore invites redundant tests — round 4's B wrote
one and it failed. Proving a case is _uncovered_ needs a negative control (break the
behavior and see the suite stay green), not a title match.

The multi-process check validates one authoritative daemon with independent,
cooperative worker processes. It is not a multi-daemon/HA or multi-device test.
SQLite state and predicates are coordinator-owned, but this is not an adversarial
sandbox: board author IDs are not independently authenticated worker identities,
and the shared bearer credential is not a per-worker ACL. A malicious worker
with database access or arbitrary standard board mutation is outside the model.
Tickets and hashes bind execution/content; they are not credentials, signatures,
or proofs that a verifier is correct. Verification is restricted to fixed arithmetic and exact snapshot-text predicates,
not a general code-task evaluator.

Task rows persist, but board entries retain their ordinary 24-hour TTL. Recovery
beyond that horizon, long-term retention, lease renewal, cancellation, dynamic
plan changes, pagination beyond this tiny board, autonomous wake/re-poll behavior,
and external-side-effect idempotency are not demonstrated. Notification repair
runs at explicit fixture/coordinator boundaries rather than a production background
reconciler.

The deterministic fault tests use simulated workers; the separate live run uses

## S1 round 3 — 2026-09-11

Round 2's open problem was that resolving a case to a test title proves nothing about
whether the test asserts the case. Round 3 replaced that rule with a mutation proof and
ran six live rounds (all `deepseek/deepseek-v4-flash`, revision `6f5504d6`) that moved
the loop from "no checkable basis" to "a host-verified useful change".

**The host now proves the gap before asking for anything.**

`evals/ooo-execution/mutation-probe.ts` runs host-owned single-substitution faults of
`src/integration/ooo-check.ts` through the real fixed check. Five survived the frozen
suite at the start of round 3, which is evidence that no test detects those faults:

| Mutant                                     | Status at round start |
| ------------------------------------------ | --------------------- |
| `sameCheck-ignores-attempt`                | survived              |
| `sameCheck-ignores-expiry`                 | survived              |
| `sameCheck-ignores-digest`                 | survived              |
| `checkResultValid-accepts-unknown-outcome` | survived              |
| `checkResultValid-log-bound-off-by-one`    | survived              |

`cycle.ts` now refuses to start a round whose declared mutant does not survive, so the
premise is a precondition, not an assumption; each declared mutant was re-proved
(1.6–9.2 s each) before every model call. Acceptance adopted the published retention
rule for generated tests: a patch is accepted only when it passes on the intact
implementation **and** fails on at least one declared mutant. A no-change conclusion is
rejected outright once a mutant has survived, because the host's own evidence
contradicts it.

**Live round outcomes**

| Round | B                                                                   | A               | Note                                                                                                                                                      |
| ----- | ------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1   | rejected: intact check failed                                       | not reached     | The worker's added test asserted behavior the protocol does not have, and it had no way to run the suite.                                                 |
| 3.2   | rejected: prose reply after a successful self-check                 | not reached     | The check tool worked (1 run, "the check accepts my proposal"), then the worker narrated instead of returning the artifact.                               |
| 3.3   | rejected: intact check failed                                       | not reached     | Three self-checks used; the worker reported "11 of 12 passing" and corrected the last assertion.                                                          |
| 3.4   | rejected: the host's title-token rule                               | not reached     | Proven-gap mode was declared but the token rule still ran and rejected a candidate; the intent was in a comment, not enforced.                            |
| 3.5   | rejected: prose, and the worker stated it could not see the mutants | not reached     | The instruction claimed the proved faults were listed, but `cycle.ts` only printed case rules. A requirement the worker cannot read is not a requirement. |
| 3.6   | **accepted: passes intact, kills all five declared mutants**        | rejected: prose | Composed candidate changes exactly one file, `evals/ooo-execution/check-events.test.ts`.                                                                  |

Round 3.6 is the first host-verified useful change this line has produced: the frozen
suite went from detecting none of five faults to detecting all five. It is **not yet
adopted**, so S1's exit condition is still unmet: the round requires A and B to be
accepted before C may promote, and A has now replied with prose in four of six rounds.

**Capabilities these rounds forced** (each from an observed failure, not speculation):

- `.pi/extensions/nmg/ooo-execution.ts` gained a host-provided, host-bounded
  `run_check` tool: the worker may run the round's own fixed check on proposed files
  (validated through the same shared contract as a submission, `maxRuns` host-frozen),
  so it can verify its own patch. Without it every added test was written blind.
- The tool result and the system prompt restate the artifact shape at the point of
  decision, after a passing self-check made the worker switch to narrating.
- `cycle.ts` prints declared mutants and case rules into the task instruction, which is
  digest-bound, so every acceptance rule is readable by the worker.
- Rejection reasons and accepted candidates are persisted; without that, a useful
  product existed only inside the process that produced it. Round 3.6's accepted text
  was lost to this gap and is only described by its mutant kills.

**Still missing for the field's evidence standard**: repeated trials on a frozen task
set, a held-out check, and any measurement of time or tokens saved. What round 3 does
show is that a real external wait can carry an independent task to a host-verified,
provably useful result while the waiting task is still blocked.

## S1 round 4 — 2026-09-11

This round landed the measurement contract and the downstream-pushback machinery, then ran
live once. The mechanisms are covered by 58 offline tests; the live run is the first one
that reports real cost.

**Measured (deepseek-v4-flash, revision `90178712`, first round with these fields):**

| Quantity             | Value                                                           |
| -------------------- | --------------------------------------------------------------- |
| B worker             | 78,172 tokens, 4 turns, 2 self-checks, 37.0 s                   |
| A worker             | 38,859 tokens, 3 turns, 1 self-check, 6.0 s                     |
| Hidden external wait | 1,602 ms (the check `accept`ed inside B's run)                  |
| Host check work      | 13 check runs, 21,903 ms                                        |
| Reopens              | 0 (C never ran)                                                 |
| Verdict              | B accepted (kills all five declared mutants), A rejected: prose |

**What the numbers say.** The round cost 117k worker tokens, and the host spent 21.9 s of
local check time to verify it — 13.7× the 1.6 s of external wait it hid. The free class of
speculation is therefore worth doing (it is already happening: all five
`mutant-survived-baseline` proofs, ~7.7 s, completed inside B's 37 s model call instead of
before the round), but "load the wait by guessing" would have been noise beside verification
cost. Any future payoff claim must be stated against this ledger, not against the wait alone.

**Class-A effect is visible in the timeline.** Premise proofs at 13:05:33.3–13:05:39.4, B's
model call until 13:06:12.2, check terminal at 13:05:33.3: the required host work moved off
the pre-round critical path and the external wait stopped being the bottleneck.

**A's failure is now the stable blocker, and the literature explains it better than "framing".** A's
role is to decide whether anything in its file is at fault; it has answered in prose in five of
seven rounds, including after a passing self-check. B's role states a target to hit, and B has
emitted valid JSON whenever the requirement was stated that way. The published explanations are
not "the wording of the role": explicit reasoning degrades instruction-following
([When Thinking Fails](https://huggingface.co/papers/2505.11423)), stacked constraints degrade
it non-linearly and should be compiled into fewer non-overlapping ones
([Instruction Stacking Collapse](https://arxiv.org/html/2608.02639v1)), and format cost is paid
from spare capacity, which A's heavier task has less of
([Capacity, Not Format](https://arxiv.org/html/2606.09410)). Rewriting the persona is not
supported as a remedy ([Personas in System Prompts](https://doi.org/10.18653/v1/2024.findings-emnlp.888)).
The architectural fix the same literature points at is to stop asking in the prompt and constrain
at sampling: this repository's SDK already exposes `Tool.constrainedSampling` with
`{type:"json_schema", strict}` through `defineTool`, so the artifact can become a bounded tool
call whose schema is the contract, with host validation kept because constrained decoding removes
syntax failures only, not structural or semantic ones
([Structured Output Control](https://arxiv.org/html/2606.09395v1)). We also restated the same format
rule in four places (the patch prompt, the system prompt, the check tool result, and the pushback
note), which is the stacking pattern this literature says to remove.

**Pushback path status.** The declared-precondition reopen, the mid-attempt pushback tool,
and the bounded reopen loop all have deterministic tests, but no live round has exercised
them yet: the round ends at A before C's requirements are ever evaluated. Their live evidence
is outstanding.

## S1 round 5 — 2026-09-11

The first round where **all three tasks were accepted** (`rejections` empty), after steps 1–2 of
the format work: the artifact is delivered through a `submit_artifact` tool whose schema is the
contract and which requests provider-side constrained sampling, and the prompt states the format
constraint once instead of four times.

| Quantity             | Value                                                                |
| -------------------- | -------------------------------------------------------------------- |
| B worker             | 67,513 tokens, 4 turns, 1 self-check, 60.6 s                         |
| A worker             | 96,601 tokens, 6 turns, 2 self-checks, 12.8 s                        |
| C worker             | 41,920 tokens, 4 turns, 1 self-check, 7.5 s                          |
| Hidden external wait | 1,577 ms                                                             |
| Host check work      | 15 runs, 23,317 ms                                                   |
| Reopens              | 0                                                                    |
| Verdicts             | B accepted (kills all five declared mutants), A accepted, C accepted |

**The prose failure class is gone.** A answered with a `no-change-needed` conclusion carrying a
resolved citation, after having answered in prose in five of the previous seven rounds. B and C
also delivered through the tool. The three `pi turn error: This operation was aborted` lines in
the run are the intended path: the tool aborts the session once an artifact is recorded, so the
worker cannot keep talking (or contradicting) after submitting, and the host never reads text as
an answer.

**Accepted artifact** (the round's product, persisted under `.nmg/ooo-live/`):
`evals/ooo-execution/check-events.test.ts`, 7,350 bytes, adding ten tests and removing none
(4 → 14 test titles). It passes on the intact implementation and fails on all five
previously-undetected mutants. Adoption into the next round's baseline is a human promotion and
had not happened when this was recorded, so S1's exit condition is met except for that last step.

**Cost, honestly.** The round spent 206k worker tokens and 23.3 s of host verification against a
1.6 s external wait, so the ledger still says verification dominates. A is now the most expensive
worker (96.6k tokens over six turns with two self-checks) even though its answer was a no-change
conclusion; that is a concrete target for the next cost investigation, not a scheduling issue.

**Not yet exercised live**: the downstream-pushback edge (declared preconditions, mid-attempt
pushback, reopen) still has only deterministic tests, because C's declared requirement was
satisfied on the first attempt and no reopen was needed.

## S2 slice 2: the round logs itself, and replays without a model — 2026-09-11

The durable-execution split this repository already uses elsewhere is "deterministic
orchestration, uncertain work recorded as an activity result". A model call is such an
activity, so replaying a round must not call a model again, and the verdicts must follow
from the frozen inputs plus the recorded answers.

`evals/ooo-execution/round-log.ts` adds the record: a JSON-lines event stream (plan, check
issued/terminal, claim, artifact or worker failure, pushback, verdict, each mutant outcome,
reopen, terminal state) plus `recordedWorker(events)`, which answers from the log instead of
from a model, and `compareTerminal(recorded, replayed)`.

**Replay found a real non-determinism.** The first replay did not reproduce the round: A's
frozen instruction embedded the check's `checkId`, which was a fresh `randomUUID()` per
issue, so every round's digest differed and the host refused the recorded artifact as
`stale patch digest`. That is the correct refusal — the envelope really was different. The
fix belongs in the coordinator: a check's identity is now derived from the round's own state
(`digest([taskId, attempt])`, scoped to the store, with `runId` still the discriminator), so
the same round produces the same envelopes. Nothing else in the round was non-deterministic:
timestamps appear in events but not in digests, and attempts are part of both.

| Property                    | Evidence (`evals/ooo-execution/replay.test.ts`, 5 tests)                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| replay reproduces the round | a logged A/B/C round replays to an empty `compareTerminal`, with exactly the three recorded attempts and no model call |
| the log is not trusted      | an artifact edited in the log completes the round with a _different_ verdict: the host re-checks it                    |
| truncation is detected      | a missing recorded attempt is reported as a recorded worker failure, and the terminal state diverges at that task      |
| a malformed log is refused  | not-JSON, an unknown kind, and a missing timestamp each fail the read instead of being skipped                         |
| replay is still a round     | a faithfully replayed artifact the host refuses is still rejected                                                      |

The live cycle writes `.nmg/ooo-live/round.jsonl`, so a real round can be re-verified later
by re-running the host checks against its recorded answers — the ~200k worker tokens of a
round are not needed to re-check what it produced. What replay does **not** establish: that a
_new_ log line cannot change the verdict for a reason the host cannot see (only the host's
own checks are re-derived), and that the log is tamper-evident (it is not: nothing
chains the lines, and a reader that trusted it would be trusting an ordinary file).

## S2 slice 1: recovery, explicit termination, cancellation — 2026-09-11

Offline only; no model calls. S2's exit criterion is "after fault injection: no duplicate
completion, no wrong unblock, no infinite wait; a restart recovers or terminates
explicitly", and this slice covers it with 8 deterministic tests in
`evals/ooo-execution/recovery.test.ts`, plus two coordinator capabilities the criterion
needed:

| Injected fault                              | Observed behaviour                                                                                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| coordinator crashes with a live claim       | the successor does not steal the claim, the holder's artifact is accepted, resubmission is `duplicate`                    |
| a claim retired by a withdraw, then a crash | the old ticket's artifact is `stale`; only the surviving generation can complete                                          |
| the claim lease lapses                      | the resume is a **new** generation (`attempt + 1`), and the retired ticket is `stale`                                     |
| a check never reports                       | `abandonCheck` records `undecidable` once, is idempotent, and a forged ticket cannot end the wait                         |
| the round is cancelled                      | `next()`/`claim()`/`issueCheck()`/`externalReady()` all refuse, a late artifact is `stale`, the reason survives a restart |
| the store predates a new column             | the additive migration keeps the claim, the attempt and the ticket identity                                               |

The two new coordinator capabilities are `cancel(reason)` (round-level, fencing every task
by advancing its attempt and withdrawing outstanding handoffs) and `abandonCheck(ticket,
reason)` (an explicit terminal decision for a wait that would otherwise only end by lease
expiry). Both are idempotent and bound to the issued ticket.

What this slice does **not** show: log-and-replay. The state lives in SQLite and a
successor continues from it, but the model calls are not recorded as replayable activities,
so a round cannot be reconstructed from its log. Orphan-process behaviour under a real
multi-process cancellation is also untested — the cancellation is verified at the
coordinator level, not against live worker processes.

## S1 round 6 — 2026-09-11 (the promoted baseline, with scoped snapshots)

Command: `PI_PROVIDER=deepseek PI_MODEL=deepseek-v4-flash live-cycle --live`. Revision
`90178712`. This round runs **on the round-5 promoted baseline**, which is what makes the
S1 exit condition observable rather than asserted.

| Worker | Tokens  | Turns | Self-checks | cacheRead | Time    |
| ------ | ------- | ----- | ----------- | --------- | ------- |
| B      | 177,503 | 7     | 1           | 132,352   | 100.5 s |
| A      | 32,547  | 4     | 1           | 16,768    | 7.1 s   |
| C      | 33,530  | 4     | 1           | 16,896    | 8.2 s   |

Hidden external wait 1,985 ms; 7 host check runs totalling 16,226 ms; `reopens` 0;
`rejections` **0**; verdicts B accepted, A accepted, C accepted; composed verdict accept.

**The round did real work.** Earlier rounds' declared mutants were all killed by the
promoted baseline, so the round declared a fault the baseline still missed:
`reopen-keeps-attempt` (the reopen path clearing the row while keeping the attempt, so the
fencing generation is never advanced). The host proved the gap before the round
(`mutant-survived-baseline`), and B's accepted patch closed it. Re-measured independently
with the same verification library in one command:

| `reopen-keeps-attempt` against                       | Verdict                        |
| ---------------------------------------------------- | ------------------------------ |
| current baseline (round-5 promotion)                 | survives — the gap is real     |
| round-6 candidate (9,450 bytes, 16 titles, +2 tests) | **killed** — the gap is closed |
| round-6 candidate on the intact implementation       | accept                         |

### Three structural fixes this round needed

The failures were no longer prose; each one exposed a place where the host offered the
worker an answer the host would reject.

1. **Scoped snapshot.** The whole 59,874-byte baseline was re-sent on every model turn.
   The readable subset is now host-declared and digest-bound (`visible`), an editable path
   can never be hidden, and what is frozen-but-not-shown is named in the prompt, so
   narrowing the view is never a hidden rule. Hidden here: `ooo-patch.ts`,
   `ooo-execution.ts` (16.7 KB of the 59.9 KB).
2. **Admitted answer channel.** A round answered `kind: "no-change"` with a prose
   `conclusion` because the envelope checked only that fields were _present_, and a later
   round answered `promote-candidate` on a task that must return files because the schema
   offered every kind. The tool schema now derives its enum from the task's frozen
   acceptance rule (`admittedConclusions`), and the discriminator is the tool's own shape.
3. **The ticket carries the frozen work.** The ticket's patch payload hand-listed fields,
   so it silently omitted each newly added one and the driver disagreed with the
   coordinator about the digest — twice. It now carries the frozen work itself, the driver
   rebuilds from the ticket, and a mismatch error names the differing fields.

Two of these bugs were caught by the digest rather than by a test: the readable subset
sorted its default in input key order, and the admitted set sorted only the explicit
branch. Both made a digest depend on declaration order.

### Cost, and what it does and does not show

The measurement contract now records provider cache accounting, and the provider does
cache: 132 KB of B's 177 KB and about half of A's and C's tokens are `cacheRead`. Any
statement about worker cost that ignores this is wrong in the worker's favour. A's total
fell from 96,601 tokens over 6 turns (round 5) to 32,547 over 4 turns, and the scoped
snapshot removes 28% of the per-turn context; turns differ between the rounds, so this is
not a clean per-turn measurement. A simple "tokens ≈ turns × snapshot" model fits round 5
and does not fit round 6, so the per-turn accounting is left as an open question rather
than a conclusion. Host verification still dominates the external wait (16.2 s against
2.0 s), as in every round so far.

### Promotion (round 6)

The round-6 candidate was promoted with explicit human approval; the previous version is kept
at `.nmg/ooo-live/baseline-pre-promotion/check-events.test.ts.round5-promoted`. Re-measured on
the promoted tree rather than trusted from the round's own verdict:

| Mutant                         | Before promotion | After promotion       |
| ------------------------------ | ---------------- | --------------------- |
| `reopen-keeps-attempt`         | **survived**     | **rejected (killed)** |
| `submit-skips-fencing-recheck` | killed           | killed                |
| the six round-2/3 mutants      | killed           | killed                |

The two fixed check files now run 21 tests (was 19) and the offline suite 78. So the promoted
baseline is the round-5 product with the round-6 product applied on top of it, and each
promotion is accepted only on a re-measurement that the new baseline detects what the old one
missed.

## S1 exit: promotion — 2026-09-11

The accepted candidate from round 5 (`evals/ooo-execution/check-events.test.ts`) was promoted to
the working baseline with explicit human approval, and the previous version was kept at
`.nmg/ooo-live/baseline-pre-promotion/check-events.test.ts` for rollback. Promotion is not
accepted on the round's own verdict: the promoted baseline was re-measured independently.

| Mutant                                     | Before promotion | After promotion       |
| ------------------------------------------ | ---------------- | --------------------- |
| `sameCheck-ignores-attempt`                | survived         | **rejected (killed)** |
| `sameCheck-ignores-expiry`                 | survived         | **rejected (killed)** |
| `sameCheck-ignores-digest`                 | survived         | **rejected (killed)** |
| `checkResultValid-accepts-unknown-outcome` | survived         | **rejected (killed)** |
| `checkResultValid-log-bound-off-by-one`    | survived         | **rejected (killed)** |
| `sameCheck-loose-owner`                    | killed           | killed                |

`evals/ooo-execution/mutation-probe.ts` against the promoted tree reports `baseline: accept` and a
failed check for all six mutants, so the suite now detects every fault it previously missed. The
new baseline runs green (19 tests across the two fixed check files; 70 tests in the whole offline
suite).

This is the first change in this line that was produced by the round, verified by the host, and
then _used by the next baseline_ — the S1 exit condition. What it does not show: that the loop
gains speed or quality, that it works without human promotion, or that any of this transfers
beyond this repository's own check protocol.

## Trust boundary and remaining proof

real Pi SDK agents. Neither exercises background tool continuation, AG context
restoration or same-session safe-point activation. This establishes restricted
multi-process admission and a real-agent execution adapter, not a general Agent
OoO scheduler or a measured speedup. HA/MGR scoring is not required for these
probes.
