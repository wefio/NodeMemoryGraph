/* global __NMG_SOURCE_REVISION__ */
import {
  withRequest,
  requestIdentity,
  queueAccepted,
  queueStarted,
  queueFinished,
  queueStatus,
  reportFailure,
  embeddingOperation,
  embeddingObservation,
  recentFailures,
  check,
  classifyError,
} from "./monitoring.mjs";
import { memoryBucket, reclaimAll, reclamationStatus } from "./reclamation.mjs";
import {
  measure,
  profileSearch,
  runtimeStatus,
  statisticsEnabled,
  setStatistics,
  requestAccepted,
  requestStarted,
  requestFinished,
} from "./diagnostics.mjs";
import init from "../sqlite-wasm/worker-loader.mjs";
import compiledSqlite from "../sqlite-wasm/sqlite3.wasm";
import { configure, DatabaseSync, withDatabases, sqliteStats } from "./sqlite.mjs";
import { memRequestStarted, memLog, memFields } from "./mem-trace.mjs";
import { AmlMemoryService, AML_SEARCH_PROFILE, CORE_SOURCE } from "./memory-service.ts";
import { createEmbeddingClientFromEnv } from "../../src/core/embedding-provider.ts";
import {
  normalizeContent,
  contentText,
  describeContent,
  ContentValidationError,
} from "../../src/integration/multimodal-content.ts";
import { createHash, timingSafeEqual } from "node:crypto";
import { page } from "./page.mjs";
import {
  USER_LIMIT,
  PART_LIMIT,
  PART_TARGET,
  MAX_PARTS,
  keyFor,
  StorageError,
  loadManifest,
  newPart,
  runPart,
  stagePart,
  stageSearchPart,
  commitManifest,
  removeStaged,
  retireParts,
  userCapacity,
  resetUser,
  manifestFormat,
  pendingCount,
  setPending,
} from "./storage.mjs";
import { deltaBytes, USER_DELTA_LIMIT } from "./page-delta.mjs";
import { deferredDocuments } from "./embedding-session.mjs";
import {
  LOG_ENTRY_VERSION,
  MAX_PENDING_READ,
  deleteLogEntries,
  findLogEntry,
  foldPlan,
  listPending,
  logEntryLanded,
  putLogEntry,
} from "./append-log.mjs";
import { cosineSimilarity } from "../../src/core/vector.ts";
import {
  MAX_QUERY_FEATURES,
  MAX_QUERY_WINDOWS,
  QUERY_CHUNK_CHARS,
  selectQueryFeatures,
} from "./query-chunks.mjs";
const MAX_DATABASE_BYTES = USER_LIMIT;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
/** Payload caps are sized against the platform request body, not against a single
 *  global character budget. The benchmark contract states there is no global
 *  character cap and that an unsupported payload should get a clear 4xx, so a cap
 *  here may reject only what cannot fit — not what merely reads long.
 *
 *  Measured failure: an Agent Memory Leaderboard smoke run failed its whole Search
 *  stage with `413 content_too_large` because the per-clause cap was 4,096
 *  characters, and a separate Add failed the same way because one message exceeded
 *  128,000 characters. Both payloads fit comfortably in a 6 MiB body, so both were
 *  our limit rejecting legitimate input.
 *
 *  The query cap is generous on purpose: query embedding is best-effort
 *  (`warmClauseVectors` swallows its failure), so a very long query degrades to
 *  lexical retrieval instead of failing the request. */
const MAX_QUERY_CHARS = 1_000_000;
const MAX_MESSAGE_CHARS = 1_000_000;
const MAX_COMBINED_MESSAGE_CHARS = 1_500_000;
const MAX_ORDERED_CONTENT_BYTES = 4 * 1024 * 1024;
const TEXT_LIMITS = {
  max_query_chars: MAX_QUERY_CHARS,
  max_message_chars: MAX_MESSAGE_CHARS,
  max_combined_message_chars: MAX_COMBINED_MESSAGE_CHARS,
  max_ordered_content_bytes: MAX_ORDERED_CONTENT_BYTES,
  query_chunk_chars: QUERY_CHUNK_CHARS,
  max_query_chunks: MAX_QUERY_WINDOWS,
  max_query_features: MAX_QUERY_FEATURES,
};
const SOURCE_REVISION =
  typeof __NMG_SOURCE_REVISION__ === "undefined" ? "development" : __NMG_SOURCE_REVISION__;
// Cache only the completed, I/O-free WASM instance. Pending operations belong
// to their originating request and must never be chained across invocations.
let ready;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const objectKey = (key) => `users/${key}.sqlite`;
const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function textField(value, label, max = 512) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(
      400,
      "invalid_request",
      `${label} must be a nonempty string of at most ${max} characters`,
    );
  return value;
}
function contentField(value, maxTextChars = MAX_MESSAGE_CHARS) {
  try {
    const content = normalizeContent(value, { maxTextChars });
    if (
      typeof content !== "string" &&
      new TextEncoder().encode(JSON.stringify(content)).length > MAX_ORDERED_CONTENT_BYTES
    ) {
      throw new HttpError(
        413,
        "content_too_large",
        `Ordered source content limit is ${MAX_ORDERED_CONTENT_BYTES} bytes`,
      );
    }
    return content;
  } catch (error) {
    if (error instanceof ContentValidationError)
      throw new HttpError(
        error.code === "content_too_large" ? 413 : 400,
        error.code,
        error.message,
      );
    throw error;
  }
}
function createContentView() {
  // Supplied captions are the retrieval view; no model is invoked.
  return (content) => describeContent(content);
}
async function sqliteReady() {
  if (ready) return ready;
  const instance = await init({
    instantiateWasm(imports, receive) {
      const instance = new WebAssembly.Instance(compiledSqlite, imports);
      receive(instance, compiledSqlite);
      return instance.exports;
    },
    print: () => {},
    printErr: () => {},
  });
  if (!ready) {
    ready = instance;
    configure(ready);
    // Once per instance: what loading the SQLite module costs, before any request data is
    // touched. `seq` here is the request that paid for the load.
    memLog("sqlite_ready", null, { sqlite: sqliteStats() });
  }
  return ready;
}
function authenticate(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const authorizationToken = authorization.match(/^(?:Bearer|Token)\s+(.+)$/i)?.[1] || "";
  const supplied = request.headers.get("x-api-key") || authorizationToken;
  if (!env.NMG_API_KEY)
    throw new HttpError(503, "not_configured", "API authentication is not configured");
  if (
    !supplied ||
    !timingSafeEqual(Buffer.from(hash(supplied)), Buffer.from(hash(env.NMG_API_KEY)))
  )
    throw new HttpError(
      401,
      "unauthorized",
      "A valid Token, Bearer, or X-API-Key credential is required",
    );
}
async function readJson(request) {
  if (Number(request.headers.get("content-length")) > MAX_BODY_BYTES)
    throw new HttpError(413, "request_too_large", "Request limit is 6 MiB");
  if (!request.body) throw new HttpError(400, "invalid_json", "JSON body required");
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new HttpError(413, "request_too_large", "Request limit is 6 MiB");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  try {
    const v = JSON.parse(new TextDecoder().decode(body));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw 0;
    return v;
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be a JSON object");
  }
}
/** Retry delay for a manifest CAS conflict: exponential with full jitter. The
 *  previous fixed 15-100 ms window made sixteen writers re-collide in lockstep, so
 *  each of them spent its whole attempt budget on the same round trips. */
const WRITE_BACKOFF_BASE_MS = 20;
const WRITE_BACKOFF_CAP_MS = 600;
const writeBackoffMs = (attempt) =>
  Math.random() * Math.min(WRITE_BACKOFF_CAP_MS, WRITE_BACKOFF_BASE_MS * 2 ** (attempt - 1));
// Atomic manifest commits preserve request idempotency across all partitions.
/** One attempt's manifest read, with the guard that turns a reset during a retry into
 *  a clear 409 instead of a write against a replaced dataset. */
async function readAttempt(env, key, userId, attempt, generation) {
  const { object, manifest: before } = await measure("manifest_read", () =>
    loadManifest(env.MEMORY, key, userId),
  );
  const observed = before.generation ?? null;
  if (attempt === 0) return { object, before, generation: observed };
  if (observed !== generation)
    throw new HttpError(
      409,
      "user_reset",
      "User memory was reset during this operation; submit only the new dataset",
    );
  return { object, before, generation };
}

/** Runs the operation once and commits it, or reports that the CAS rejected the write.
 *
 *  The outcome carries an explicit `retry` flag rather than signalling a lost CAS with
 *  `response: null`. `null` is a legal JSON payload, so an operation that legitimately
 *  returned it would be retried until the attempt budget ran out and then answered 503 -
 *  a failure mode no test would notice. Read-only outcomes are `committed: false` and
 *  must not be retried either. */
async function commitAttempt(env, { sqlite, key, object, before, operation, reuse, staged }) {
  const manifest = structuredClone(before);
  const result = await operation({ sqlite, key, manifest, staged, reuse });
  if (result.readOnly) return { response: result.response, committed: false, retry: false };
  const saved = await measure("manifest_commit", () =>
    commitManifest(env.MEMORY, key, object, manifest),
  );
  if (!saved) return { retry: true };
  const live = new Set(manifest.parts.map((p) => p.key));
  // `reuse` holds keys uploaded by an earlier attempt of this same request. A committed attempt
  // has to retire those too: they belong to a manifest that lost its CAS, so filtering only
  // `staged` left one orphan per reused snapshot under parts/. The end-state invariant is
  // "every key under parts/ is referenced by the manifest", which is what this enforces.
  await removeStaged(
    env.MEMORY,
    [...new Set([...staged, ...reuse.values()])].filter((k) => !live.has(k)),
  ).catch(() => {});
  await measure("retired_cleanup", () => retireParts(env.MEMORY, before, manifest));
  return { response: result.response, committed: true, retry: false };
}

