/**
 * The read face's one rule for a board entry's body.
 *
 * An entry's body is opaque to the middle and may be long: a memory pointer, a note, a delivered
 * artifact, a broadcast that quotes another entry. Whoever shows an entry to a reader shapes that body
 * the same way, so the rule lives here once, and both the store's compact read and the host adapters use
 * it instead of each writing its own truncation. A lone `memory=<id>` pointer is already the intended
 * low-context form and is returned whole; anything longer is collapsed to a single bounded line, so a
 * read never carries a body its reader did not ask for.
 *
 * The bound is the caller's, because how much of a body fits is the reader's decision. What a body looks
 * like when it is shown is this rule's.
 */
export function boardEntryView(content: string, max = 200): string {
  if (content.trim().startsWith("memory=")) return content.trim();
  const single = content.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}
