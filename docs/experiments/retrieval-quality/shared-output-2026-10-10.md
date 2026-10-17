# Shared output wrapping — 2026-10-10

## Questions and frozen comparison

Registered before implementation. Does shorter shared search/get copy reduce
visible text without removing candidate content, interpretation safeguards, or
exact-read guidance? This does not test retrieval relevance or answer quality.

- Baseline: `94ca7e8f8000fb275e73961b25ba0c517e2f63df` in the main checkout.
- Candidate: isolated `perf/shared-recall-output`, starting at the same revision.
  The lexical-budget slice is not included in either arm.
- Supply identical synthetic `MemoryContext` records to both arms; do not run
  retrieval, live providers, model judges, or benchmarks. Compare shared
  projections, unwrapped search/evidence bodies, and wrapped search/get text.
- Change only shared disclosure copy in `src/prompts/nmg-prompts.yaml`. Keep
  candidate fields, order, full IDs, preview length, budgets, exact-read APIs,
  structured diagnostics, disclosure bookkeeping and host history unchanged.
  Regenerate runtime prompts through the existing generator.

## Fixed cells

| Cell                        | Protected information                                                    |
| --------------------------- | ------------------------------------------------------------------------ |
| Healthy empty               | Empty-result semantics; no extra wrapper                                 |
| Degraded empty              | Lexical-only warning, mode and bounded reason                            |
| One English record          | Statement preview, full memory ID, exact-get guidance                    |
| One Chinese record          | Same, without language-specific shortening                               |
| Thirteen mixed long records | Same count/order and existing 320-character previews                     |
| Exact values and provenance | Values, scope, event/expiry dates, external source, truth and open state |
| Withdrawn record            | Withdrawal boundary and redaction of statement/source                    |
| Logical structure           | Membership, local labels, chain structure and independent budget         |
| Deferred records            | Deferred IDs, conditional single get, no repeated search                 |
| Already in context          | Existing title/IDs/flag unchanged; no historical-message replacement     |
| Conflicting statements      | Both statements and their distinct scope/truth retained                  |
| Degraded nonempty           | Candidates plus lexical-only warning, mode and reason                    |

Search and get are separate output cells where applicable. Already-in-context
text is an unchanged adapter envelope; the ordinary Pi regression checks its
real disclosure path. No new folding or retrieval rules are introduced.

## Measures and stopping rule

Report UTF-16 code units and UTF-8 bytes, distinguishing unwrapped body from
wrapping. These are not measured provider tokens, billing, cache-hit savings,
compact frequency, or natural garbage rate. No model-matched tokenization was
verified in this comparison; no tokenizer dependency or network counting call
was added. A later, separate named-encoding study does not turn these character
measurements into token measurements.

Accept only if projections and unwrapped bodies are identical, every protected
value/marker and guidance obligation survives, every nonempty shared-wrapped
search/get fixture gets shorter, and empty/folded-only output does not grow.
Run targeted surface/prompt/Pi regressions, LSP checks, a build before
`agent:verify`, and the selected blocking checks. Otherwise revert the candidate
copy; do not expand into preview cuts, short IDs, new formats, count/rank/gate
changes, additional experiments, or deployment.

The throwaway paired probe is removed after collecting its source-bound output.
Local receipts are under `.nmg/verification/shared-output/`; repository tests and
this record retain the reproducible domain. No shared daemon restart, merge,
push, or runtime activation is part of this slice.

## Results

The final paired probe ran at `2026-10-10T14:54:27.569Z`: 24 cells,
all projections and unwrapped bodies identical, no input mutation. The Pi public
formatters match composition through the shared renderers in the 22 ordinary
cells. The remaining two are the explicitly reconstructed folded-only envelope,
not a real model-input or cache confirmation. Probe source, inputs, source hashes
and per-cell metrics are preserved in the receipt; the throwaway source is removed.

| Fixture                | Search UTF-16 units, baseline → candidate | Get UTF-16 units, baseline → candidate |
| ---------------------- | ----------------------------------------- | -------------------------------------- |
| Healthy empty          | 29 → 29                                   | 210 → 86                               |
| Degraded empty         | 153 → 153                                 | 210 → 86                               |
| One English            | 732 → 522                                 | 406 → 282                              |
| One Chinese            | 720 → 510                                 | 394 → 270                              |
| Thirteen mixed long    | 6,241 → 6,031                             | 9,339 → 9,215                          |
| Values/provenance      | 813 → 603                                 | 687 → 563                              |
| Withdrawn              | 939 → 704                                 | 649 → 500                              |
| Logical structure      | 1,125 → 915                               | 845 → 721                              |
| Deferred               | 823 → 595                                 | 599 → 442                              |
| Conflicting statements | 864 → 654                                 | 596 → 472                              |
| Degraded nonempty      | 824 → 614                                 | 377 → 253                              |
| Already in context     | 223 → 223                                 | 223 → 223                              |

Ordinary nonempty search wrapping saves 210 UTF-16 units / 208 UTF-8 bytes
per block; get saves 124 / 124. Withdrawal and deferred hints add their own
bounded savings. The usual one-digit-count net wrapping changes from 522 to
312 units for search and 211 to 87 for get. These are wrapping reductions, not
whole-message percentages: the 13-long-record fixtures shrink only about 3.4%
(search) and 1.3% (get) in UTF-16 units. Empty get uses count=0 in both arms;
its unchanged bare-renderer placeholder is not part of the wrapped body.

Targeted surface/prompt/Pi checks: 78/78 after copy-aware assertions. The
pre-implementation run had four expected failures in new copy requirements;
the first broader run had three stale Pi wording assertions, corrected without
weakening row-format, exact-read or withdrawal checks. DAP confirmed the actual
public formatter keeps its row and read guidance but drops the duplicate legend.
LSP reported zero diagnostics in touched tests and generated runtime prompts.

Full blocking verification: run `8c5e0714-2d68-4350-a7ec-60cb26a686d6`,
16/16 checks passed, product tests 1,684/1,684. The detached collector records
actual exit 0, signal null at `2026-10-10T14:59:47.075Z`. This is an eight-path
dirty precommit verification; clean-revision verification is collected separately
in the receipt directory rather than embedded in its own commit. Dependencies
are reused through the main checkout's junction, not freshly installed.

Data-body identity does not establish unchanged model interpretation of shorter
copy. No relevance, task-success, paid-provider, live-harness token/cache, or
deployment claim is made. The DSH automatic formatter already supplies only the preamble,
not the shared metadata footer; that existing host wiring is not repaired or
claimed complete by this copy-only change.
