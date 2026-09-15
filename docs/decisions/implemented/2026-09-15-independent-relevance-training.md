# Independent relevance training data

[中文](2026-09-15-independent-relevance-training.zh-CN.md)

**Status:** implemented
**Approved:** explicit

## Problem

Question-index splits inside a memory benchmark cannot establish transfer to
automatic recall. Anonymous caches hide source overlap, and answer-string matching
learns a different target from relevance. Sparse qrels also leave many candidates
unjudged; treating them as negative creates unsupported labels. Local traffic is
too sparse to provide the primary training volume.

## Decision

The offline trainer consumes attributable external or independently verified data,
with explicit train/cal/test roles and a separate test corpus. It excludes unknown
labels from fitting and reports their coverage. Calibration chooses a frozen
operating point subject to known-evidence retention; independent tests report both
noise reduction and evidence loss. Outputs are offline candidates, not deployment
approval. The executable contract and commands live in
[relevance training](../../design/relevance-training.md).

## Alternatives considered

- Random question splits within LoCoMo: useful for development diagnostics, but
  inadequate for target-domain or cross-corpus claims.
- Wait for a local self-labeling loop: too little traffic, and answer reuse is not
  an independently verified relevance label.
- Treat unjudged qrels as negative: provides easy training volume at the cost of
  label validity. Unknowns remain explicit until independently judged.
- Automatically deploy a calibrated artifact: calibration on another domain does
  not establish live evidence preservation.

## Consequences

Legacy anonymous caches require rebuilding. Positive-only qrels can prepare data
but cannot complete supervised fitting without explicit negatives. The tool checks
provenance structure and overlap, not whether an external annotator told the truth.
Held-out metrics remain conditional on observed judgments and the retrieved pool.

## Deferred

An automatic verified-label producer, sufficiently large independent positive and
negative corpora, and live target-domain model admission remain separate work. No
new learned artifact is enabled by this change.
