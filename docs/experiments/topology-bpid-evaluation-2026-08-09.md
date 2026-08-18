# BPID identity-candidate evaluation — 2026-08-09

## Question

Can a cheap, model-free candidate generator narrow the node-pair search space
without hiding most true identity matches, and is NMG's current high-confidence
gate precise enough to authorize unattended physical merges?

## Dataset and protocol

`npm run eval:topology:bpid` uses the official BPID matching split published
with _BPID: A Benchmark for Personal Identity Deduplication_ (EMNLP 2024):
10,000 synthetic profile pairs independently labelled by trained annotators,
including 4,333 matches and 5,667 non-matches. The source archive is published
on [Zenodo](https://zenodo.org/records/13932202) under Apache-2.0; the paper and
dataset description are available from the
[ACL Anthology](https://aclanthology.org/2024.emnlp-industry.40/).

The Lab evaluator computes name, email, phone, address, and date-of-birth
similarity and combines them into an uncalibrated blocking score. This is not a
probability or a product threshold. It reports the full threshold curve so no
single benchmark-tuned cutoff is silently adopted. It does not call an LLM or
embedding model.

For a bounded recovery probe, three labelled matches and three labelled
non-matches scoring at least `0.98` are materialized as separate NMG entity
nodes. Each receives five independent proposal observations, passes through the
real automatic-merge assessment, is physically merged, and is immediately
rolled back using its journal. This deliberately measures recoverability, not
whether knowingly merging a negative pair is acceptable.

## Results

| Candidate threshold | Recall | Precision | Pair reduction |
| ------------------: | -----: | --------: | -------------: |
|                0.30 | 99.84% |    44.08% |          1.86% |
|                0.50 | 98.80% |    46.40% |          7.73% |
|                0.70 | 90.56% |    53.98% |         27.30% |
|                0.80 | 68.47% |    62.03% |         52.17% |
|                0.90 | 18.46% |    78.59% |         89.82% |
|                0.95 |  5.59% |    91.67% |         97.36% |
|                0.98 |  5.12% |    92.12% |         97.59% |

At `0.98`, 241 pairs survive: 222 matches and 19 non-matches. All six bounded
merge/rollback probes restored the original memory ownership and node IDs;
three were deliberately selected false positives and were also restored.

## Interpretation

The cheap score is useful only as a **blocking/candidate-generation signal**.
It can preserve nearly all matches only while rejecting very little of the
pair space. Tightening it enough to reduce the pool by about 98% destroys
recall and still leaves a 7.88% false-merge rate among selected pairs. Several
hard negatives share apparently decisive identifiers—email, phone, name, or
date of birth—while another field conflicts. Therefore:

- similarity may nominate a bounded pair for semantic review;
- a high similarity value must not be interpreted as calibrated identity
  confidence;
- NMG's current automatic merge gate is not sufficient for unattended merge
  actuation when its confidence input comes from this blocker;
- explicit conflict detection, a separately validated semantic judge, and
  real-use error costs remain necessary;
- journaled rollback limits damage but does not make false merges harmless,
  because wrong merged state may already have affected an Agent answer.

BPID is synthetic and pair-labelled rather than an online stream of naturally
coexisting NMG nodes. This closes the missing hard-negative/candidate audit but
does not establish production precision. Unattended identity mutation remains
disabled.