async function mutateUser(env, userId, operation) {
  const sqlite = await measure("sqlite_init", () => sqliteReady()),
    key = keyFor(userId);
  // Concurrent writers on one user serialize through the manifest CAS: each loser
  // re-reads and retries. 4 attempts is fine for incidental overlap, but a
  // benchmark harness can hit one user with 16 writers at once, where every
  // round trip is cheap (~1 s) and giving up surfaces as a spurious 503.
  const attempts = Number(env.NMG_WRITE_ATTEMPTS) > 0 ? Number(env.NMG_WRITE_ATTEMPTS) : 12;
  // Partition snapshots this request already uploaded, keyed by content. A retry
  // recomputes the snapshot, and a competing Add that rewrote a different
  // partition leaves this one byte-identical, so re-uploading it was pure cost.
  const reuse = new Map();
  let committed = false;
  let generation;
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, writeBackoffMs(attempt)));
      const attemptState = await readAttempt(env, key, userId, attempt, generation);
      generation = attemptState.generation;
      // Staged objects survive a conflict retry so the next attempt can reuse an
      // identical upload; they are removed once, after the last attempt.
      const staged = [];
      try {
        const outcome = await commitAttempt(env, {
          sqlite,
          key,
          object: attemptState.object,
          before: attemptState.before,
          operation,
          reuse,
          staged,
        });
        if (!outcome.retry) {
          // Only the ending attempt may claim the commit: a lost CAS must not touch
          // `committed`, or the `finally` cleanup below would run for a write that a
          // rival did commit.
          committed ||= outcome.committed;
          return outcome.response;
        }
      } catch (error) {
        if (error.code === "snapshot_changed") continue;
        throw error;
      }
    }
    throw new HttpError(
      503,
      "write_conflict",
      "Concurrent changes detected; retry the same request_id",
    );
  } finally {
    if (!committed) await removeStaged(env.MEMORY, [...reuse.values()]).catch(() => {});
  }
}
/** Per-attempt embedding timeout.
 *
 *  The platform kills an invocation at 120 s and the client retries a timeout, so a
 *  per-attempt budget of 90 s made one slow call 90 s + backoff + 90 s: the request died
 *  at the platform ceiling with no answer and no diagnostics, which is what the 220
 *  timeouts of the 2026-10-29 incident look like. Ten seconds is the provider client's
 *  own default and leaves room for a round trip to be slow ten times over. */
const EMBED_TIMEOUT_MS = 10_000;
/** Per-attempt timeout for documents.
 *
 *  A query is small and the provider is remote from the function, so ten seconds is already
 *  generous for it. A document batch is neither: it carries a whole message, and the calls
 *  cross a region boundary, where a healthy round trip and a stalled one differ by an order of
 *  magnitude. Cutting a document at ten seconds turned "the provider was slow" into a failed
 *  Add, which is the one failure the write path cannot absorb. */
const EMBED_DOCUMENT_TIMEOUT_MS = 25_000;
/** Total embedding work one write may spend. The invocation is killed at 120 s, and the write
 *  still needs room for its partition round trips after the vectors land, so the budget is
 *  well inside it: past this point the Add fails with a clear code instead of running out the
 *  clock with no answer. */
const EMBED_WRITE_BUDGET_MS = 45_000;
/** Total embedding work one search may spend, across every call site.
 *
 *  A single search embeds its clauses, their windows, every pending record and each
 *  partition's query - all inside one invocation. Bounding the total rather than each
 *  call means a slow provider costs a degraded score instead of the whole request:
 *  every caller already treats a missing vector as "score this one by term overlap". */
const EMBED_QUERY_BUDGET_MS = 25_000;
function embeddingClient(env) {
  const client = createEmbeddingClientFromEnv({
    ...env,
    NMG_EMBED_TIMEOUT_MS: env.NMG_EMBED_TIMEOUT_MS ?? String(EMBED_TIMEOUT_MS),
  });
  if (!client) return undefined;
  /** text -> vector, for every feature this request has needed so far. */
  const vectorsByText = new Map();
  const budgetMs =
    Number(env.NMG_EMBED_QUERY_BUDGET_MS) > 0
      ? Number(env.NMG_EMBED_QUERY_BUDGET_MS)
      : EMBED_QUERY_BUDGET_MS;
  const deadline = Date.now() + budgetMs;
  const writeBudgetMs =
    Number(env.NMG_EMBED_WRITE_BUDGET_MS) > 0
      ? Number(env.NMG_EMBED_WRITE_BUDGET_MS)
      : EMBED_WRITE_BUDGET_MS;
  const writeDeadline = Date.now() + writeBudgetMs;
  // A second client, not a second knob on the first: the provider client keeps one timeout,
  // and documents need a longer one than queries.
  let documentClient;
  const documents = () =>
    (documentClient ??= createEmbeddingClientFromEnv({
      ...env,
      NMG_EMBED_TIMEOUT_MS: env.NMG_EMBED_TIMEOUT_MS ?? String(EMBED_DOCUMENT_TIMEOUT_MS),
    }));
  // Thrown from inside `measure`'s async callback this becomes a rejection, which is what
  // every call site is written against (`catch(() => [])`). A synchronous throw would
  // escape that and fail the request instead of degrading it.
  const spend = () => {
    if (Date.now() < deadline) return;
    throw Object.assign(new Error("embedding budget exhausted for this request"), {
      code: "embedding_budget_exhausted",
    });
  };
  return {
    indexId: client.indexId,
    model: client.model,
    profile: client.profile,
    embed: (inputs) =>
      Promise.resolve().then(() => {
        spend();
        return embeddingOperation(() => client.embed(inputs));
      }),
    embedDocuments: deferredDocuments((inputs) => {
      // Bounded by a total, not by an attempt: without it one slow provider turned a single
      // Add into a 55-120 s request that the platform killed with no answer.
      if (Date.now() >= writeDeadline)
        throw Object.assign(new Error("embedding budget exhausted for this request"), {
          code: "embedding_budget_exhausted",
        });
      return embeddingOperation(() => documents().embedDocuments(inputs));
    }),
    // Cached per TEXT, not per input array. The retrieval engine embeds one feature at a
    // time (`embedQueries([text])`), so a cache keyed by the array only ever hits when the
    // caller happens to ask for the same list: pre-warming a batch would populate nothing the
    // engine could use, and it would embed every feature separately instead. Against a
    // provider across a region boundary that is up to twenty-four round trips per search
    // instead of one.
    embedQueries(inputs) {
      const unique = [...new Set(inputs)];
      const missing = unique.filter((text) => !vectorsByText.has(text));
      const fetched = missing.length
        ? measure("embedding", async () => {
            spend();
            // Embedded exactly as given. Long-query handling lives in
            // `queryFeatures`, which searches the whole clause and its windows as
            // separate features: pooling them here would average the query's
            // aspects into one compromise vector, which measured worse than either
            // the whole text or the per-feature maximum.
            const vectors = await embeddingOperation(() => client.embedQueries(missing));
            if (vectors.length !== missing.length)
              throw new Error("embedding provider returned an invalid query batch");
            return vectors;
          }).then((vectors) => {
            missing.forEach((text, index) => vectorsByText.set(text, vectors[index]));
          })
        : undefined;
      return Promise.resolve(fetched).then(() => inputs.map((text) => vectorsByText.get(text)));
    },
  };
}
function copyLegacyReceipts(manifest, rows) {
  for (const row of rows || [])
    manifest.receipts[row.request_hash] ??= {
      fingerprint: row.fingerprint,
      response: JSON.parse(row.response),
      completed_at: row.completed_at,
    };
}
function normalizeAddMessage(m) {
  if (!m || typeof m !== "object") throw new HttpError(400, "invalid_request", "Invalid message");
  const content = contentField(m.content);
  const role = textField(m.role, "message.role", 64);
  if (!["user", "assistant"].includes(role))
    throw new HttpError(400, "invalid_request", "message.role must be user or assistant");
  let chat_time = m.chat_time;
  if (chat_time === undefined && m.timestamp !== undefined) {
    if (
      typeof m.timestamp !== "number" ||
      !Number.isFinite(m.timestamp) ||
      !Number.isFinite(new Date(m.timestamp).getTime())
    )
      throw new HttpError(400, "invalid_request", "timestamp must be Unix milliseconds");
    chat_time = new Date(m.timestamp).toISOString();
  }
  if (
    chat_time !== undefined &&
    (typeof chat_time !== "string" || !Number.isFinite(Date.parse(chat_time)))
  )
    throw new HttpError(400, "invalid_request", "chat_time must be a valid date string");
  return { role, content, ...(chat_time ? { chat_time } : {}) };
}
async function existingReceipt(env, ctx, requestHash, fingerprint) {
  const previous = ctx.manifest.receipts[requestHash];
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        "request_id_reused",
        "request_id was already used for different content",
      );
    return { readOnly: true, response: previous.response };
  }
  // A v1 receipt remains authoritative when retrying a pre-upgrade request.
  const legacy = ctx.manifest.parts.find((p) => p.key === objectKey(ctx.key));
  if (!legacy) return undefined;
  const old = await runPart(env.MEMORY, legacy, ctx.sqlite, async ({ connection }) => {
    const exists = connection
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_receipts'")
      .get();
    return {
      readOnly: true,
      response: exists
        ? connection
            .prepare("SELECT fingerprint,response FROM cloud_receipts WHERE request_hash=?")
            .get(requestHash)
        : undefined,
    };
  });
  if (old.response) {
    if (old.response.fingerprint !== fingerprint)
      throw new HttpError(
        409,
        "request_id_reused",
        "request_id was already used for different content",
      );
    return { readOnly: true, response: JSON.parse(old.response.response) };
  }
  return undefined;
}
async function addOneBatch(env, ctx, requestId, batch, manifest, staged) {
  const reserve = batch.reduce(
    (sum, m) =>
      sum +
      new TextEncoder().encode(
        typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      ).length *
        6 +
      12 * 1024,
    0,
  );
  let index = manifest.parts.length - 1;
  if (index < 0 || manifest.parts[index].bytes + reserve > PART_TARGET) {
    if (manifest.parts.length >= MAX_PARTS)
      throw new StorageError("user_storage_limit", "User exceeds 128 storage partitions");
    index = manifest.parts.length;
    manifest.parts.push(newPart(ctx.userId));
  }
  const compute = (part) =>
    runPart(env.MEMORY, part, ctx.sqlite, async ({ key: partKey }) => {
      const service = new AmlMemoryService(partKey, ctx.client);
      return {
        response: await measure("nmg_write", () =>
          service.rememberBatch(ctx.userId, ctx.sessionId, requestId, batch),
        ),
      };
    });
  let result = await compute(manifest.parts[index]);
  if (result.snapshot.byteLength > PART_LIMIT && manifest.parts[index].bytes) {
    if (manifest.parts.length >= MAX_PARTS)
      throw new StorageError("user_storage_limit", "User exceeds 128 storage partitions");
    index = manifest.parts.length;
    manifest.parts.push(newPart(ctx.userId));
    result = await compute(manifest.parts[index]);
  }
  if (result.snapshot.byteLength > PART_LIMIT)
    throw new StorageError(
      "part_storage_limit",
      "One Add batch exceeds 8 MiB; submit fewer messages",
    );
  copyLegacyReceipts(manifest, result.legacyReceipts);
  const part = await stagePart(
    env.MEMORY,
    ctx.key,
    manifest.parts[index],
    result.snapshot,
    ctx.reuse,
  );
  manifest.parts[index] = part;
  staged.push(part.key);
  return result.response.added;
}
/** Validation shared by both accept paths: the log and the synchronous write must
 *  reject exactly the same requests, or a mode switch changes what is legal. */
