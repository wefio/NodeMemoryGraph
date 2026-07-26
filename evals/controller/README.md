# Differentiable controller evaluation

This experiment isolates retrieval control from answer generation. It uses the
official evidence identifiers supplied by LoCoMo and BEAM and performs no model
API calls.

```bash
npm run eval:controller -- locomo 4
npm run eval:controller -- beam 4
```

For every case, the runner:

1. imports raw benchmark turns into a fresh NMG store;
2. performs one deterministic `searchContext` retrieval;
3. intersects retrieved memories with official evidence IDs;
4. converts the completed trace into the versioned 32-feature protocol;
5. trains on all but the last case in each category;
6. compares deterministic usefulness ordering and learned node ordering on the
   same held-out candidates and Top-N budget.

The report separates candidate recall from ranking recall. This distinction is
essential: the controller cannot recover an evidence item that candidate
generation never returned.

The report uses two independent gates:

- `controllerGate` checks labelled training volume, held-out recall and
  precision non-degradation, and bounded inference cost;
- `retrievalGate` checks whether upstream candidate recall is at least 0.8.

A passed controller gate permits shadow evaluation even when candidate
generation is still weak. Active/default Pi eligibility requires both gates.
The runner reports these states but never changes the Pi extension
configuration.

## Result policy

Historical ad-hoc BGE and hashing runs were removed from this document because
they used changing samples, prompts, and corpus-rebuild policies. They are not
reproducible capability evidence.

New controller results must come from the current runner, retain their
`sampleFingerprint`, use official benchmark evidence IDs, report candidate and
controller gates separately, and include repeated trials for stochastic reader
models. Raw results remain in ignored local directories.
