# Remaining design questions

[简体中文](open-design-questions.zh-CN.md) · [Terms used](open-design-questions.terms.yaml)

**Authority:** [Parent scope](../design.md).

## Remaining design questions

- Can a future deterministic gate identify the narrow tasks that benefit from
  an explicit reasoning workspace without injecting it into ordinary turns?
- What measured ambiguity/coverage thresholds justify node creation or
  refinement?
- What feedback proves a retrieved memory was useful without reinforcing the
  router's own prior selections?
- What STG retention, expiry, and demotion policy preserves useful provisional
  information without turning STG into a second unbounded archive?
- What counts as an independent task or source when estimating edge stability,
  and how should repeated evidence from the same session be discounted?
- Which stability threshold, evidence coverage, and hysteresis margin justify
  consolidating a local subgraph into LTG?
- How should the implemented Active Graph budget allocator and marginal-gain
  stopping signals be calibrated on independent natural outcomes?
- How should QPP1 depth and QPP2 retained mass be calibrated from independent
  outcome evidence rather than benchmark labels or the controller's own prior
  selections?
- Does the implemented per-turn construction budget (three searches, five total
  search/get calls, exact-evidence progression, and no-gain stopping) strike the
  right precision/cost balance for genuinely multi-part natural queries?
- At what measured node/leaf count does exact contiguous vector scan stop
  meeting the end-to-end latency budget?
- What privacy/delete interface can remove raw evidence and every dependent
  summary, cache, and learned signal?
