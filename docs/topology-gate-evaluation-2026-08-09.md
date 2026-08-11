# Topology identity-gate evaluation — 2026-08-09

## Question

Can NMG's conservative, read-only `same_as` gate distinguish repeated evidence
about one person from an incorrectly proposed cross-person merge, withdraw its
eligibility when contradictory identity evidence arrives, and do so without
silently mutating the graph?

## Protocol

`npm run eval:topology` uses the official LoCoMo conversations without an LLM.
LoCoMo's stable speaker labels are treated as held-out identity supervision:

- each speaker is deliberately split into an early-session and late-session
  node with the same conversation/person scope;
- the early/late pair is an injected positive `same_as` candidate;
- the two different speakers in each conversation form an injected negative
  candidate;
- five independent proposal observations at confidence `0.99`, with evidence
  on both nodes, exercise the production automation gate;
- after each positive assessment, a pending `distinct_from` proposal is added
  and the same gate is assessed again;
- accepted relations and node merges are never invoked.

The gate arm still uses oracle candidate construction. A second, non-oracle
discovery arm embeds only the early/late utterance content with NMG's local
hashing embedder (no node name, scope, or speaker label), then selects the most
similar late fragment for each early fragment. Official speaker labels are
consulted only after ranking to score the candidate.

## Result

Dataset: official LoCoMo `locomo10.json` (10 conversations).

| Metric                                      |       Result |
| ------------------------------------------- | -----------: |
| Same-person early/late candidates           |           20 |
| Same-person candidates eligible             | 20/20 (100%) |
| Cross-person candidates                     |           10 |
| Cross-person candidates rejected            | 10/10 (100%) |
| Eligibility withdrawn after `distinct_from` | 20/20 (100%) |
| Content-only candidates discovered          |            20 |
| Same-person discovered candidates            |  16/20 (80%) |
| Candidate discovery precision                |          80% |
| Candidate discovery recall                   |          80% |
| Naturally discovered false candidates        |             4 |
| Foreign records co-located if forcibly merged | 12 (3 each) |
| False-merge probes successfully rolled back  |    4/4 (100%) |
| Topology mutations caused by assessment     |            0 |

All cross-person candidates were rejected by `scope_mismatch`. The result is
written to `evals/topology/results/latest.json`; the deterministic unit fixture
checks the same invariants independently of the downloaded dataset.

## Interpretation and remaining risk

The experiment demonstrates that the current scope/conflict safety checks work
on natural conversation identities and that assessment is reversible and
read-only. The content-only arm also establishes a real, non-oracle candidate
baseline: even in a two-person conversation, 4/20 nearest-fragment candidates
are wrong. Forcing those four bad pairs through the journaled merge path places
12 cross-person records under the wrong shared identity node before all four
transforms roll back successfully. This is a structural contamination measure,
not an answer-accuracy score. Candidate similarity therefore cannot authorize merging. It does
**not** establish an end-to-end false-merge rate:

- the production gate candidates were still injected; the discovery arm only
  measures blocking/ranking and does not submit or actuate proposals;
- LoCoMo does not contain labelled homonyms, identity corrections, or ambiguous
  alias chains;
- no actuator is enabled in this benchmark. Journaled physical merge rollback
  is covered by deterministic store/service tests, including refusal after a
  later topology edit, but it is not exercised on naturally discovered false
  merges here;
- the cost of a false merge still needs a real-use corpus or a dedicated entity
  resolution dataset with naturally generated candidates.

Accordingly, unattended identity mutation remains disabled.
