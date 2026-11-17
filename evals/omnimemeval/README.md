# OmniMemEval integration

[简体中文](README.zh-CN.md) · [Terms](README.terms.yaml)

OmniMemEval's user-memory track uses the NMG adapter to send Add and Search
requests to the NMG HTTP service. OmniMemEval owns dataset parsing, answer
generation, judging, checkpoints, and reports. [NMG HTTP service setup](../../onlion/README.md)

## Run LongMemEval over NMG HTTP

Use Bash with Node.js, Git, uv, and Python 3.12 available. For a fresh setup,
start in the NMG repository. The bootstrap checks out the pinned upstream suite.
Its Python
3.11 scorer environment is separate from the upstream suite's Python 3.12 environment.

```bash
npm run benchmark:setup
npm run benchmark:install:omni-adapter
cd .benchmarks/official/OmniMemEval
uv venv --python 3.12 .venv
source .venv/bin/activate
uv pip install -r requirements_user_memory.txt
```

For an existing prepared checkout, rerun only
`npm run benchmark:install:omni-adapter` from the NMG repository to update the adapter.
On Windows, the commands above use Bash and Python from WSL. Follow the pinned
upstream README to prepare the dataset and create a private `.env.aml` in the
OmniMemEval checkout for the answer and judge configuration. Supply
`NMG_OMNI_API_TOKEN` through the process environment.

```bash
export NMG_OMNI_API_URL=https://your-memory-service.example
export NMG_OMNI_API_NAMESPACE="omni-lme-$(date -u +%Y%m%dT%H%M%SZ)"

bash scripts/run_lme_eval.sh --lib nmg --env .env.aml \
  --version "$NMG_OMNI_API_NAMESPACE" --clear 0 --streaming 0
```

The example runs the full suite and writes results under
`results/lme/nmg-<version>/`. To run only Add and Search, append `--to-step 2`.
Use the upstream runner's `--help` for options. For an independent experiment,
choose a fresh namespace. To continue an interrupted HTTP run, reuse its
namespace, version, endpoint, and dataset settings and use the upstream
runner's documented checkpoint options.

The adapter supports non-streaming Add and Search. Automatic deletion and
HaluMem's operation-level scoring are unavailable, so leave `--clear 0` and
`--streaming 0` in place. Test data stays on the selected NMG HTTP service.

## Integration boundary

The installer registers the `nmg` client with OmniMemEval and installs the
shared temporal presentation policy next to it. [Installer](install-adapter.ts)

The client requires an HTTPS endpoint except for loopback tests, rejects
redirects, and prefixes benchmark user IDs with `NMG_OMNI_API_NAMESPACE`.
Add sends a content-derived request ID and checks the synchronous receipt and
identity echoes. Search preserves service ranking within `top_k` and renders
text for the upstream reader. The NMG HTTP service owns extraction, retrieval,
and embedding configuration. [HTTP client](nmg_client.py)

Source and session time travel with Add messages. Search uses `event_time`
for temporal presentation and accepts `created_at` as a compatibility alias
only when `event_time` is absent. An explicit null remains unknown and existing
prefixes are preserved. The structured response retains original fields and
unrendered evidence. [Shared temporal evidence policy](../../docs/design/design/progressive-retrieval.md#temporal-evidence-presentation)

Transport errors include request correlation, elapsed time, HTTP status, and
a bounded response body with the configured token redacted. [HTTP transport contract test](../../tests/evals/omnimemeval-http-client-contract.py)

## Historical benchmark results

The local SQLite benchmark runs, including reverse-retrieval, BGE, PersonaMem
v2, LoCoMo and BEAM measurements, used the archived implementation. Consult
the saved run settings and evidence before comparing those measurements with
a NMG HTTP run. [Evaluation results](../../docs/experiments/benchmark-results.md) · [Archived benchmark guide](https://github.com/wefio/NodeMemoryGraph/blob/codex/archive-legacy-memory-engine-3cf3bec2/evals/omnimemeval/README.md)

Use the [research utilities](research/README.md) for diagnostics on completed
artifacts. The matched no-memory baseline is an internal comparison. The
strict evidence audit reports exact-text coverage separately from official
benchmark scores.