function readAddRequest(input) {
  const userId = textField(input.user_id ?? input.userId, "user_id");
  requestIdentity(userId, input.request_id);
  const requestId = textField(input.request_id, "request_id");
  const sessionId = textField(input.session_id ?? input.conversationId, "session_id");
  if (!Array.isArray(input.messages) || !input.messages.length || input.messages.length > 512)
    throw new HttpError(400, "invalid_request", "messages must contain between 1 and 512 messages");
  let chars = 0;
  const messages = input.messages.map((m) => {
    const message = normalizeAddMessage(m);
    chars += contentText(message.content).length;
    return message;
  });
  if (chars > MAX_COMBINED_MESSAGE_CHARS)
    throw new HttpError(
      413,
      "request_too_large",
      `Combined message content limit is ${MAX_COMBINED_MESSAGE_CHARS} characters`,
    );
  return {
    userId,
    requestId,
    sessionId,
    messages,
    requestHash: hash(requestId),
    fingerprint: hash(JSON.stringify({ sessionId, messages })),
  };
}
/** Body returned by both accept paths. `completed` describes persistence, not
 *  compaction: after the log write the data is durable and readable through
 *  `pendingForSearch`, which is what the contract asks a 200 to mean. */
function addResponse(key, requestId, userId, sessionId, requestHash, added) {
  return {
    success: true,
    request_id: requestId,
    user_id: userId,
    session_id: sessionId,
    task_id: `${key}.${requestHash}`,
    status: "completed",
    added,
  };
}
/** Accepts an Add as one immutable log entry.
 *
 *  The cost is a manifest read, one log write, and a manifest CAS that carries the
 *  pending counter - no partition download, no SQLite export, no snapshot upload,
 *  which is what made a 16-way burst on one user sixteen multi-megabyte rounds.
 *  The retry loop re-writes the same entry (a replay, no write) and re-commits only
 *  the manifest, so a conflict is cheap here. */
async function acceptAdd(env, input) {
  const { userId, requestId, sessionId, messages, requestHash, fingerprint } =
    readAddRequest(input);
  const contentView = createContentView();
  let accepted = 0;
  let prepared = null;
  let reservation = null;
  const response = await mutateUser(env, userId, async (ctx) => {
    const reused = await existingReceipt(env, ctx, requestHash, fingerprint);
    if (reused) return reused;
    // Scoped to this generation: an entry written before a reset has the same name,
    // and replaying its stored response would swallow the new Add - the request would
    // answer 200 while its data was never recorded (class A, data lost).
    const pending = await findLogEntry(env.MEMORY, ctx.key, requestHash, {
      generation: ctx.manifest.generation ?? null,
    });
    if (pending) {
      if (pending.entry.fingerprint !== fingerprint)
        throw new HttpError(
          409,
          "request_id_reused",
          "request_id was already used for different content",
        );
      return { readOnly: true, response: pending.entry.response };
    }
    // Structured content is prepared once per request, not once per retry: a
    // caption may come from a vision model and a CAS conflict must not pay for it
    // twice. It is prepared before the entry is written, so a fold never has to call
    // a vision model while holding a partition.
    if (!prepared) {
      prepared = [];
      for (const message of messages)
        prepared.push(
          typeof message.content === "string"
            ? message
            : { ...message, indexText: await contentView(message.content) },
        );
    }
    const response = addResponse(
      ctx.key,
      requestId,
      userId,
      sessionId,
      requestHash,
      prepared.length,
    );
    // Reserve the counter *before* the entry is durable. The order is the safety
    // argument: a failed commit leaves no entry behind, while a failed write leaves
    // the counter one too high - and an over-count only costs a log listing. The
    // other order strands an entry no counter accounts for, and `pendingCount === 0`
    // then hides it from every search (I1).
    accepted = setPending(ctx.manifest, pendingCount(ctx.manifest) + 1);
    reservation = {
      key: ctx.key,
      entry: {
        v: LOG_ENTRY_VERSION,
        generation: ctx.manifest.generation ?? null,
        user_id: userId,
        session_id: sessionId,
        request_id: requestId,
        request_hash: requestHash,
        fingerprint,
        received_at: Date.now(),
        messages: prepared,
        response,
      },
    };
    return { response };
  });
  // The reservation is committed; only now must the entry become durable. A failure
  // answers 5xx with the counter one too high, which capacity or the next fold
  // corrects by reading the log back.
  if (reservation) {
    try {
      await putLogEntry(env.MEMORY, reservation.key, reservation.entry);
    } catch (error) {
      // A throwing write is not proof that nothing reached the bucket: the storage
      // wrapper writes first and then verifies the generation, so the throw can
      // happen after the object landed. Ask instead of assuming, and only give the
      // slot back when the answer is a definite "no" - releasing for an entry that
      // is on disk leaves a counter below the truth, which hides accepted data.
      const landed = await logEntryLanded(env.MEMORY, reservation.key, reservation.entry).catch(
        () => null,
      );
      if (landed === true) return { response, pending: accepted };
      if (landed === false) await releasePending(env, userId).catch(() => {});
      throw error;
    }
  }
  return { response, pending: accepted };
}
/** Folds waiting entries into the partition, one partition write for the batch.
 *
 *  Entries whose receipt already exists are skipped, which is what makes a fold
 *  that committed and then crashed before deleting its entries safe to repeat (I3).
 *  Their objects are removed only after the commit, never before. */
async function foldPending(env, userId) {
  const client = embeddingClient(env);
  const key = keyFor(userId);
  const waiting = await listPending(env.MEMORY, key, { limit: FOLD_BATCH });
  if (waiting.length === 0) {
    // An empty log with a non-zero counter is the residue of a reservation whose
    // write never landed. Nothing else notices it: the fold trigger is the counter
    // itself, so it never fires. Give one slot back per call and report the release
    // as progress, which is what keeps `/admin/fold` iterating until it is clean.
    const manifest = (await loadManifest(env.MEMORY, key, userId)).manifest;
    if (pendingCount(manifest) === 0) return { folded: 0, remaining: 0, released: false };
    const released = await releasePending(env, userId).catch(() => null);
    // `remaining` must be the count *after* the release. Reporting the pre-release
    // number made a log that needed exactly the round budget answer 409 on its last
    // call: safe, but it looked like the drain had failed to make progress.
    return { folded: 0, remaining: released ?? pendingCount(manifest), released: true };
  }
  const plan = foldPlan(waiting, { maxEntries: FOLD_BATCH, maxBytes: MAX_BODY_BYTES });
  let drop = [];
  let remaining = 0;
  const result = await mutateUser(env, userId, async (ctx) => {
    // A name leaves the counter whether the entry is applied or skipped: a receipt
    // that already exists (crash recovery) and a cross-generation entry both mean
    // this name is finished with. Counting only the applied ones leaves the counter
    // above zero forever, which disables the search short-circuit in
    // `pendingForSearch` and reports a backlog that does not exist.
    const names = new Set();
    let folded = 0;
    const generation = ctx.manifest.generation ?? null;
    for (const { name, entry } of plan.fold) {
      names.add(name);
      if (ctx.manifest.receipts[entry.request_hash]) continue;
      if ((entry.generation ?? null) !== generation) continue;
      const batch = entry.messages.map((message, index) => ({
        ...message,
        source_message_id: `aml:${entry.request_hash}:${index}`,
      }));
      await addOneBatch(
        env,
        { ...ctx, userId, sessionId: entry.session_id, client },
        entry.request_id,
        batch,
        ctx.manifest,
        ctx.staged,
      );
      ctx.manifest.receipts[entry.request_hash] = {
        fingerprint: entry.fingerprint,
        response: entry.response,
        completed_at: new Date().toISOString(),
      };
      folded += 1;
    }
    drop = [...names];
    if (names.size === 0) return { readOnly: true, response: { folded: 0 } };
    // The counter is deliberately not touched here. Subtracting what this batch
    // retired is only correct for the attempt that computed the plan: `mutateUser`
    // re-runs this callback with the *same* plan after a CAS conflict, and by then a
    // rival fold has usually retired those names already, so the subtraction would
    // happen twice and drive the count below the log. The count is reconciled from
    // the log after the delete instead - derived, never accumulated.
    return { response: { folded } };
  });
  // Only after the commit: an entry present without a receipt is safe to repeat,
  // an entry deleted without a receipt would be lost (I3).
  if (drop.length > 0) {
    await deleteLogEntries(env.MEMORY, key, drop).catch(() => {});
    // One read of the log's own truth settles every way the count could have drifted:
    // a stale plan after a CAS retry, entries whose receipt already existed, entries
    // from another generation, and a failed delete. Reading it after the delete is
    // what makes the counter a derivation instead of a history.
    const left = await listPending(env.MEMORY, key, { limit: Infinity }).then(
      (list) => list.length,
      () => null,
    );
    if (left !== null) {
      remaining = left;
      await reconcilePending(env, userId, left).catch(() => {});
    }
  }
  return { folded: result.folded ?? 0, remaining };
}
/** Gives one reserved slot back after a write that never became durable.
 *
 *  Relative, not absolute: a concurrent accept may have reserved in between, and
 *  writing a computed absolute value would erase its increment (a lost update).
 *  The read-modify-write is inside the manifest CAS like every other count change. */
