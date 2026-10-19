# Active-design byte-budget rollout

[English](document-byte-budget-rollout-2026-10-14.md) | [简体中文](document-byte-budget-rollout-2026-10-14.zh-CN.md) · [Terms](document-byte-budget-rollout-2026-10-14.terms.yaml)

Evidence boundary (2026-10-17 documentation review): all timings, test counts,
check outcomes and tool/route descriptions below are historical observations on
their recorded inputs. They are not fresh checks of this documentation worktree.
No suite, gate, coverage run or benchmark was executed to produce this translation
review; missing run identity or snapshot details remain explicit uncertainties.

**Source baseline:** `270d9e3bbaa0548b17ee996a2261253e3fce841a`, isolated branch `feat/documentation-byte-budget-rollout`.
**Policy owner:** [CI contract](../../README.md#ci-contract). [Lifecycle rationale](../../decisions/implemented/2026-08-24-documentation-lifecycle.md) records alternatives and costs; this file records observations, not another rule owner.

## Original-input refusal

The prior verifier budgeted seven named standing entries, not active design prose. The role extension keeps the existing 15,000 B threshold, applies it to all active design Markdown including newly created nested topics, and discovers all Skill entries rather than five named ones. The 5,000 B AGENTS/decision-index budgets are unchanged. Archived designs, experimental source evidence and Skill reference material retain their distinct roles.

Six new regression cases ran against the original checker first: 37 tests, 33 pass, 4 fail. Those four failures were a newly named design at 15,001 B, an oversized new nested topic, Chinese UTF-8 bytes exceeding the cap despite fewer than 15,000 characters, and a newly named Skill entry. Exact 15,000 B acceptance and historical/evidence role boundaries already passed. After the checker extension, all 37 passed.

Before any of the long source files was changed, the real `npm run docs:check` exited **1**, with **21 byte-budget errors** and no warnings. Representative original inputs:

| Original path | Original UTF-8 bytes |
| --- | ---: |
| `docs/design/design.md` | 200,588 |
| `docs/design/task-unit-semantics-obligations.md` | 206,542 |
| `docs/design/task-unit-semantics.md` | 61,514 |
| `docs/design/ooo-execution-bootstrap.md` | 55,352 |

The 200,588 B reading belongs to `design.md`, not `task-unit-semantics.md`. Each of the 21 original inputs was compared exactly with its baseline Git blob, and its SHA-256 recorded before relocation. Synthetic fixtures supplement this real rejection; they do not replace it.

## Responsibility relocation

Whole existing chapters moved together. Largest responsibilities were routed first; neighbouring small explanations stayed in their current owner. A chapter that remained too large was divided at its own existing subsections, not at equal byte or line intervals. The lifecycle obligation table was divided into Store/port/borrowed-view obligations and host/run-record/daemon-client obligations, retaining each complete row.

The operation produced 106 document outputs: 21 original entries, **84 new active-design topics subject to the same 15,000 B budget**, and one dated historical-reading record. Markdown table column padding was removed without changing cell text. This was not a substitute for splitting or a ceiling increase.

The one evidence relocation is the ledger's historical `Verification commands` block. Its original instrument names, historical failures, fixes, caveats, timings and counts are preserved in [the reading record](task-unit-semantics-ledger-readings-2026-10-14.md), with navigation in both directions. Current obligation rows and normative design prose remain in budgeted design units; they were not moved into an exempt experiment folder.

Parent entries link the complete responsibilities, and children link their parent scope. Required definitions remain explicit local references rather than a blanket instruction to read every parent page. Twenty-three existing Markdown incoming references were redirected. Seven existing terminology pointers were updated to actual contract owners, retaining all names and aliases.

## Verification and limits

A separate conservation probe checked all 21 original Git hashes and every original nonblank source-line atom, with table alignment normalized, heading level ignored and local link targets canonicalized. All source atoms remained. Obligation row IDs retained exact multiplicities; a negative control deleting the D1 row was rejected. This is a bounded textual check, not proof of semantic equivalence or writing quality. The probes were one-time tools, not a new documentation platform.

The first post-move check found three body labels mistakenly exposed as frontmatter, one angle-bracket external URL incorrectly re-rooted, and six stale glossary owner anchors. Those failures were repaired rather than bypassed: subsection headings delimit the metadata region, the external URL remains external, and glossary pointers resolve to their new owners.

After repair, `docs:check` reported **431 files, 0 errors, 0 warnings**; `glossary:check` reported **17 terms, 0 errors**. The combined verifier/hygiene/glossary target suite passed **67/67**. LSP diagnostics for edited verifier/test code and both temporary probes reported zero.

A separate bounded Markdown-fragment audit compared the baseline's 372 Markdown files with 458 after relocation. It recognized 162 baseline and 165 current fragment edges and found no newly broken targets. Sixteen pre-existing broken edges remained identified as baseline issues, not silently counted as valid; the parser is not a general Markdown semantic validator.

The next two entries describe completed native check reports with timed-out
outer task-tool wrappers; neither is a successful outer-tool invocation.
On 2026-10-15 the full scoped run `c4d265e0-793d-43fb-b1fc-057f10e87108` completed all **16 blocking checks**, each with native exit 0 (`04:10:00.564Z`–`04:11:46.013Z`). Research and chaos remained advisory skips. The outer task-tool invocation later reported a timeout despite the completed native evidence; that wrapper invocation is not reported as successful. Subsequent EOF-only cleanup removed extra blank terminal lines, and `git diff --check` passed.

The post-cleanup run `2ad387f7-54c0-47d1-8a8d-0610476dae0a` again completed all 16 blocking checks with native exit 0 (`04:19:38.283Z`–`04:21:39.151Z`); its outer task tool also timed out. A direct Bash invocation of the watchdog's dry-run exited 0. No cause for the outer-tool discrepancy is claimed.

The final synchronous documentation check reported **432 files, 0 errors, 0 warnings**; the term catalog remained **17 terms, 0 errors**. Both temporary probes were removed.

A post-commit metadata review found five original draft designs whose split topics had omitted `Status`; absence means `current`, not inherited draft status. The affected topics were explicitly restored to `draft`, and source-derived status checks cover all split topics. Textual atom conservation alone had not detected that metadata-scope change.

Final clean functional verification used commit `55fe90bf4ef7a11b8c785247ee2af323cd2e4963`, all 138 owned paths and `--require-clean`: run `f473bfe2-f313-4314-b99b-c6ac9557682b` (`04:32:01.239Z`–`04:33:30.397Z`). All 16 blocking checks executed successfully; both the watchdog and the direct Bash wrapper exited 0. Research and chaos were skipped by policy. This clean run includes the draft-status correction, not just the earlier text relocation. That receipt belongs to the named commit and input paths, not later prose,
Chinese companions, term additions or this review's continued dirty worktree.

This records a real red-to-green budget transition and automatic coverage of new design/Skill entries. It does not claim measured reading-time savings, prose quality, semantic equivalence, remote CI, external review, or execution of the historical/live experiments.
