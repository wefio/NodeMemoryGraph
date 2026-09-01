# OmniMemEval research utilities

These files are diagnostic or hypothesis-testing utilities. They do not define
the public benchmark execution path, official prompts, or NMG runtime defaults.
Use the parent directory's `run.ts`, `benchmark.config.json`, `bridge.ts`, and
`README.md` for reproducible suite execution.

## Layout

- `audits/` — inspect completed result artifacts, retrieval coverage, QPP signals,
  and ranking distributions. They do not call an answer model unless their own
  command says so.
- `probes/` — bounded mechanism checks for retrieval, HyDE, progressive disclosure,
  MGR, and answer behaviour. Treat results as experimental evidence.
- `ablations/` — paired counterfactual arms such as reverse retrieval, pagination,
  and PersonaMem variants. They must not silently become product policy.
- `polarity/` — offline extraction, normalization, validation, and BEAM-specific
  polarity experiments.

The repository-level scripts intentionally expose only the maintained audit and
ablation entry points from `package.json`. Run an unlisted file directly only
when reproducing the experiment that owns it, and record conclusions in
`docs/experiments/` rather than promoting the script into a second benchmark
pipeline.

## Prefix-cache fake API

`probes/fake-cache-api.ts` is an independent, OpenAI-compatible test endpoint.
Point a benchmark's chat base URL at it and leave the benchmark request path
unchanged. The endpoint returns a fixed compatible completion; it does not call
NMG, a tokenizer, or a model.

For each actual UTF-8 request body, the endpoint computes chained SHA-256
checkpoints at fixed byte boundaries. Only `(cumulative length, hash, arrival
time)` is retained. Matching hashes are compared only at equal lengths, so the
last match estimates the theoretical longest common byte prefix with an error
smaller than one block. Prompt text is discarded after hashing and never appears
in the report.

```powershell
node --experimental-strip-types `
  evals/omnimemeval/research/probes/fake-cache-api.ts
```

Use `http://127.0.0.1:8788/v1` as the chat base URL. Read estimates from
`GET /__cache/report?profile=normal-cloud`, or clear the in-memory trace with
`POST /__cache/reset`. The default block is 512 bytes and can be changed with
`CACHE_PREFIX_BLOCK_BYTES`. The built-in `local`, `normal-cloud`, and
`slow-cache` profiles estimate queue, network, cache-build, and expiry costs.

This measures serialized byte-prefix potential, not provider token-cache
semantics. Providers may canonicalize messages, tokenize differently, or use
undocumented minimum cache blocks. Use it to compare request ordering and layout
without paid calls; provider-reported cache-hit/miss tokens remain the source of
truth for billing.
