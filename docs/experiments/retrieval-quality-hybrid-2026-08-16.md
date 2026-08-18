# Retrieval-quality hybrid arm + LongMemEval full — 2026-08-16

Second formal run of the pinned retrieval-quality protocol
(`evals/retrieval/`). Adds the hybrid arm (FTS5 + BGE-small-en-v1.5, 384
dims, `bge-en` profile, local OpenAI-compatible server) and the full
500-question LongMemEval-S. Companion to
[retrieval-quality-baseline-2026-08-16.md](retrieval-quality-baseline-2026-08-16.md)
(lexical arm, pinned samples).

Raw artifacts: `evals/results/retrieval/2026-08-16T14-29-42-183Z` (LME full,
lexical), `2026-08-16T15-07-00-133Z` (LME full, hybrid),
`2026-08-16T07-21-03-546Z` (LoCoMo hybrid), `2026-08-16T07-27-08-833Z`
(BEAM hybrid).

Both arms share the same ingested stores per dataset (ingestion is
retrieval-mode-independent and deterministic), so every paired number below
is exactly same-data, same-memories.

## LongMemEval-S, full 500 questions (new — all six question types)

| arm | R@1 | R@5 | R@10 | R@20 | any@20 | all@20 | MRR(Q) | ctx chars |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 43.7% | 70.6% | 79.5% | 82.2% | 93.8% | 76.0% | 0.858 | 5603 |
| hybrid | 47.2% | 73.6% | 82.5% | **84.8%** | **96.6%** | **80.6%** | **0.915** | 4538 |

R@20 by question type, lexical → hybrid:

| question_type | n | lexical | hybrid |
| --- | ---: | ---: | ---: |
| single-session-user | 70 | 97.1% | 97.1% |
| single-session-assistant | 56 | 98.2% | **100.0%** |
| knowledge-update | 78 | 92.9% | **95.5%** |
| temporal-reasoning | 133 | 79.5% | 80.8% |
| multi-session | 133 | 76.2% | 78.2% |
| single-session-preference | 30 | 56.7% | **86.7%** |

## LoCoMo (all 10 users, 1532 questions) and BEAM (all 20 conversations, 235 labelled)

| dataset | arm | R@1 | R@5 | R@10 | R@20 | any@20 | all@20 | MRR(Q) |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| LoCoMo | lexical | 11.8% | 19.9% | 23.4% | 24.1% | 34.3% | 27.7% | 0.232 |
| LoCoMo | hybrid | 13.6% | 24.2% | 27.8% | **29.3%** | **40.5%** | **32.7%** | **0.268** |
| BEAM | lexical | 4.9% | 11.6% | 14.9% | 16.9% | 48.1% | 19.6% | 0.257 |
| BEAM | hybrid | 6.5% | 16.2% | 20.3% | **21.8%** | **56.6%** | **25.1%** | **0.322** |

BEAM hybrid by capability (R@20): preference_following 53.2%,
information_extraction 44.1%, multi_session_reasoning 38.8%,
instruction_following 25.0%, event_ordering 15.6%, summarization 5.7%.

## Caveats

- Hybrid search latencies (p50 ≈ 2.75s on LME) include the one-time
  per-store embedding index build on first search; steady-state retrieval
  latency is the lexical arm's p50 (≈60–70ms) plus one embedding round-trip.
  Treat the latency columns as non-comparable here; quality metrics are the
  subject of this document.
- The BEAM hybrid run had to be repeated once: `beam_100k.json` was rewritten
  by an external process mid-run and the loader read a partial file. The
  rerun above used the complete file (400 questions loaded, 235 with gold
  labels; the 165 questions with empty `source_chat_ids` are excluded, same
  as the legacy audit).
- The earlier pinned-sample LME number (first 100 questions, R@20 75.9%
  lexical) is superseded by the full-500 table above; the first-100 sample is
  not stratified (only single-session-user and multi-session).

## Reading

- Hybrid helps most where question and evidence wording diverge:
  single-session-preference 56.7%→86.7% (+30 pts) is the clearest embedding
  win; knowledge-update and assistant-evidence are near-saturated.
- LoCoMo and BEAM remain hard in absolute terms even hybrid (R@20 29.3% /
  21.8%): their gold is exact source messages and many questions need
  evidence whose wording shares almost nothing with the question
  (summarization 5.7%, event_ordering 15.6%). This is the known ceiling of
  query-by-question retrieval and the motivation for graph/chain expansion,
  not a regression.
- Ingestion performance note: this run exercised the new
  `RememberInput.supersedeScan` gate (writes.ts). The supersede-candidate
  scan is O(scope) per write and its result is only consumed by an external
  judge, so judge-less benchmark ingestion now skips it; measured ingestion
  on the bridge path improved ~12× (102s → 8.3s for a fixed 148-conversation
  sample) and full-500 LME ingestion completed within the timeout where the
  pre-fix run could not. Store contents are unchanged when no judge is
  configured, so metrics remain comparable across the fix.
- Judge cost knob: the write-time LLM judge now sends `max_tokens`
  (default 1000, `NMG_JUDGE_MAX_TOKENS`). The verdict JSON is well under 100
  tokens and thinking is client-disabled by default, so 1000 is headroom,
  not a requirement.
