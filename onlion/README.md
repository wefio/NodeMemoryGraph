# onlion — AML cloud memory service

[简体中文](README.zh-CN.md)

The Git-managed source of the cloud memory application behind NMG's AML
Add/Search boundary. It imports the canonical root `src/` — one NMG
implementation for CLI/daemon and this service, no vendored second tree.
Rationale and boundaries: [the owning decision](../docs/decisions/implemented/2026-10-22-onlion-aml-cloud-service.md).

## Layout

- `backend/worker.mjs` — HTTP surface, authentication, R2 snapshot and receipt
  transaction wiring.
- `backend/memory-service.ts` — the thin AML adapter over the daemon core:
  message mapping, fixed search profile, projection.
- `backend/extractive-summaries.mjs` — deterministic, LLM-free retrieval-index
  summaries through the store's provider mechanism.
- `backend/storage.mjs`, `sqlite.mjs`, `page-delta.mjs` — R2 manifest
  transactions, SQLite WASM request contexts, snapshot page deltas.
- `vendor/` — SQLite WASM runtime glue only (the official 3.53.4 build plus a
  callback module generated at build time from
  `callbacks.manifest.json`, the readable coverage-set manifest; the generated
  wasm is untracked). search-query-parser is a normal npm dependency.
- `.runtime/` — untracked datasets, checkpoints, test persistence, receipts.

## Commands

```bash
npm install
npm run build    # bundles dist/server plus wrangler.json and prompts
npm run check    # tsc --noEmit over the backend and root declarations
npm run verify   # build, check, native temporal/media, backend, worker suites
```

Test suites run against the built Worker in Miniflare with simulated R2 and no
external model.

## Local deployment

```bash
npm run build
npm run start    # wrangler dev on 127.0.0.1:8787, persistence .runtime/wrangler
```

Set `NMG_API_KEY` for the served instance (a Wrangler secret in production;
`--var NMG_API_KEY:...` locally). Optional embedding variables
(`NMG_EMBED_PROVIDER`/`NMG_EMBED_BASE_URL`/…) enable hybrid retrieval; without
them the service runs lexical. Deployment naming is explicit:
`NMG_WORKER_NAME` and `NMG_R2_BUCKET` override the build output instead of
inheriting one hosting configuration.

Deploy with Wrangler after enabling R2 on the target account:

```bash
node node_modules/wrangler/bin/wrangler.js deploy --config dist/server/wrangler.json
```

A `--dry-run` with `--outdir` verifies packaging without touching remote
resources. The local smoke flow (health, Add, receipt conflict, text/image
Search, isolation) lives in `.runtime/verification/smoke-local.mjs` and runs
against `wrangler dev`.

## Multimodal behavior

- Add and Search accept ordered `text`/`image_url` parts; Base64 data URLs
  only (JPEG/PNG/WebP/GIF), bounded per image, content and request.
- Retrieval uses the supplied caption text plus opaque per-image SHA-256
  references. No image-description model is required or invoked, and there is
  no multimodal embedding.
- Search returns the original ordered parts in `content`; `raw_content` is the
  original evidence JSON. `content` may carry the shared conditional temporal
  prefix ([the presentation policy](../src/integration/temporal-evidence-policy.json)).
- Attribution follows the message role; the structured-content marker carries
  format, source role and content hash.

## Multi-clause search

Search accepts either the legacy single `query` (optionally with `options`, which
become `query + ' ' + option` clauses) or a `queries` list of one to eight
independent clauses, each a string or `{text, name}`. The server never invents a
retrieval dimension: the caller supplies them. All clauses are fused the same
way — highest score per memory id, sorted, capped at `top_k` — and the response
adds one row per clause with `contributed` and `exclusive` counts over the
returned page. `queries[0]` is the presentation clause. Sending `queries`
together with `query` or `options` is rejected. See
[the decision](../docs/decisions/implemented/2026-10-23-onlion-multi-clause-search.md).

## Non-goals

No official AML evaluation, production deployment or full benchmark score is
claimed from this package. Remote deletion, async Add, HaluMem
materialized-operation scoring and streaming lifecycles are out of scope; see
[the integration boundary](../evals/omnimemeval/README.md#integration-boundary)
for the evaluation adapter that targets this service.
