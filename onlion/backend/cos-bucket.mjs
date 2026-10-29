/**
 * R2-binding-shaped bucket backed by Tencent COS.
 *
 * storage.mjs / monitoring.mjs / reclamation.mjs only rely on five operations
 * (get, head, put, delete, list) and one conditional-write contract:
 *
 *   put(key, value, {onlyIf: {etagMatches}}) -> falsy when the expectation fails
 *
 * COS has no If-Match on PUT Object, so `etagMatches` is emulated with a claim
 * object written under `x-cos-forbid-overwrite: true`. See conditionalPut().
 */
import { createHash, randomUUID } from "node:crypto";
import { encodePath, signCosRequest } from "./cos-sign.mjs";

const MAX_BATCH_DELETE = 1000;
const CLAIM_STALE_MS = 10_000;
const CLAIM_WAIT_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [120, 300];

export class CosError extends Error {
  constructor(status, code, message, key) {
    super(message);
    this.name = "CosError";
    this.status = status;
    this.code = code;
    this.key = key;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One COS round trip may not outlast this.
 *
 *  Nothing bounded these requests before, so a stalled bucket hung until the platform
 *  killed the invocation at 120 s - the same ceiling that hid the embedding problem. A
 *  timeout here surfaces as a retryable error, and each caller's own retry decides what
 *  to do with it instead of the instance waiting out the clock. */
const COS_TIMEOUT_MS = 20_000;
const normalizeEtag = (value) =>
  value ? String(value).replace(/^"|"$/g, "").toLowerCase() : undefined;
const sameEtag = (left, right) => !!left && !!right && normalizeEtag(left) === normalizeEtag(right);
const sha1Hex = (text) => createHash("sha1").update(text, "utf8").digest("hex");
const byteLength = (body) => (typeof body === "string" ? Buffer.byteLength(body) : body.byteLength);

function claimKeyFor(key, expectedEtag) {
  return `claims/${sha1Hex(`${key}\0${normalizeEtag(expectedEtag)}`)}.json`;
}

function decodeXml(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlTag(xml, name) {
  const match = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : undefined;
}

const escapeXml = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** One round trip, bounded.
 *
 *  Nothing bounded these before, so a stalled bucket hung until the platform killed the
 *  invocation at 120 s. The timeout belongs to the transport rather than to each caller:
 *  it surfaces as a retryable error, and the caller's own retry decides what to do. */
async function sendRequest(fetchImpl, timeoutMs, method, key, url, headers, body) {
  try {
    return await fetchImpl(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    const wrapped = new CosError(
      0,
      timedOut ? "timeout" : "network_error",
      `COS ${method} ${key} ${
        timedOut ? `timed out after ${timeoutMs} ms` : `failed: ${error?.name ?? error?.message}`
      }`,
      key,
    );
    wrapped.retryable = true;
    throw wrapped;
  }
}
export function createCosBucket(config) {
  const {
    bucket,
    region,
    secretId,
    secretKey,
    endpoint = `${bucket}.cos.${region}.myqcloud.com`,
    fetchImpl = fetch,
    clock = Date.now,
    staleClaimMs = CLAIM_STALE_MS,
    timeoutMs = COS_TIMEOUT_MS,
  } = config;
  if (!bucket || !region || !secretId || !secretKey)
    throw new Error("COS bucket needs bucket, region, secretId and secretKey");

  async function rawFetch(method, key, { query = {}, headers = {}, body } = {}) {
    const path = encodePath(key);
    const signedHeaders = { host: endpoint, ...headers };
    const signed = signCosRequest({
      secretId,
      secretKey,
      method,
      path,
      params: query,
      headers: signedHeaders,
      nowSeconds: Math.floor(clock() / 1000),
    });
    // `host` is derived from the URL; sending it again confuses some runtimes.
    const outgoing = { ...signedHeaders };
    delete outgoing.host;
    outgoing.authorization = signed.authorization;
    const url = `https://${endpoint}${path}${signed.query ? `?${signed.query}` : ""}`;
    const response = await sendRequest(fetchImpl, timeoutMs, method, key, url, outgoing, body);
    if (response.status >= 500 || response.status === 429) {
      const error = new CosError(
        response.status,
        "server_error",
        `COS ${method} ${key} answered ${response.status}`,
        key,
      );
      error.retryable = true;
      throw error;
    }
    return response;
  }

  async function send(method, key, options) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await rawFetch(method, key, options);
      } catch (error) {
        const retryable =
          error.retryable || error.code === "ECONNRESET" || error.name === "TimeoutError";
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw error;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  async function fail(response, key, method) {
    let code = "cos_error";
    try {
      code = xmlTag(await response.text(), "Code") ?? code;
    } catch {
      /* body is optional */
    }
    throw new CosError(
      response.status,
      code,
      `COS ${method} ${key} failed with ${response.status} (${code})`,
      key,
    );
  }

  async function putObject(key, body, options = {}, { forbidOverwrite = false } = {}) {
    const headers = {};
    const contentType = options.httpMetadata?.contentType;
    if (contentType) headers["content-type"] = contentType;
    for (const [name, value] of Object.entries(options.customMetadata ?? {}))
      headers[`x-cos-meta-${name.toLowerCase()}`] = String(value);
    if (forbidOverwrite) headers["x-cos-forbid-overwrite"] = "true";
    const response = await send("PUT", key, { headers, body });
    // 409 FileAlreadyExists is the "precondition failed" answer, not an outage.
    if (forbidOverwrite && response.status === 409) return null;
    if (!response.ok) await fail(response, key, "PUT");
    return { etag: normalizeEtag(response.headers.get("etag")), size: byteLength(body), key };
  }

  async function deleteKey(key) {
    const response = await send("DELETE", key);
    if (!response.ok && response.status !== 404) await fail(response, key, "DELETE");
  }

  async function deleteBatch(keys) {
    // DELETE Multiple Objects is a POST with ?delete, not a DELETE (COS 436/8283).
    const body = `<Delete><Quiet>true</Quiet>${keys
      .map((key) => `<Object><Key>${escapeXml(key)}</Key></Object>`)
      .join("")}</Delete>`;
    const response = await send("POST", "", {
      query: { delete: "" },
      headers: {
        "content-type": "application/xml",
        "content-md5": createHash("md5").update(body, "utf8").digest("base64"),
      },
      body,
    });
    if (!response.ok) await fail(response, `${keys.length} objects`, "POST");
  }

  /**
   * COS cannot compare-and-swap on PUT. The claim object gives us "exactly one
   * writer per observed etag": the claim key is derived from the expected etag,
   * and forbid-overwrite makes its creation atomic. A successful manifest write
   * changes the etag, so the old claim key can never be reused — a leaked claim
   * wastes an object but cannot block later writers.
   */
  async function conditionalPut(key, body, options, expectedEtag) {
    const claimKey = claimKeyFor(key, expectedEtag);
    const owner = randomUUID();
    let acquiredAt = 0;
    for (let attempt = 0; attempt < CLAIM_WAIT_ATTEMPTS; attempt++) {
      const created = await putObject(
        claimKey,
        JSON.stringify({ owner, at: new Date(clock()).toISOString() }),
        {
          httpMetadata: { contentType: "application/json" },
        },
        { forbidOverwrite: true },
      );
      if (created) {
        acquiredAt = clock();
        break;
      }
      const held = await head(claimKey);
      if (!held) continue;
      const modified = Date.parse(held.lastModified ?? "");
      const age = Number.isFinite(modified) ? clock() - modified : Infinity;
      if (age > staleClaimMs) {
        // Crashed writer: take the claim over. Two simultaneous takeovers can
        // still both proceed; the etag re-read below bounds the damage.
        await deleteKey(claimKey);
        continue;
      }
      await sleep(60 + attempt * 40);
    }
    if (!acquiredAt) return null;

    try {
      const current = await head(key);
      if (!current || !sameEtag(current.etag, expectedEtag)) return null;
      return await putObject(key, body, options);
    } finally {
      if (clock() - acquiredAt < staleClaimMs) await deleteKey(claimKey).catch(() => {});
      else await releaseClaim(claimKey, owner);
    }
  }

  async function releaseClaim(claimKey, owner) {
    try {
      const held = await get(claimKey);
      if (!held) return;
      if ((await held.json()).owner !== owner) return;
      await deleteKey(claimKey);
    } catch {
      /* a stale claim only costs one object; never fail the caller for it */
    }
  }

  async function head(key) {
    const response = await send("HEAD", key);
    if (response.status === 404) return null;
    if (!response.ok) await fail(response, key, "HEAD");
    return {
      key,
      size: Number(response.headers.get("content-length") ?? 0),
      etag: normalizeEtag(response.headers.get("etag")),
      lastModified: response.headers.get("last-modified") ?? undefined,
    };
  }

  async function get(key, options = {}) {
    const headers = {};
    let expectedStatus = 200;
    if (options.range) {
      const { offset = 0, length } = options.range;
      headers.range =
        length === undefined ? `bytes=${offset}-` : `bytes=${offset}-${offset + length - 1}`;
      expectedStatus = 206;
    }
    const response = await send("GET", key, { headers });
    if (response.status === 404) return null;
    if (response.status !== expectedStatus && !response.ok) await fail(response, key, "GET");
    let buffered;
    const arrayBuffer = async () => (buffered ??= await response.arrayBuffer());
    return {
      key,
      size: Number(response.headers.get("content-length") ?? 0),
      etag: normalizeEtag(response.headers.get("etag")),
      lastModified: response.headers.get("last-modified") ?? undefined,
      arrayBuffer,
      async json() {
        return JSON.parse(new TextDecoder().decode(new Uint8Array(await arrayBuffer())));
      },
    };
  }

  async function list({ prefix, limit = 1000, cursor } = {}) {
    const query = { "list-type": "2", "max-keys": String(limit) };
    if (prefix) query.prefix = prefix;
    if (cursor) query["continuation-token"] = cursor;
    const response = await send("GET", "", { query });
    if (!response.ok) await fail(response, `list ${prefix ?? ""}`, "GET");
    const xml = await response.text();
    const objects = [...xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)]
      .map((match) => ({
        key: xmlTag(match[1], "Key"),
        size: Number(xmlTag(match[1], "Size") ?? 0),
      }))
      .filter((object) => typeof object.key === "string");
    const truncated = xmlTag(xml, "IsTruncated") === "true";
    const next = xmlTag(xml, "NextContinuationToken");
    if (truncated && !next)
      throw new CosError(
        500,
        "list_cursor_missing",
        `COS listed ${objects.length} objects but returned no continuation token`,
        prefix,
      );
    return { objects, truncated, cursor: truncated ? next : null };
  }

  async function put(key, body, options = {}) {
    const onlyIf = options.onlyIf;
    if (!onlyIf) return putObject(key, body, options);
    if (onlyIf.etagDoesNotMatch === "*")
      return putObject(key, body, options, { forbidOverwrite: true });
    if (onlyIf.etagMatches) return conditionalPut(key, body, options, onlyIf.etagMatches);
    throw new CosError(
      400,
      "unsupported_conditional",
      "COS adapter supports onlyIf.etagMatches and onlyIf.etagDoesNotMatch:'*'",
      key,
    );
  }

  async function remove(keys) {
    const list_ = Array.isArray(keys) ? keys : [keys];
    for (let index = 0; index < list_.length; index += MAX_BATCH_DELETE) {
      const chunk = list_.slice(index, index + MAX_BATCH_DELETE);
      if (chunk.length === 1) await deleteKey(chunk[0]);
      else if (chunk.length) await deleteBatch(chunk);
    }
  }

  return { get, head, put, delete: remove, list };
}

/** Reads the credentials from the function environment (Makers env vars). */
export function createCosBucketFromEnv(env = process.env) {
  return createCosBucket({
    bucket: env.NMG_COS_BUCKET,
    region: env.NMG_COS_REGION,
    secretId: env.NMG_COS_SECRET_ID,
    secretKey: env.NMG_COS_SECRET_KEY,
    endpoint: env.NMG_COS_ENDPOINT || undefined,
  });
}
