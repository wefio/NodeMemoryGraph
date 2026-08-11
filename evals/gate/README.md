# Automatic-recall gate probe

Run:

```powershell
npm run eval:gate
```

This deterministic, no-LLM probe measures false positives and false negatives
for explicit recall intent across English, Chinese, German, French, Japanese,
and Spanish. It is deliberately small and curated: use it to expose language
coverage gaps and prevent regressions, not to claim production prevalence or
to tune additional regexes as if they were learned policy.
