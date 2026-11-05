# Memory quality invariant suite

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

Run with:

```powershell
npm run eval:quality
```

This deterministic development suite covers eleven P1 failure classes:
temporal state, multi-record aggregation, conflicting evidence, multi-hop graph
reachability, exact cold details, secret rejection, transient-memory
pollution, write-gate boundary drift, refusal evidence for a later storage
miss, refinement granularity, and the missing legacy candidate union. It tests
mechanisms and invariants without an LLM, so it complements rather than replaces
LongMemEval and the Pi end-to-end agent cases.

The last four are the write and retrieval-window side. They pin the two
judgements NMG cannot observe today — "this should have been recorded" and "this
record is too vague" — to the mechanisms that would make them assertable: the
gate's boundary in both directions, a session-anchored event for every refusal,
a vague predecessor that stays readable after refinement, and the boundary at
which a shallow tier stops hiding a deeper one.

Two cases are **expected failures** (known gaps): they assert the behaviour we
want rather than the behaviour the code has, so they stay green only while the
defect exists. When a defect is fixed its case starts passing, the run turns
red, and the marker must be removed. Known gaps are reported separately and are
never counted as ordinary passes.
