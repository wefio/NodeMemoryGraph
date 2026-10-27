/**
 * Tencent COS request signing (Signature V5).
 *
 * Kept separate from cos-bucket.mjs so the algorithm can be unit-tested without
 * any network access: the only inputs are the canonical request parts.
 * https://cloud.tencent.com/document/product/436/7778
 */
import { createHash, createHmac } from "node:crypto";

/** RFC 3986 percent-encoding, which is stricter than encodeURIComponent. */
export function encodeComponent(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** Object keys keep their slashes but every other reserved character is encoded. */
export function encodePath(key) {
  return `/${String(key)
    .split("/")
    .map(encodeComponent)
    .join("/")}`;
}

const sha1Hex = (text) => createHash("sha1").update(text, "utf8").digest("hex");
const hmacSha1Hex = (key, text) => createHmac("sha1", key).update(text, "utf8").digest("hex");

/**
 * Builds the canonical query string and Authorization header for one request.
 * `headers` must contain `host`; lowercase names are expected of the caller.
 */
export function signCosRequest({
  secretId,
  secretKey,
  method,
  path,
  params = {},
  headers,
  lifetimeSeconds = 900,
  nowSeconds = Math.floor(Date.now() / 1000),
}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]),
  );
  if (!lower.host) throw new Error("COS signing requires a host header");

  const headerNames = Object.keys(lower).sort();
  const headerList = headerNames.map((name) => `${encodeComponent(name)}=${encodeComponent(lower[name])}`).join("&");
  const paramNames = Object.keys(params).sort();
  const paramList = paramNames.map((name) => `${encodeComponent(name)}=${encodeComponent(params[name])}`).join("&");
  const httpString = [method.toLowerCase(), path, paramList, headerList, ""].join("\n");

  const keyTime = `${nowSeconds};${nowSeconds + lifetimeSeconds}`;
  const signKey = hmacSha1Hex(secretKey, keyTime);
  const stringToSign = ["sha1", keyTime, sha1Hex(httpString), ""].join("\n");
  const signature = hmacSha1Hex(signKey, stringToSign);

  return {
    query: paramList,
    signedHeaders: headerNames,
    authorization: [
      "q-sign-algorithm=sha1",
      `q-ak=${secretId}`,
      `q-sign-time=${keyTime}`,
      `q-key-time=${keyTime}`,
      `q-header-list=${headerNames.join(";")}`,
      `q-url-param-list=${paramNames.join(";")}`,
      `q-signature=${signature}`,
    ].join("&"),
    httpString,
  };
}