async function releasePending(env, userId) {
  const response = await mutateUser(env, userId, async (ctx) => {
    const count = pendingCount(ctx.manifest);
    if (count === 0) return { readOnly: true, response: { pending: 0 } };
    setPending(ctx.manifest, count - 1);
    return { response: { pending: count - 1 } };
  });
  // The count itself, not the response body: callers that report `remaining` need
  // the value after the release, and `mutateUser` already unwraps `response`.
  return response.pending;
}
/** Writes the observed number of waiting entries back to the manifest. Used after a
 *  failed delete, where the decremented counter no longer matches the log. */
async function reconcilePending(env, userId, count) {
  return mutateUser(env, userId, async (ctx) => {
    if (pendingCount(ctx.manifest) === count)
      return { readOnly: true, response: { pending: count } };
    setPending(ctx.manifest, count);
    return { response: { pending: count } };
  });
}
/** Terms the lexical fallback scores against: the query features, split the way the
 *  store's own lexical channel splits them (lowercase, alphanumeric runs, stopword-ish
 *  short tokens dropped). */
function queryTerms(features) {
  const seen = new Set();
  for (const feature of features)
    for (const term of String(feature)
      .toLowerCase()
      .split(/[^a-z0-9一-鿿]+/u))
      if (term.length > 2) seen.add(term);
  return [...seen];
}

/** How many query terms a pending entry mentions. Zero means it is not a match, which is
 *  what keeps an unmatched query answering with an empty page in a lexical-only
 *  deployment. */
function pendingTermScore(content, terms) {
  const text = String(content).toLowerCase();
  let score = 0;
  for (const term of terms) if (text.includes(term)) score += 1;
  return score;
}
/** Fuses the entries still in the log into the page, scored against the same clauses the
 *  partitions were searched with.
 *
 *  Each entry costs one embedding call, capped by `MAX_PENDING_READ`, because a search has
 *  to see an Add that was just accepted. It is also attributed to the clause it matches
 *  best: the per-clause counts must keep covering every returned memory, which is the
 *  multi-clause contract, and a pending record that skipped attribution made the sum fall
 *  short of the page size.
 *
 *  Without a vector channel the same fusion runs on term overlap instead, because a
 *  deployment that has no embeddings still has to return what it accepted - and a flat
 *  zero score would return every pending entry for every query, including one that
 *  matches nothing.
 */
async function fusePendingRecords({
  env,
  ctx,
  features,
  candidates,
  client,
  modes,
  topK,
  contributions,
  appendOnly,
  appendedById,
}) {
  if (pendingCount(ctx.manifest) === 0) return candidates;
  const waiting = await pendingForSearch(env, ctx, Math.min(topK, MAX_PENDING_READ));
  if (waiting.length === 0) return candidates;
  const attribute = (clauseIndex) => {
    const total = contributions?.[clauseIndex];
    if (total && clauseIndex >= 0) total.contributed += 1;
  };
  const merge = (scored) => {
    const page = [];
    for (const item of scored) {
      attribute(item.clause);
      // An append-only clause never competes for the page: its matches are the supplement,
      // exactly as they are for a folded record.
      if (appendOnly?.[item.clause]) {
        const prior = appendedById?.get(item.record.id);
        if (prior && prior.score > item.record.score) continue;
        appendedById?.set(item.record.id, item.record);
        continue;
      }
      page.push(item.record);
    }
    return [...candidates, ...page]
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, topK);
  };

  if (!client) {
    const termsPerClause = features.map((list) => queryTerms(list));
    const scored = [];
    for (const record of waiting) {
      const perClause = termsPerClause.map((terms) => pendingTermScore(record.content, terms));
      const best = Math.max(...perClause);
      if (best > 0)
        scored.push({ record: { ...record, score: best }, clause: perClause.indexOf(best) });
    }
    return merge(scored);
  }

  // One batch call, not one call per feature and per record. The vectors are the same,
  // and the sequential version spent up to forty round trips inside a single search -
  // which is how a slow provider became a 120 s invocation the platform had to kill.
  const texts = [];
  const position = new Map();
  const collect = (text) => {
    if (!position.has(text)) position.set(text, texts.push(text) - 1);
  };
  for (const list of features) for (const text of list) collect(text);
  for (const record of waiting) collect(record.content);
  const vectors = await client.embedQueries(texts).catch(() => []);
  const byText = new Map();
  texts.forEach((text, index) => {
    if (vectors[index]) byText.set(text, vectors[index]);
  });
  const vectorsPerClause = features.map((list) =>
    list.map((text) => byText.get(text)).filter(Boolean),
  );
  const scored = [];
  for (const record of waiting) {
    const vector = byText.get(record.content);
    if (!vector) continue;
    const perClause = vectorsPerClause.map((vectors) =>
      vectors.reduce(
        (best, feature) => Math.max(best, cosineSimilarity(vector, feature)),
        -Infinity,
      ),
    );
    const best = Math.max(...perClause);
    if (!Number.isFinite(best)) continue;
    modes.add("records");
    scored.push({ record: { ...record, score: best }, clause: perClause.indexOf(best) });
  }
  return merge(scored);
}

/** Records that are still in the log, shaped like page items so the existing
 *  fusion by identity and highest score applies unchanged.
 *
 *  Scoring happens in `search`: one embedding call per entry, capped at
 *  `MAX_PENDING_READ`, because a search must see an Add that was just accepted. */
async function pendingForSearch(env, ctx, limit) {
  if (pendingCount(ctx.manifest) === 0) return [];
  const waiting = await listPending(env.MEMORY, ctx.key, {
    limit: Math.min(limit, MAX_PENDING_READ),
    generation: ctx.manifest.generation ?? null,
    // Newest first: a streaming update has to be visible before it is folded, and taking
    // the oldest entries meant the most recent ones fell outside the window.
    newest: true,
  });
  return waiting.flatMap(({ entry }) =>
    entry.messages.map((message, index) => ({
      id: `pending:${entry.request_hash}:${index}`,
      content: message.indexText ?? (typeof message.content === "string" ? message.content : ""),
      score: 0,
      // Message times, not the accept time: a pending entry must look like the record it
      // will become, or the page changes shape the moment a fold runs. `created_at` and
      // `event_time` both come from the message, which is what the partition would store.
      event_time: message.chat_time ?? null,
      created_at: message.chat_time ?? new Date(entry.received_at).toISOString(),
      stored_at: new Date(entry.received_at).toISOString(),
      pending: true,
    })),
  );
}
async function add(env, input) {
  const { userId, requestId, sessionId, messages, requestHash, fingerprint } =
    readAddRequest(input);
  const client = embeddingClient(env);
  const contentView = createContentView();
  const serviceContext = { userId, sessionId, client };
  return mutateUser(env, userId, async (ctx) => {
    const { key, manifest, staged } = ctx;
    const reused = await existingReceipt(env, ctx, requestHash, fingerprint);
    if (reused) return reused;
    // Prepare supplied text and optional captions outside SQLite, after receipts.
    // This request-scoped cache also survives manifest CAS recomputation.
    const prepared = [];
    for (const message of messages)
      prepared.push(
        typeof message.content === "string"
          ? message
          : { ...message, indexText: await contentView(message.content) },
      );
    const batchSize = prepared.some((message) => Array.isArray(message.content)) ? 1 : 32;
    let added = 0;
    for (let offset = 0; offset < prepared.length; offset += batchSize) {
      // Preserve the source session while giving each logical Add its own
      // stable message IDs. Local per-batch index 0 is not a conversation ID.
      // Keep these internal IDs out of the existing receipt fingerprint.
      const batch = prepared
        .slice(offset, offset + batchSize)
        .map((m, i) => ({ ...m, source_message_id: `aml:${requestHash}:${offset + i}` }));
      added += await addOneBatch(
        env,
        { ...ctx, ...serviceContext },
        requestId,
        batch,
        manifest,
        staged,
      );
    }
    const response = {
      success: true,
      request_id: requestId,
      user_id: userId,
      session_id: sessionId,
      task_id: `${key}.${requestHash}`,
      status: "completed",
      added,
    };
    manifest.receipts[requestHash] = {
      fingerprint,
      response,
      completed_at: new Date().toISOString(),
    };
    return { response };
  });
}

/** Neighbourhood budget: measured on LoCoMo, five appended records carry 40-47%
 * of the coverage gain of twenty at roughly a third of the text. */
const APPENDED_MAX_RECORDS = 5;

/** Where an Add is accepted: `log` writes one immutable entry and folds it later,
 *  `sync` is the original read-modify-write. `log` is the default; `NMG_ADD_MODE=sync`
 *  is the escape hatch, so a deployment can go back without a code change. */
const addMode = (env) => (env.NMG_ADD_MODE === "sync" ? "sync" : "log");
/** Entries folded into a partition by one request. A fold is one partition write
 *  regardless of how many entries it absorbs, so a 16-way burst needs two folds. */
const FOLD_BATCH = 8;
/** Fold as soon as a full batch is waiting.
 *
 *  This is a read-window contract, not a tuning knob: a search reads at most
 *  `MAX_PENDING_READ` entries, so anything beyond that is invisible until it folds. With a
 *  higher trigger the standing backlog lived between the batch and the trigger (16..23 at
 *  the old value of 24) and every search hid part of it - whichever end the window took.
 *  Folding at one batch keeps the backlog below the window, and costs no extra partition
 *  writes: a fold absorbs exactly one batch, so the cadence is one fold per batch of
 *  accepts at any trigger value above it. */
