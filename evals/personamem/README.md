# PersonaMem adapter

Place one official question/context pair under `evals/personamem/data/`:

```text
questions_32k.csv
shared_contexts_32k.jsonl
```

Set `NMG_PERSONAMEM_SIZE` to `128k` or `1M` for the other official variants, or
override `NMG_PERSONAMEM_QUESTIONS` and `NMG_PERSONAMEM_CONTEXTS` directly.

```powershell
npm run eval:personamem -- validate 1
npm run eval:personamem -- matched 1
npm run benchmark:score -- personamem <result-directory>
```

The separate scorer applies PersonaMem's official single-option extraction
rule and does not call an LLM judge.

The adapter joins each question to `shared_context_id`, applies the official
`end_index_in_shared_context` cutoff, preserves multiple-choice options, and
reports results by PersonaMem question type.
