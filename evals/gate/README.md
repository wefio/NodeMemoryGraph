# Automatic-recall gate probe

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

Run:

```powershell
npm run eval:gate
```

This deterministic, no-LLM probe measures false positives and false negatives
for explicit recall intent across English, Chinese, German, French, Japanese,
and Spanish. It is deliberately small and curated: use it to expose language
coverage gaps and prevent regressions, not to claim production prevalence or
to tune additional regexes as if they were learned policy.
