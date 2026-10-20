# Memory quality invariant suite

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

Run with:

```powershell
npm run eval:quality
```

This deterministic development suite covers the seven P1 failure classes:
temporal state, multi-record aggregation, conflicting evidence, multi-hop graph
reachability, exact cold details, secret rejection, and transient-memory
pollution. It tests mechanisms and invariants without an LLM, so it complements
rather than replaces LongMemEval and the Pi end-to-end agent cases.
