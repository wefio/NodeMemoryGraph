# Relevance training data and evaluation

**Status:** current

## Boundary

The offline relevance trainer uses external relevance judgments or independently
verified evidence. Local recall traces supply later calibration and failure cases;
training does not wait for local traffic. Memory benchmarks are evaluation-only.
Answer-string containment, answer reuse, silence, and unjudged candidates are not
negative relevance labels.

`tools/relevance-training-data.ts` owns the versioned dataset and manifest
validation. `tools/relevance-model-train.ts` owns preparation, fitting and reporting.
These are offline research tools; a successful run does not enable a runtime head.

## Prepare and partition

Prepare candidate lists through NMG's search path, with an explicit source partition:

```sh
node --experimental-strip-types tools/relevance-model-train.ts --prepare-only --qrels /data/corpus-a --qrels-split train --cache /data/derived/a-train.json
node --experimental-strip-types tools/relevance-model-train.ts --prepare-only --qrels /data/corpus-a --qrels-split dev --cache /data/derived/a-cal.json
node --experimental-strip-types tools/relevance-model-train.ts --prepare-only --qrels /data/corpus-b --qrels-split test --cache /data/derived/b-test.json
```

Inputs are `corpus.jsonl`, `queries.jsonl`, and `qrels/<partition>.tsv`. Existing
outputs are not overwritten. Corpus content hashes bind reusable stores; dataset
files retain query IDs, source-unit IDs, candidate IDs, judgment provenance,
feature columns, and retrieval protocol/embedder identity. Empty retrieved lists
remain in the denominator. Lexical preparation ignores ambient embedding settings;
embedding preparation requires both `--embeddings` and `--embedder <indexId>`.

Explicit qrels scores of zero are negative, positive scores are relevant, and
absent judgments are `-1` (unknown). The importer does not assume unjudged documents
are irrelevant. Sparse positive-only qrels therefore cannot by themselves provide
both classes for this supervised trainer.

The manifest assigns whole source units to roles before fitting:

```json
{
  "version": 1,
  "train": ["a-train.json"],
  "cal": ["a-cal.json"],
  "test": ["b-test.json"]
}
```

Paths are relative to the manifest. Fitting/calibration reject published test
partitions and memory-benchmark corpus IDs. Test corpora must differ from training
and calibration by both declared ID and content hash. Shared source units and
normalized duplicate queries cannot cross roles. Feature/retriever protocols must
agree. These checks detect recorded identity overlap, not semantic paraphrases or
false provenance supplied by a producer.

For offline constructed memory tasks, producers use `labelSource: verified-evidence`
and retain a verifiable `labelEvidence` reference. Every variant from a conversation
shares its `sourceUnitId`; split source conversations before generating variants.
A generator or LLM judge alone is not independent verification. This importer
accepts such records but does not implement an automatic labeling service.

## Fit and evaluate

```sh
node --experimental-strip-types tools/relevance-model-train.ts --manifest /data/derived/training.json --out /data/derived/candidate.json --json
```

Only known candidate labels train the item head or calibrate its probabilities.
Each role requires explicit positives and negatives. The calibration set selects
one operating floor; the test sets evaluate that frozen floor. The default
`--min-retention 1` requires retaining all known positive candidates and all
positive-bearing lists intact on calibration. A lower value is an explicit
experimental tolerance, not product policy or a guarantee on unseen data.

Reports include input hashes and roles, per-test-corpus metrics, judgment coverage,
known-noise removal, candidate reduction, positive retention, hit retention, and
all-known-positives retention. Unknown candidates are counted separately. These
metrics are conditional on the retrieved pool and known judgments: all-positive
retention does not prove multi-hop sufficiency, candidate reduction is not measured
token savings, and cross-corpus performance is not live automatic-recall quality.

The default output is `.benchmarks/relevance/candidate.json`, accompanied by
`.report.json`; it is not the runtime model location. The artifact records its
training provenance and offline purpose. `deploymentEligible` remains false:
natural target-domain validation and runtime admission are separate operations.

`--certify` also requires the manifest and refuses unknown candidate judgments or
multiple evaluation queries from the same source unit.
Its threshold lattice is constructed from training data, then assessed on
calibration and the independent test data. Statistical bounds retain their
sampling assumptions; they do not certify cross-domain invariance or evidence
preservation. The regular retention report is the primary conservative comparison.

## Data acquisition

External labeled data provides scale. Offline construction supplies memory-specific
time, preference, and multi-hop cases with traceable evidence. Local explicitly
confirmed outcomes supply a small target-domain audit. Automatic injection,
disclosure, or a model's failure to cite a memory is not feedback truth. Candidate
relevance, whole-list sufficiency and expansion usefulness remain distinct targets;
this trainer fits the first target only.

Rationale: [independent training data](../decisions/implemented/2026-09-15-independent-relevance-training.md).
