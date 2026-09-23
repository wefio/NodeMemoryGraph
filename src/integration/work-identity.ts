/**
 * What names a piece of work, in one place.
 *
 * A verdict binds to a digest rather than to bytes: the board records the digest of what was delivered,
 * and a second delivery of other bytes cannot inherit the first one's judgement. That digest is sha256 in
 * hex, and it is written here rather than at each site because the same two lines had been written in four
 * modules - twice as an identical private `digestOf(value)` - while two of those callers had folded their
 * own shortening into it, so a twelve-character report identity and a sixteen-character branch identity
 * looked like part of the rule instead of a caller's choice. Only the algorithm and the encoding live here,
 * because those are the part a reader of a stored digest depends on.
 *
 * Sites that need another encoding on purpose keep their own convention: a search index's base64url content
 * hash, a session identifier, and a CLI-protocol identity that carries a visible `sha256:` prefix are three
 * different rules about three different values, not three spellings of this one.
 *
 * Canonicalisation is deliberately the caller's job, and that is why the JSON variant takes a value: JSON
 * key order is whatever the caller built, so a caller that needs one identity per shape rather than one per
 * serialisation has to shape or sort the value first. Freezing a patch does exactly that before digesting
 * it, which is why `preparePatchWork` returns a digest and not a serialisation. Shortening a digest is the
 * caller's choice too, and it says so by slicing - two callers want short identities for logs and reports.
 */
import { createHash } from "node:crypto";

/** The identity of work bytes: sha256, hex, full length. Text and raw bytes are the same rule, because an
 *  artifact is bytes and a stored digest does not care which reader produced them. */
export function workDigest(bytes: string | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The identity of a value, over its JSON text. The caller owns key order: two serialisations of one shape
 *  are two identities unless the caller froze the shape first. */
export function workDigestOf(value: unknown): string {
  return workDigest(JSON.stringify(value));
}
