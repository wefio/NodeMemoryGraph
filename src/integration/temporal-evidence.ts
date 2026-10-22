import policy from "./temporal-evidence-policy.json" with { type: "json" };

const temporalQuery = new RegExp(policy.temporalQuery.join("|"), "i");
const relativeEvidence = new RegExp(policy.relativeEvidence.join("|"), "i");
const isoTime = new RegExp(policy.isoTime);
const timestampPrefix = new RegExp(policy.timestampPrefix, "i");

/** Lightweight plain-text evidence for protocols without the rich Agent Surface.
 * Metadata is preserved separately; this heuristic controls display only. Never
 * infer historical time from storage creation or rewrite persisted statements.
 */
export function renderTemporalEvidence(
  content: string,
  eventTime: string | null | undefined,
  query: string,
): string {
  if (timestampPrefix.test(content)) return content;
  if (
    !eventTime ||
    isoTime.exec(eventTime)?.[0] !== eventTime ||
    !Number.isFinite(Date.parse(eventTime))
  ) {
    return content;
  }
  // Date.parse accepts rolled-over calendar dates such as February 31.
  const day = eventTime.slice(0, 10);
  if (new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) !== day) return content;
  if (!temporalQuery.test(query) && !relativeEvidence.test(content)) return content;
  return `[Timestamp: ${eventTime}] ${content}`;
}
