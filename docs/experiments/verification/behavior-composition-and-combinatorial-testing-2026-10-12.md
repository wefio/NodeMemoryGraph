# Behavioral composition tests: minimal contracts, bounded exploration and NIST algorithm selection (2026-10-12)

[简体中文](behavior-composition-and-combinatorial-testing-2026-10-12.zh-CN.md) · [Terms used](behavior-composition-and-combinatorial-testing-2026-10-12.terms.yaml)

## Scope and evidence status

This record asks how to extract common semantic fragments from existing tests so an LLM can compose, explore and propose reproducible counterexamples in a bounded environment, without making generated tests the source of correctness.

It contains a literature review, repository observations, the [first local extraction](#first-pilot-results), [second cross-family composition](#second-pilot-results), [third state-boundary composition](#third-boundary-composition-results), [product-test structural screen](#broader-structural-screen-2026-10-13) and [existing-node path implementation](#existing-node-path-implementation-results-2026-10-13). It does not contain algorithm measurements or a repository-wide migration result. Unimplemented portions remain pilot proposals. Implementation choices belong to design and decision owners; this research changes no product contract, test classification, blocking check or acceptance standard. Document authority follows the [ownership boundary](../../README.md#ownership-and-authority).

Initial repository observations use `1787310a2a9fda2f285f6be5c2138c87ebe69b04`; each pilot states its own baseline and measurement scope. This research did not run IPOG, SCA or a candidate-test generator, or measure NMG's natural-defect detection rate, speed or maintenance cost. Source versions and text-review limits are listed under [sources and unverified items](#sources-and-unverified-items).

## Selection conclusion

1. Start with common semantic fragments, not a requirement to operatorize every test or reach indivisible granularity. Ordinary functions, types and assertions suffice for the first composition.
2. Correctness rests on existing product contracts and independently checked domain properties. A small stable set of rules can constrain exploration, but mutual test success or model votes do not establish that those rules are valid.
3. Keep a mixed suite: named regressions, composable behaviors, parameter-combination gap filling, bounded state exploration and real-boundary tests have separate jobs.
4. ACTS Advanced IPOG is the first candidate for parameter-combination gaps. Compare IPOG-F on the same model before selecting it. Basic SCA and ordered t-way cover order only within their definitions; neither alone accepts NMG state behavior.
5. Do not build a general DSL, generator platform or whole-repository formal model yet. Use one real test family to examine reuse, omission risk and traceability compatibility before expanding.

## Composition expression and composition coverage

**Composition expression** asks how to avoid repeated preparation and actions. **Composition coverage** asks which inputs, states, event orders and boundaries actually execute. Extracting a function does not automatically increase coverage; fewer tests do not automatically preserve defect detection.

A fragment can mean “create work and have A claim it,” “submit this attempt's artifact” or “judge under another identity.” It need not turn every field assignment or API call into an action. Further decomposition follows actual reuse and observation needs, not a predetermined atomic granularity.

Resource composition is different from behavior composition. The [composable test runtime](../../design/ci-cd-and-quality/composable-test-runtime.md) acquires and releases workspaces, databases and daemons; behavioral fragments own domain actions, result references and observable state. Reusing the former does not implement the latter.

### Minimal composition contract

Each reused fragment must expose these semantics to callers; they need not all become metadata fields or a uniform interface:

| Semantic concern | What the caller must know | Task Board example |
| --- | --- | --- |
| Conditions and inputs | Required state; source of identities, clocks, objects and parameters | Entry open; submitter identity; claim still live |
| Result references | The object, attempt or artifact a result identifies for later actions | Entry ID, attempt and digest, not a hidden “last result” |
| State changes | Relevant state an action can change | Claim holder, artifact, judgment and attempt |
| Protected state | Existing state an unrelated action must not change | Renewing a live claim does not discard its submitted artifact |
| Observation and failure | Where intermediate state is observed; how expected refusal is checked as a result | Judgment absent after submission; related state unchanged after refusal |

A composite may fuse implementation but must not close observation seams needed by a test. Pass identities, references and clocks explicitly; share helpers only when actual consumers justify it. Rejection paths use a raw action capable of making the attempt, not a convenience helper that admits only success.

## Correctness foundations and LLM exploration boundaries

### What a small kernel protects

The pilot separates three things:

- **Product rules:** protected behavior, domain, assumptions and exceptions stay with existing owners; for example, a judgment must bind the artifact it judges.
- **Generation and execution mechanisms:** input construction, reference management, budgets, observations, replay and counterexample shrinking. These can be tested and cross-checked.
- **Candidate properties:** new relationships or anomaly explanations proposed by an LLM. They start as research questions, not automatically as product rules.

The [verification traceability workflow](../../../skills/verification-traceability/SKILL.md) owns assertion, domain and evidence-strength requirements. This record creates no competing assertion ledger. The first pilot protects only the domain properties it needs, not a complete axiom set or whole-repository correctness proof.

Self-checks, differential checks, property tests and cross-test validation are permitted. The prohibited acceptance cycle is a candidate changing the rules, domain, judge and evidence, then approving itself with its own green result. Two matching models, self-consistent receipts or multiple model votes do not independently show that a rule matches product intent.

### Exploration permission and acceptance permission

An LLM may propose compositions, choose inputs, inject deliberate damage, shrink counterexamples and suggest properties. Approval of new rules and acceptance standards stays with their owners. Before execution, fix the candidate version, applicable rules and domain, and bound:

- Separate test data, paths and processes; no shared memory store or production service, and no inherited external-provider credentials.
- Time, steps, samples, concurrency, memory, disk and network privileges. Fault injection needing extra permission is declared separately.
- Writable paths. A generated candidate cannot also weaken stable rules, acceptance code or baseline samples.

A failure report must recover the candidate version, initial state, inputs, identities, clocks, actual action sequence, observations and expected-result authority. Random exploration retains its seed; schedules or external responses not reconstructible from that seed need their own records. Replay before classifying a product defect, model error, test error or environment issue. Timeout, unreplayable behavior and unmet premises are not passes.

Ordinary `agent:verify` does not automatically provide this sandbox or trusted-baseline isolation. [Fixed trusted-baseline verification](../../design/ci-cd-and-quality/repository-control-plane.md) is explicit, with separate policy, dependencies and same-permission threat boundaries. This study neither enlarges that guarantee nor submits test edits to a baseline that permits only product-directory changes.

## Coverage selection: necessary conditions, seams and boundaries

The generation model distinguishes constructible environments, operations the product should accept, operations it should reject and research inputs. Constraints may exclude impossible environments; they must not filter out every expected rejection and call the remaining successful paths sufficient coverage.

Start from necessary conditions and boundary interactions for a concrete rule:

- Identity: claimant, bystander, submitter and independent judge.
- Lifecycle: live claim, renewal, release, reclaim and completion, with explicit clock boundaries.
- Versions and references: same entry, different attempts, same or different digests. Operation names must not hide object differences.
- Continuation after failure: execute a valid action after refusal and inspect possible state contamination.
- Timing: repetition, adjacency, permitted intervening actions and faults before or after submission.

Do not join order coverage across resets of independent tests. Report structural coverage, parameter coverage, order coverage, state-transition observations and named regressions separately. State each denominator, model constraints and executed scope rather than producing one “behavior coverage” percentage.

## NIST algorithm assessment

### IPOG: discrete parameter coverage without state semantics

IPOG constructs tests for the first `t` parameters, then adds parameters one at a time: horizontal extension covers more uncovered combinations in existing tests; vertical growth supplies the remainder. With constraints, a partial assignment must extend to a complete assignment satisfying all constraints.

Its promise is that each t-way value combination extendible to a valid complete case in the declared discrete domains and constraints occurs in at least one test. It does not promise a minimum suite, every real-world value, target-state reachability or defect detection. Bounded state sequences can be expanded into parameter columns, but transitions, references and time require separate encoding and validation.

The following capabilities are limited to the 2023 ACTS Basic 1.0 / Advanced 3.3 guide [S1], not unverified later releases:

| Algorithm | Guide capability and limit | Pilot selection and abandonment condition |
| --- | --- | --- |
| IPOG | Advanced supports constraints, mixed strength and negative testing | First gap-filling candidate; compare alternatives if generation, execution or model maintenance is unacceptable despite coverage |
| IPOG-F | Same capabilities, different construction heuristics | Compare on the same model and obligations; F in its name is not measured speed evidence |
| IPOG-F2 | No constraints, mixed strength or negative testing | Does not meet this pilot's constrained gap-filling needs; not a general claim of no value |
| IPOG-D | Recursive/compositional construction targets larger models but lacks those three capabilities | Not a default merely because there are many parameters; missing required capabilities disqualifies it, and post-generation filtering is not equivalent coverage |
| Base Choice | A 1-way method varying each parameter around baseline values | Smoke-test aid, not interaction coverage |

Mixed strength permits different `t` for parameter groups; extend augments existing input suites [S1]. Overall 2-way plus higher-strength critical seams is worth investigating, but strength follows domain risk and omission evidence, not a generalized “most defects involve few parameters” assumption. Mapping old tests into seed inputs does not preserve assertions or execution semantics; named regressions remain.

Explicitly enable `-Dcheck=on`: the guide's CLI disables coverage checking by default. The check establishes input coverage inside the current model, not model correctness. A small pilot also enumerates allowed combinations and denominators independently; generator self-checking is not prohibited.

[S4] studied ACTS 2.92 on 17 industrial PLC programs: IPOG completed more generation tasks within that study's budget, while IPOG-D had memory exhaustion and suite inflation. It did not support “prefer IPOG-D for large models.” There were no model constraints or mixed strength; outcomes concerned generation applicability, time and suite size, not bug finding. This is historical evidence against selection by promotion, not a current NMG algorithm ranking.

### Constraints and negative tests: stronger validity, different coverage domains

ACTS offers two constraint methods [S1, S5]:

- **Minimum forbidden tuples (MFT):** precompute minimal impossible value combinations, including implied conflicts across constraints, then check partial assignments against them.
- **CSP solver:** decide whether the current partial assignment and every constraint are jointly satisfiable.

The guide suggests comparing MFT first for simple constraints over few parameters, then trying a solver if generation is too slow. Measure preprocessing, generation, memory and execution on the same model. Individually plausible constraints do not establish that a partial case can be completed.

Native ACTS negative testing places at most one value marked invalid alongside `(t-1)`-way combinations of valid values, reducing masking among invalid values. Positive and negative tests both satisfy model constraints [S1]. It does not directly cover multiple simultaneous violations or dynamic state refusal.

For NMG, bystander submission and submission after claim expiry are required rejection behaviors, not inputs to discard for failing success premises. An individually valid identity lacking present authority is also not the same as ACTS's invalid-parameter-value marker.

### Basic SCA: event permutations with intervening events

A sequence covering array covers permutations of a selected set of `t` event symbols, allowing other symbols between them [S2]. It suits events usually executed once, where relative order matters more than adjacency and intervening actions preserve critical conditions.

The basic target does not express repetition, action parameters, current state or dynamic references. Covering “claim before submit” does not make this illustrative trace a submission under a live claim:

```text
claim A → release A → submit A
```

This is an explanatory boundary, not an executed defect reproduction. Renaming repeated actions as distinct symbols can produce candidate inputs, but object identity, valid state and permissible insertions still need definitions.

[S2] says the arrays originated from a rough 2009 greedy algorithm and might be improved; its page and tables also differ in maintenance age. Official arrays are coverage examples, not evidence of minimality or current optimality. When repetition, adjacency or dependency obligations cannot be expressed, use a state model or specialized constrained sequence generator rather than increasing SCA strength to compensate for the missing model.

### Ordered t-way: input-combination order, not reachability

The 2022 draft [S3] defines an ordered combination cover (OCC): `t` is the number of parameters per combination and `s` is the order length. It covers ordered subsequences of parameter combinations, permits intervening rows and permits repeated value combinations.

Its sufficient construction concatenates `s` strength-`t` covering arrays. Selecting a required combination from each segment realizes any requested sequence of `s` combinations. This strengthens coverage beyond static input combinations or event-name permutations.

The guarantee remains order within that abstraction, not adjacency, elapsed time, identity/artifact consistency, executable paths or target-state reachability. Intervening inputs may change state; concatenation across resets is not a continuous state trace. Constraints and initial states cannot inherit the construction's guarantee without argument.

Accept it as an auxiliary metric for parameterized traces when `s`, `t`, permitted insertions and trace boundaries are explicit and state observations accompany it. Reject it as behavioral acceptance when requirements concern exact adjacency, dependencies or real-time boundaries but the model represents only input order. Change the model instead.

### Later developments, alternatives and evidence gaps

This review found neither evidence that these methods are collectively obsolete nor proof that they are currently optimal.

- **Replace constraint handling:** BDD plus IPOG [S5] showed useful generation time on 62 models at 2-way/3-way strength, including the cost of preconstructing complete/partial valid-case spaces. Results depend on model and construction order. It is a performance candidate, not altered coverage semantics or a universal optimum.
- **Improve construction:** CAgen FIPO/mFIPOG and parallel extensions [S7] were found at abstract level. Full text, implementation and capability matrix were not completely checked; they do not justify replacing IPOG here.
- **Strengthen sequence constraints:** the 2019 constrained sequence work [S6] has verified title, authors and abstract, but no acquired full text. Constraint language, repeated-event support, coverage guarantee and scale remain unverified. “Supports constraints” does not establish NMG state semantics.
- **Replace input models or exploration:** use state/command models for dynamic dependencies, repetition and object references, and goal/coverage-guided exploration for feedback from unknown paths. These address different omissions; newer publication alone does not make them comprehensive replacements.

## Non-NIST routes: acceptance and abandonment

| Route | Problem addressed | Cost and acceptance condition | When it does not fit |
| --- | --- | --- | --- |
| Typed composite functions/fixtures | Common semantic fragments and resource reuse | Behavior-oriented names, explicit inputs/references/observation seams; no first-round DSL | Hidden critical state, unrelated responsibilities, or rewritten syntax without reuse |
| Model/command property tests [S8] | State, repetition, premises and shrinking | Independently maintain a minimal model; generate refusal commands; retain replay traces | Model copies implementation blind spots, or references/schedules cannot be reconstructed |
| Dafny-style formal slices [S9] | Universal properties in small pure cores | Stable worthwhile slices; include specification maintenance and solver variability | Whole asynchronous/IO modeling costs more than it returns, or model proof is claimed as implementation proof |
| Small proof kernel plus implementation differential [S10, S11] | Bound proof acceptance and connect model to implementation | Check trusted propositions/dependencies; sandbox builds at tool boundaries, externally replay and separately test implementation | Candidate rewrites the proposition, or proves a model but claims all implementation |
| Deterministic simulation/fault injection [S12] | Replayable interleavings, faults and long traces | Destructive isolated environments plus real IO/process/persistence tests | Simulation omits upgrade/runtime/resource behavior, or simulated green alone approves boundary changes |
| LLM-proposed properties/counterexamples [S13] | Broader candidate input/property exploration | Check rules, replay and human/independent evaluation first; bounded permission/budget | Count model reports directly as defects, generalize research validity to NMG, or permit automatic lowering of standards |

These routes may combine; none must replace every test. Cedar's Lean model and randomized Rust differential tests [S10] illustrate model proof plus implementation comparison, not proof of the complete Rust implementation. Agentic PBT [S13] is research evidence, not industry consensus or NMG false-positive measurement.

## Small pilot: Task Board delivery and judgment

### Scope and existing authority

The first candidate is [task-board-deliverable.test.ts](../../../tests/core/task-board-deliverable.test.ts). Its observed version has eight named tests covering:

- Only a live claimant may deliver; submission does not complete the entry.
- Submitters cannot judge their own artifact; independent judgment records the judged digest.
- Different artifacts do not inherit old judgments.
- A new attempt clears old artifact and judgment.
- Renewing the same live claim neither creates an attempt nor discards its artifact.
- `undecidable` retains its meaning and open state; unlisted judgment values are rejected.
- No delivery after entry completion.
- No judgment without an artifact.

These are existing observations of this family, not a complete Task Board rule set. Use isolated resources and choose fixtures according to the [resource assertion boundary](../../design/ci-cd-and-quality/composable-test-runtime.md); this study does not require opportunistically migrating database resource types.

### Proposed implementation sequence

1. Keep the eight tests and assertions; handwrite a few composites replacing only repeated setup/actions. Show actual duplication removed and observations retained.
2. Associate each property with identity, state, attempt and digest relationships. Compare observations and refusal conditions, not just test counts.
3. Add fixed boundary interactions such as judgment after redelivery, delivery after renewal and valid continuation after refusal. New properties need existing authority or separate review, not automatic approval of LLM expectations.
4. If needed, enumerate a small discrete model's existing input coverage, then compare IPOG/IPOG-F gap-fill candidates. Keep regressions and leave generation outside default CI acceptance initially.
5. Only then allow budgeted sequence exploration, shrinking and replay. Put helpers with demonstrated shared consumers; do not infer a repository-wide action library from one family.

The [RTM source consumer](../../../tools/rtm-check.ts) discovers names from literal `test("name", ...)` declarations; it does not parse the variable in `test(c.name, ...)`. The first round therefore keeps named literals and composes only their bodies. Batch generation separately needs discovery, traceability bindings and executed identity, not merely runnable code.

### Pilot acceptance and exit

| Question | Verification | Unsupported conclusion |
| --- | --- | --- |
| Existing properties and observations preserved? | Replay named regressions before/after; inspect refusals, changes and protected state | Same count means no omissions |
| New combinations execute and reach the intended boundary? | Replay identities, references, clocks, intermediate states and results | Listed combinations equal executed coverage |
| Judge detects relevant errors? | Targeted negative controls/fault substitutions; separately report caught, survived, inapplicable, unrun and environment failures | Crash equals target-defect detection; inapplicable equals pass |
| Parameter model covers its declared domain? | Small-model enumeration plus generator checking of constraints, extendible combinations, denominators and gaps | Full model coverage equals sufficient product coverage |
| Further sharing/generation worthwhile? | Compare repeated edits for one domain change, extraction complexity, generation/execution time and replay cost | Fewer tests means lower total cost or preserved detection |

Expand only with clear reuse, preserved properties, replayable boundaries, valid traceability and acceptable budgets. Shrink or remove abstractions hiding state, filtering refusal, requiring large infrastructure for a small family, or costing more to maintain. Keep useful counterexamples and named regressions rather than weaken acceptance to sustain the pilot.

Fix generation/exploration sample budgets and performance tolerances before their implementation. Round one only extracts semantics while preserving regressions; generated samples or speed are not acceptance evidence. Documentation structure checks do not experimentally validate behavior.

<a id="第一轮试点结果"></a>

### First pilot results

On 2026-10-12, a Windows working tree extracted local behavior from `tests/core/task-board-deliverable.test.ts` at `1d8e479294718bb023d70f45d0017a0cfcbf3d6f`. The [pilot decision](../../decisions/implemented/2026-10-12-deliverable-tests-compose-behavior.md) owns the choice and alternatives; this result is not a repository-wide policy.

- `claimedWorkItem` combines creation and claiming; `deliveredWorkItem` adds delivery. Three tests use the claim factory and five the delivery factory. Identities/digests are explicit, returning actual entry snapshots.
- Every source text for the eight names and 25 `assert.*` calls matches. A TypeScript AST comparator discovers literal tests and associates assertions, refusing zero tests, missing assertions or a mismatch, not merely comparing totals.
- The file goes from 263 to 235 lines including the two new factories: 28 fewer lines of repeated prefix, not assertions, rejection paths, cleanup or operations.
- One target execution before and one after each report 8 passed and zero failed, cancelled, skipped or todo. File LSP has zero diagnostics; scoped Prettier/ESLint pass.
- Existing controls `stale-claim-may-deliver-again` and `deliverer-may-judge-its-own-work` are caught by the named renewal/no-new-attempt and no-self-judgment tests. The harness first runs clean tests, reports 2/2 caught and restores `src/core/store/base.ts` byte-identically. Fault definitions are unchanged.

Replay:

```text
node --experimental-strip-types --test tests/core/task-board-deliverable.test.ts
npm run mutation:teeth -- --targets=src/core/store/base.ts --mutant=stale-claim-may-deliver-again,deliverer-may-judge-its-own-work
```

The target budget is 60 seconds and control budget 120 seconds, not speed tolerances. Two target runs are not a performance experiment. There is no claim of acceleration, all unknown-defect detection or new state interactions. Assertion preservation plus two controls is not formal semantic equivalence.

This round supports ordinary local functions for common prefixes, retaining observed assertions and two specified controls. It adds no boundary combinations, generator, exploration budget or cross-file sharing; later sharing follows below. Existing routes still own full acceptance, and verifier receipts—not these local outcomes—own latest execution evidence.

<a id="第二轮试点结果"></a>

### Second pilot results

On 2026-10-12 the same Windows tree checks composition over existing objects. Comparison still uses `1d8e479294718bb023d70f45d0017a0cfcbf3d6f`; consumers are `tests/core/task-board-deliverable.test.ts` and `tests/core/task-board-retention.test.ts`, shared implementation `tests/support/task-board-behavior.ts`, with choices owned by the [pilot decision](../../decisions/implemented/2026-10-12-deliverable-tests-compose-behavior.md).

- Separate scenario creation from claiming/delivering an existing entry. Five delivery tests and four retention tests share the function; the other three keep direct claim and one-step refusal observations. Callers supply reference, identity, digest, lease and time; the operator returns the actual delivered snapshot without recreating the object.
- Delivery tests explicitly choose current time and a 3600-second lease; retention tests keep historical live times and 600-second leases. Both actions use the same supplied instant. Creation/final handling keep the product clock; this is not complete deterministic simulation.
- AST comparison associates assertions with each literal test: delivery's eight names/25 calls and retention's four names/18 calls match individually. In-memory zero-test, deleted-assertion and modified-assertion controls check the comparator.
- Existing consumers first report 12 passed; adding four helper contracts yields 16 passed, with zero failed, cancelled, skipped or todo throughout. No regression is renamed or deleted.
- New tests observe exact existing references/historical clocks, renewal/redelivery on the same independently judged entry, competing-claim refusal followed by the owner's continuation, and unswallowed delivery exceptions with successful claims still observable. State is checked on both sides of judgment seams; old snapshots are not mutated in place.
- Each new test uses a separate `:memory:` store; original file-database lifecycles stay unchanged. Delivery failure replaces that test store's method: no disk/backend fault or transaction-rollback proof.
- Four code files have zero LSP diagnostics; scoped Prettier/ESLint pass. Both old controls are again caught by the required named tests, 2/2, restoring production bytes with fault definitions unchanged.

Replay within 60 seconds:

```text
node --experimental-strip-types --test tests/core/task-board-deliverable.test.ts tests/core/task-board-retention.test.ts tests/support/task-board-behavior.test.ts
```

The two controls reuse the [first-round scoped command](#first-pilot-results) with 120 seconds. An accidentally unscoped full mutation invocation timed out without complete retained results; it is not passing evidence. After confirming no remaining sweep process, mutation lock or production edit, the scoped run completed. The full sweep remained unverified at this point.

This supports reuse across two real families and preservation of existing-object, refusal and partial-failure semantics in named samples. Explicit parameters and helper tests add code/maintenance, so line count or speed is not the claimed gain. No DSL, generator, LLM exploration or repository-wide migration; no measured t-way coverage, unknown-defect detection or complete correctness.

### Independent-workspace pre-commit recheck

The independent workspace starts at `2337963637e6bbdaf1ecf237e0fc7ce6ef045ffc` and runs `npm ci` against that committed lockfile, not another contributor's shared-workspace lock changes. Its 16 target tests, four-file LSP and two specified controls pass.

The first full scoped run passes 15 static checks but reports `test:product` as 1724 passed/1 failed: unchanged `tests/extensions/nmg/reasoning-workspace.test.ts`, `clear removes only the selected session scratchpad`, gets `EPERM` in `finally` while `rmSync` removes its temporary directory. Debugger stepping removes it successfully; 20 ordinary standalone repeats reproduce 0/20 failures. No repeatable cause is established; this does not label it “flaky” or close it.

```text
node --experimental-strip-types --test --test-name-pattern="^clear removes only the selected session scratchpad$" tests/extensions/nmg/reasoning-workspace.test.ts
```

The failure is not a pass, and isolated repeats do not replace full acceptance. The failing test, gates and lockfile remain unchanged. The second full run passes product tests but its earlier `rtm:check` reads the first failed receipt and refuses, so the run still fails. After a new receipt is written, a standalone `rtm:check` passes; failed receipts are neither deleted nor hand-edited. The full pre-commit scope runs again, with execution owned by that workspace's verifier receipt.

<a id="第三轮边界组合结果"></a>

### Third boundary-composition results

Baseline: independent-workspace `d864ffb56331405a5833a6fc41df3ce8451751a7`. This round reuses `claimAndDeliver` without a new operator or interface change, adding two named store contracts in `tests/core/task-board-attempt-boundaries.test.ts`, each with separate memory DB and `node:test` connection cleanup.

- Same-identity reclaim: revision and judgment work 1ms before the 60-second lease ends; exactly at expiry the claim is no longer live, direct old-identity delivery is refused without changing data. Reclaim enters attempt 2, clearing old artifact/reference/digest/judgment before redelivery. Shared delivery must not advance to attempt 3.
- Different-identity takeover: a competing claim is refused 1ms before expiry and accepted exactly at expiry. Observe old artifact/judgment isolation before new delivery. Afterwards the old holder cannot deliver or steal the new live lease, but may independently judge its current artifact: judgment binds the new digest, not a permanent identity blacklist.
- Entry TTL is fixed in 2099, separating entry cleanup from the 60-second claim lease. Claim, delivery and judgment use specified instants; creation retains product time. This is neither end-to-end deterministic simulation nor cross-process concurrency.
- Four related files first report 38 passed; five files with the new scenarios report 40, all with zero failed/cancelled/skipped/todo. Git confirms old tests, helper and product source unchanged from baseline; no retired tests or rewritten expectations.
- The new test and mutation registry have zero LSP diagnostics; scoped Prettier/ESLint pass. Three new fault locations resolve and, with two existing controls, are caught by required names: 5/5, production bytes restored.

| New negative control | Incorrect semantics | Required failing scenario |
| --- | --- | --- |
| `expired-self-claim-is-only-a-heartbeat` | Renewal checks identity but omits liveness | Same-identity reclaim at expiry |
| `claim-is-live-at-its-expiry-boundary` | Changes interval end from `>` to `>=` | Same-identity reclaim at expiry |
| `new-attempt-keeps-prior-deliverer` | New attempt clears artifact but keeps old submitter | Different-identity takeover at expiry |

Registration/execution reuse the existing mutation harness. Expiry uses function-scoped AST text location; the others use existing initializer/literal-fragment operators. No new runner or locator implementation.

```text
node --experimental-strip-types --test tests/core/task-board.test.ts tests/core/task-board-deliverable.test.ts tests/core/task-board-retention.test.ts tests/support/task-board-behavior.test.ts tests/core/task-board-attempt-boundaries.test.ts
npm run mutation:teeth -- --targets=src/core/store/base.ts --mutant=expired-self-claim-is-only-a-heartbeat,claim-is-live-at-its-expiry-boundary,new-attempt-keeps-prior-deliverer,stale-claim-may-deliver-again,deliverer-may-judge-its-own-work
```

Budgets are 60 seconds for targets and 120 for scoped controls. Normal implementation passes; no product defect is found. Catching deliberate variants is not finding three natural defects or establishing three new detection abilities. The old suite was not separately tested against new variants to measure incremental detection. Old active-release cases already observe submitter clearing; these add expiry context and seams, which does not by itself make them redundant.

Intermediate observations matter: a wrongly retained old submitter could be overwritten by later delivery, so final state cannot replace post-claim checks. These samples do not prove full sequence coverage, retirement equivalence, maintenance savings or complete correctness. Parameter generation, bounded LLM exploration and retention-marker/lease interactions remain unverified.

<a id="更广的结构筛选2026-10-13"></a>

### Broader structural screen (2026-10-13)

The previous three-scope inspection used “same file, short fragment” to argue against another extraction, without sufficient evidence. This section supersedes that conclusion: short fragments and local reuse do not negate centralized semantic maintenance. A directly implementable first choice was found, rather than deferring until whole-system defect-detection gains are proved.

#### Inputs and method

Observed state: `d864ffb56331405a5833a6fc41df3ce8451751a7` plus uncommitted third-round edits. Inputs come from the fourteen `test:product` glob groups in `package.json`, including the new boundary file, excluding research/chaos/evals and production data. A one-off AST probe parses 199 files, finding 1,716 static test/it declarations, 15,666 non-direct-assertion call sites and 3,967 same-lexical-block action pairs. These are source locations, not executions; 1,716 is not the previous product report's 1,727 cases.

The [screen snapshot](behavior-structure-screen-2026-10-13.json) stores timestamp, Node/TypeScript versions, HEAD, input/probe SHA256, all inputs and the explicitly selected 16 method families/14 action-pair families, with at most four cross-file examples per family. This is historical measurement, not a live source inventory or semantic-equivalence proof. Separate checks pass for manifest/all 199 input hashes, retained 16/14 families and the 13-path/5-file/9-scenario relationships.

The probe reuses `resolveRouteTestFiles` and `writeJsonAtomic`, adding no npm command, framework or runtime interface. Method clusters retain receivers/argument fields; pairs retain intervening statements/direct assertion counts, not falsely treating calls across assertions as adjacent. Self-checks cover adjacent calls, assertion barriers, distinct callbacks, empty AST, closed paths and rejection of extra-metadata fragments from basic paths. Execution/LSP pass; the one-off script is not delivered, with recomputation method and references retained in the snapshot.

#### Candidate ranking

Ranking uses real common structure, consumer differences and side-effect boundaries, not frequencies, lines or edit counts converted into savings.

| Candidate | Cross-file findings | Semantic checks and principal risks | Judgment |
| --- | --- | --- | --- |
| Path/cycle links over existing nodes | `linkNodes`: 47 sites/9 files; 13 confirmed basic paths in 9 named scenarios/5 files | Same store/type; previous target becomes next source, no intervening assertion. Closed paths, direction and call order matter: no deduplication, sorting or imposed acyclicity | First choice: ordinary typed path builder; no node creation or scenario judgment |
| Explicit edge sets on an existing memory chain | `addMemoryChainEdge`: 20 sites/4 files; 9 adjacent pairs/3 files | Includes convergence, not just lines; distinguish node/memory IDs, DAG refusals and LTG/STG stores. Twenty sites are not twenty proved replacements | Reserve: explicit writes on existing chain references, not one generic graph operator with node relations |
| Batch memory writes | remember→remember: 172 pairs/25 files, 160 statement-adjacent | Deduplication, supersession, scope, sourceActor and STG/LTG affect each result; service `rememberBatch` is already single-physical-store | Large opportunity, but adjacency alone is not identical setup. Reuse existing capability before inventing a universal writer from name counts |
| Rebuild leaves/inject external vectors after writing | remember→rebuildLeafBlocks: 16/6 files; upsertExternalEmbeddings: 9 sites/5 files | Whole-store versus specified nodes; membersKey/Delta transitions may be the subject. Vectors, model namespaces and readiness are inputs | Valuable second tier; do not swallow the change under test into setup |
| Write after working-state binding | bindWorkingState→replaceWorkingState: 12/4 files | Trusted host context versus privacy/budget/refusal-preserved state; concatenation does not establish mergeable authorization/observations | Higher risk, not first implementation; helper must not choose authority for callers |
| Directory cleanup after close | 78 sites/45 files | Resource lifecycle, not behavioral coverage; memory/file/daemon resources must match | Broadest mechanical reuse signal; return to test-runtime owner, not a competing behavior library |

Keep `claimAndDeliver`: it has real cross-scenario reuse, but it is not the only worthwhile operator. Three earlier small scopes do not show no repository-wide opportunities. Retention/cleanup observations and distinct embedding doubles still require separate treatment; this is not a blanket rejection of fragments in those domains.

#### Concrete first-choice scope

All thirteen paths appear in snapshot `basicNodePaths`:

- `tests/core/analogy.test.ts`: bidirectional contradiction, dependency path and causal cycle.
- `tests/core/community.test.ts`: connectivity, dependency/contradiction communities and feedback cycle.
- `tests/core/graph-cycles.test.ts`: directed cycle, acyclic path and observations between symmetric/directed relations on the same objects.
- `tests/core/multi-hop-path.test.ts`: two-hop existing-node path.
- `tests/core/store/graph.test.ts`: two-hop neighborhood.

Basic-path selection requires at least two consecutive `linkNodes` calls with exactly sourceNodeId/targetNodeId/type, same receiver/literal relation type, and previous target expression equal to next source. Any other statement ends the fragment. Each of the five files was inspected: NmgStore and real existing-node references. Dynamic mixin types at test call sites provided no usable definition location, so owning `src/core/store/graph.ts` and LSP were used to check actual inputs and NodeRelation outputs; textual matches were not represented as type equivalence.

A feasible interface is ordinary `linkNodePath(store, existingNodeIds, relationType)`. Callers explicitly supply A→B→C or A→B→A. Preserve sequential writes, existing failure propagation and product clocks, returning real relation observations: no transaction, automatic closure or prefilter. Only identical basic semantics enter it; idempotent relinking, evidence merging, strength and intermediate assertions may stay direct. This is an interface/scope proposal at this stage, not delivered code or an acceptance gate.

Git locations include cycle `cb4a858a`, community `ed8e9797`, analogy `294cd18e` and multi-hop `e093eb6c`. They show shared structural intent across features, not repeated synchronized fixes to a field or measured maintenance time saved.

#### Principal risks and decision endpoint

The main risk is erasing distinctions, not function length:

- Ordinary node relations permit cycle diagnosis; memory-chain writes reject DAG cycles. They cannot share default-acyclic premises or borrow acceptance evidence.
- Adjacent create/edge calls in `tests/core/stg-isolated.test.ts` cross LTG/STG; same method names do not mean the same execution object.
- Repeated same-endpoint `linkNodes` can test idempotence/evidence merging, not a two-edge path.
- Composition across assertions hides observations. Frequent remember/bind/cleanup calls do not directly define one contract.

The screen ends with an implementable first choice, reserves and exclusions, withdrawing “no worthwhile new candidate.” Implement the existing-node fragment with existing named scenarios and necessary local contracts/controls, without first proving overall detection gains or retiring tests automatically. This phase screens structure only: no new operator, generated sequence, product/original-test edit, maintenance-time measurement, natural-defect detection or complete semantic coverage.

<a id="已有节点路径实施结果2026-10-13"></a>

### Existing-node path implementation results (2026-10-13)

After user approval, scope is fixed to the thirteen screened fragments. `linkNodePath` in `tests/support/node-graph-behavior.ts` is an ordinary typed function holding only `linkNodes` write capability: pairwise connect caller-owned IDs/type and return actual relation results. Resources, creation and judgments remain consumer-owned; [test design](../../design/ci-cd-and-quality/composable-test-runtime.md) owns the boundaries. No product source, dependency, verification route, DSL or generator changes.

#### Preservation comparison

Baseline: `d864ffb56331405a5833a6fc41df3ce8451751a7`. All original 49 literal test names and 158 `assert` source calls in five consumers match individually. These are declarations/call sites, not assertion execution counts. Expand helper calls into adjacent-ID three-field `store.linkNodes` calls, remove only the newly introduced import, then compare whole consumer ASTs through TypeScript's comment-free printer: all five equal baseline. Receiver, endpoints, relation type, write order, creation and observations remain. This is not general semantic equivalence or complete correctness.

| Consumer | Original names | Original assertion calls | Migrated fragments |
| --- | ---: | ---: | ---: |
| analogy | 4 | 12 | 3 |
| community | 3 | 12 | 4 |
| graph-cycles | 8 | 21 | 4 |
| multi-hop-path | 3 | 18 | 1 |
| store/graph | 31 | 95 | 1 |
| Total | 49 | 158 | 13 |

The one-off comparator reuses `writeJsonAtomic`, with explicit baseline, five paths and expected thirteen fragments. Controls accept valid expansion and reject empty input, renames, missing/changed assertions, wrong endpoints/receiver/type and extra observations. Execution/LSP pass. Environment: Node `v24.19.0`, TypeScript `5.9.3`; post-format measurement `2026-10-13T04:16:02.786Z`; probe SHA256 `bb4123e205a993e5fb3a494cdf14c48c29df3cd67f9754bb42c04363d8d620ed`. Full local result: `.nmg/verification/node-path-comparison.json`; script not delivered. Recompute by reading the five baseline blobs, collecting literal names/assertions with `ts.createSourceFile` and using the expansion/printer method above; scoped execution follows below.

Screen hashes remain pre-implementation measurements, not rewritten using changed consumers. Idempotence, evidence merging, extra metadata, independent edges and symmetric/directed observations stay in place. No automatic retirement. Product source, existing Task Board helper and original delivery/retention tests remain baseline-identical.

#### Contracts and scoped controls

Four named contracts check direction/order/actual snapshots; repeated endpoints/edges and per-call results; no writes for empty/single-node input; and unchanged later-error propagation with execution stopped and a successful prefix retained in real SQLite. Three scenarios use independent `:memory:` stores; the empty/single case needs only a write capability that throws on any call. Failure injects the same Error at call two, not a natural product defect or underlying database failure. Original consumer file-database lifecycles stay unchanged.

Five files pass 49/49 before migration; adding four contracts yields 53/53:

```text
node --experimental-strip-types --test tests/core/analogy.test.ts tests/core/community.test.ts tests/core/graph-cycles.test.ts tests/core/multi-hop-path.test.ts tests/core/store/graph.test.ts tests/support/node-graph-behavior.test.ts
npm run mutation:teeth -- --targets=tests/support/node-graph-behavior.ts --mutant=node-path-skips-the-first-edge,node-path-counts-only-unique-endpoints,node-path-swallows-a-later-link-failure
```

Existing harness registers three function-scoped faults without a new operator/runner: skip first edge is caught by order/snapshot checks; unique-endpoint length by repetition checks; swallowed later failure by failure/successful-prefix checks. All 3/3 locate and are caught by required real names, with target bytes restored. Result time: `2026-10-13T04:14:39.671Z`, local `.nmg/verification/node-path-teeth.json`. This is not a full sweep, three natural defects or proof of three additional detection abilities.

#### Full checks and unresolved reproduction

First full scoped run `c6c1ca85-f912-4606-be6d-fbfdbf246018` writes a failed receipt at `2026-10-13T04:22:28.657Z`: 15 blocking checks pass, product 1,730 passed/1 failed. Unchanged `tests/cli/process.test.ts`, `daemon idle timer is refreshed by requests`, receives `running=false` after its second status read. Outer task separately returns `[TIMED OUT]`. Receipt failure and outer timeout are distinct observations, not explanations for each other. Local `.nmg/verification/node-path-final-verify.log` and `node-path-first-full-failure.json` retain both, without deletion/manual edits.

Second full run `5337bab5-255a-4776-8a0b-e4e4f10d577a` writes at `2026-10-13T04:38:27.895Z`: product passes, but earlier `rtm:check` reads the previous product failure and fails, so the whole run is not green. Its outer `--json` task also times out. Preserve failure receipts and review only normally emitted new verifier evidence.

Third run `a5db74d7-d0cb-4ee4-81e8-4c38b4131323` writes success at `2026-10-13T04:48:37.414Z`: all sixteen blocking checks for fourteen owned paths pass, including RTM/product. A one-off independent launcher records HEAD and fourteen input SHA256 values before invoking the same watchdog without route/standard changes. Native child exit is zero; status written at `2026-10-13T04:48:37.447Z`. Launcher missing-input control, LSP and full lint pass; it is not delivered. This establishes that run's normal completion, not the first two outer timeouts' cause.

Four exact-name standalone repeats pass 4/4 (0/4 reproduced under those conditions). At the original second assertion the debugger observes `first.running=true` and `second.running=true`, then confirms temporary cleanup after continuing. No changes to the CLI case, daemon or standards, and no verifier process remains at inspection. Neither original full-run failure nor outer-timeout root cause is established. Later green results do not mark them resolved or replace investigation with “flaky.”

```text
node --experimental-strip-types --test --test-name-pattern="^daemon idle timer is refreshed by requests$" tests/cli/process.test.ts
```

#### Decision and limits

Keep the function and thirteen fragments, closing this implementation block after verification, not automatically moving to chain/batch/other candidates. No maintenance-time, natural-detection gain or whole-repository migration benefit is measured. AST preservation, actual execution and specified fault detection provide separate evidence. Existing `agent:verify` receipts own final full scoped checks; local results do not substitute. At this historical stage the path work was not staged/committed. Later delivery/integration follows; failed observations and unconfirmed causes remain.

## Local integration delivery (2026-10-13)

Closeout delivers only the chosen `claimAndDeliver`, `linkNodePath` and consumers, without expanding the operator library, DSL or generator. Fourteen behavior paths commit as `164f0bb08c923e410ee980e28a9ee4bf9f17e34f`, parent `d864ffb5`; fourteen input SHA256 values match after commit/hook and workspace is clean. Pre-commit recheck: targets 93/93, nine-file zero LSP diagnostics, scoped run `4aef3730-5754-45ee-baf2-dc18296bcf86` completes sixteen blocking checks at `2026-10-13T14:06:40.477Z`, native exit zero. That old-baseline recheck is not integration proof.

Independent `test/behavior-and-reporting-integration` starts from shared committed snapshot `a964fa3af2baddf12e1e625a9bfd907d8266095f`, replaying execution reporting `66238c2`, recovery tests `432c0e8`, composition `d864ffb5`, then `164f0bb`, producing `cc34153e059101333466be0f303175cdfb1632b5`. Only the CI owning design's updated date conflicts; retain the newer date. Thirty of thirty-one differing paths are blob-identical to their source commits. Design body equals the recovery-fix version plus operator §4.1, retaining type entry points, on-demand inventory, GC skips and behavior contracts. Other baseline code and uncommitted shared files are neither imported nor overwritten.

Measured on that integrated code snapshot:

- Fifteen target files: 128 cases, 126 passed, zero failed, two explicit GC skips; explicit-GC robustness 16/16 with no skip.
- Ten offline harnesses derived from real `tools/ci-uncovered-tests.ts --list`: 91/91, no failures/skips and no filtered recovery scenarios.
- Nineteen affected TypeScript files: zero LSP diagnostics.
- Existing harness's three node-path and five Task Board controls: 8/8 caught by required names, both targets byte-restored. Not a full sweep.
- Clean `npm run verify:product-ci`: native exit zero at `2026-10-13T14:29:25.477Z`; 1781 cases, 1779 passed, zero failed, two explicit GC skips. All thirty-one input SHA256 values match before/after.

This evidence section was added after that code snapshot; CI does not claim to cover later documentation bytes. The owner emits final clean scoped receipts. In PowerShell, recover scope with `$scope = git diff --name-only a964fa3af2baddf12e1e625a9bfd907d8266095f HEAD`, then run `node --experimental-strip-types tools/agent-verify-watchdog.ts --require-clean @scope`. Target tests, explicit GC, scoped mutation and full CI use the existing entry points here and in the two repair decisions, not a new runner.

This completes local operator commits and functional integration, not a claim that the shared branch is merged or pushed. No Linux, GitHub workflow dispatch, independent external acceptance, live provider, full benchmark, measured generator or natural-defect gain proof. Success does not close historical daemon or outer-timeout causes.

<a id="来源与未验证项"></a>

## Sources and unverified items

Doubao search discovered sources; text review checked definitions, conditions and limits. Some NIST originals were unreachable; marked mirrors below are third-party `csrc.nist.rip` text, not verification of the original site's latest release. OpenReview Last Modified is not a publication date.

| ID | Source and reviewed scope | Evidence boundary |
| --- | --- | --- |
| S1 | [ACTS User Guide, Basic 1.0 / Advanced 3.3; file marked Nov 2023, mirrored PDF](https://csrc.nist.rip/csrc/media/Projects/automated-combinatorial-testing-for-software/documents/acts_user_guide_for_basic1.0_and_advanced3.3_versions_nov23.pdf), §§1–3 | Algorithm capability, constraints, mixed strength, negative testing, extend and coverage checks; no later-release verification |
| S2 | [NIST Event Sequence Testing, mirrored text](https://csrc.nist.rip/Projects/automated-combinatorial-testing-for-software/combinatorial-methods-in-testing/event-sequence-testing), page marked updated 2021-10-12 | SCA, insertions, examples and original construction; not optimality |
| S3 | [Ordered t-way Combinations for Testing State-based Systems, 2022-04-14 draft, mirrored PDF](https://csrc.nist.rip/csrc/media/Projects/automated-combinatorial-testing-for-software/documents/seqWP-4.pdf), full text; [2023 conference record](https://openreview.net/forum?id=vyfw4ngjAt) | OCC/construction checked against acquired 2022 draft; verification wall blocked 2023 PDF, so revisions unchecked |
| S4 | [Combinatorial Modeling and Test Case Generation for Industrial Control Software using ACTS, 2018 v2](https://arxiv.org/pdf/1803.09006v2), full text | ACTS 2.92, seventeen PLC programs, generation efficiency/applicability; not defect detection or current ranking |
| S5 | [Using binary decision diagrams for constraint handling in combinatorial interaction testing, 2019 v1](https://arxiv.org/html/1907.01779v1), constraint/IPOG/BDD definitions, experiments and validity threats | Constraint performance on 62 models, 2-way/3-way; not universal optimality |
| S6 | Duan, Lei, Kacker, Kuhn: [An Approach to T-Way Test Sequence Generation With Constraints, 2019 ICSTW discovery entry](https://csrc.nist.gov/Projects/automated-combinatorial-testing-for-software/acts-library/workshop-papers) | Title/authors/abstract only; algorithm text, capability and coverage guarantee unverified |
| S7 | [Developing multithreaded techniques and improved constraint handling for the tool CAgen, 2022](https://openreview.net/forum?id=7JEW3ZNrXb) | Abstract only; performance not adopted as NMG selection evidence |
| S8 | [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/) | Commands, models, premises and execution; not integrated/measured in NMG |
| S9 | [Dafny Quick Reference](https://dafny.org/dafny/QuickReference), [Verification Optimization](https://dafny.org/dafny/VerificationOptimization/VerificationOptimization) | Specification/proof mechanisms and solver-stability costs; not whole-repository applicability |
| S10 | [Lean into verified software development: Cedar](https://aws.amazon.com/blogs/opensource/lean-into-verified-software-development/) | Executable Lean model, property proofs and randomized Rust differential combination |
| S11 | [Lean: Validating Proofs](https://lean-lang.org/doc/reference/latest/ValidatingProofs/) | Trusted propositions, dependencies and verification boundaries; mutable latest URL does not eliminate compiler/runtime trust |
| S12 | [FoundationDB testing](https://apple.github.io/foundationdb/testing.html) | Deterministic simulation/fault experience, not validation of NMG real boundaries |
| S13 | [Agentic PBT, 2025 v1](https://arxiv.org/html/2510.09907v1) | Research evaluation of properties/defect reports; sample validity is not NMG false-positive rate or industry consensus |

Still unverified: cross-test maintenance gains, comprehensive defect detection, uncovered state boundaries, real generator/dependency execution, latest ACTS release, S6/S7 full text, 2023 OCC changes from the draft, and isolation strength of a bounded exploration environment. First-round evidence covers only its explicitly measured local slice. Later results return to this record; formal rules/behavior changes return to their existing owners, not self-promotion by a research document.
