# Memory surface unification: output compatibility and rendering cost

[中文](memory-surface-unification-2026-10-26.zh-CN.md) · [Terms used](memory-surface-unification-2026-10-26.terms.yaml)

## Question and method

Does routing shared memory tool rendering through InformationView preserve the
delivered text, and what does preparation cost? This offline probe calls the
production search, compact-search, exact-evidence and save-reply renderers. It
uses deterministic presentation fixtures, without a database, embedder or LLM.

The baseline uses the shared surface from `5f0cb01736bdea722642155380d862ba56eae2dd`.
Both runs use Node v24.19.0 on Windows, 30 warmups and 200 measured calls per case.
Search/read cases contain 0, 1, 20 or 200 records, with long statements, original
sources, timestamps, open status and degraded-retrieval labels. Save cases contain
0, 1 or 6 candidates per follow-up class (the renderer admits at most 3).
Reports record input hashes, implementation hashes, complete output hashes,
character counts and latency distributions. The runner was formatted between
runs; input identities and measurement logic are unchanged.

## Initial unification results

All 15 cases have identical complete output hashes and character counts before
and after unification. The 20-record evidence case retains all 20,972 characters;
the generic 8,000-character preparation default does not cut the admitted page.

| Case | Baseline mean, ms | Unified mean, ms |
| --- | ---: | ---: |
| Search, 20 records | 0.0552 | 0.1514 |
| Compact search, 20 records | 0.0090 | 0.0826 |
| Exact evidence, 20 records | 0.0824 | 0.2007 |
| Save, 6 candidates per class | 0.0113 | 0.0128 |
| Exact evidence, 200 records | 0.9849 | 1.8727 |

Snapshotting and source fingerprinting add work. This run measures the cost of
the shared protocol, not a speedup. Individual microsecond timings are noisy;
the small single-process run does not establish production latency or throughput.

## Deferred metadata

The final implementation defers source hashing until `included` is read and
memoizes that array on the immutable output. Deduplication uses exact text under
the canonical source/purpose/preview key. All 15 text cases still match the
baseline. A separate infrastructure comparison matches all 12 complete output
digests (including source hashes) and the deterministic retrieval result digest.

Two text-only repeats after the change give mean search-20 latency of
0.1945/0.1299 ms and evidence-20 latency of 0.2519/0.2006 ms. These noisy runs
do not establish a consistent end-to-end speedup over the eager unified stage.
They were taken later on the same machine; the first also overlapped contract
tests. The isolated preparation probe separates text from metadata consumption:

| Flat preparation, 8,000-character budget | Complete metadata p50, ms | Text-only p50, ms |
| --- | ---: | ---: |
| 20 input items | 0.1056 | 0.0417 |
| 200 input items | 0.3183 | 0.2010 |
| 2,000 input items | 2.1180 | 1.9793 |

`infra-perf.ts` forces `included` inside the original full-output timing, so
deferred work is not silently moved outside that measurement. Its separate
`textOnlyLatencyMs` measures preparation plus text access. Both run 40 iterations;
this remains a small synthetic workload. Input snapshots are still copied once
per preparation; no process-wide validation or permission cache is added.

## Evidence and reproduction

- [Baseline artifact](artifacts/2026-10-26-memory-surface-baseline.json)
- [Unified artifact](artifacts/2026-10-26-memory-surface-unified.json)
- [Deferred artifact](artifacts/2026-10-26-memory-surface-lazy.json)
- [Deferred repeat](artifacts/2026-10-26-memory-surface-lazy-repeat.json)
- [Final source after excerpt-helper extraction](artifacts/2026-10-26-memory-surface-final.json)
- [Complete metadata parity and cost](artifacts/2026-10-26-memory-surface-metadata.json)
- [Probe](../../../evals/retrieval/memory-surface.ts)

From a checkout with dependencies installed, generate the prompt artifact, then
run the probe. Comparison refuses mismatched inputs or changed complete text:

```powershell
npm run prompts:generate
node --experimental-strip-types evals/retrieval/memory-surface.ts --out memory-surface-result.json --compare docs/experiments/retrieval/artifacts/2026-10-26-memory-surface-baseline.json
node --experimental-strip-types evals/retrieval/infra-perf.ts --out memory-metadata-result.json --compare docs/experiments/retrieval/artifacts/2026-10-26-infra-final.json
```

## Verification scope

Final verification on 2026-10-27 passed all 16 blocking `agent:verify` checks.
The product suite reported 2,073 tests: 2,071 passed, 2 skipped, 0 failed.

Contract tests additionally check immutable source snapshots, preview versus
full disclosure, withdrawn-source redaction, complete evidence beyond 8,000
characters, save acknowledgement retention, and atomic candidate/caveat blocks
under a smaller context budget. No save acknowledgement or composite follow-up
creates a memory disclosure receipt.

This work measures the shared search/get/save surfaces. Other mutation-action
confirmations, host error strings and JSON/RPC business results are outside this
projection change. The probe does not launch a live host or measure model answer
quality. No new recall run was made; the earlier paired LME result belongs to
the infrastructure change and is not a fresh validation of this revision.

One full verification attempt failed in `stg-isolated.test.ts` while removing
its temporary directory (`EPERM`), after the store-path assertions completed.
The same isolated case was rerun 10 times with the following command; 0/10
attempts reproduced the failure. The cause of that cleanup failure remains
unestablished; these retries do not prove it cannot recur under suite concurrency.

```powershell
node --experimental-strip-types --test --test-name-pattern='Phase1: stgStorePath derives' tests/core/stg-isolated.test.ts
```
