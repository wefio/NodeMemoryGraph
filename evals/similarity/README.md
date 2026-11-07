# Relevance-model offline probes

[English](README.md) | [简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

Archived probes that measured the learned relevance model
(`src/lab/relevance-model.ts`) outside a live session: does its feature set keep
separating relevant from irrelevant pairs when the language changes, and does it
agree with what real traces recorded as useful?

The scripts were recovered from an uncommitted 2026-09-29 worktree snapshot and
landed here as an archive. **No result numbers travel with them**: the probe
reports were never committed, so this directory documents a method and its
frozen inputs, not a measurement. Nothing here is wired into CI, `npm run
agent:verify`, or any scoring path — running a probe is a manual act.

## Files

| File | What it does |
| --- | --- |
| `pair-features.ts` | Shared feature extraction: character n-gram cosine plus the pair features both probes feed the model |
| `multilingual-similarity-probe.ts` | Streams `SemRel/SemRel2024` sentence pairs from Hugging Face, scores them with `statementSimilarity` and the learned model, and reports accuracy per language for a train/held-out split |
| `local-trace-ranking-probe.ts` | Replays this store's own `retrieval_traces` rows (query, candidates, selections, useful/contradicted/rejected ids) through the same features, so the model is judged against recorded use rather than a public dataset |
| `semrel-*.json` | Frozen split manifests — a 300-row smoke run and the three canonical seeds (19427/19428/19429) — so a rerun reproduces the same sample without re-deriving splits |

## Running a probe

Both probes need this directory's own dependencies; the repository root does not
provide them.

```bash
cd evals/similarity
npm install            # @huggingface/hub, hyparquet, hyparquet-compressors
node --experimental-strip-types multilingual-similarity-probe.ts --out report.json
node --experimental-strip-types local-trace-ranking-probe.ts \
  --store ~/.nmg/nmg.sqlite --model weights.json --out traces.json
```

`multilingual-similarity-probe.ts` accepts `--train-languages`,
`--held-out-languages`, `--epochs`, `--max-pairs`, `--max-rows-per-split`,
`--seed` and `--model-out`; defaults train on `eng,esp,hau,mar,tel` and hold out
`afr,arb,hin,ind,pan`. It downloads the dataset on first run, so it needs network
access and disk.

`local-trace-ranking-probe.ts` reads the store read-only and needs a trained
model file; it writes nothing back to the database.

## Boundaries

The BPID identity-matching probe of the same model lives in
[`evals/topology/bpid-neural-probe.ts`](../topology/bpid-neural-probe.ts). It
trains on `.benchmarks/bpid/data/data_release/matching_dataset.jsonl` (not in
this repository) over the same three seeds and fails a run whose rejection
precision drops below 0.95 or whose relevant retention drops below 0.99.

These are diagnostic probes: they expose language-coverage and ranking gaps and
guard against regressions. They are not production prevalence estimates, and a
green probe is not a decision — an accepted result becomes normative only
through the decision or design owner.
