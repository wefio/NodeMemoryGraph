# Reusing existing search events as a low-cost recall signal

## Question

Can a session trial obtain weak search-action observations without adding a
per-turn judge, diagnostic prompt, RPC, or second runtime recorder? The objective
is minimum total cost subject to adequate recall, not merely moving cost from
one mechanism to another.

## Method and source

This is a retrospective, read-only feasibility check, not a prospective quality
or cost comparison. The implementation inspected is
`b854b413ac5e29cc0a81456b9bed9430aa6652c6`.

The existing [`NmgService`](../../../src/cli/service.ts) search path calls
`#recordRecallInstance()` for ordinary searches. The
[recall-instance owner](../../../src/lab/recall-instance.ts) already captures
`kind`, `sessionId`, `trigger`, `activeGraphId` and bounded candidates. No new
producer is required to observe recorded explicit search actions.

The analysis reads a fixed prefix of the existing
`<NMG_DATA_DIR>/recall-instances.jsonl`, filters session
`01a12a62-bbe4-76b0-a742-e748dfa0cf0e`, and emits counts only. Neither query text nor
candidate statements enter this report. Existing label entries are checked for
the selected graph IDs; no labels are generated or written.

- Measured at: `2026-10-15T07:15:41.402Z`.
- Source prefix: 3,564,300 bytes; later concurrent appends are excluded.
- SHA-256: `d0a741ace8c2a2dd228ec11e1fb033fbded51cb6e09e7ad7059449433e29c0e0`.
- Selected timestamps: `2026-10-11T09:56:06.881Z` through
  `2026-10-15T06:57:44.790Z`.
- Local derived receipt: `.nmg/verification/passive-recall-trial/existing-events.json`.
  It is not a copy of the raw corpus. To replay against a growing source, read
  exactly the recorded prefix length and verify its hash before filtering.

## Results

| Observation | Count |
| --- | ---: |
| Current-session recorded events | 33 |
| `auto` | 14 |
| `explicit` | 19 |
| Distinct graph IDs | 33 |
| Selected zero-candidate events | 4 |
| Matching existing label entries | 0 |
| Malformed lines in the captured prefix | 0 |

The other 3,039 rows are excluded by session identity. Selected captures contain
at most eight candidates, as bounded by the existing owner.

An explicit event means that a search RPC not marked `autoRecall:true` ran. It
is not proof that the main LLM independently chose it: clients and diagnostic
scripts can issue the same RPC. These rows are not counted as independent
natural tasks. The explicit trigger is a search query, not necessarily the
original user message.

The corpus lacks a user-turn identity and an entry-gate decision. Absence of an
`auto` row, or temporal proximity to an `explicit` row, does not establish a
missed entry. Internal probes are excluded, and failed calls or calls without a
disclosure graph are not a complete part of this capture. The observed counts
cannot provide a denominator for all searches or a miss rate. Existing relevance
labels, even if present, would not establish whether retrieval was necessary.

## Cost boundary

The single sandbox read/parse/aggregate measured 12.9664 ms. This is an in-process
wall-time observation with filesystem cache state uncontrolled. It excludes the
tool roundtrip, main-model reasoning, development and reporting. It is not a
per-turn measurement or evidence of end-to-end savings.

This trial adds no product runtime path, tool definition, prompt, model call,
retrieval, or background poll. Existing capture still has serialization, file
I/O and storage costs; those were not measured or removed. Reading and analyzing
its output also costs resources. Reusing it does not make the overall system
free or prove that the baseline is optimal.

## Outcome and limits

Existing explicit-search events are available for weak observation without a
second recorder. An isolated session-observer prototype passed 70 targeted
mechanics tests and had zero LSP diagnostics, but was discarded rather than
merged: it duplicated observations before a demonstrated data gap required the
extra runtime and maintenance. That prototype's passing tests do not validate
this signal's usefulness. No new Lab mode or operation is delivered.

The existing [recall cue capability](../../design/design.md#session-only-recall-cues)
remains paused for this session. No trigger is learned or promoted from these
19 explicit events, and no feedback, claim outcome, classifier, shared-service
change, or paid model evaluation is performed. Reuse feasibility is established;
entry detection, natural quality, and lowest total cost remain unverified.