const FOLD_TRIGGER = FOLD_BATCH;

/** Features to embed and search per clause, bounded by `MAX_QUERY_FEATURES`.
 *
 * The raw clause is never embedded: `selectQueryFeatures` returns its head window,
 * its end-anchored tail window, then the interior windows, so both ends of a long
 * clause reach the model instead of a megabyte string the model silently truncated.
 * Results fuse by identity on the highest score, so a record matches a clause by
 * its *best* feature. `warmClauseVectors` trims the tail end of this list when the
 * embedding budget runs out, which is why the order matters. */
const MAX_SEARCH_CLAUSES = 8;
/** One request may carry independent retrieval clauses: each is plain text plus
 * an optional label. The legacy `query`(+`options`) shape is one clause. */
async function readClauses(input, optionTexts) {
  const nodes = input.queries;
  if (nodes === undefined) {
    // Preserve query text; use opaque image references or optional pixel descriptions.
    // Options never enter the vision request and are not used to infer an answer.
    const queryContent = contentField(input.query, MAX_QUERY_CHARS);
    const query = await createContentView()(queryContent);
    return dedupeClauses([
      { text: query, name: null },
      ...optionTexts.map((choice) => ({ text: query + " " + choice, name: null })),
    ]);
  }
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > MAX_SEARCH_CLAUSES)
    throw new HttpError(
      400,
      "invalid_request",
      `queries must be an array of 1 to ${MAX_SEARCH_CLAUSES} clauses`,
    );
  if (optionTexts.length > 0)
    throw new HttpError(400, "invalid_request", "queries and options cannot be combined");
  if (input.query !== undefined)
    throw new HttpError(400, "invalid_request", "queries and query cannot be combined");
  const clauses = nodes.map((node) => {
    if (typeof node === "string")
      return { text: textField(node, "query", MAX_QUERY_CHARS), name: null, appendOnly: false };
    if (!node || typeof node !== "object")
      throw new HttpError(
        400,
        "invalid_request",
        "each query clause must be a string or an object with text",
      );
    const name = node.name === undefined ? null : textField(node.name, "name", 64);
    // appendOnly clause results never compete for the page; they are returned as
    // a supplement, so a broad dimension cannot crowd out ranked evidence.
    const appendOnly = node.appendOnly === true || node.mode === "append";
    return { text: textField(node.text ?? node.query, "query", MAX_QUERY_CHARS), name, appendOnly };
  });
  if (clauses[0].appendOnly)
    throw new HttpError(
      400,
      "invalid_request",
      "the first clause carries the presentation and cannot be appendOnly",
    );
  if (clauses.every((clause) => clause.appendOnly))
    throw new HttpError(400, "invalid_request", "at least one clause must be ranked");
  return dedupeClauses(clauses);
}
/** Identical clause text is collapsed before retrieval, keeping the first label,
 * so a fusion index always refers to one clause. */
function dedupeClauses(clauses) {
  const seen = new Set(),
    kept = [];
  for (const clause of clauses) {
    if (seen.has(clause.text)) continue;
    seen.add(clause.text);
    kept.push(clause);
  }
  return kept;
}
/** Merge a partition's append-only results, keeping the highest score per id. */
function addAppended(appended, memories) {
  for (const memory of memories ?? []) {
    const prior = appended.get(memory.id);
    if (!prior || (memory.score ?? 0) >= (prior.score ?? 0)) appended.set(memory.id, memory);
  }
}
/** Resolve every feature before SQLite is opened, so no partition holds a database
 *  across remote I/O.
 *
 *  `selectQueryFeatures` already spent the feature budget, so every feature here is
 *  one the search will use: nothing is trimmed. Features are resolved round by
 *  round — round 0 across all clauses, then round 1, and so on — which keeps the
 *  clauses balanced instead of finishing one clause's windows before starting the
 *  next. Best-effort: a failed embedding is simply not cached, and the feature falls
 *  back to whatever the retrieval layer manages, so the request still answers. */
async function warmClauseVectors(client, features, parts) {
  if (!client || parts.length === 0) return;
  // One call for every distinct feature text. The engine then looks each one up by text, so
  // this pre-warms exactly the entries it will ask for; doing it per text meant up to
  // twenty-four cross-region round trips before the first partition was even opened.
  const texts = [...new Set(features.flat())];
  if (texts.length === 0) return;
  await client.embedQueries(texts).catch(() => undefined);
}
/** Reports a request that is still running after `NMG_SLOW_REPORT_MS`. The platform
 *  kills an invocation at 120 s and a killed invocation leaves nothing behind, so an
 *  incident like the 220 timeouts of 2026-10-29 says only "it took 120 s" - never which
 *  part held it. This writes one line at 60 s, which survives the kill. */
function watchSlowRequest(env, context, started) {
  const afterMs = Number(env.NMG_SLOW_REPORT_MS) > 0 ? Number(env.NMG_SLOW_REPORT_MS) : 60_000;
  const timer = setTimeout(() => {
    // eslint-disable-next-line no-console -- diagnostic output, like monitoring.mjs
    console.error(
      JSON.stringify({
        event: "nmg_slow_request",
        at: new Date().toISOString(),
        trace_id: context.trace_id,
        route: context.route,
        elapsed_ms: Date.now() - started,
        add_mode: env.NMG_ADD_MODE ?? null,
        queue: queueStatus(),
        // A killed invocation carries none of this, so the report has to be written while
        // the request is still alive: memory, how many requests this instance has served,
        // and how many SQLite images it has held at once.
        ...memFields({ sqlite: sqliteStats() }),
        last_embedding: embeddingObservation(),
      }),
    );
  }, afterMs);
  timer?.unref?.();
  return () => clearTimeout(timer);
}
/** Fold one partition's persistence mode into the request totals. */
function tallyPartPersistence(persistence, saved) {
  if (saved.mode === "inline_page_delta") persistence.inline_delta_saves++;
  if (saved.mode === "full_snapshot") persistence.full_snapshot_saves++;
  persistence.changed_pages += saved.changedPages;
}
/** The supplement returned to the caller: deduplicated against the page and
 * bounded by the same top_k, so a response never doubles unexpectedly. */
function collectAppended(appended, page, topK) {
  const pageIds = new Set(page.map((memory) => memory.id));
  return [...appended.values()]
    .filter((memory) => !pageIds.has(memory.id))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.id.localeCompare(b.id))
    .slice(0, topK);
}
/** Sum a partition's per-clause attribution into the request totals. */
function addClauseContributions(contributions, clauses) {
  for (const clause of clauses ?? []) {
    const total = contributions[clause.index];
    if (!total) continue;
    total.contributed += clause.contributed;
    total.exclusive += clause.exclusive;
  }
}
async function search(env, input, options = {}) {
  const userId = textField(input.user_id ?? input.userId, "user_id");
  requestIdentity(userId, input.request_id);
  const topK = input.top_k ?? input.topK;
  if (!Number.isInteger(topK) || topK < 1 || topK > 100)
    throw new HttpError(400, "invalid_request", "top_k must be an integer between 1 and 100");
  const choices = input.options ?? [];
  if (!Array.isArray(choices) || choices.length > 16)
    throw new HttpError(400, "invalid_request", "options must be an array of at most 16 strings");
  const optionTexts = choices.map((choice) => textField(choice, "option", 4096));
  const clauses = await readClauses(input, optionTexts);
  const queries = clauses.map((clause) => clause.text);
  const features = selectQueryFeatures(queries);
  const appendOnly = clauses.map((clause) => clause.appendOnly === true);
  const hasAppendOnly = appendOnly.some(Boolean);
  const appendedById = new Map();
  const contributions = clauses.map((_clause, index) => ({ index, contributed: 0, exclusive: 0 }));
  const client = embeddingClient(env),
    started = Date.now();
  return mutateUser(env, userId, async ({ sqlite, key, manifest, staged, reuse }) => {
    let candidates = [];
    const modes = new Set();
    let changed = false;
    await warmClauseVectors(client, features, manifest.parts);
    const persistence = { inline_delta_saves: 0, full_snapshot_saves: 0, changed_pages: 0 };
    for (let i = 0; i < manifest.parts.length; i++) {
      const result = await runPart(
        env.MEMORY,
        manifest.parts[i],
        sqlite,
        async ({ key: partKey }) => {
          const service = new AmlMemoryService(partKey, client);
          return {
            response: await measure("retrieval_including_embedding", () =>
              service.search(queries, topK, appendOnly, features),
            ),
          };
        },
        { readOnlyIfUnchanged: !options.fullSnapshot && env.NMG_SEARCH_DELTAS !== "0" },
      );
      const otherBytes = manifest.parts.reduce(
        (sum, p, j) => sum + (j === i ? 0 : deltaBytes(p)),
        0,
      );
      const saved = result.readOnly
        ? {
            part: manifest.parts[i],
            mode: "unchanged",
            changed: false,
            stagedKey: null,
            changedPages: 0,
          }
        : await stageSearchPart(
            env.MEMORY,
            key,
            manifest.parts[i],
            result,
            USER_DELTA_LIMIT - otherBytes,
            options.fullSnapshot || env.NMG_SEARCH_DELTAS === "0",
            // Without this a search retry re-uploaded a byte-identical snapshot: the signature
            // accepted a reuse map, the call site never passed one.
            reuse,
          );
      copyLegacyReceipts(manifest, result.legacyReceipts);
      manifest.parts[i] = saved.part;
      if (saved.stagedKey) staged.push(saved.stagedKey);
      changed ||= saved.changed || result.legacyReceipts.length > 0;
      tallyPartPersistence(persistence, saved);
      modes.add(result.response.retrievalMode);
      addClauseContributions(contributions, result.response.clauses);
      addAppended(appendedById, result.response.appended);
      candidates.push(...result.response.memories);
      // Bounded global Top K; never retain every shard's candidates in RAM.
      candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      candidates = candidates.slice(0, topK);
    }
    const fused = await fusePendingRecords({
      env,
      ctx: { key, manifest },
      features,
      candidates,
      client,
      modes,
      topK,
      contributions,
      appendOnly,
      appendedById,
    });
    candidates = fused;
    persistence.inline_bytes = manifest.parts.reduce((sum, p) => sum + deltaBytes(p), 0);
    const appended = collectAppended(
      appendedById,
      candidates,
      Math.min(topK, APPENDED_MAX_RECORDS),
    );
    return {
      readOnly: !changed,
      response: {
        data: candidates,
        retrieval_mode: modes.has("records") ? "records" : "lexical",
        timings: {
          totalMs: Date.now() - started,
          partitions: manifest.parts.length,
          clauses: clauses.length,
        },
        clauses: clauses.map((clause, index) => ({
          name: clause.name,
          index,
          appendOnly: clause.appendOnly === true,
          contributed: contributions[index].contributed,
          exclusive: contributions[index].exclusive,
        })),
        ...(hasAppendOnly ? { appended } : {}),
        persistence,
        storage_format: manifestFormat(manifest),
      },
    };
  });
}
async function reset(env, input) {
  const userId = textField(input.user_id, "user_id");
  if (input.confirm_user_id !== userId)
    throw new HttpError(
      400,
      "confirmation_required",
      "confirm_user_id must exactly match user_id; reset permanently removes all user memories and Add receipts",
    );
  const resetId = textField(input.reset_id, "reset_id", 128);
  if (!env.MEMORY)
    throw new HttpError(503, "storage_unavailable", "Persistent storage binding missing");
  return resetUser(env.MEMORY, userId, resetId);
}
async function status(env, taskId) {
  if (!/^[a-f0-9]{24}\.[a-f0-9]{64}$/.test(taskId))
    throw new HttpError(400, "invalid_task_id", "Invalid task_id");
  const [key, requestHash] = taskId.split(".");
  const { manifest } = await loadManifest(env.MEMORY, key, "");
  const receipt = manifest.receipts[requestHash];
  if (receipt) return { ...receipt.response, completed_at: receipt.completed_at };
  // An Add accepted into the log has no partition receipt yet, but it is durable and the
  // caller is entitled to ask about it. The entry is scoped to the current generation, the
  // same rule the accept-side replay lookup follows.
  const pending = await findLogEntry(env.MEMORY, key, requestHash, {
    generation: manifest.generation ?? null,
  }).then(
    (found) => found?.entry ?? null,
    () => null,
  );
  if (pending)
    return {
      ...pending.response,
      completed_at: new Date(pending.received_at).toISOString(),
      pending: true,
    };
  const legacy = manifest.parts.find((p) => p.key === objectKey(key));
  if (legacy) {
    // Status uses the original file name and never needs the original user_id.
    const object = await env.MEMORY.get(legacy.key),
      sqlite = await sqliteReady();
    void sqlite;
    if (object)
      return withDatabases(
        new Map([[`${key}.sqlite`, new Uint8Array(await object.arrayBuffer())]]),
        async () => {
          const db = new DatabaseSync(`/tmp/nmg/${key}.sqlite`);
          const exists = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='cloud_receipts'")
            .get();
          const row = exists
            ? db
                .prepare("SELECT response,completed_at FROM cloud_receipts WHERE request_hash=?")
                .get(requestHash)
            : undefined;
          if (!row)
            throw new HttpError(404, "task_not_found", "No completed write for this task_id");
          return { ...JSON.parse(row.response), completed_at: row.completed_at };
        },
      );
  }
  throw new HttpError(404, "task_not_found", "No completed write for this task_id");
}

