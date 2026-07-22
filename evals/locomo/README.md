# LoCoMo adapter

Place the official `locomo10.json` at `evals/locomo/data/locomo10.json`, or set
`NMG_LOCOMO_DATA` to its path.

```powershell
npm run eval:locomo -- validate 1
npm run eval:locomo -- matched 1
```

The adapter preserves session timestamps and `dia_id` evidence references. A
matched run compares no memory, ranked raw sessions, flat hybrid turns, NMG
node/leaf retrieval, and one-hop NMG graph expansion under one context budget.
