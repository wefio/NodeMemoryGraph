# BEAM adapter

Place the official chat directory under `evals/beam/data/chats/100K`, or point
`NMG_BEAM_DATA` at any downloaded BEAM scale directory. The loader recursively
discovers cases containing:

```text
<case>/chat.json
<case>/probing_questions/probing_questions.json
```

```powershell
npm run eval:beam -- validate 1
npm run eval:beam -- matched 1
npm run benchmark:score -- beam <result-directory>
```

The separate scorer uses the official rubric semantics with DeepSeek V4 Flash.
`event_ordering` uses normalized Kendall tau-b, matching BEAM's primary report
aggregation. The judge substitution is explicitly not leaderboard-comparable.

The adapter flattens chat batches into timestamp-preserving sessions, retains
source chat IDs when supplied, and samples independently across all probing
question categories. Start with the repository's 100K/128K-scale data before
moving to 500K, 1M, or 10M.
