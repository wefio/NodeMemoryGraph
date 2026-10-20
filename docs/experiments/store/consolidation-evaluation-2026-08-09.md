# STG → LTG consolidation gate evaluation — 2026-08-09

[English](consolidation-evaluation-2026-08-09.md) | [简体中文](consolidation-evaluation-2026-08-09.zh-CN.md) · [Terms](consolidation-evaluation-2026-08-09.terms.yaml)

Evidence boundary (2026-10-17 documentation review): this is a historical
record. Its configurations, measured results and implementation-status statements
are not current test receipts or default-policy authorization. This review did
not rerun the experiment or independently revalidate the original run artifacts.

This is a policy-coverage and reversibility audit, not a claim that automatic
consolidation is ready for default use.

## Protocol

- Dataset: official LoCoMo `locomo10.json`.
- Unit: one evidence source ID within one conversation.
- Outcome units: distinct official QA tasks that cite that source ID. Task IDs
  are distinct in this instrument; that does not establish statistically
  independent confirmations drawn from the same conversation.
- Labels: official evidence IDs only; no model-generated judgments.
- Prior: the zero-annotation write path (`confidence = 0.5`, prior strength 2).
- Policy: the current default STG consolidation and retention thresholds.
- Command: `npm run eval:consolidation`.

## Result

- 1,986 QA tasks across 10 conversations.
- 1,434 unique official evidence items.
- 355 evidence items appear in at least three independent tasks.
- The combined mean and conservative-bound gates require five all-positive
  outcomes from the zero-annotation prior; 75 evidence items qualify.
- Candidate coverage is 5.23% of all official evidence and 21.13% of evidence
  meeting the nominal three-task recurrence floor.
- With retention hysteresis (`mean >= 0.65`, conservative lower bound `>= 0.35`),
  46 of 75 candidates retract after two later contradictions, 20 after three,
  and 9 after four. None oscillates out after a single contradiction.

## Engineering conclusion

The default gate is conservative, and the lower retention thresholds provide a
real reversible lifecycle without one-event promote/demote oscillation. NMG now
withdraws only active LTG rows carrying the exact
`consolidated_from_stg.sourceMemoryId` marker when support falls below the
retention gate. A pre-existing or manually written LTG duplicate has no such
marker and is never retracted by STG feedback. A later requalification creates
a fresh auditable LTG version.

This benchmark cannot estimate false-promotion precision: absence from
one QA evidence list is neither a contradiction nor an authoritative negative
promotion label; it may simply mean that the memory was not used for that question. Automatic
actuation therefore remains off by default until natural corrections or another
authoritative negative-label source can measure false-promotion cost.

LongMemEval `knowledge-update` cases clarify a separate invariant rather than
solving that missing precision label. For example, one official case changes a
charity-5K personal best from `27:12` to `25:50`. A new same-scope state must
replace the old current projection immediately; it cannot wait for the two or
more posterior contradictions required by consolidation hysteresis. NMG now
reconciles physically separate STG/LTG state versions during projection and
keeps only the newest, while an as-of search still returns the older version.
This closes stale-current-state exposure but does not turn LongMemEval into a
false-promotion precision benchmark.

HaluMem is the most relevant authoritative source already present through
OmniMemEval: it publishes operation-level memory points and includes
interference and dynamic updates. The operation adapter and official-judge
wrapper are described in the cited follow-up. Its user-1, session-6 natural slice achieved
full expected-memory recall but only 0.683 all-candidate weighted accuracy,
rejected 0/1 interference records, and updated 3/4 targets correctly. The high
official extraction F1 (0.933) therefore does not imply a clean write set.

That result evaluates the benchmark bridge's raw-message ingress, which stores
assistant dialogue as unverified `conversation_evidence`; it does not label the
actual candidates produced by the Pi `remember` boundary or the posterior
STG-to-LTG promotion gate. It closes the missing operation-level harness and
demonstrates an authoritative pollution failure, but unattended consolidation
remains disabled until real promotion candidates are scored and false-promotion
cost plus retraction are measured. Full protocol and results are in
[the HaluMem operation report](../benchmarks/halumem-operation-evaluation-2026-08-11.md).
That follow-up is dated 2026-08-11; the filename of this record does not date
all subsequently included material to 2026-08-09.