async function diagnosticSearch(env, input) {
  const count = input.repetitions ?? 3;
  if (!Number.isInteger(count) || count < 1 || count > 10)
    throw new HttpError(400, "invalid_request", "repetitions must be between 1 and 10");
  if (input.persistence !== undefined && !["delta", "snapshot"].includes(input.persistence))
    throw new HttpError(400, "invalid_request", "persistence must be delta or snapshot");
  const runs = [];
  for (let i = 0; i < count; i++) {
    const measured = await profileSearch(() =>
      search(
        env,
        { ...input, top_k: input.top_k ?? 10 },
        { fullSnapshot: input.persistence === "snapshot" },
      ),
    );
    runs.push({
      server_ms: measured.server_ms,
      stages_ms: measured.stages_ms,
      partitions: measured.result.timings.partitions,
      result_count: measured.result.data.length,
      retrieval_mode: measured.result.retrieval_mode,
      persistence: measured.result.persistence,
      result_digest: hash(JSON.stringify(measured.result.data)),
    });
  }
  const times = runs.map((r) => r.server_ms).sort((a, b) => a - b);
  return {
    scope: "server_processing",
    query: input.query,
    runs,
    summary: {
      count,
      median_ms: (times[Math.floor((count - 1) / 2)] + times[Math.floor(count / 2)]) / 2,
      p95_ms: times[Math.ceil(count * 0.95) - 1],
    },
    notes: [
      "Includes snapshot writes and manifest commit; excludes network and request queue.",
      "retrieval_including_embedding contains embedding; do not sum these fields.",
      "Workers clock resolution can show zero for synchronous work; these are elapsed times, not CPU times.",
      "AML searches do not record usage or feedback traces; unchanged images skip persistence. The configured embedding provider is used.",
    ],
  };
}
function isOwner(request, env) {
  return (
    !!env.NMG_OWNER_EMAIL &&
    request.headers.get("oai-authenticated-user-email")?.toLowerCase() ===
      env.NMG_OWNER_EMAIL.toLowerCase()
  );
}
function requireOwner(request, env) {
  if (!isOwner(request, env))
    throw new HttpError(
      401,
      "owner_sign_in_required",
      "Sign in as the Site owner to use diagnostics",
    );
  if (request.method !== "GET" && request.headers.get("origin") !== new URL(request.url).origin)
    throw new HttpError(403, "invalid_origin", "Admin operations require a same-origin request");
}
function normalizePath(url) {
  return url.pathname.replace(/^\/api(?=\/)/, "").replace(/\/$/, "") || "/";
}
const MEMORY_ROUTES = [
  "/add",
  "/remember",
  "/search",
  "/reset",
  "/reclaim",
  "/reclaim/user",
  "/capacity",
  "/add/status",
  "/admin/reset",
  "/admin/capacity",
  "/admin/diagnostics/search",
  "/admin/diagnostics/seed",
];
function isMemoryRoute(path) {
  return MEMORY_ROUTES.includes(path) || path.startsWith("/add/status/");
}
function pageResponse(request, env, path) {
  if (path !== "/" || request.method !== "GET") return undefined;
  return new Response(
    isOwner(request, env) ? page.replace('id="diagnostics" hidden', 'id="diagnostics"') : page,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy":
          "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'self' https://chatgpt.com",
      },
    },
  );
}
async function healthResponse(env, path) {
  if (path !== "/health") return undefined;
  if (!env.MEMORY)
    throw new HttpError(503, "storage_unavailable", "Persistent storage binding missing");
  const sqlite = await sqliteReady();
  await env.MEMORY.head("health/probe");
  return json({
    status: "ok",
    service: "NodeMemoryGraph",
    storage: "R2",
    sqlite: sqlite.version.libVersion,
    retrieval: env.NMG_EMBED_PROVIDER || env.NMG_EMBED_BASE_URL ? "hybrid" : "lexical",
    max_user_database_bytes: MAX_DATABASE_BYTES,
    storage_format: "nmg-shards-v3",
    supported_storage_formats: ["nmg-shards-v2", "nmg-shards-v3"],
    search_page_deltas: env.NMG_SEARCH_DELTAS !== "0",
    max_partition_bytes: 16 * 1024 * 1024,
    max_add_partition_bytes: PART_LIMIT,
    max_partitions: MAX_PARTS,
    graph_scope: "partition",
    max_request_bytes: MAX_BODY_BYTES,
    limits: {
      ...TEXT_LIMITS,
      add_mode: addMode(env),
      pending_read_limit: MAX_PENDING_READ,
      merge_batch: FOLD_BATCH,
      // Reported because they bound a request: an invocation is killed at 120 s, and a
      // per-attempt timeout larger than that turns a slow provider into a dead request.
      embed_timeout_ms:
        Number(env.NMG_EMBED_TIMEOUT_MS) > 0 ? Number(env.NMG_EMBED_TIMEOUT_MS) : EMBED_TIMEOUT_MS,
      embed_query_budget_ms:
        Number(env.NMG_EMBED_QUERY_BUDGET_MS) > 0
          ? Number(env.NMG_EMBED_QUERY_BUDGET_MS)
          : EMBED_QUERY_BUDGET_MS,
      embed_document_timeout_ms:
        Number(env.NMG_EMBED_TIMEOUT_MS) > 0
          ? Number(env.NMG_EMBED_TIMEOUT_MS)
          : EMBED_DOCUMENT_TIMEOUT_MS,
      embed_write_budget_ms:
        Number(env.NMG_EMBED_WRITE_BUDGET_MS) > 0
          ? Number(env.NMG_EMBED_WRITE_BUDGET_MS)
          : EMBED_WRITE_BUDGET_MS,
      slow_report_ms: Number(env.NMG_SLOW_REPORT_MS) > 0 ? Number(env.NMG_SLOW_REPORT_MS) : 60_000,
    },
    upstream_commit: SOURCE_REVISION.split("+")[0],
    source_revision: SOURCE_REVISION,
    core_source: CORE_SOURCE,
    multimodal: {
      format: "ordered-text-base64-image-parts",
      index_view: "supplied-text-plus-image-hash",
    },
    query_terms_prepared: true,
    memory_service: "daemon-core-aml-v1",
    request_lifecycle: "independent-v2",
    search_request_profile: true,
    harness: false,
    search_profile: AML_SEARCH_PROFILE,
    reclamation: { user: "/reclaim/user", all: "/reclaim/all", automatic: false },
  });
}
async function reclaimAllRoute(request, env, path) {
  if (path !== "/admin/reclaim-all" && path !== "/reclaim/all") return undefined;
  if (path.startsWith("/admin/")) requireOwner(request, env);
  else authenticate(request, env);
  if (!env.MEMORY)
    throw new HttpError(503, "storage_unavailable", "Persistent storage binding missing");
  if (request.method === "GET") return json(await reclamationStatus(env.MEMORY));
  if (request.method === "POST") {
    const input = await readJson(request);
    if (input.confirm !== "ALL_MEMORY")
      throw new HttpError(
        400,
        "confirmation_required",
        "confirm must be ALL_MEMORY; all users and their memory will be permanently removed",
      );
    const result = await reclaimAll(env.MEMORY, textField(input.operation_id, "operation_id", 128));
    return json(result, result.complete ? 200 : 202);
  }
  throw new HttpError(405, "method_not_allowed", "Use GET or POST");
}
async function runSelfTestContract(request, env) {
  // Fixed synthetic fixture only; cannot access caller-selected users or data.
  const uid = "__nmg_contract_" + crypto.randomUUID(),
    session = "contract-session";
  const checks = [];
  const probe = async (route, body, expected = 200) => {
    let response;
    try {
      response = await handle(
        new Request(new URL(route, request.url), {
          method: "POST",
          headers: {
            authorization: "Bearer " + env.NMG_API_KEY,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        env,
      );
    } catch (error) {
      response = json(
        { success: false, error: { code: error.code || "service_unavailable" } },
        error.status || 503,
      );
    }
    const value = await response.json();
    if (response.status !== expected)
      throw new HttpError(
        503,
        "contract_probe_failed",
        route + " returned " + response.status + " instead of " + expected,
      );
    checks.push({ route, status: response.status });
    return value;
  };
  const message = (i) => ({
    user_id: uid,
    session_id: session,
    request_id: "c" + i,
    messages: [
      {
        role: i % 2 ? "assistant" : "user",
        timestamp: 1704067200000 + i * 1000,
        content: "Contract probe favorite robot " + ["Atlas", "Spot", "Digit"][i],
      },
    ],
  });
  const first = await probe("/add", message(0));
  for (let i = 1; i <= 2; i++) {
    await probe("/search", { user_id: uid, query: "favorite robot", top_k: 10 });
    await probe("/add", message(i));
  }
  const found = await probe("/search", { user_id: uid, query: "favorite robot", top_k: 10 });
  if (found.data.length !== 3)
    throw new HttpError(503, "contract_probe_failed", "Expected three memories");
  for (let i = 0; i < 3; i++) {
    const retry = await probe("/add", message(0));
    if (JSON.stringify(retry) !== JSON.stringify(first))
      throw new HttpError(503, "contract_probe_failed", "Retry receipt differs");
  }
  const invalid = message(0);
  delete invalid.request_id;
  await probe("/add", invalid, 400);
  await probe("/search", { user_id: uid, query: "favorite robot" }, 400);
  const isolated = await probe("/search", {
    user_id: uid + "-other",
    query: "favorite robot",
    top_k: 10,
  });
  if (isolated.data.length) throw new HttpError(503, "contract_probe_failed", "Isolation failed");
  return json({ success: true, fixture_user_id: uid, result_count: found.data.length, checks });
}
function assertSelfTestAccess(request, env) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || "";
  const expires = Number(env.NMG_SELFTEST_EXPIRES_AT);
  if (
    !env.NMG_SELFTEST_TOKEN ||
    !expires ||
    Date.now() >= expires ||
    !token ||
    !timingSafeEqual(Buffer.from(hash(token)), Buffer.from(hash(env.NMG_SELFTEST_TOKEN)))
  )
    throw new HttpError(401, "selftest_unauthorized", "Self-test access is unavailable or expired");
}
async function selfTestRoute(request, env, _url, path) {
  if (path !== "/diagnostics/self-test" || request.method !== "POST") return undefined;
  assertSelfTestAccess(request, env);
  env = { ...env, MEMORY: await memoryBucket(env.MEMORY) };
  const input = await readJson(request);
  if (Object.keys(input).some((k) => !["op", "persistence", "repetitions"].includes(k)))
    throw new HttpError(
      400,
      "invalid_request",
      "Self-test accepts only op, persistence and repetitions",
    );
  if (input.op === "contract") return runSelfTestContract(request, env);
  const userId = "__nmg_selftest_v1";
  if (input.op === "seed")
    return json(
      await add(env, {
        user_id: userId,
        session_id: "selftest",
        request_id: "selftest-seed-v1",
        messages: [
          { role: "user", content: "我最喜欢的机器人是 Atlas，我正在学习机器人控制。" },
          { role: "user", content: "这台测试笔记本有 64 GB 内存，测试项目使用 Python。" },
          { role: "user", content: "测试项目计划使用 ROS 2 和激光雷达完成室内建图。" },
        ],
      }),
    );
  if (input.op !== "query")
    throw new HttpError(400, "invalid_request", "op must be seed, query or contract");
  return json(
    await diagnosticSearch(env, {
      user_id: userId,
      query: "我最喜欢的机器人是什么？",
      top_k: 10,
      repetitions: input.repetitions ?? 1,
      persistence: input.persistence ?? "delta",
    }),
  );
}
function overallServiceStatus({ blocked, maintenance, recent, history, queueState }) {
  if (blocked) return "unavailable";
  if (maintenance) return "maintenance";
  return recent ||
    history.status !== "ok" ||
    queueState.waiting > 0 ||
    queueState.active?.elapsed_ms > 30000
    ? "degraded"
    : "ok";
}
/** Bounded count of a field across failure entries, largest first. */
function countTop(entries, keyOf, limit = 8) {
  const counts = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}
/** What the deployment is actually configured to talk to, for an operator looking at one
 *  line of JSON.
 *
 *  The endpoint is reported as scheme, host and path - never the key - because "which endpoint
 *  is this build calling" kept being a guess: a stale env var, a console setting the CLI deploy
 *  did not carry, or a switch that was applied to the wrong environment all looked identical
 *  from the outside. Values come from the client the requests themselves use, so they cannot
 *  drift from what is in effect. */
function embeddingDiagnostics(env) {
  const raw = env.NMG_EMBED_BASE_URL ?? null;
  let endpoint = null;
  if (raw) {
    try {
      const url = new URL(raw);
      endpoint = `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      endpoint = "unparseable";
    }
  }
  let client;
  try {
    client = createEmbeddingClientFromEnv({
      ...env,
      NMG_EMBED_TIMEOUT_MS: env.NMG_EMBED_TIMEOUT_MS ?? String(EMBED_TIMEOUT_MS),
    });
  } catch {
    client = undefined;
  }
  const number = (value, fallback) => (Number(value) > 0 ? Number(value) : fallback);
  return {
    configured: !!(env.NMG_EMBED_PROVIDER || raw),
    endpoint,
    provider: env.NMG_EMBED_PROVIDER ?? (raw ? "openai" : null),
    model: client?.model ?? env.NMG_EMBED_MODEL ?? null,
    dimensions: client?.dimensions ?? number(env.NMG_EMBED_DIMENSIONS, null),
    profile: client?.profile ?? null,
    index_id: client?.indexId ?? null,
    timeout_ms: number(env.NMG_EMBED_TIMEOUT_MS, EMBED_TIMEOUT_MS),
    document_timeout_ms: number(env.NMG_EMBED_TIMEOUT_MS, EMBED_DOCUMENT_TIMEOUT_MS),
    query_budget_ms: number(env.NMG_EMBED_QUERY_BUDGET_MS, EMBED_QUERY_BUDGET_MS),
    write_budget_ms: number(env.NMG_EMBED_WRITE_BUDGET_MS, EMBED_WRITE_BUDGET_MS),
    last_observation: embeddingObservation(),
  };
}
async function adminStatusResponse(env) {
  const [sqlite, r2, reclaim, history] = await Promise.all([
    check(() => sqliteReady().then(() => true)),
    check(() => env.MEMORY.head("health/probe").then(() => true)),
    check(() => reclamationStatus(env.MEMORY)),
    check(() => recentFailures(env.MEMORY)),
  ]);
  const failures = history.value ?? [],
    load = runtimeStatus(),
    queueState = queueStatus();
  const recent = failures.some((e) => Date.now() - Date.parse(e.at) < 5 * 60000);
  const blocked =
    sqlite.status !== "ok" || r2.status !== "ok" || reclaim.status !== "ok" || !env.NMG_API_KEY;
  const status = overallServiceStatus({
    blocked,
    maintenance: !!reclaim.value?.maintenance,
    recent,
    history,
    queueState,
  });
  return json({
    status,
    checked_at: new Date().toISOString(),
    sqlite: sqlite.status,
    r2: r2.status,
    checks: {
      sqlite,
      r2: { status: r2.status, ms: r2.ms, code: r2.code },
      reclamation: { status: reclaim.status, code: reclaim.code },
      error_history: { status: history.status, code: history.code },
    },
    authentication: { configured: !!env.NMG_API_KEY },
    maintenance: reclaim.value ?? null,
    revision: SOURCE_REVISION,
    embedding: embeddingDiagnostics(env),
    checks_ms: { sqlite: sqlite.ms, r2: r2.ms },
    load,
    queue: queueState,
    // On demand, per instance: the same fields the slow-request report carries, so memory
    // can be watched while a deployment is live instead of only after an incident.
    memory: memFields({ sqlite: sqliteStats() }),
    failures: {
      scope: env.NMG_ERROR_HISTORY === "1" ? "shared_best_effort" : "isolate_only",
      retention_hours: 24,
      maximum: 20,
      // Reading twenty entries to answer "what is failing" is what made three incidents slow
      // to diagnose, so the counts are computed here: same data, one glance.
      summary: {
        total: failures.length,
        by_code: countTop(failures, (entry) => entry.code ?? "unknown"),
        by_route: countTop(failures, (entry) => entry.route ?? "unknown"),
        from: failures.at(-1)?.at ?? null,
        to: failures[0]?.at ?? null,
      },
      entries: failures,
    },
    limitations: [
      "Basic probes do not guarantee model availability.",
      "Queue and last embedding observation describe only this isolate.",
      "Platform cancellations or memory termination may bypass application logging.",
    ],
  });
}
async function adminRoute(request, env, url, path) {
  if (!path.startsWith("/admin/")) return undefined;
  requireOwner(request, env);
  const handled = await adminRouteDispatcher(request, env, url, path);
  if (handled !== undefined) return handled;
  throw new HttpError(404, "not_found", "Unknown admin route");
}
async function adminRouteDispatcher(request, env, url, path) {
  if (path === "/admin/statistics" && request.method === "POST") {
    const input = await readJson(request);
    if (typeof input.enabled !== "boolean")
      throw new HttpError(400, "invalid_request", "enabled must be boolean");
    return json({ load: setStatistics(input.enabled) });
  }
  if (path === "/admin/capacity" && request.method === "GET")
    return json(
      await userCapacity(env.MEMORY, textField(url.searchParams.get("user_id"), "user_id")),
    );
  if (path === "/admin/reset" && request.method === "POST")
    return json(await reset(env, await readJson(request)));
  if (path === "/admin/key" && request.method === "GET") return json({ api_key: env.NMG_API_KEY });
  if (path === "/admin/status" && request.method === "GET") return adminStatusResponse(env);
  return adminDiagnosticsRoute(request, env, path);
}
async function adminDiagnosticsRoute(request, env, path) {
  if (path === "/admin/diagnostics/search" && request.method === "POST") {
    const input = await readJson(request);
    return json(await diagnosticSearch(env, input));
  }
  if (path === "/admin/diagnostics/seed" && request.method === "POST") {
    // A fixed small fixture, separate from all client user IDs. No arbitrary writes here.
    return json(
      await add(env, {
        user_id: "__nmg_diagnostics_v1",
        session_id: "diagnostics",
        request_id: "diagnostics-seed-v1",
        messages: [
          { role: "user", content: "我最喜欢的机器人是 Atlas，我正在学习机器人控制。" },
          { role: "user", content: "我的笔记本有 64 GB 内存，我使用 Python 开发机器人程序。" },
          { role: "user", content: "我计划学习 ROS 2，并用激光雷达完成室内建图。" },
        ],
      }),
    );
  }
  return undefined;
}
async function searchRoute(request, env, _url, path) {
  if (path !== "/search" || request.method !== "POST") return undefined;
  const input = await readJson(request);
  if (request.headers.get("x-nmg-profile") === "1") {
    const { result, ...diagnostics } = await profileSearch(() => search(env, input));
    return json({ ...result, diagnostics });
  }
  return json(await search(env, input));
}
async function addStatusRoute(request, env, url, path) {
  if (path.startsWith("/add/status/") && request.method === "GET")
    return json(await status(env, path.slice("/add/status/".length)));
  if (path === "/add/status" && request.method === "GET") {
    const taskId =
      url.searchParams.get("task_id") ??
      hash(textField(url.searchParams.get("user_id"), "user_id")).slice(0, 24) +
        "." +
        hash(textField(url.searchParams.get("request_id"), "request_id"));
    return json(await status(env, taskId));
  }
  return undefined;
}
async function memoryApiRoute(request, env, url, path) {
  authenticate(request, env);
  if (!env.MEMORY)
    throw new HttpError(503, "storage_unavailable", "Persistent storage binding missing");
  if ((path === "/reclaim" || path === "/reclaim/user") && request.method === "POST") {
    const input = await readJson(request),
      userId = textField(input.user_id, "user_id"),
      requestId = textField(input.request_id, "request_id", 128);
    const result = await reset(env, {
      user_id: userId,
      confirm_user_id: userId,
      reset_id: requestId,
    });
    return json({ ...result, request_id: requestId, scope: "user" });
  }
  const reset = await resetRoute(request, env, path);
  if (reset !== undefined) return reset;
  const capacity = await capacityRoute(request, env, url, path);
  if (capacity !== undefined) return capacity;
  const add = await addRoute(request, env, path);
  if (add !== undefined) return add;
  const search = await searchRoute(request, env, url, path);
  if (search !== undefined) return search;
  const status = await addStatusRoute(request, env, url, path);
  if (status !== undefined) return status;
  throw new HttpError(404, "not_found", "Unknown API route");
}
async function resetRoute(request, env, path) {
  if (path !== "/reset" || request.method !== "POST") return undefined;
  return json(await reset(env, await readJson(request)));
}
async function capacityRoute(request, env, url, path) {
  if (path !== "/capacity" || request.method !== "GET") return undefined;
  return json(
    await userCapacity(env.MEMORY, textField(url.searchParams.get("user_id"), "user_id")),
  );
}
/** Drains one user's log. Needed before rolling the code back - a v4 manifest is
 *  unreadable to an older deployment - and by the log-mode test, which otherwise has
 *  no way to observe a fully drained counter. Bounded so one request cannot fold an
 *  unbounded log. */
async function foldRoute(request, env, url, path) {
  if (path !== "/admin/fold") return undefined;
  requireOwner(request, env);
  if (request.method !== "POST")
    throw new HttpError(405, "method_not_allowed", "Use POST to fold one user's log");
  const userId = textField(url.searchParams.get("user_id"), "user_id");
  let folded = 0;
  let remaining = 0;
  let released = 0;
  for (let round = 0; round < 8; round += 1) {
    const step = await foldPending(env, userId);
    folded += step.folded;
    remaining = step.remaining;
    if (step.released) released += 1;
    if (step.folded === 0 && !step.released) break;
  }
  // A drain is a verification, not an attempt: the runbook uses it before rolling
  // the code back, and a v4 manifest is unreadable to an older deployment. Answering
  // 200 with entries left would make that check a false green, so anything not fully
  // drained is a 409 the caller has to retry.
  const drained = remaining === 0;
  return json(
    { success: drained, user_id: userId, folded, released, remaining },
    drained ? 200 : 409,
  );
}
async function addRoute(request, env, path) {
  if ((path !== "/add" && path !== "/remember") || request.method !== "POST") return undefined;
  const input = await readJson(request);
  if (addMode(env) !== "log") return json(await add(env, input));
  const accepted = await acceptAdd(env, input);
  // A burst leaves entries waiting; fold a bounded batch here rather than on the
  // read path, so accepted latency stays flat while the log cannot grow forever.
  if (accepted.pending >= FOLD_TRIGGER)
    await foldPending(env, accepted.response.user_id).catch(() => {});
  return json(accepted.response);
}
async function handle(request, env) {
  const url = new URL(request.url);
  const path = normalizePath(url);
  const early =
    pageResponse(request, env, path) ??
    (await healthResponse(env, path)) ??
    (await reclaimAllRoute(request, env, path)) ??
    (await foldRoute(request, env, url, path));
  if (early) return early;
  if (isMemoryRoute(path)) {
    if (path.startsWith("/admin/")) requireOwner(request, env);
    else authenticate(request, env);
    if (!env.MEMORY)
      throw new HttpError(503, "storage_unavailable", "Persistent storage binding missing");
    env = { ...env, MEMORY: await memoryBucket(env.MEMORY) };
  }
  const selfTest = await selfTestRoute(request, env, url, path);
  if (selfTest) return selfTest;
  const admin = await adminRoute(request, env, url, path);
  if (admin) return admin;
  return memoryApiRoute(request, env, url, path);
}
export default {
  fetch(request, env, execution) {
    const rawRay = request.headers.get("cf-ray") ?? "";
    const traceId = /^[a-zA-Z0-9-]{1,80}$/.test(rawRay) ? rawRay : crypto.randomUUID();
    const pathname = new URL(request.url).pathname;
    const normalized = pathname.replace(/^\/api(?=\/)/, "").replace(/\/$/, "") || "/";
    const route = normalized.startsWith("/add/status/")
      ? "/add/status/:task_id"
      : /^\/(?:add|remember|search|health|capacity|reset|reclaim(?:\/(?:user|all))?|admin\/(?:status|key|statistics|capacity|reset|reclaim-all|diagnostics\/(?:search|seed)))$/.test(
            normalized,
          ) || normalized === "/"
        ? normalized
        : "/unknown";
    const context = { trace_id: traceId, route, env, execution };
    return withRequest(context, () => {
      const track = statisticsEnabled();
      const startedAt = Date.now();
      context.seq = memRequestStarted(route);
      const stopSlowWatch = watchSlowRequest(env, context, startedAt);
      if (track) requestAccepted();
      const received = track ? performance.now() : 0;
      let begun;
      const metadataRequest =
        (request.method === "GET" && pathname === "/") ||
        (request.method === "GET" &&
          /^\/(?:api\/)?(?:health|admin\/status|admin\/key|admin\/capacity|capacity)\/?$/.test(
            pathname,
          )) ||
        /^\/(?:api\/)?(?:admin\/reclaim-all|reclaim\/all)\/?$/.test(pathname);
      if (!metadataRequest) queueAccepted();
      const invoke = async () => {
        if (!metadataRequest) queueStarted(context);
        if (track) {
          begun = performance.now();
          requestStarted();
        }
        try {
          return await handle(request, env);
        } finally {
          if (!metadataRequest) queueFinished();
        }
      };
      const job = Promise.resolve()
        .then(invoke)
        .catch((error) => {
          const full = String(error.message).includes("SQLITE_FULL");
          const status = error.status || (full ? 413 : 503);
          if (status >= 500 || status === 413 || status === 409) reportFailure(error, status);
          const code = error.code || (full ? "user_storage_limit" : classifyError(error).code);
          return json(
            {
              success: false,
              trace_id: traceId,
              error: {
                code,
                message:
                  error instanceof HttpError || error instanceof StorageError
                    ? error.message
                    : full
                      ? "Storage partition reached its working-memory limit"
                      : "Operation failed; check the trace_id in service diagnostics",
              },
            },
            status,
            { "retry-after": "2", "x-nmg-trace-id": traceId },
          );
        });
      const tracked = track
        ? job.then((response) => {
            requestFinished(response.status, performance.now() - begun, begun - received);
            return response;
          })
        : job;
      return tracked.finally(() => {
        stopSlowWatch();
        memLog("exit", route, {
          seq: context.seq,
          elapsed_ms: Date.now() - startedAt,
          sqlite: sqliteStats(),
        });
      });
    });
  },
};
