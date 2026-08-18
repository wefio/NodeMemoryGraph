# Retrieval-quality baseline — 2026-08-16

First formal run of the pinned retrieval-quality protocol
(`evals/retrieval/`, see its README for the protocol definition). Lexical arm
(SQLite FTS5, zero-config, fully offline and deterministic), topK=20, git
`5dd8c64` (dirty), Node 24.

Raw artifacts: `evals/results/retrieval/2026-08-15T17-13-18-391Z` (LoCoMo),
`evals/results/retrieval/2026-08-16T04-21-46-510Z` (LongMemEval, BEAM).

## Overall

| dataset | questions | R@1 | R@5 | R@10 | R@20 | any@20 | all@20 | MRR(Q) | ctx chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LoCoMo | 1532 | 11.8% | 19.9% | 23.4% | 24.1% | 34.3% | 27.7% | 0.232 | 2184 |
| LongMemEval-S (first 100) | 100 | 48.8% | 65.9% | 72.9% | 75.9% | 95.0% | 77.0% | 0.867 | 4274 |
| BEAM | 235 | 4.9% | 11.6% | 14.9% | 16.9% | 48.1% | 19.6% | 0.257 | 5877 |

## Per-slice detail

- LoCoMo by category: cat-1 12.8% R@20 (282 q), cat-2 31.6% (320 q),
  cat-3 10.7% (89 q), cat-4 35.1% (841 q).
- LongMemEval by question_type: single-session-user 97.1% R@20 (70 q),
  multi-session 61.0% R@20 (30 q).
- BEAM by capability: information_extraction 35.3%, preference_following
  44.7%, multi_session_reasoning 29.1%, event_ordering 12.4%,
  instruction_following 11.5%, summarization 5.3% R@20 (40 q each, 36 for
  summarization).

## Sample caveats

These affect comparability and are part of the result, not footnotes:

- The pinned LongMemEval default (first 100 questions) is **not stratified**:
  it contains only single-session-user (70) and multi-session (30) questions.
  The overall LME number above is therefore not comparable to a full
  500-question run, which also includes temporal-reasoning, knowledge-update,
  preference, and assistant-evidence types.
- 165 of 400 BEAM questions carry empty `source_chat_ids` in this data
  release (all abstention, contradiction_resolution, knowledge_update, and
  temporal_reasoning entries) and are excluded from the gold metrics — the
  legacy `audit-beam-retrieval.py` treats them the same way.

## Reading

This is the zero-config lexical arm under strict verbatim gold matching —
the floor, not the ceiling. The hybrid arm (`--hybrid` with a BGE endpoint)
is the configuration historical OmniMemEval runs used; run it to compare
like-for-like against those numbers.

The flat R@5→R@20 slope on LoCoMo and BEAM shows the lexical miss mode is
"gold never enters the candidate pool", not "gold ranked too low" — exactly
the gap the embedding arm is expected to close. LongMemEval's steep
R@1→R@20 climb (48.8%→75.9%) shows the opposite miss mode: evidence is in
the pool but ranked below the top, where QPP-driven second-pass expansion
already helps.
