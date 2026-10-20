# SimHash lexical complement for supersession candidates

[English](simhash-lexical-complement-design.md) | [简体中文](simhash-lexical-complement-design.zh-CN.md) · [Terms](simhash-lexical-complement-design.terms.yaml)

**Status:** draft

Draft proposal, not implemented for memory supersession candidate recall. The repository has a shared SimHash utility, but current callers use it for tessera file-drift recovery, not for `memory_records` or `supersedeCandidates`.

Origin: dated 2026-09-03 draft for work item 7. This proposal complements the current [supersession design](supersession-design.md); it does not change its semantic-judgment boundary.

## 1. Problem

The current `supersedeCandidates` path uses same-scope token prefiltering, normalized token overlap, transition phrases, caller-supplied polarity, and `statementSimilarity`. The memory write-token path lowercases tokens, strips non-ASCII characters, and keeps tokens of at least two characters; it does not stem or normalize spelling variants. For example:

| Existing statement | Incoming statement | Current candidate-path issue |
| --- | --- | --- |
| `解释: explanations` | `解释: explanation` | The incoming singular token can pass the substring prefilter, but exact token overlap is zero. |
| `embeddings 配置` | `embedding 配置` | Han text is removed from this write-token set; the remaining singular/plural tokens differ. |
| `colour` | `color` | There is no shared token substring, so the current prefilter can omit the old row. |

These illustrate possible recall gaps, not measured miss rates. For a Han-only incoming statement with no recognized transition phrase, the current write-token path returns no supersession candidates; polarity alone does not bypass that early return. The current code and decision boundary are described in the [supersession design](supersession-design.md).

## 2. Goal and boundaries

**Goal:** Evaluate a deterministic lexical-fingerprint channel that can put morphology, spelling, or script variants into a candidate set for caller review.

**Non-goals:**

- Do not infer semantic identity, merge records, or apply supersession from a fingerprint. A caller still decides whether the records describe the same scoped, single-valued property.
- Do not change retrieval ranking or reuse the rejected hashing-retrieval fallback.
- Do not add an external dependency or treat a threshold from another system as an NMG result.
- Do not assume the existing tessera fingerprint and threshold are appropriate for memory statements.

NMG already has `src/core/simhash.ts`, used by the tessera file-drift path. That establishes an available implementation primitive, not validated performance for supersession candidates. The shared utility's persisted tessera fingerprint is stored as 16-character hex text; the full unsigned 64-bit range must not be persisted as a SQLite signed `INTEGER`.

## 3. Candidate proposal

A draft variant is a 64-bit token SimHash over normalized lexical tokens, with Hamming distance as the comparison measure. The earlier `Hamming <= 3` value is an experiment starting point only; it is not a validated threshold.

A functional retrieval channel must be independent of the exact-token prefilter for variants such as `colour`/`color`; running a Hamming check only on rows already selected by `instr()` cannot recover rows that the prefilter omitted. A single fingerprint column also does not by itself provide an efficient Hamming-radius lookup. Storage encoding, scoped candidate lookup, index strategy, migration/backfill, and write cost therefore remain open design questions.

Any implementation must merge and deduplicate its candidates with the existing list, respect same-scope and status rules, preserve `SUPERSEDE_CANDIDATE_MAX`, and leave semantic judgment to a caller. The current exact-token, transition, and polarity channels remain the baseline.

## 4. Evidence needed before implementation

The original work item called for a local comparison before implementation. A source-accurate experiment should:

1. Use a declared, reproducible corpus and report its size, source, and scope; do not assume an old estimate such as “~330 memories” describes the current database.
2. Construct one-token morphology and spelling variants from eligible statements, with a frozen generator and separate test/validation examples.
3. Measure current candidate recall, proposed-channel recall, false-candidate rate, and added lookup/write cost. Keep candidate recall separate from semantic supersession accuracy.
4. Include representative short statements, Chinese/mixed-script text, and variants with no exact shared token.
5. Decide whether the additional recall justifies its storage and query cost; otherwise retain the current path and record the result.

No result for this experiment is claimed by this draft. The `src/core/simhash.ts` unit tests and tessera drift tests exercise a different use case and do not validate supersession candidate recall.

## 5. Open questions

- Which fingerprint/tokenization and threshold preserve useful recall without flooding review with unrelated candidates?
- What scoped index or lookup strategy supports a Hamming-radius query without scanning every memory on each write?
- Which record types and statement lengths should be excluded?
- How should candidates from the fingerprint channel rank against explicit transition/polarity hits and current token overlap?
- Does a frozen, product-representative corpus show a useful recall gain after accounting for false candidates and write latency?

## 6. Research references

The original draft cites [claude-memory-system issue #53](https://github.com/nikhilsitaram/claude-memory-system/issues/53), [Qdrant pull request #8707](https://github.com/qdrant/qdrant/pull/8707), and character n-gram vector-space methods as external precedents. These references are not reproduced measurements for NMG; their thresholds and quality claims must not be treated as project evidence.

## Source references

See [`src/core/simhash.ts`](../../src/core/simhash.ts), the [tessera fingerprint service](../../src/cli/service.ts), [tessera storage and retrieval](../../src/core/store/retrieval.ts), [`supersedeCandidates`](../../src/core/store/writes.ts), and the [supersession design](supersession-design.md).