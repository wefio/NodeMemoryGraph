# Reader guidance and distributed terminology rollout

[中文](document-reader-and-terminology-rollout-2026-10-15.zh-CN.md) · [Terms used](document-reader-and-terminology-rollout-2026-10-15.terms.yaml)

Counts below belong to their named historical checkpoints. The
[retained-document iteration](#retained-document-groups-and-word-keys) supersedes
the former requirement to assign every term a separate ID. Earlier successful
checks do not cover later edits or complete repository-wide prose review.

## Scope and source

Base: `0ff7a8f85dd7d3dd6507b58a28032f254b3a1424`. The local branch is
`feat/documentation-writing-rollout`; no push, merge, live-model call or external
benchmark is part of this work.

This batch edits actual prose: bilingual task-based documentation entry routes,
CI/RCP reading paths, terminology lookup and recovery instructions, the owning
lifecycle and terminology decisions, and the maintenance workflow. It removes a
duplicated post-mortem instruction without removing the triage requirement.

Fourteen process terms move from the manual v1 index into three topic-owned v2
sources. The existing three governance entries remain, for seventeen registered
terms. Definitions distinguish contract from work order, assertion from check,
kind from stage, assertion context from session context, and receipt self-checks
from authenticated execution. Full behavior contracts remain at their owners.

Structural hygiene uses role discovery for active design and Skill Markdown,
including Skill references, while retaining the three required workflow files.
Archives and raw experimental evidence are not admitted by this change. Reference
heading checks do not impose the Skill entry's byte ceiling on references.

## Reader review and preservation

This is the author's review, not an independent semantic review:

| Reader question | Revised route and boundary |
| --- | --- |
| Where do I start, and which text can I change? | Both docs indexes separate task entry points from document authority; guides do not redefine design. |
| What does a process word mean? | CI/RCP routes to topic YAML; names, aliases and stable IDs resolve to a definition and a separate behavior owner. |
| What if lookup fails or is ambiguous? | Governance gives local and wider queries; a miss is bounded, candidates require disambiguation, and a bad catalog must be repaired first. |
| What does a green document check establish? | The CI table distinguishes admitted structure, role budgets, warnings and unautomated semantic review. |
| Does an unchanged name imply unchanged query output? | Migrated v2 entries retain the three-column first line but add definition metadata and use topic namespaces. The v1 reader remains compatible when a v1 source is present. |

The preservation check reads the original index with
`git show 0ff7a8f85dd7d3dd6507b58a28032f254b3a1424:docs/glossary.yaml`, parses YAML,
and calls `queryTerms` for each original canonical name and alias. All 46 queries
resolve uniquely; `term`, the complete `aliases` array, `owner`, `anchor` and
`status` match the original fourteen rows. Each migrated entry has a scoped ID
and a definition. This checks lookup identity, not general semantic equivalence.

All 136 active design files retain their explicit or default lifecycle status
relative to the base. The heading checker reports no defects in the 155 tracked
active-design/Skill Markdown files. That is structural coverage, not a claim
that all 155 files received a prose rewrite or complete reader review.

Remaining mentions of the v1 filename are migration/compatibility explanations
or historical examples in rejected decisions; those historical records are not
rewritten as current instructions. Approval examples refer to checked terminology
metadata, not to machine certification of word meanings.

## Executed checks

- Target tests: 72 passed, zero failed, including heading parser, documentation
  verifier and glossary resolver cases.
- Docs check before this report: 432 Markdown files, zero errors and warnings.
- Glossary check: seventeen terms from three v2 sources, zero errors.
- LSP: zero diagnostics across the six touched TS/MTS code/test files.
- Complexity gate: passed. Formatting covers the touched code; `git diff --check`
  passed.
- The three documented lookup examples were executed successfully: directory-bounded
  `收据`, `repository.verification.assertion-context`, and namespace-selected
  `术语定义`.

The first target run was red for newly discovered design/Skill defects, an empty
registered corpus, and v2-only discovery. After implementation, the previous
pilot-only expectation and a lifecycle fixture with an empty body also required
updating to the admitted policy. The final 72-case target run is green; the
archive/raw-evidence exemptions and missing-required-file refusal remain tested.

Pre-commit full run `7ba146a5-71c5-48d4-8cca-e7f86ae3f727`, from
`2026-10-15T05:06:28.510Z` to `2026-10-15T05:08:10.413Z`, records all sixteen
blocking checks as actually passed with native child exit zero, including the
product-test command. Research and chaos were explicitly skipped as advisory.
The outer task tool timed out at 361 seconds: that wrapper is not reported as
successful merely because its completed report exists.

Clean committed-input run `7bf07ea4-be96-4c86-8dfd-c6a9439bcd43` verifies functional
commit `c31e03fc355bef2e75588d516616641099cb7d3b`, with all 26 owned paths passed
explicitly and `--require-clean`. The native parent invocation ran from
`2026-10-15T05:15:36.177Z` to `2026-10-15T05:17:05.179Z` and returned exit zero,
without a signal or error. Its report records all sixteen blocking commands
passed with child exit zero. Research and chaos remain advisory skips, not
execution successes. Docs check includes this report: 433 files, zero errors
and warnings.

The clean run used the existing watchdog directly, with stdout/stderr sent to
a file and the parent's observed status recorded separately. The scoped input
list and native exit record are local artifacts under `.nmg/verification/`;
the shared commit, command below and observations above recover the required
verification facts without private memory.

```sh
# At the functional commit, pass the changed paths explicitly on the clean tree.
node --experimental-strip-types tools/agent-verify-watchdog.ts \
  $(git diff-tree --no-commit-id --name-only -r c31e03fc355bef2e75588d516616641099cb7d3b) \
  --require-clean --json --timeout-ms 300000
```

The later evidence-only commit updates this record, not the implementation
measured by the clean sixteen-command run.

## Reader standard and first application

The reader-oriented standard is committed first at
`3a3eb04a756fe750c5c3458f3b63cd9896ad2216`. Its canonical criteria and review
procedure are in
[reader-review.md](../../../skills/doc-maintenance/references/reader-review.md);
the governance model and maintenance entry route there rather than keeping a
parallel checklist. The bilingual lifecycle decision records the choice and
cost of adapting controlled-language ideas without claiming ASD-STE100 compliance,
adopting its full vocabulary, or introducing a sentence-length gate.

Clean standard-only run `046fd5cd-95d4-456b-9fc9-6f50cff61e93` passed all eight
selected blocking checks with top-level native exit zero and no dirty inputs.
The prior 72-case documentation/glossary target set also passed after the
standard was written. Neither result certifies the quality of its normative prose.

The first subsequent application rewrites the
[trusted-baseline operating topic](../../design/ci-cd-and-quality/repository-control-plane/trusted-baseline-verification.md)
into prerequisites, installation, policy eligibility, candidate execution,
result handling and trust limits. This is one operational reading unit, not
completion of the remaining topic documents.

Author comparison against that file at the standard commit:

| Original contract group | Preserved in the revised reading path |
| --- | --- |
| Choice and authority | Explicit local workflow; ordinary reconcile/agent verification has no automatic baseline isolation; governing decisions remain linked |
| Installation | Reviewed fixed commit; existing parent, absent target outside the candidate repository; ordinary files only; 256 MiB Git-output limit |
| Dependencies and upgrades | Exact npm options, no lifecycle scripts, no failure downgrade or missing-environment exemption; new install directory and explicit new entry on upgrade |
| Policy boundary | Baseline policy; nonempty uniquely identified obligations with tests and timeout; src-only product changes; package/lock/tsconfig and other-path restrictions; independent review for rule/test/dependency changes |
| Candidate and executor identity | Committed snapshot, no dirty/untracked reads or auto-commit; baseline tests/helpers, candidate imports, external adjudicator, installed dependencies and digest checks |
| Acceptance and failure | All obligations execute without historical reuse; TAP must be nonempty and entirely passed with no failure/cancel/skip/todo; missing reports, errors and timeouts fail |
| Results and limits | Exit codes 0/1/2; bound JSON identities and actual claims; no automatic receipt, lifecycle transition, signature, formal proof or adversarial-isolation claim |

Both executable command lines and the Authority field match the source exactly.
The canonical term heading remains; six incoming fragment links found in docs
still target that heading. A bounded field-presence check supplements this
comparison but is not semantic proof. No runtime behavior or verification policy
is changed by the rewrite.

The combined target run actually passed 77 tests, with zero failures or skips:
heading hygiene, docs verification, glossary resolution and the existing trusted
verification fixtures. Docs remained at 433 files with zero errors/warnings;
glossary remained at seventeen entries with zero errors. The shown installation
and verification commands were not executed against a real user repository;
the trusted-verification coverage is the product fixture suite, not a new live
installation. No independent prose review or reading-efficiency measurement is
claimed.

## Track selection and repository-context remediation

The next batch compares two reading units against base
`00e7181f7f7d32e2c74d3caf961a240610211e3f`:
[execution tracks](../../design/ci-cd-and-quality/verification-tracks.md) and
[repository context](../../design/ci-cd-and-quality/repository-context.md).
The first now separates entry selection, local-only tools, lint/format scope,
type/policy checks, mutation-anchor interpretation, complexity evidence,
provider isolation and coverage liveness. The second separates owner lookup,
capability discovery, data sources and reconciliation interpretation.

Author source comparison retained these contract groups:

- Track commands and purposes, local-only tools, lint scope and severity
  exceptions, console exemption, matching format/hook surfaces and independent
  subpackage workflow.
- Type-check scope exclusions, policy-word metadata versus actual policy freedom,
  read-only anchor resolution versus a real pre-push mutation sweep, complexity
  merge-base/AST identity/unmeasured-file boundaries.
- Keyless restrictions, module-top provider stripping and explicit provider
  configuration, test concurrency 2 versus 4, and the 0.01% coverage-liveness
  threshold rather than a coverage-quality target.
- Scope selection without collecting another Agent's changes; optional navigation
  rather than mandatory whole-document reading; readonly/no-database/no-daemon/
  no-live-model behavior; capability and route ownership boundaries.
- Desired/observed/evidence identities, all three reconciliation states and their
  failure conditions, dirty-content fingerprint changes, Git metadata versus
  content identity, and the distinction between drift and architecture correctness.

Bounded checks confirm that all original inline code identifiers, Authority
fields, default lifecycle statuses and canonical subheadings remain. No incoming
fragment links to these two file paths were found in docs/skills; the canonical
term heading in the context page is retained. These checks supplement author
review and are not a semantic-equivalence proof.

Patch-local mutation narration and an environment-free one-second timing claim
were removed from standing prose; the failure mechanism and decision reference
remain. The actual `mutation:anchors` run resolved 110 of 110 anchors over 22
targets. It did not execute mutation tests. Counts belong to that observation,
not a second maintained source inventory.

The documented scoped `agent:context` command ran successfully. Its readonly view
reported `drifted` because the latest evidence did not describe that scope/state;
this was not presented as convergence or an architectural failure. Combined
existing target suites passed 106 tests with zero failures or skips: docs hygiene,
docs verification, glossary, repository context, ESLint scan scope and test groups.
Docs check reported 433 files with zero errors/warnings, glossary seventeen terms
with zero errors. No live provider, full mutation sweep or remote CI was run.
This is two more actual rewrites, not full-repository prose-review completion.

## Established topic naming correction

The user identified that the split retained chapter-position names instead of the
repository's established descriptive English kebab-case style. Absence of an
explicit prohibition did not justify the inconsistency. This correction covers
all 84 topic files introduced by `270d9e3..0ff7a8f8`, compared with base
`a4ab1e16f66b259d7ac536ce8cce9eddbae33012`: 78 paths were renamed; six already
suitable names were retained. Both language variants of implementation-artifact
navigation use the same subject basename. Existing bilingual suffixes, meaningful
versions/dates, ordered list steps and stable domain/obligation IDs remain.
Generated `— topic` labels and mechanical chapter-position headings were cleaned
in the affected topic/parent corpus; this does not certify their remaining prose.

Examples of the resulting CI topic names are `verification-tracks.md`,
`repository-context.md` and `repository-control-plane/`, with
`trusted-baseline-verification.md`, `contract-surface-and-ir.md` and
`verifier-and-receipts.md` below the latter. The reader-review reference owns the
style guidance; the bilingual lifecycle decision records the rejected alternative
and migration cost. No new filename gate or universal prohibition on digits was
introduced.

Migration covered incoming local Markdown links, relative links from moved files,
changed fragments and section references, and terminology `owner`/`anchor`
bindings. Historical commit-bound code examples and fenced literals were not
rewritten as current instructions. The explicit map covered exactly 84 original
paths, rejected target collisions, and retained explicit/default lifecycle status,
obligation-ID occurrences and fenced code. All term IDs, names, aliases,
definitions, statuses and source namespaces remained equal after excluding only
the intended owner/anchor migration. No tracked runtime/source file changed.

The bounded scan covered 459 tracked Markdown files and inline local fragment
links outside fenced code/comments: 185 edges before, 224 after adding named
section references, twelve distinct already-invalid source/link pairs, zero newly
invalid pairs. It checked actual post-rewrite headings, including duplicate-slug
suffixes. This is not a full renderer or an exhaustive HTML/Setext/reference-link
validator; earlier audits with different scopes are not the same measurement.
No complete old repository-relative topic path remained in the scanned tracked
Markdown/YAML/JS/TS/JSON sources.

The temporary probe passed its map, collision, literal, duplicate-heading and
external-URL self-checks. A negative control replaced one `D1` reference in the
migrated store/operation/view child: exact-output verification failed with native
exit 1, and original bytes were restored before a positive rerun. The first
attempt selected the routing parent, which had no `D1`, and stopped before any
write; debugger inspection located the actual child. Probe LSP reported zero
diagnostics; the probe and mapping input were removed before commit. The map and
raw local observations are retained only as optional verification artifacts;
Git's old/new paths and this shared record remain the recoverable task evidence.

Existing targeted suites passed 111 tests with zero failures or skips, including
the trusted-baseline fixture suite (not a real trust installation). Docs check
reported 433 files, zero errors/warnings; glossary check reported seventeen terms,
zero errors. No live provider, full mutation run, remote CI, push or merge was
performed. This finishes the naming correction across all 84 split topics, not
full-repository content/reader review.

## Retained-document groups and word keys

This iteration starts at `4ecf243f8e0449bb5289fe74ee25284351bdcc0d`.
[The bilingual owner](../../README.md#bilingual-policy) now covers all retained
reader-facing material, including archives, decisions, Skills/references and
experiment/incident reports. Only explicitly disposable working material is
excepted; missing counterparts are debt, not another language exemption.

English prose, Chinese prose and one shared `<topic>.terms.yaml` form a reading
group. Shared concepts reference their canonical words, not copied definitions.
The user rejected a second manually assigned identifier for every word: canonical
English is the key; Chinese translations/precise aliases share the definition;
qualify genuine homonyms by namespace. The namespace defaults to `repository`.
Old v1 and ID-bearing v2 definitions remain readable, without generating IDs for
new terms. Canonical renames migrate references/successors; discovery aliases do
not make obsolete references valid. Contract/assertion/route/session identities
are real protocol identities and are not removed by this lexical simplification.
[The decision](../../decisions/implemented/2026-09-08-repository-terminology-index.md)
records the rejected alternative and migration cost.

### Implementation and negative evidence

- Use-only/no-specialized-term files are supported. The first four new reference
  tests actually ran red: 22 pass / 4 fail, then 26/26 green, no skips.
- Word keys/default namespaces/schema/rename/successor/legacy compatibility ran
  red at 23 pass / 9 fail, then green at 32/32, no skips. A debugger reproduced
  the former mandatory-ID rejection. Query ambiguity and bounded misses remain
  failures, not permission to read outside the selected corpus.
- The existing Contract example lacked `domain` and `assumes`; compiling the
  `4ecf243` version is a negative control. Both corrected language examples now
  compile, explicitly retain `strength: witness`, and have equal digest
  `sha256:1d44391d7cacb049a5377b30e281c117d343eb2ea927e4115f181be239f382ac`.
  This is compiler acceptance/equal IR identity, not universal claim evidence.
- A temporary evidence probe first read nonexistent `compiled.ir.digest` and
  crashed. Debugger inspection established the actual
  `compiled.contract.contractDigest`; only the corrected native-zero run is
  counted. LSP reported `compiled: any`, illustrating why zero diagnostics alone
  did not validate that property access.
- The new Chinese report exposed a filename-check defect: the date/rolling-name
  check did not strip `.zh-CN` before checking. New fixture tests ran red at
  44 pass / 3 fail (47 total). One-line suffix normalization keeps undated names
  advisory and preserves the same severity; the expanded target set passed 89/89.
- Executing the bounded receipt example exposed its cross-domain dependency gap:
  valid CI/RCP use lists reference AG/STG/LTG outside that directory. The query
  actually failed closed; widened queries succeeded. Happy-path instructions now
  use the complete corpus; governance explicitly labels bounded failure/recovery.
  No valid references were deleted and lookup did not silently read outside scope.
- Governance's English translation exceeded 15,000 B; `docs:check` rejected it.
  Equivalent concise wording brought it under the existing ceiling; the ceiling
  was not increased and normative content was not moved to an exempt role.

### Reading units and author comparison

Nine CI/RCP groups now have both bodies and a shared companion: the CI root,
tracks, repository context, RCP parent, Contract/IR, verifier/receipts,
run-to-completion CLI, trusted baseline and narrow/full gates. Governance, the
maintenance Skill, reader-review, docs index and the lifecycle/terminology
owners also have their required companions/counterparts. This report is itself
paired. Memory-graph definitions were added at existing owners; that does not
complete the memory-graph prose backlog.

Author source/bilingual comparison covered:

| Unit | Conditions and limits compared |
| --- | --- |
| CI root | Test classification versus resource choice; exact pipeline entry/scope; full-plan versus full-product scope; 150-second whole-run budget; explicit advisory/skip/timeout attribution; owned commits. |
| Tracks | Command sets, lint/type/format surfaces, warning exceptions, anchor-only versus mutation execution, merge-base/AST identity, keyless isolation and coverage liveness. |
| Repository context | Optional lookup, capabilities and actual stable route IDs, no database/daemon/live calls, desired/observed/evidence identities and all three reconciliation states. |
| RCP parent | Truth owners, unauthenticated receipt limits, include-pruning/read-byte limits, authority, minimum WorkOrder fields, verification before terminal state and conditional continuous/extensions. |
| Contract/IR | Inputs/claims, domain/assumptions/strength and assertion identity; corrected examples do not become universal proof. |
| Receipts | Self-hash, work order/gate/scope/check/verifier bindings; incomplete JSON sketch is not a valid receipt; local integrity is not authenticated execution. |
| CLI | Read-only plan default, explicit authorized apply, interrupted-attempt recovery without harness replay, declared forge authority and optional identity-bound NMG feedback. |
| Trusted baseline | Reviewed external installation, src-only policy, independent rule approval, fixed candidate, every obligation actually runs, exits 0/1/2 and same-permission adversary exclusions. |
| Narrow/full | Shared-root escalation, exactly one owner route, strict nonempty/no-skip TAP, qualified `sharedChecks: none`, and full without an applicable authored Contract producing no RCP receipt. |

This is the author's comparison, not independent review or mechanical semantic
proof. Correct API/command literals remain; wrong examples are corrected against
their owner, not preserved for byte equality. Lifecycle scope remains explicit
or default-current. No RCP runtime or CI severity is changed.

### Link and test observations

A bounded audit first examined twenty CI/RCP/governance language targets:
459 baseline versus 471 current Markdown sources, 30 versus 40 inline fragment
edges, zero baseline-invalid and fourteen newly invalid occurrences. Those links
were repaired. Expanding to thirty targets, including policy/Skill/decision
owners, observed 64 versus 92 edges and zero invalid on both sides. That run
returned native zero and compiled both Contract examples. These counts precede
this report's Chinese counterpart; they are not whole-repository link counts.
The profile excludes fences/comments/inline code and covers ATX-derived Unicode
slugs, not full renderer, Setext/HTML/reference-link equivalence.

A fresh TAP run of `tests/tools/glossary-check.test.ts`,
`tests/docs/document-hygiene.test.ts` and `tests/docs/verify-docs.test.ts` passed
82/82 with zero fail/cancel/skip/todo and native exit zero. Latest document checks
before this report translation covered 445 files, zero errors/warnings; glossary
checks found 25 definitions in eleven discovered design sources, zero errors.
New companions outside that tool's design corpus do not silently expand its
admission scope. Definitions remain at their single owner.

After the Chinese report and filename fix, a fresh target run passed 89/89,
zero fail/cancel/skip/todo, native zero. Docs covered 446 files, zero errors and
warnings. The same thirty-target audit now observed 472 current sources/94 edges,
zero invalid, versus baseline 459/64/zero invalid. Six explicit use-only companions
outside automatic discovery were separately parsed and their 34 canonical uses
resolved uniquely against registered definitions. This does not expand automatic
check scope. All four edited TS/MTS source/test files and the temporary probe had
zero LSP diagnostics; compilation and executable checks remain separate evidence.

### Scoped verification checkpoint

Pre-commit run `a8b8f689-b5d0-4777-b368-cc8b277e3b79` actually passed all sixteen
selected blocking commands on the dirty owned inputs. Its native parent ran from
`2026-10-15T13:07:40.936Z` to `2026-10-15T13:09:26.427Z`, returning 0 with no
signal/error. This is not substituted for a clean run.

Functional checkpoint `dae398e50082e482defe084f8d539a1233da7ab7` contains the
prose groups and checker changes. A staged whitespace check had actually failed
on the new Chinese Created header's trailing spaces; native Git identified it.
Correction `49159d2989032650a4ee27a7fd5b68d1814a123a` uses blank lines without
changing either language's metadata. Native `git diff --check 4ecf243` then
returned zero. The temporary probe was removed before the functional commit.

Clean run `2c1c631b-a186-4be2-bd20-ba89530e479b` verifies `49159d2`, with the
same sixty owned paths passed explicitly and `--require-clean`. Native parent
execution from `2026-10-15T13:13:00.965Z` to `2026-10-15T13:14:49.324Z` returned
0, no signal/error; the tree was clean before and after. All sixteen commands
actually passed with child exit zero:

`docs:check`, `glossary:check`, `build`, `package:check`, `check`, `check:tests`,
`mutation:anchors`, `check:lock`, `lint`, `format:check`, `agent:context:check`,
`complexity:gate`, `verify:packages`, `check:policy-words`, `rtm:check`,
`test:product`.

Research/chaos were advisory skips, not passes. The report records the executed
product command/exit, not per-case TAP counts; no unrecorded count is inferred.
The command uses the existing watchdog, sixty paths recoverable with
`git diff --no-renames --name-only 4ecf243 49159d2`, and
`--require-clean --json --timeout-ms 300000`. Named local reports/native records
are optional artifacts; commits and this record preserve the required facts.
This subsequent evidence-only edit is not the code measured by that clean run.

No real user-repository trust installation, live provider, remote CI, push, PR or
merge is claimed. Repository-wide retained prose remediation remains open after
local checkpoints. The requested DSH comparison is deferred until NMG completion/
verification and authorizes findings first, not DSH edits.

## Memory graphs and state spaces: 2026-10-16 checkpoint

Functional commit `fe697a362aa7d045bd61b75695358a7af04dd412` changes twenty-five
owned paths from `225255086b3965a87993087a59f4867d476d7461`. Six reading groups
now have English, Chinese and shared term-use materials:

```text
docs/design/memory-graphs
docs/design/memory-graphs/session-runtime-graph-and-projection-revisions
docs/design/memory-graphs/theoretical-lineage
docs/design/memory-graphs/session-runtime-graph-and-projection-revisions/shared-task-board
docs/design/session-active-graph-runtime-design
docs/design/state-spaces
```

The review is an author comparison against old text, source and existing
contracts, not independent semantic review. The reader questions are where
provisional memory lives, how AG differs from a frozen retrieval projection,
how state is maintained and what counts as independent artifact acceptance.

### Facts corrected and preserved

- `src/core/stg.ts` and `src/cli/service.ts` establish one project STG file,
  session-private provisional rows and separate shared LTG-cache hints. Row
  filtering is not harness authentication or database-kernel row-level security.
- Cross-store consolidation uses `remember` plus `consolidated_from_stg` /
  `attributes.sourceMemoryId`; it does not promise equal physical record/node
  IDs across databases. Within-store residence changes retain their own identity
  contract. The overview no longer extends that promise across stores.
- `SessionActiveGraphRuntime` separates mutable session AG, task frames and frozen
  projections. `boardChannelId` is a design identity; board APIs use `taskId`,
  not a new argument. Public `activeGraphId` still identifies a projection.
- The state-entry decision and `state-spaces.md` own normal `nmg_state` access;
  internal Lab authority/RPC compatibility is not daily model-facing Lab use.
  Writer expiry retains text; clear/release removes live state, not old host
  messages. Fences do not authenticate or certify completion.
- Pi's grouped 16,000-UTF-16-unit output budget is implemented and distinct from
  the still-incomplete multidimensional AG construction budget. Preparation and
  carriage do not confirm final provider input or natural cost/quality benefit.
- Board claim, delivery, independent verdict and resolution remain different.
  `undecidable` is not `rejected`; a resolved self-report is not acceptance.
  Historical reads do not automatically stage current AG context.
- Filter telemetry counts returned candidates/survivors, not SQLite internal
  rows scanned or measured pushdown savings. Paired illustrative JSON parses,
  agrees and satisfies `selectivity = 1 - after/before`; the numbers are not a run.
- Theory/survey comparisons retain their references but do not prove research
  completeness, NMG superiority, unlimited recovery or calibrated defaults.
  No new online literature verification was performed.

Four new canonical word keys are `projection revision`, `task frame`, `Task Board`
and `state space`, without artificial IDs or a new namespace. Full-corpus
queries for `ProjectionRevision`, `任务帧`, `任务黑板` and `状态空间` resolved uniquely.
Directory-only lookup of the locally defined projection correctly failed on
external dependencies and requested a wider scope; it did not silently cross
that boundary. Automatic admission remains design-only: 29 definitions from
sixteen sources, not all retained companions. This evidence companion was separately
parsed: all 26 canonical references resolved uniquely; an unregistered-name
negative control returned no matches. It adds no automatic admission scope.

### Link and fixture evidence

The bounded probe compared 472 baseline and 478 current regular Markdown
sources against twelve explicit language targets. Selected fragment edges were
32 before and 40 after. Seven baseline-invalid source/link pairs and four newly
invalid state-space links were repaired in seven sources; final invalid count
was zero within that scope. An actual overview link changed to
`#missing-negative-control-heading` produced exit 1 and one new invalid edge;
restoration returned exit 0. This covers simple inline local fragments, Unicode
ATX slugs and duplicate suffixes, excluding fences/comments/inline code. It is
not Setext, HTML, reference-link or full-renderer/all-repository proof.

The paired concept map now distinguishes mutable AG from its projection, but
its remaining body/owner links and companion still need review. The harness
reference received only its carriage-fragment repair; stale tool/Lab/per-inference
instructions and its missing group members remain debt, not an exemption.

Isolated runtime fixtures: **80/80**, zero fail/cancel/skip/todo, native 0,
`2026-10-15T14:01:23.611Z`–`14:01:25.427Z`. Inputs were core STG isolated/v2,
session AG, working state and board-deliverable tests; CLI state/working-state;
and integration working-state client/input/context-information tests.
Documentation fixtures: **89/89**, zero fail/cancel/skip/todo, native 0,
`2026-10-16T03:10:23.955Z`–`03:10:25.660Z`, from
`tests/docs/document-hygiene.test.ts`, `tests/docs/verify-docs.test.ts` and
`tests/tools/glossary-check.test.ts`. No live provider/benchmark or real host GUI
is established. The temporary probe had zero LSP diagnostics and was removed
before the functional commit. Native `git diff --check` passed.

### Execution, reuse and clean verification

- Precommit run `5357e317-f2f5-47ef-b154-c9945b3f7e17` actually executed eight
  blocking checks on the twenty-five owned paths: `check`, `docs:check`,
  `format:check`, `glossary:check`, `lint`, `package:check`, `rtm:check`,
  `node-test:documentation`. All child exits were 0. Native parent:
  `2026-10-16T03:13:33.996Z`–`03:14:20.884Z`, status 0, no signal/error.
- Clean default run `ebb46c69-a885-434b-a8a6-496b824b1642` validated `fe697a3`
  but **reused** the existing operation receipt (`rcp.status = reused`). Its
  eight returned checks were not eight fresh executions. Parent status was 0,
  with clean before/after; no receipt was changed to force a result.
- Clean `--full --require-clean` run `0ee7342a-bcee-4caf-baa4-7f582cf1f18b`
  actually executed the documentation route's **two** declared blocking checks,
  `docs:check` and `glossary:check`, both child exit 0. Native parent:
  `2026-10-16T03:16:19.527Z`–`03:16:21.277Z`, status 0, no signal/error,
  clean before/after. This is not an eight-check rerun or full-product execution.

Final checks reported 452 documentation files, zero errors/warnings, and 29
terms with zero errors. Owned input paths are recoverable with
`git diff --no-renames --name-only 2252550 fe697a3`. Pass them directly to the
watchdog with `--json --timeout-ms 300000`; add `--full --require-clean` for the
clean declared-route run. `--` belongs to the npm wrapper syntax, not direct
Node invocation. An initial direct invocation with that separator was rejected
before checks ran; removing it succeeded. The Windows task runner also rejected
a shell heredoc before Node started; the portable `node -e` retry ran the fixtures.
A malformed codemode call made no tool calls. None is counted as test execution.

Named local artifacts use `.nmg/verification/memory-graphs-*`; this record,
source owners and Git preserve the necessary scope/results without those files.
This subsequent evidence edit is not the input measured by the functional clean
run. Repository-wide retained prose remains unfinished; DSH inspection stays
deferred and no DSH edit, push, PR, merge or remote CI is claimed.

## Translation contribution review: 2026-10-17

Two separately tasked workers supplied Chinese drafts and term-use files.
The reviewed subset comprises fifty retained experiment records across four
complete batches. Coordinator review compared all fifty complete source/draft
pairs and their term definitions before integrating one hundred new companions and updating the English owners:

- Experiment-root summary: `benchmark-results`.
- `benchmarks/`: `beam-100k-evaluation-2026-08-13`,
  `halumem-operation-evaluation-2026-08-11`,
  `lme-recall-headers-2026-08-04`,
  `locomo-evidence-mode-signal-2026-08-02`,
  `locomo-qpp-safe-prefix-2026-07-29`.
- `retrieval-quality/`: `gate-cascade-literature-2026-09-09`,
  `gate-certification-2026-09-09`, `relevance-gate-calibration-2026-09-09`,
  `sufficiency-shape-features-2026-09-12`, `baseline-2026-08-16`, `hybrid-2026-08-16`,
  `node-summaries-2026-08-24`, `chains-2026-08-24`,
  `chain-activation-2026-08-25`, `summaries-2026-08-18`,
  `compound-reference-2026-10-11`, `shared-output-2026-10-10`,
  `uuid-dedup-2026-10-11`, `lexical-tie-ranking-2026-09-30`, `status-2026-08-18`.

- `store/`: `consolidation-evaluation-2026-08-09`,
  `scale-evaluation-2026-08-09`, `write-path-scope-index-batching-2026-08-31`.
- `topology/`: `bpid-evaluation-2026-08-09`, `gate-evaluation-2026-08-09`,
  `namesakes-evaluation-2026-08-18`.
- `runtime/`: `matched-evaluation-2026-08-09` (also contains dated 2026-08-20 sections),
  `real-use-shadow-2026-08-09`.
- `context/`: `intervention-literature-2026-09-07`, `live-canary-2026-09-07`,
  `live-comparison-preregistration-2026-09-07`, `router-component-2026-09-06`.
- `retrieval/`: `hyde-pool-full-2026-08-04`.

- `execution/`: `task-semantics-design-cases-2026-09-13`,
  `task-semantics-slice1-2026-09-13`, `mast-coverage-2026-09-12`, `field-ownership-2026-10-01`, `ooo-retention-2026-09-13`,
  `ooo-round-transition-2026-09-13`, `ooo-run-namespace-2026-09-13`,
  `ooo-single-boundary-2026-09-13`, `ooo-task-tables-2026-09-13`,
  `ooo-transaction-port-2026-09-13`.
- `verification/`: `task-unit-semantics-ledger-readings-2026-10-14`,
  `full-gate-atomic-checks-2026-09-23`,
  `full-gate-parallel-static-2026-09-23`, `impact-probe-2026-09-23`,
  `document-byte-budget-rollout-2026-10-14`, `product-file-partitions-2026-09-23`.

Each basename has English, `.zh-CN.md` and `.terms.yaml` siblings. The final
reader-facing files, not private worker transcripts, preserve the review's
necessary evidence boundaries:

- The LongMemEval bridge comparison bypassed the changed Pi header renderer;
  unchanged bridge metrics do not validate that renderer or isolate judge noise.
- The lexical baseline's original per-capability count note totals 236, whereas
  its overall sample is 235. A later table totals 235 with a 39-question
  preference slice, but the original baseline slice counts remain unrechecked.
- R@5-to-R@20 curves alone cannot distinguish absent candidates from candidates
  below rank 20, or isolate a QPP benefit.
- The activation report's displayed rows retain about 25.5% of the any@20 gain
  with 39.5% of the *additional* characters, not 40% of both total quantities.
  A diagnostic counting ranked golds cannot rule out non-gold chain seeds or
  establish a universal chain-expansion upper bound.
- Shared stores alone do not isolate a causal effect; v1/v2 selector changes
  confound a pure arm comparison. Character counts and one short call per node
  do not establish billed-token or monetary savings.
- Terms distinguish historical configurations from runtime guarantees, sampling
  strata from mere type coverage, and STG consolidation from capability promotion.

The second batch additionally separates repeated/injected task observations from
independent evidence, gold-seeded prototype construction from label-free scoring,
and a selected-pair non-match fraction from an observed false-merge rate. The
read-only topology assessment and the separate forced-merge rollback probes are
now explicit rather than contradictory. Retained evaluator source was inspected;
that inspection is not a new historical-run or regression receipt.

The Namesakes intervals describe repeats over ten fixed entities, not fifty
independent entities. The canary and HyDE use same-model answering/judging;
temperature 0 is not repeatability or independent-judgment assurance. HyDE's
479-question recall denominator, 500 judged questions and rounded delta mismatch
are explicit, with original values retained rather than inventing missing counts.
External literature citations remain unverified research leads. The proposed
pre-registration lacks its suite/map, numeric grid, budgets and power details,
and has unresolved H1/§6 cost wording; it is not represented as a completed
prospective freeze. No missing experimental settings were chosen by this review.
For handoff integrity only, the twelve second-batch source-file hashes matched
the worker manifests before integration; that is not experiment verification.

The third batch keeps research `ooo_probe_*` storage separate from the product
`taskRun` contract. A retention pin preserves verdict evidence but does not
accept an artifact; the probe fact rows retain latest values rather than an
append-only attempt history. Transaction-port refusal is conditional on an
existing transition, not a ban on standalone portless publication. The
cancelled-round leak positions and local mutation recipes are historical leads,
not current defect or replay-availability confirmations. The field-ownership JSON
records a count of five models, one base revision and three source hashes, not
five individually listed model identities.

Verification summaries retain the unresolved 12.3-second prose value versus the
rounded 12.2/12.7-second table differences and the unresolved 100.0-second serial
row attribution to a 107.4-second companion row. The parallel table's seven
seconds is specifically 27.8−20.8 non-product time, offset by three seconds more
product time; the end-to-end difference is four seconds. Matching quoted timing
pairs across documents are not counted as independent replications without run
identity. Native child reports and timed-out outer wrappers remain distinct.
The RCP translation now distinguishes eight removed Git-initialization cases
from two fewer config child processes per remaining real-Git fixture. Source
inspection and historical DSH references are not a fresh runtime/DSH audit.
The third-batch source comparison was invoked, but its complete pre-edit result
was not recovered at this checkpoint; the earlier all-twelve-match statement is
withdrawn. The manifests retain per-file hashes, but no match is asserted for
the now-edited sources. One colon-containing anchor value in
`docs/design/design.terms.yaml` was quoted without changing its meaning; no YAML
or repository gate result is inferred from that edit.

All fifteen fourth-batch records (listed by owner above) now have complete
manual EN/ZH/terms comparison and integration. Consolidated checks remain deferred;
the three copy/reference units reuse the existing canonical reference/copy definitions. Read-only inspection of `memory-reference.ts` and
the service resolver confirmed prefix/quote matching and original short-quote
witnesses, not historical timing or test receipts.

The shared-output denominator is twelve fixture types × search/get surfaces:
24 paired surface cells, not two arms or 24 independent tasks. Its shrinking
condition excludes the explicitly unchanged folded-only envelope. Character
counts do not become billing/token measurements. Compound-reference rendering
uses a UTF-16 shortness guard; its original ID/short-quote witnesses do not freeze
the entire current body. The clean-postcommit obligation remains separate from
the completed precommit count. The UUID matrix reuses 100 IDs in 16 cells,
not 1,600 independent IDs; decimal length is a mean. Literal canonical-ID lookup
is distinguished from the separate graph-scoped reference resolver. RPC ownership
and live-target checks are also separated from the pure helper's caller-supplied
scope; its default target set does not refresh records. A translation
that changed absence of a promised no-extra-call recovery into an absence of any
need to promise it was corrected.

The fourth reviewed unit, `lexical-tie-ranking-2026-09-30`, now separates its
historical post-selection experiment from the already approved pre-budget
extension. `search-ranking.ts`, the retrieval call sites and the canonical
`pre-budget lexical tie-break` decision were read. The helper preserves its input
pool, but a pre-cap reorder can change the returned prefix; reported unchanged
R@20 is not a universal product guarantee. The existing decision remains the
algorithm owner rather than duplicating it in the experiment's vocabulary.
Its bilingual wording now clarifies UTF-16 evidence units and query-term document
frequency. The canonical compound-reference definition likewise says prefix AND
quote, not either one, and preserves the RPC/pure-helper distinction.
The 500-unit evidence slice is UTF-16, and the stated 100 MB budget has no
before/after resident-memory measurement in this record. The 1,540/1,532 LoCoMo
populations remain unreconciled; nineteen query rows are not proof of nineteen
independent tasks, missing negatives are not verified irrelevant labels, and
p=1.0 is not an equivalence proof. No local report or benchmark was rerun.

The next two reviewed units are the root `benchmark-results` snapshot and
`runtime/real-use-shadow-2026-08-09`. All three artifacts per unit were compared;
the source view included the configured runner preflight, cache wrapper, bridge,
headless helper, data-path resolver, dataset join and calibration gates. None of
those programs was executed.

The benchmark summary no longer presents its old version/checkpoints as current
runs or exact-resume guarantees. Official rows use a different answer/judge pair;
the mutable upstream URL and run/uncertainty details remain unverified. Temporal
`event_ordering` 21.73 versus 18.92 does not support a literal "no movement"
claim or isolate a narrative ceiling. Logical A/B 68.67 and full-run 66.57,
and summarization 46.52/69.74 across changed run sets, remain separate readings.
The eval-only default label does not establish current bridge defaults. Local stages are
not inherently zero-cost; preserved direct shell commands are historical and
routed to the current config-driven workflow. The current provider probe has
cache-only/no-provider exceptions and is not full-run health. Cache-only limits
embedding I/O, not answer/judge network calls.

The shadow report separates first natural use, later controlled episodes and
current source behavior. Nine outcome events are not nine successful tasks;
explicit Agent feedback is not independently verified claim support. Seeding
and a quieter second run do not isolate a causal effect. Current timers wrap
individual prompt/settling calls, not startup/result fetching/cleanup or total
helper lifetime. Awaiting child stop before owned-daemon shutdown is not an
all-crash guarantee. Historical controlled/ambiguous rows do not become valid
current natural-training rows by renaming; offline candidates remain non-active.
Collection switches, shadow-scoring eligibility and active/default authority
remain distinct. The docs index now calls the benchmark page a historical snapshot.

The reviewed `retrieval-quality/status-2026-08-18` separates its initial
checkpoint from 2026-08-24/25 follow-ups; it is not a current resume plan or
one-date account snapshot. Old 612+16 tests/tsc and v1 results do not prove
present receipts, v2 dominance or conservative bounds. Product calls do not
reproduce four retired benchmark arms. Cache/store persistence and old balances,
reset/fallback instructions are not current readiness or spending authority.
`+0 generated` alone does not diagnose quota failure; `reasoning` alone does
not prove ignored settings or extra billing/latency. The corrected chain owner
supplies 25.5% any@20-gain retention, 39.5% additional context and 58.9% total
context instead of mixed 40% denominators. Gold-only ranked-hit diagnostics do
not prove chain unreachability or deployability. Current TODO/protocol owners
supersede the old open list. No provider/store check or run occurred; quota
heading/term anchors were repaired. The incoming-anchor lookup covered
docs/skills/evals, not a consolidated link gate.

The eighth reviewed fourth-batch unit, `execution/mast-coverage-2026-09-12`,
is now explicitly a historical research-probe annotation, not natural failure
incidence or a product Task Board contract. Its 7/5/2 tally counts category
labels, not incidents or independent trials. Row 3.2 keeps the 9/10 survivor and
later 2-killed/5-survivor readings without inventing their population linkage;
if 2 were subtracted from 9, 7 would remain, not 5. The mismatch is unresolved.
Within-plan exclusion needs disjoint effects, one authority and candidate
worktrees; it is not OS isolation or protection from unplanned writers. Board
coordination exists even though the fixed composition path has no A/B dialogue.
Successful admitted completion is distinct from physically preventing termination.
The separately launched fixture processes are real, but their scripted behavior
is not independent model behavior. The external 28.5% observation has a different
denominator; it is not quantitative corroboration. Online references, original
logs and old source/test counts were not reverified. The source admission report
was read for scope, not executed. Only a bounded incoming-anchor lookup was used.
At that integration checkpoint the queue-derived remainder was 69, with seven round4
reports awaiting full review; the shared work plan preserves the other queues.

On 2026-10-18, `execution/task-semantics-design-cases-2026-09-13` and
`task-semantics-slice1-2026-09-13` were fully compared with their drafts/terms
and integrated. The current next-slice owner was read for the minimum cases,
finite cap and explicit unmodelled boundaries. Read-only compiler source/LSP
inspection confirms the current signature and its documented pure-input role,
not a test or full runtime integration receipt.

The 1444 product count remains its own historical reading; the ledger's 1457
and described 1446 → 1457 clock-window transition are not a matched run/tree
reconciliation. The local-script versus later `mutation:teeth` invocation is
left unresolved, not silently turned into an exact reproduction command. The
budget mutant was undistinguished under the old selected inputs because the
neighboring guard intercepted them. New cases distinguish it, so global semantic
equivalence is not established. The term/section no longer claims that no test
could catch it. Fused ranges count model events/legal orders, not elapsed-time
speedup, confidence intervals or demonstrated model-session reuse. A plan
permutation preserving IDs is not a text-merge or OS-write-isolation proof.
No-clock API checks are not a live timing measurement. The single-run namespace
limit is dated and routes to the later research namespace report, not a claim
about current product taskRun state. Missing parent-refinement mapping is still
distinct from the specific input-closure repair. Retention is a concrete reading
link rather than an unnamed branch prerequisite. All numeric tables and literal
commands remain, with their historical limits; no program was executed.
At that two-unit checkpoint the queue-derived remainder was 67, including five round4 reports awaiting
review; no new corpus-completeness claim or gate result is made.

Two colon-containing values in the current
`docs/design/task-unit-semantics.terms.yaml` were quoted without changing their
anchor meanings. This is a syntax repair, not a strict-parser/gate pass or
recovery of the six unknown predecessor contents. DSH wiring and all experiment
receipts remain dated observations, not new host acceptance.

The preserved tables and command blocks remain historical references. Original
experiment artifacts and the reported measurements were not independently
revalidated or rerun. No tests, lint, formatting, documentation/glossary/link
gates, benchmarks, provider experiments, commits or DSH edits were performed for
this contribution review. Consolidated verification remains pending; the earlier
receipts above do not cover these new inputs.

## UOp reference source review: 2026-10-17

The bilingual [UOp catalogue](../../design/design/learnable-routing-and-differentiable-query-graphs/uop-catalogue.md)
and its shared term file now describe the current internal `Op` keys. Read-only
inspection of `src/lab/autodiff.ts` and LSP symbol lookup identified the missing
`Sqrt`, shortened gradient names, two-dimensional rather than arbitrary-rank
shapes, whole-buffer reductions, positive floors and zero-norm handling. The
catalogue now separates these implementation conventions from mathematical
or runtime-activation guarantees. No numerical test, benchmark or repository
gate was executed; the source review does not replace consolidated verification.

## Tessera design source review: 2026-10-17

The [tessera design](../../design/memory-tesserae-design.md), its Chinese companion
and shared terms now distinguish the dated draft from the inspected schema,
write, query and service paths. Label/snippet FTS is not full-file indexing;
relocation still reads files and can scan up to 200 regular files. Single-line
first matches, skipped/unreadable files and the missing-root case do not establish
unique identity or project-wide absence. Late fingerprint backfill is not a
verified write-time snapshot, and a no-success pass can stop root-level backfill.
The bookmark query does not filter linked memory status; a metadata marker alone
gives no schema-free or cascading-lifecycle guarantee. Historical ticket 8 does
not certify present DSH cleanup.

The original five external comparisons were retained in a bilingual research
child, with their original URLs and survey date. They remain unverified leads;
architectural similarity does not validate NMG's cost, lifecycle or drift claims.
The 100% recall / 0.24% false-positive figures remain attributed to the original
file-scale discussion, not promoted to universal bounds or rerun results.
This was read-only source review and documentation writing, not a runtime,
security, external-literature or consolidated-gate receipt.

## Fourth-batch intake identity: 2026-10-17

Both frozen round4 manifests were read. Before coordinator edits, raw-byte
SHA-256 comparison matched all 15 English sources (G8/H7) and all 30 delivered
companions (G16/H14) against their per-file manifest values. The source identities
are recorded below so this observation does not depend on a private transcript.
This is handoff integrity only, not semantic acceptance, historical-run
revalidation or a repository-gate receipt. The earlier contribution-review scope
must not be extended to all these inputs merely because their hashes matched.

| Batch | Source under `docs/experiments/` | SHA-256 |
| --- | --- | --- |
| G | `benchmark-results.md` | `759a33d20491769f96d25746dcfea2ed81d542fda6682a1e24593a08b3a31144` |
| G | `execution/mast-coverage-2026-09-12.md` | `bece4fc3f2784ba1cfa025ff72e7c0d2717f085d9ab0213d9c91cfd55f3620a8` |
| G | `execution/task-semantics-design-cases-2026-09-13.md` | `e153f2cbb5954486779950d0f9ac928f845c70f4f78bb2e0547692d75023c03a` |
| G | `execution/task-semantics-slice1-2026-09-13.md` | `3cdf1ae396a7988605b43952ea5a055adb44cec7db4445b9fad0a61a73db25f9` |
| G | `retrieval-quality/compound-reference-2026-10-11.md` | `64cfc6baaa58d12bc6dd2b35ae7f1b09767921ba40ab99e9778812ff10055b4a` |
| G | `retrieval-quality/shared-output-2026-10-10.md` | `18e3879aa22959f6582632ad5a83a585a47426e54899dd217fcaa6e2b2627a6a` |
| G | `retrieval-quality/uuid-dedup-2026-10-11.md` | `923e961c77148d50b84a1a825afd1d0f7b564fd771f3e12d72c4a29ea9019a7b` |
| G | `verification/task-unit-semantics-ledger-readings-2026-10-14.md` | `77f07312358ed6fa6a61089095851a7fb9854c118d52c0fc3710ff61a62cab3c` |
| H | `retrieval-quality/gate-cascade-literature-2026-09-09.md` | `ce26ae3a7a2c0c649eb9e18d07bc44b1d684cb05e61985d71ac6dc106e6e9a5d` |
| H | `retrieval-quality/gate-certification-2026-09-09.md` | `0bba51ad561b0db30b9acdea3527e811ceab1564ddd7743e75607198333f45f6` |
| H | `retrieval-quality/lexical-tie-ranking-2026-09-30.md` | `e0f2f3ec307b58c9eb3ff285d1249228870c74a6a04f2c0f0871d31d9280fbc9` |
| H | `retrieval-quality/relevance-gate-calibration-2026-09-09.md` | `ce36bf83a03fa31d4635e3607b186c53e9f80205356fbbc3f8b455d4dfa85542` |
| H | `retrieval-quality/status-2026-08-18.md` | `5905638b499a49a87a2201f715c5064ab4052f4dcc86ed7dd4f910a159c8d93f` |
| H | `retrieval-quality/sufficiency-shape-features-2026-09-12.md` | `a420c2203837e84b6a35651233bffae9b35147ac174487f860f436f13fed563c` |
| H | `runtime/real-use-shadow-2026-08-09.md` | `cd42acc6b881bcb44f3bfbd8a50b508d6ca8e9c0996b30b08be0c1a9b526a646` |

## Planning inventory and fifth-batch allocation: 2026-10-17

A read-only filename inventory of existing Git-discovered Markdown (tracked and
non-ignored untracked files) found 360 source candidates after excluding Chinese
suffix/directory variants: 71 missing Chinese siblings, 74 missing term siblings,
and 74 incomplete filename groups. These are planning flags, not semantic
coverage or an admitted documentation-gate result; ignored material and alternate
legacy groupings still need scope review.

One flag is the retained `CLEANABLE-scratch-2026-09-19.md` in the speculation
run2 evidence directory. Its text explicitly permits deletion after a report
quotes the run numbers, so it is disposable working material with a stated
cleanup condition. It was left byte-for-byte unchanged, not deleted or silently
counted as an ordinary untranslated reading unit. At that inventory checkpoint, the remaining 73 candidates
split into 11 already-delivered fourth-batch units awaiting full review, 12
newly allocated fifth-batch design units (I6/J6), and 50 not yet allocated.
The 26 outside-`docs/` candidates include entry/operating material; their placement
is not a blanket exemption. DSH-related documentation remains held for scope
clarification, not authorized for editing by this inventory.

The machine inventory and work allocation are shared at
`C:/Documents/GitHub/nmg-doc-contributions/coordination/reader-inventory-2026-10-17.json`
and `reader-work-plan-2026-10-17.json`. Fifth-batch task references are
`1792226691093_000606` (I6) and `1792226691099_000607` (J6) on
`nmg-doc-writing-rollout`; only their separate `round5/<agent-id>/` contribution
roots may be written. Dispatch is not receipt or acceptance. All earlier roots
remain frozen, and consolidated verification has not begun. Subsequent benchmark
summary/runtime-shadow/status integration reduces the fourth-batch review queue to eight;
the work plan records that delta without pretending to rerun the full inventory.

Reading the closed-header contract also exposed an authoring mistake in the
new tessera design package: review notes were placed in the header, and its
research child introduced an unsupported `Survey recorded` field. The notes now
sit in body sections; the survey date remains in the research prose. This was
an EN/ZH author correction, not a header-check pass.

## Fifth-batch receipt and sixth-batch allocation: 2026-10-17

Both fifth-batch contributions were received and acknowledged for receipt only:
I6 result `1792242997088_000616` and J6 result `1792243003627_000617` on
`nmg-doc-writing-rollout`. Before coordinator edits, all 12 source hashes and
24 output hashes matched their manifests. I's manifest raw SHA256 was
`adfb69c63d3e34324b16b17987bc6d9a88acbfd50100438e56ba6bdea3894d1c`; J's was
`103d67b09585d3a01be02d8dbc5353c8ec0f4a2c0525d3da751c51f9de6863a6`, also matching its delivered digest.
This is file identity, not semantic acceptance, budget verification or a gate.
The raw comparison is shared in
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round5-intake-2026-10-17.json`.
All contribution roots through round5 and their manifests are frozen.

The source bindings below preserve the intake checkpoint; they are not claims
that later edited sources still have these bytes:

| Source | Pre-edit SHA256 |
| --- | --- |
| `docs/design/design/memory-graph-reasoner.md` | `788f54402ea843314cf183be1aa7c65bed08fb9501fc7f684fc2cfe2dc37a0a7` |
| `docs/design/design/session-reasoning-workspace-and-compaction-checkpoint.md` | `d57af7fbff5902949f3a5db075ca90f6cb6e424cf3f51a6f8a960b6386e41b3c` |
| `docs/design/design/stg-ltg-connectivity-and-provisional-memory.md` | `809b3cebd07ed274fc7254c4e84d6347bb85803501226bf9eb3d7ef8dbaf28c4` |
| `docs/design/design/active-graph-activation-and-consolidation/node-identity-and-reversible-canonicalization.md` | `acfef0e3ab1da5b9b4880dae9c9b723afaa7cd0647d5f3fa0205022352d6c39c` |
| `docs/design/design/active-graph-activation-and-consolidation/session-ag-and-projection-revisions.md` | `57c91af34e133a996544110f86996a7fc22692e8eb3778b83dc7aed1554bc3d9` |
| `docs/design/design/active-graph-activation-and-consolidation/edge-stability-and-structural-consolidation.md` | `e0d4cd46c3b83fde913419f595febc2c147e8e4788f44db32f823e533a7e89b5` |
| `docs/design/agent-convergence-feedback-design/executable-v1-specification-and-decision-gates.md` | `0cf9ea4502fece3e805ec4dd2beeb148e5af44df50badcbb978b230348d35220` |
| `docs/design/agent-convergence-feedback-design/existing-runtime-components.md` | `19d3fe22e2de10d13e869b711ae585cae597d1d110f9d20c57a648d6b5b28daa` |
| `docs/design/agent-convergence-feedback-design/harness-formalization/low-compute-router-candidate.md` | `5e1e0f0aa31a11fd43dcf6090697c824184fa3b5929de41b3a1a6a50518d1569` |
| `docs/design/agent-convergence-feedback-design/implementation-boundary.md` | `b493b5a5674d370836e0c35b30f55e12102b32cf854a34da9e23c0a83ddec389` |
| `docs/design/design/evaluation-and-falsifiable-claims.md` | `5d43dbeebccd1938d951cd5981e5073f22a77c3b1b5f92ac8a18cc06d292fa92` |
| `docs/design/session-active-graph-runtime-design/remaining-work.md` | `0ea41bf76fdde5e7386fbb29aba0b28d2390f5e19e9e66663ec9f34a4cfc0674` |

Fifth-batch semantic review remains pending. At its receipt checkpoint the
manually integrated count was 42 experiment units/84 companions. Worker findings are review leads,
not coordinator conclusions. In particular, absence of a design `Status` is
not itself an error: the existing contract defaults it to current. Review must
instead settle any concrete conflict with the document's scoped claims.

The sixth batch assigns eight distinct new sources each to K8
(`1792243238385_000618`) and L8 (`1792243238402_000619`). Their only writable roots
are their own `round6/<agent-id>/` under `nmg-doc-contributions`; shared NMG
sources, DSH and earlier deliveries remain read-only. The 16 selected sources
were individually checked for missing Chinese and term companions, not run
through a documentation gate. The shared work plan lists their exact paths.
At sixth-batch dispatch, the planning queue partitioned into 8 round4 reviews, 12 round5
reviews, 16 round6 assignments and 34 unassigned filename candidates: 70 total.
This is a queue delta from the earlier snapshot, not a new corpus completeness
claim. DSH scope holds and deferred consolidated verification are unchanged.

## Sixth-batch receipt and seventh-batch allocation: 2026-10-17

K8 result `1792244305344_000624` and L8 result `1792244112903_000623` were
acknowledged for receipt only. Independent raw-byte comparison matched all
16 source and 32 output SHA256 values against the manifests before edits.
K's observed manifest hash is `d2f44112be63388925ef30950ba51a8775048e3903cb0b48095b44b23bfd37eb`;
L's is `57bec6b07c9af19399610e4fa87ffed084d4385ddb940a52022ade5fb8698c20`,
also matching its delivered digest. Full comparison:
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round6-intake-2026-10-17.json`.
This verifies handoff identity only, not semantic correctness, budgets or gates.
All contribution roots through round6 and their manifests are frozen.

| Source | Pre-edit SHA256 |
| --- | --- |
| `docs/design/design/active-graph-activation-and-consolidation.md` | `64223d8b4e59ae4c3c0410652bbae59f827d44d12f38cf8511eeb58b72ea4244` |
| `docs/design/design/core-data-model.md` | `97292097a5b3908be83e5036f09521c76f44f540c8c858fd72924759d6f01cd6` |
| `docs/design/design/incremental-storage-and-index-maintenance.md` | `f18cdebaf07429a4a59d418ce0be5a95b5588e07eeb6d739f8176e77bc081fb8` |
| `docs/design/design/learnable-routing-and-differentiable-query-graphs.md` | `53a651e81d324e4f076e9009815a27a5c843fbcc90c2fc08d21ea8870ce269d6` |
| `docs/design/design/memory-graph-reasoner/differentiable-set-logic.md` | `bf666896c2d4c8c33ace45712d1ed66a23e26b34edbe725b6a6eed0e72a6f7df` |
| `docs/design/design/progressive-retrieval.md` | `2297c162e358405a11c36e18e96de4c34ad3734ef899d989e31d624fd7f3f214` |
| `docs/design/design/session-capture-and-write-path.md` | `790be930fce2b573e6e6a7db51f9e64f0caa88f11d2dbb81107cf96de70c9553` |
| `docs/design/design/product-boundary.md` | `4958692c6561170d3fc9c542cbf39a5ca3b11a9854ecc0a038af263b274f7346` |
| `docs/design/agent-convergence-feedback-design.md` | `d8bce541ab37189f39134975a8d644bed208323ea7426af5f83b227dfe3f84b0` |
| `docs/design/agent-convergence-feedback-design/harness-formalization.md` | `ebc69d352ce031eff4e2e87a28984163649d471387b170424c249c09826bf0cf` |
| `docs/design/completion-audit.md` | `7f1ab1475d2dfdeeb61ac4e29f52bc170a5dd34ff71f054c0cccc187c7878b61` |
| `docs/design/completion-audit/requirement-matrix.md` | `c2bdd0d2bebbd483c7db09921f00009f1a795a9f3352dcfdbbdac5f411772423` |
| `docs/design/design/evaluation-and-falsifiable-claims/offline-text-space-policy-optimization.md` | `e02f091c6082e3aa85d02fb195a48948324e77c1a0f4858dd5bc11a593c71208` |
| `docs/design/design/implementation-order.md` | `434670f8d28814adc79bfd8d44aec077906b78fef3c806cffcb07f37bb018e6a` |
| `docs/design/design/implementation-versus-target.md` | `ecf9fa70cabbae53d90e926df13aa23f5dbf615229e4f6b94cec8ab7788cdc3b` |
| `docs/design/design/product-boundary/agent-cli-and-resident-service.md` | `478f1e99cf6beb493b6f0432b762c26c626691b39236aa0f0b454e5260d0908f` |

No sixth-batch unit has been semantically integrated. At receipt, before the
later reviews, the manual count was 43 experiment units/86 companions. Source-issue lists are leads,
not accepted corrections. In particular, differently scoped completion claims
need not conflict, missing design Status defaults to current, and 2026-08-30 is
earlier than 2026-10-07/08 (the L manifest's direction was misstated).

Seventh-batch M8 (`1792244572845_000625`) and N8 (`1792244572858_000626`) each
cover eight new sources, listed in the shared work plan. Only each worker's
`round7/<agent-id>/` root is writable. Three sources already have Chinese
companions: protocol-governed-collaboration, verification-claims and root README.
Their existing Chinese must be compared and fingerprinted, not overwritten or
retranslated merely for variation. The archived design remains in bilingual
scope; maintained TODOs are not disposable. Entry/template machine-field and
packaging effects require review before integration. No source or loader edits
were delegated. AGENTS keeps its 5,000-byte ceiling, Skill entries 15,000 bytes;
ordinary READMEs and the archived design do not inherit the active-design ceiling.
At dispatch the snapshot-derived queue is 69: seven round4 reviews, 12 round5
reviews, 16 round6 reviews, 16 round7 assignments, and 18 unassigned candidates
(16 evaluation READMEs plus two DSH scope holds). This is not a new corpus audit.
No tests/gates/provider/network/daemon/Git writes or DSH edits were performed.

## Fourth-batch manual review closed: 2026-10-18

All five remaining reading units were compared in full across English, Chinese
and shared terms, corrected at the English owner and integrated. All 15 round4
units are now manually reviewed; rounds1–4 total 50 experiment units and 100 new
companions. This closes the fourth-batch writing/review queue, not the overall
rollout or deferred repository verification.

| Unit | Corrected boundary |
| --- | --- |
| `verification/task-unit-semantics-ledger-readings-2026-10-14` | Readings are tied to their recorded instruments, not one relocation revision. Added searchable historical sections; JSON-after-stdout-loss is not blanket no-log behavior. Named assertion, suite failure and timeout remain distinct. Worktree-local isolation is not shared-service isolation; the 31 LSP diagnostics and timings are not today's expectations. |
| `retrieval-quality/gate-cascade-literature-2026-09-09` | AND equivalence needs fixed per-item predicates over the same pool, not merely pure filters. Reordering can change a capped prefix's recall. Hard permission/validity filters cannot become learned features. Different datasets/units and unverified literature do not prove causal or universal superiority. |
| `retrieval-quality/gate-certification-2026-09-09` | The source builder's baseline explains 67 = 1 + (4+7)×6; 109 is the expanded lattice, not the same family. DROPS fails a repeated bound check, not necessarily alpha itself. 40.7%/52.5% question risks are below 63.0%, not worse; 87.2% is a different item metric. Pool coverage does not force ~34% selective risk at 10% acceptance. Item bootstrap is approximate; independence, family construction and held-out use matter. |
| `retrieval-quality/relevance-gate-calibration-2026-09-09` | Kept 9.00 top1/2.00 gap as unresolved score-unit evidence, not normalized guesses; 19/23 recalls are not independent users. 13.1%→20.3% is about 1.55x, not double; 81%→50% is 31pp. 0.438→0.521 recall is movement with a precision tradeoff, not "nothing moved". Score bands/ECE do not identify causes or authorize current defaults. |
| `retrieval-quality/sufficiency-shape-features-2026-09-12` | Marked assumed negatives beside all affected proxy results; missing positive qrels is unknown, not noise or proof of unanswerability. Fold reuse is not independent-task evidence; missing spread and 10/11-feature binding remain explicit. Some shape features retain units, and a coverage quantile is neither a risk guarantee nor production readiness. |

The inspected `certifyPoints`, `boundHolds` and `latticeSpec` paths and the
current relevance-training owner supply interpretation boundaries, not a new
run. The current protocol's manifest, train-derived candidate family, explicit
judgments and deployment-ineligible artifact requirements are separated from
legacy LoCoMo/qrels experiments. No source data was regenerated and no default,
parameter, admission rule or runtime implementation was changed. Historical
commands/tables remain as evidence, not authorized current reproduction recipes.

Residual historical unknowns remain named: raw artifacts and external sources
were not reopened, mixed score-path units are unreconciled, the sufficiency
feature-count binding is absent, and old counts/timings do not establish matched
runs. These limits are now part of the reader-facing claims rather than hidden
behind pass/ship wording. The bounded incoming-fragment lookup in docs/skills/evals
found no affected references; it is not a repository link gate. No test, lint,
format, benchmark, provider/network call, daemon operation or Git write ran.
DSH remains untouched and scope-held. The snapshot-derived queue is now 62:
12 round5 reviews, 16 round6 reviews, 16 round7 assignments, and 18 unassigned
filename candidates. That is queue accounting, not whole-corpus semantic coverage.

## Seventh-batch receipt and eighth-batch allocation: 2026-10-18

M8 result `1792294546294_000634` and N8 result `1792296637184_000637` were
acknowledged for receipt only. Independent raw SHA256 comparison matched 16
sources, 32 outputs and all three existing Chinese baselines before integration.
M's manifest is `dd8cb3de8fc7d4c9f58ec7ca2db0fff307c86d4fe9557dc24751dd90ca272e4a`;
N's is `05b4f0093d4cd2a3e67c15407e54c188bb1a521073603d970c39fd24f8a32948`,
also matching its delivered digest. The comparison is shared at
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round7-intake-2026-10-18.json`.
This proves handoff identity, not translation, semantic or gate acceptance.
All contribution roots through round7 and their manifests are frozen.

| Source | Intake SHA256 |
| --- | --- |
| `docs/design/archived/file-content-source-design.md` | `c1ec40d9c30335f864a7dd4a3991016df9049adf2932e5fb3d1c228b50b7ca5b` |
| `docs/design/improvement-areas.md` | `75c9334883a10e3c1ee1ffeb98a0e9cb75e848370e1170ae92d1463353a6d026` |
| `docs/design/predicate-key-canonicalization.md` | `8d5f562984e876bc024f7043e581102c1a7805593e9bfff232e98c0cac3ca467` |
| `docs/design/protocol-governed-collaboration.md` | `e2a22386c8b82332e30f50a05b153751f5ada41d015cec23d4d3e53f79a5370c` |
| `docs/design/skillopt-policy-optimization.md` | `3944a78f4d3c9e3da1be187a611b94c07f9bbd54fa66cc339a2d025dae1b08dd` |
| `docs/design/temporary-todo.md` | `f304222b0363798ceca09158df32408f74d4706bd44ff7dbc71e1df012ceff63` |
| `docs/design/temporary-todo/default-embedding.md` | `69b1a1cc61137e75bbf70fb916817f5963daa3471ca91a130a7fe337ece3d1bc` |
| `docs/design/verification-claims.md` | `8981176b3c8c732fea833d714e817515f7d5c968d87de38af3bed74287380575` |
| `README.md` | `e1920ce3c65526e46591d107efe2577887578b8af19b5ec70a25cf31a1f3e84c` |
| `.github/pull_request_template.md` | `7a789c1be6109e32bea7f9f7bc88e2317551db01518d468c2deb8964cf8ec1c6` |
| `.pi/skills/omnimemeval-eval/SKILL.md` | `afc74528775b5e04b82e1fe981e862af41007beddfff006fd22bfcb635693bfd` |
| `AGENTS.md` | `97df92c3854a4b310a700c1d62370e64b4d72db8a3a14f39f9ba4f2af3eb5bfd` |
| `claude-plugins/nmg-memory/CLAUDE.md` | `af129f149eb98c5931198c1176f1c5b9bf69e13a04118e958d8ccd3126e198bc` |
| `docker/README.md` | `f1f2ec65d20d4352175800ac6762ec15387ab68cf3725745223b82dbc50e725d` |
| `kimi-plugin/README.md` | `d65a4f6cacef379d14b9444b38feb150fbca2b69ae0b0f869ec1360237310a1c` |
| `tests/guardrails/README.md` | `2ccf567cf1931c81306de9b050734bbf5e11973cff47abc11003b99802a4f8a2` |

| Existing Chinese baseline | Intake SHA256 |
| --- | --- |
| `docs/design/protocol-governed-collaboration.zh-CN.md` | `c1ada895acd8b241d9be0903e1b63d0f81be2858aa8e139d1d8df86c73c9d249` |
| `docs/design/verification-claims.zh-CN.md` | `b60b314b01cc4d344760df3a26428dc8580d0cc254f2903613119d2da6420325` |
| `README.zh-CN.md` | `934ab6ea8a6d45502a1b6a5e7494b425f584bd68ce97db3b56efcde884dbdb7c` |

The source PR template and Kimi README are already Chinese; their delivered
Chinese copies are byte-identical to those sources. That preserves literal
machine fields but does not supply an English primary. English-owner remediation
for these same two reading units remains pending; they are not extra completed
pairs. Likewise, the N manifest's claim that CLAUDE.md has no automatic-loading
role is not accepted without host/packaging review. Existing root README,
protocol-governed-collaboration and verification-claims Chinese remain untouched;
revised drafts are to be merged only after comparison, not copied over baselines.
The manually integrated experiment total remains 50 units/100 companions.

Eighth-batch O8 (`1792296925694_000640`) and P8 (`1792296925703_000641`) cover the
16 remaining evaluation README candidates, split to balance the large OmniMemEval
and evaluation-strategy owners. Exact paths are in the shared work plan. Only
their own `round8/<agent-id>/` contribution roots are writable. Ordinary READMEs
do not inherit the active-design byte cap; long texts must be read/translated in
full, not truncated. Source-language or executable-example defects must be
reported; any English rewrite suggestion stays in a separately hashed contribution
draft, not the shared source. No evaluation command, provider call, installation,
download, gate or daemon operation was delegated.

The original snapshot-derived queue is still 62: 12 round5 reviews, 16 round6
reviews, 16 round7 reviews, 16 round8 assignments and two unassigned DSH scope
holds. The source-language debt is inside those existing review units, not an
exemption or a new completeness claim. Nothing here establishes whole-corpus
semantic closure, approves DSH changes or starts consolidated verification.

## Eighth-batch and first cross-review receipt: 2026-10-18

O8 result `1792300028059_000653` and P8 result `1792299915603_000651` were
received and acknowledged for file identity only: 16 sources and 32 companion
outputs matched their manifest SHA256 values. Both manifests matched the reported
or delivered digest, and neither delivery contained an unlisted file. Original
round8 roots are now frozen. This does not mean the units have been semantically
accepted or integrated.

The first peer-review delivery, `1792300075386_000654`, covers the six I6 units.
Its six current sources, 12 frozen peer inputs and four correction proposals
matched their listed hashes; its manifest matched the delivered digest. The
reviewer's dispositions are four changed proposals and two reviewed-no-change
units, not coordinator acceptance. Terminology reuse, restored fragments, a
Chinese companion link and a typo correction still require coordinator review.
Raw identity evidence for all three deliveries is shared at
`C:/Documents/GitHub/nmg-doc-contributions/coordination/round8-and-peer5-intake-2026-10-18.json`
(70 recorded file comparisons; no mismatches).

Both contributors acknowledged the continuous queues (`1792299698300_000646`,
`1792299707422_000648`). The shared work plan's `continuousDelegation` grants
bounded sequential drafting/cross-review, not final acceptance: each contributor
continues to the next authorized phase without per-batch user approval. Newly
delivered review roots freeze after each handoff. At receipt, 60 existing non-DSH units were pending coordinator semantic
integration. At the subsequent I6 checkpoint, the coordinator had reviewed and
integrated six units, leaving 54 (R5 J6: 6, R6: 16, R7: 16, R8: 16), with no
candidates added. The J6 acceptance recorded below reduces the current backlog
to 48 (R6: 16, R7: 16, R8: 16). The manually integrated experiment total
remains 50/100. The two DSH scope holds, English-primary debt for the PR
template/Kimi README, source-drift checks, unresolved evidence and deferred
consolidated verification are unchanged. No repository tests/gates or
provider/daemon/Git operations were performed for the earlier receipt.

## Coordinator semantic acceptance — R5 I6 (2026-10-19)

The coordinator compared the six frozen contribution units against their current
English sources, Chinese translations, v2 terminology records, and relevant
implementation contracts before integrating all 18 files. The peer reviewer
reported four changed proposals and two reviewed-no-change dispositions; those
were inputs, not acceptance. The coordinator accepted the justified proposals,
rejected the earlier no-change disposition for the session-workspace unit, and
made the following additional source-backed corrections:

| Unit | Coordinator disposition |
| --- | --- |
| `memory-graph-reasoner` | Accepted and integrated. Review of `src/lab/memory-graph-reasoner.ts` established that `requires` multiplies the traversal absorption gate by sigmoid similarities; missing facts fall back to 0.5, it does not hard-filter candidates, and `trainPath` does not apply it. Reused the existing canonical `Memory-Graph Reasoner` term rather than creating a duplicate. |
| `session-reasoning-workspace-and-compaction-checkpoint` | Accepted and integrated after material corrections: review of `src/lab/reasoning-workspace.ts` established that evidence references are only non-empty strings and their targets are not resolved or verified as stable/external; `add`/`update` enforce support anchoring but JSON restoration does not re-run that check. `src/integration/reasoning-workspaces.ts` uses file modification time, not recent reads, for cleanup; `.pi/extensions/nmg/index.ts` registers `session_before_compact`. July 2026 measurements are retained as historical documentation, not independently reverified here. |
| `stg-ltg-connectivity-and-provisional-memory` | Accepted and integrated. The Chinese cross-reference now targets the existing Chinese companion and names current section headings instead of a stale `§3–§6` range. |
| `node-identity-and-reversible-canonicalization` | Accepted and integrated; corrected the Chinese typo `提审议` to `提议审阅`. |
| `session-ag-and-projection-revisions` | Accepted and integrated. Restored the two Chinese heading fragments to existing localized headings and corrected a duplicated `through` in the English source. |
| `edge-stability-and-structural-consolidation` | Accepted and integrated after code review of `src/core/store/graph.ts`: the default gate requires four active evidence memories in total and separately checks that each of the two nodes is represented. The English, Chinese and term definition now state that threshold without implying four memories per node. The English claim and term definition also specify that this posterior gate is for automatic consolidation of an already stored atomic claim, not the separate governed immediate-admission path for a confirmed atomic memory. |

Integration adds English/Chinese/terms navigation for the retained units and
preserves the original contribution and peer-review roots as frozen evidence.
These are coordinator semantic dispositions, not consolidated gate receipts.
No tests, lint, format, LSP checks, benchmarks, or documentation gates were run;
consolidated verification remains deferred until writing and review settle.

## Coordinator semantic acceptance — R5 J6 (2026-10-19)

The coordinator compared all six units with the current English source, Chinese
translation, terminology sidecar, and relevant implementation contracts. The
delivery manifests and source hashes had been checked before shared-tree edits;
the delivery and peer-review roots remain frozen. Worker reports and hashes were
inputs, not acceptance. The coordinator integrated all six three-file sets (18
files total) after making the following source-backed changes:

| Unit | Coordinator disposition |
| --- | --- |
| `existing-runtime-components` | Accepted and integrated. `observe()` can admit explicitly supplied `reasoning_artifact` items as well as tool observations and board projections; `semantic_memory` and `working_state` use separate paths, while automatic MGR admission remains deferred. Tessera resolution limits are stated, and SimHash metrics are bounded to the earlier file sample rather than presented as snippet-level or universal guarantees. |
| `implementation-boundary` | Accepted and integrated; replaced a stale “Section 9” reference in English and Chinese with a link to the parent implementation boundary. |
| `low-compute-router-candidate` | Accepted and integrated after aligning all three files: the 132-parameter `ContextRouter`, `context-features-v1`, and four-action `context-executor` are separate research primitives, not an assembled, active, validated, or production controller. |
| `executable-v1-specification-and-decision-gates` | Accepted and integrated after clarifying the host authorization requirement, the current adapter's bounded return without main-model exposure, and whole-fragment truncation semantics. |
| `session-active-graph-runtime-design/remaining-work` | Accepted and integrated after clarifying that `maxTaskFramesPerSession` caps all retained frames including the active frame, disclosure limits are configurable defaults, and the separate `hierarchical-activation` retrieval mode does not mean AG admission/rescoring is wired. |
| `evaluation-and-falsifiable-claims` | Accepted and integrated after removing an unsupported causal attribution for the shadow-score difference, linking the detailed BEAM report, and stating that the reported 1,540 LoCoMo questions are not reconciled with the 1,532 scored-question denominator in the relevance-gate report. |

Implementation review covered the session Active Graph, RCP feedback and CLI,
ContextRouter/features/executor/trial/intervention/journal modules, and the
controller-shadow context dataset. These are coordinator semantic dispositions,
not unified gate receipts. No tests, lint, format, LSP, benchmark/eval, provider,
network, installation, deployment, daemon, or Git-write operations were run;
consolidated verification remains deferred until writing and review settle.
The overall rollout remains incomplete.

## Coordinator semantic acceptance — R6 K8 + L8 (2026-10-18)

The coordinator compared all 16 R6 units against current English sources,
Chinese translations, terminology sidecars and relevant implementation
contracts, then integrated the 48 companion/source files. K8 and L8 delivery
hashes establish handoff identity only; they were not treated as semantic
acceptance. The following corrections and limits are now in the shared tree:

| Unit | Coordinator disposition |
| --- | --- |
| `active-graph-activation-and-consolidation` | Accepted and integrated. Corrected navigation and the duplicate-heading Core data model anchor; aligned Chinese wording for cross-session AG, and retained session/branch, HA and MGR evidence boundaries. |
| `core-data-model` | Accepted and integrated. Clarified `observe()` and compaction as session-bounded AG projection rather than a separate FIFO buffer, implementation versus target, and unnumbered subsections; linked the current open-design owner. |
| `incremental-storage-and-index-maintenance` | Accepted and integrated after checking maintenance thresholds, global/local pressure, bounded event-loop slices and retry behavior against config, service and store code. |
| `learnable-routing-and-differentiable-query-graphs` | Accepted and integrated. Named the current controller runtime/QPP settings and calibration surface, and kept runtime mode distinct from shadow controls and research primitives. |
| `memory-graph-reasoner/differentiable-set-logic` | Accepted and integrated. Fixed the research README route and bounded probe results to their historical evidence. |
| `progressive-retrieval` | Accepted and integrated; specified `NMG_QPP2_RETAINED_MASS` and its 0.98 default in English, Chinese and terms. |
| `session-capture-and-write-path` | Accepted and integrated with current navigation and the corrected export command span. |
| `product-boundary` | Accepted and integrated after aligning abbreviated signatures, recall-trigger limits, logical withdrawal versus physical erasure, and current first-response-timing references. |
| `agent-convergence-feedback-design` and `harness-formalization` | Accepted and integrated. Replaced stale internal section numbers with named links, corrected a Chinese mistranslation, aligned exploration-action notation, and kept design claims bounded. |
| `completion-audit` and `requirement-matrix` | Accepted and integrated; updated the stale audit date and corrected the surface-anchor translation while preserving the matrix's implementation/evidence boundaries. |
| `offline-text-space-policy-optimization` | Accepted and integrated. Linked the SkillOpt owner and recorded the unreconciled seven-question LongMemEval and 1,540-ingest/1,532-scored LoCoMo reports without inventing a cause. |
| `implementation-order` | Accepted and integrated. Defined the local scope of “Complete” labels and identified `nmg.v7` as historical relative to the current `nmg.v9` protocol. |
| `implementation-versus-target` | Accepted and integrated. Removed stale FIFO wording, aligned the reasoning workspace's Opt-in Lab capability with its non-default Lite boundary, and linked the current posterior-confidence heading. |
| `product-boundary/agent-cli-and-resident-service` | Accepted and integrated. Fixed the H1-to-H3 heading skip and clarified the `taskRun`-gated `adopt` compatibility rule against `src/cli/protocol.ts`. |

Integrity exception: during integration, the coordinator accidentally edited the
frozen K8 `active-graph-activation-and-consolidation.zh-CN.md` and L8
`agent-convergence-feedback-design.zh-CN.md` contribution files, then immediately
restored them. Their SHA-256 values matched their delivery manifests after
restoration (the L8 file hash was `d7e741777198eb167253b73a9ee63b8bde710ad66e403064bf7ee6cd23e3bf0d`).
No further contribution/reviewer-root writes are permitted; the original roots
remain frozen.

This is coordinator semantic acceptance, not a byte-budget result or unified
gate receipt. No tests, lint, formatting, LSP, documentation gates,
benchmarks/evals, provider/network calls, installation, deployment, daemon
operations, or Git writes were run. At the R6 checkpoint, 32 existing non-DSH
units remained (R7: 16, R8: 16), plus two DSH scope holds. Unified verification
remains deferred until writing and review finish.

## Coordinator semantic acceptance — R7 M8 + N8 (2026-10-18)

The coordinator independently compared all 16 R7 units against current English
(or Chinese-primary) sources, delivered Chinese, terms sidecars and applicable
implementation evidence, then integrated 48 source/companion files. The
handoff manifests and hashes were treated only as identity evidence. Key
coordinator dispositions:

| Unit | Coordinator disposition |
| --- | --- |
| `archived/file-content-source-design` | Accepted and integrated as a superseded design record; preserved the explicit non-memory, bounded-scope and deferred structured-unit boundaries. |
| `improvement-areas` | Accepted and integrated as historical gap analysis. Source contradictions and dated measurements remain identified rather than silently reconciled; corrected the terms definition to match the summary's resolved/reopen wording. |
| `predicate-key-canonicalization` | Accepted and integrated. Preserved the chronology from the initial polarity-guard proposal to the later result that arbitration pairs must not be polarity-guarded; retained the weak-model verification limit and advisory-only status. |
| `protocol-governed-collaboration` | Accepted and integrated; kept the ownership row's split between complete mechanism and unassigned restart responsibility, and corrected Chinese-owner links. |
| `skillopt-policy-optimization` | Accepted and integrated with the controller-only policy boundary, natural-label requirements, and held-out plus matched promotion gate intact. |
| `temporary-todo` | Accepted and integrated; preserved all unchecked work and explicit deferral prerequisites. |
| `temporary-todo/default-embedding` | Accepted and integrated after checking `NmgService.#signalMaintenance` and `#drainEmbeddings`: embedding top-up runs per operation independently of maintenance thresholds, with a bounded batch and provider cooldown. Relabelled the stale pre-change blocker and criteria as historical; this review did not rerun provider or end-to-end checks. |
| `verification-claims` | Accepted and integrated; kept literal pseudo-code, claim-domain scope, and the separate `decision`, `witness`, and `documented-only` axes. |
| `README` | Accepted and integrated; compared the full revised Chinese text with current English and the previous Chinese baseline. Corrected the English slogan's extra emphasis markers, added reciprocal terms navigation, repaired the Chinese first-response-timing target, and corrected “bundled local model” and opening tagline wording. |
| `.pi/skills/omnimemeval-eval` and `AGENTS.md` | Accepted and integrated; preserved skill discovery metadata, command literals, and the bootstrap entry's scope. |
| `docker/README` and `tests/guardrails/README` | Accepted and integrated; kept container/provider health boundaries and the temporary-guardrail lifecycle intact. |
| `.github/pull_request_template` and `kimi-plugin/README` | Same-language companions and terms were integrated, but these source bodies are already Chinese; their English-primary documentation debt remains open and is not counted as translation coverage. |
| `claude-plugins/nmg-memory/CLAUDE.md` | Translation integrated without endorsing its two source errors (self-referential restart instruction and malformed alternative-install sentence). The plugin manifest does not list this file, but host/package auto-loading behavior was not established; the delivery's no-autoload claim is not accepted. |

At the R7 checkpoint, 16 units were accepted and 16 existing non-DSH units
remained (R8: 16), plus two DSH scope holds. This coordinator disposition is
not a byte-budget result or unified gate receipt. No tests, lint, formatting,
LSP, documentation gates, benchmarks/evals, provider/network calls,
installation, deployment, daemon operations, or Git writes were run.
Contribution and reviewer roots remain frozen.

## Coordinator semantic acceptance — R8 O8 + P8 (2026-10-18)

The coordinator compared all 16 R8 evaluation README units against current
English, delivered Chinese and terms sidecars, then integrated 48 source and
companion files. Delivery hashes and reviewer reports were inputs only, not
acceptance evidence. Dispositions and bounded caveats:

| Unit group | Coordinator disposition |
| --- | --- |
| O8: `evals/omnimemeval/README` | Accepted and integrated. Kept historical runs distinct from current defaults, and preserved the separation between cold end-to-end `search_duration_ms` and warm core-sidecar timings. Clarified that official PersonaMem prompts remain unchanged while prefix-layout advice applies only to non-official runners. Current bridge/cache code was inspected; historical scores were not rerun. |
| O8: `evals/omnimemeval/research/README` | Accepted and integrated; kept the fake API's serialized byte-prefix estimate separate from provider token-cache semantics. |
| O8: `evals/adaptive-topology/README` | Accepted and integrated with a note that the historical 2026-07-19 metrics have no cited artifact path and cannot be independently reproduced from the README alone. |
| O8: `evals/beam/README` and `evals/locomo/README` | Accepted and integrated; clarified official dataset downloads are not bundled. The BEAM `100K` directory and `100K/128K-scale` wording still lacks a clear relationship and remains a source clarification debt. |
| O8: disclosure, gate and memory-quality READMEs | Accepted and integrated; retained bounded deterministic/no-LLM scope without promoting the probes to broad capability guarantees. |
| P8: `evals/README` and adapter READMEs | Accepted and integrated; preserved distinctions among deterministic engineering cases, backend benchmark execution, and Pi end-to-end gates, along with fail-closed metrics and historical-evidence limits. |
| P8: `evals/retrieval/README` | Accepted and integrated; corrected all six broken experiment links in both English and Chinese to the existing `docs/experiments/retrieval-quality/` paths. |
| P8: LongMemEval, controller, hierarchy-scale, PersonaMem, reasoning-workspace and scale | Accepted and integrated; retained manifest/sample rules, official versus diagnostic evidence, candidate/ranking limits, synthetic/local measurement boundaries, Lab-only scope and cost/quality tradeoffs. |

English source READMEs now link to their Chinese and terms companions; Chinese
navigation labels link to the Chinese files. The two R8 batches contribute 16
accepted units, leaving no filename-derived non-DSH units in the current queue.
The coordinator also resolved the separate English-primary debt by translating
the PR template and Kimi README source bodies, retaining their Chinese
companions, correcting the Kimi three-functions wording, and updating terms
anchors. This does not resolve the two DSH holds, recover unknown predecessor
terms, or establish the unresolved CLAUDE.md host/package auto-loading behavior.
No tests, lint, formatting, LSP, documentation gates, benchmarks/evals,
provider/network calls, installation, deployment, daemon operations, or Git
writes were run. Unified verification remains deferred until writing and review
finish.

## Continuous document-group regression check (2026-10-18)

The first continuous-maintenance slice adds `scripts/verify-document-groups.ts`
to the existing `docs:check` command. It discovers the union of English,
Chinese and terms files under `docs/` and `skills/`, plus the root README,
and rejects missing/non-regular members, new single-language topics and orphan
companions. The CI owner records the sole cleanup-bound scratch exception.
No section hashes, translation-quality gate, new prose template or DSH change
was introduced. Existing link and glossary checks retain their own scope.

Verification on the dirty writing-rollout tree, not a clean-checkout receipt:

- Direct group check: 333 groups, zero errors, one declared disposable scratch.
- Four target suites (`document-groups`, `document-hygiene`, `verify-docs`,
  `glossary-check`): 105 tests, 104 passed, one failed, zero skipped. All 16
  new group cases passed, including a fixture that runs the package-owned
  `docs:check` composition: structural checks pass, losing a companion exits
  one, and repairing it exits zero.
- LSP: zero diagnostics across the two new TypeScript files. Scoped ESLint,
  Prettier and owned-path whitespace checks passed.
- Repository `docs:check`: failed in its existing structural stage with 26
  errors and seven warnings, before the new group stage. Remaining errors
  include unsupported historical status/header fields and the oversized
  `task-unit-semantics.md`; this is not a unified pass.
- `glossary:check`: 363 definitions, 171 errors. The failing repository
  glossary test exposes existing missing status fields, stale owner headings
  and unresolved references. Debugger inspection confirmed these arise during
  catalog loading; no schema was weakened and no definitions were invented.

An initial duplicate admission-table row pushed the governance pair above its
existing byte ceiling; it was removed in favor of the authoritative CI table.
The restored governance files measure 14,995 and 14,984 bytes. The composition
fixture also required real script paths rather than junction aliases, because
an alias changes `argv[1]` while `import.meta.url` names the real module; its
documents must contain body text to pass the pre-existing hygiene check.

No full product suite, `agent:verify`, benchmark/eval, provider/network call,
installation, deployment, daemon operation or Git write was run. Next work is
to repair the recorded documentation/terminology debt without changing check
severity, before adding more rules or claiming rollout verification.

## Existing-debt cleanup (2026-10-19)

This follow-up addresses the failures recorded above on the same uncommitted
writing-rollout tree, at HEAD `823d96e9`. It does not replace the dated first-slice
results with a retrospective pass.

- Unsupported narrative status/header labels became ordinary prose; required
  lifecycle fields remained. Missing term statuses, quoted YAML values, aliases
  and exact owner headings were repaired without changing the schema.
- Twenty existing definitions moved into already registered design sidecars;
  their former locations now reference the canonical entries. Duplicate concept
  definitions were consolidated, the broad edge-activation alias was narrowed,
  and historical record-level polarity was distinguished from current claim
  metadata. Twenty additional entries explain source-supported existing uses,
  including the synchronous embedding interface and explicit execution tool
  sets. Canonical terminology does not establish runtime integration. This is
  not recovery of the six unknown predecessor files.
- The complete task-refinement and deterministic-concurrency sections moved to
  `docs/design/task-unit-semantics/refinement-and-concurrency.md` and its Chinese
  companion, with a terms sidecar. Comparison with the pre-split review snapshot
  retained both sections' text in both languages, apart from trailing blank
  lines. Parent headings remain inbound anchors and route to the child. Parent
  sizes are 14,605 / 12,502 bytes; child sizes are 3,287 / 2,679 bytes (English /
  Chinese). No byte ceiling was raised.
- Three regression cases first failed on the existing checker: the translated
  subtree instruction entry was misclassified; multiple reciprocal links were
  not parsed; and body examples were treated as metadata. Debugger inspection
  confirmed that the existing two-target retirement header produced no match
  under the single-link pattern. The repaired parser checks every target inside
  the header, while missing reciprocals and genuinely unplaced content still
  warn. It then exposed a real missing retirement backlink in each language;
  those were added after reviewing the retirement decision's stated scope.
- The whitespace check exposed thirteen trailing-space lines. Unnecessary
  paragraph-end spaces were removed; two metadata pairs now use blank lines to
  preserve separate rendered fields without trailing-space hard breaks.

The local verification batch is bounded to the named checks:

| Check | Result |
|---|---|
| `npm run docs:check` | 669 files, zero errors and warnings; 334 document groups, zero errors, one declared disposable scratch |
| `npm run glossary:check` | 422 definitions, zero errors; registered discovery scope unchanged |
| Four suites: `document-groups`, `document-hygiene`, `verify-docs`, `glossary-check` | 108 tests passed; zero failed, cancelled or skipped |
| Targeted LSP | Zero diagnostics across both checker/test pairs |
| Scoped ESLint and Prettier | Both checker/test pairs passed |
| Owned-path `git diff --check` | Exit 0; six nonfatal line-ending normalization notices, no configuration changes |

The suites ran with `node --experimental-strip-types --test` against
`tests/docs/document-groups.test.ts`, `tests/docs/document-hygiene.test.ts`,
`tests/docs/verify-docs.test.ts` and `tests/tools/glossary-check.test.ts`.
The 79 implemented decisions and 31 decisions with open items remain separate
counts; passing documentation checks does not resolve those open items.

Schema, severity, registered glossary scope and byte ceilings were not relaxed.
No section hashes, prose templates or DSH changes were introduced. No full
product suite, `agent:verify`, benchmark/eval, provider/network workload,
installation, deployment, daemon operation or Git write was performed.

## Limits

The check does not extract all natural-language term uses, generate the product
concept map, detect new concepts at creation time, or pin terminology policy in
an external trusted install. Section-confirmation hashes remain disabled.

The registered, authorized non-DSH queue has been reviewed and integrated;
the named local documentation checks pass, and no failed acceptance item has
been identified within that task scope. DSH scope holds and unresolved
predecessor-inventory facts remain explicit boundaries, not grounds to call
this scope unfinished. This report does not establish out-of-scope coverage,
whole-repository writing-quality or reading-efficiency measurements, remote CI
or full-product verification, nor impose them as additional completion gates.

## Mainline integration for PR 93 (2026-10-19)

The isolated documentation branch integrates main `1534e98acbdd93f037d128b5ee0ce8720abf3234` for [PR 93](https://github.com/wefio/NodeMemoryGraph/pull/93). All 48 documentation conflicts have explicit working resolutions. Relative to that main revision, runtime implementation and lockfiles are unchanged: the non-document changes are the eight documentation checker/test files and the package-owned documentation command.

Upstream storage, SQL filtering/binding, selected-evidence lexical ordering, declaration recovery, test-resource and automatic waiting-budget facts are retained at their split bilingual owners. Historical pre-budget ranking and retained source-only feature/incident records remain explicitly scoped rather than advertised as current mainline implementation. The recovery account distinguishes nine declared SQLite scenarios from migration or real-process proof.

The continuous group check exposed 24 missing companions imported from main. Eighteen term companions and six Chinese reports complete those groups. The long Chinese behavioral-composition report now has a complete English primary, retaining measured tables, commands, historical failures, proof limits and existing inbound anchors. Definitions remain in the registered design-sidecar scope. Protocol table padding was removed without changing its cells; eleven trailing-space lines were repaired while retaining separate rendered fields.

| Integrated-branch check | Observed result |
| --- | --- |
| `npm run docs:check` | 711 files; 0 errors, 0 warnings; 355 groups, 0 errors, 1 declared disposable scratch |
| `npm run glossary:check` | 433 definitions; 0 errors |
| Four focused documentation/glossary suites | 108 passed; 0 failed, cancelled or skipped |
| Eight owned TypeScript files | 0 LSP diagnostics; scoped formatting and ESLint completed |
| PR diff whitespace and conflict markers | No trailing-whitespace diagnostics or working conflict markers |

These observations belong to this integration worktree, not the earlier source workspace. They do not reuse its full-verifier receipt. Full local verification, remote checks and publication status are reported separately on PR 93; an unexecuted step is not a pass. Dependency installation, deployment and live provider/benchmark workloads were not performed for this section. The previously accepted queue remains complete within its authorized scope.
