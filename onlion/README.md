# NMG HTTP service (onlion)

[简体中文](README.zh-CN.md)

The NMG memory HTTP API exposes Add and Search. Run it locally with `nmg http`
or deploy the cloud adapter in `onlion`. Both entry points share request
validation, memory writes and evidence projection.
[Service design decision](../docs/decisions/implemented/2026-10-22-onlion-aml-cloud-service.md)

## Layout

- [`backend/worker.mjs`](backend/worker.mjs) handles HTTP routes, auth, write
  receipts and the coordination of pending writes with search.
- [`backend/memory-service.ts`](backend/memory-service.ts) binds cloud SQLite snapshots
  to the [shared memory service](../src/integration/memory-http-service.ts).
  Shared modules own evidence attribution, clause fusion and pending evidence scoring.
- [`backend/append-log.mjs`](backend/append-log.mjs) owns pending writes.
  [`backend/storage.mjs`](backend/storage.mjs) manages manifests and snapshots.
  [`backend/sqlite.mjs`](backend/sqlite.mjs) opens request-scoped SQLite WASM
  databases using the runtime under `sqlite-wasm/`.
- Cloudflare binds R2 directly. [`backend/edgeone-entry.mjs`](backend/edgeone-entry.mjs)
  connects the same Worker to the COS adapter.

## Commands

```bash
npm install
npm run build    # bundles dist/server plus wrangler.json and prompts
npm run check    # tsc --noEmit over the backend and root declarations
npm run verify   # build, check, native temporal/media, backend, worker suites
```

The CI suite runs against the built Worker in Miniflare with simulated R2 and
no external model. After building, run `npm run test:http-contract` for just
the HTTP contract. It checks health, auth, immediate search visibility,
out-of-order and duplicate Adds, conflicting request IDs, user isolation,
and reset. A loopback relay injects a 429 and disconnects after a successful
upstream Add to check recovery with the same request ID.

## Local memory HTTP

Set the database and listener in `nmg-http.json`, then run
`nmg http --config ./nmg-http.json`. From a source checkout, use
`npm run cli -- http --config ./nmg-http.json`.

```json
{
  "databasePath": "./http-test.sqlite",
  "host": "127.0.0.1",
  "port": 8787,
  "defaultTopK": 20,
  "maxRequestBytes": 6291456
}
```

`databasePath` is required. Resolve relative paths from the config file's directory.
The other values are defaults. To protect Add and Search, set `apiKeyEnv` to the name
of an environment variable containing the key; clients send `Authorization: Bearer <key>`.
A non-loopback bind requires a key.

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/add -H 'Content-Type: application/json' \
  -d '{"user_id":"demo","session_id":"s1","request_id":"r1","messages":[{"role":"user","content":"I prefer morning meetings."}]}'
curl http://127.0.0.1:8787/search -H 'Content-Type: application/json' \
  -d '{"user_id":"demo","query":"When should meetings be scheduled?","top_k":5}'
```

The local listener isolates SQLite namespaces by `user_id`. Each Add atomically
writes up to 128 messages. Repeating the same request ID and payload replays the
receipt. Changing the payload with the same ID yields `409`. Search uses the
shared engine for lexical retrieval with one query and returns both structured
`data` and the NMG renderer's `rendered` text. The HTTP listener and daemon
sessions use separate memory namespaces.

## Local deployment

Use this path to debug the Cloudflare Worker and object storage adapter locally.

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

A `--dry-run` with `--outdir` verifies packaging without contacting remote
resources.

## EdgeOne deployment

Use this target when the evaluation traffic must reach the service from
mainland China; the hosted-platform path returns 403 to those requests.
`onlion/edgeone-migration-plan.md` owns the design and the collected pitfalls.

```bash
npm run build:edgeone   # dist/edgeone (single-file function) + dist/edgeone.zip
npm run test:cos        # storage adapter against the real bucket
npm run test:edgeone    # full Add/Search/reset over the built artifact + real bucket
npm run deploy:edgeone  # edgeone makers deploy ./dist/edgeone -n nmg-memory-api
```

Storage is Tencent COS instead of R2. The bucket must be in the **same region**
as the function, and **version control must stay off**: the storage adapter
emulates the manifest CAS with `x-cos-forbid-overwrite`, which COS ignores on
versioned buckets. The function region is a per-project console setting that
only applies on the next deployment; `edgeone.json` does not retarget an
existing project, so verify placement with the `x-nmg-region` response header.

Configuration comes from the platform environment, not from files:
`NMG_API_KEY`, `NMG_COS_BUCKET`/`NMG_COS_REGION`/`NMG_COS_SECRET_ID`/`NMG_COS_SECRET_KEY`,
and the optional `NMG_EMBED_*` set (same meaning as for the Wrangler target).
Set `NMG_ENDPOINT` and `NMG_API_KEY` and run `npm run smoke:edgeone` to run
the same HTTP contract over the network. Use an endpoint whose key allows
Add, Search, capacity and reset. The run creates and resets only its own
randomly named test users. Use [`soak-endpoint.mjs`](scripts/soak-endpoint.mjs)
for sustained concurrency and latency measurements.

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
together with `query` or `options` is rejected. A clause may carry
`appendOnly: true`: its results skip the page and come back in a separate
`appended` field, deduplicated against the page and capped at `top_k`. See
[the multi-clause decision](../docs/decisions/implemented/2026-10-23-onlion-multi-clause-search.md)
and [the append-only decision](../docs/decisions/implemented/2026-10-23-onlion-append-only-clauses.md).

## Non-goals

The included verification covers the service contract and packaging. Remote
deletion, async Add, HaluMem
materialized-operation scoring and streaming lifecycles are out of scope; see
[the integration boundary](../evals/omnimemeval/README.md#integration-boundary)
for the evaluation adapter that targets this service.
