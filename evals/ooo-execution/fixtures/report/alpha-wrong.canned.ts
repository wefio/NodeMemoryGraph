import type { Section } from "./interface.ts";

/** A wrong answer, not a stub: it sorts descending where the frozen check says ascending, so a run
 *  that accepts it would be accepting on something other than the check. */
export function alphaSection(rows: readonly string[]): Section {
  const kept = rows.filter((row) => row.trim() !== "").sort((a, b) => b.localeCompare(a));
  return { id: "alpha", title: "Alpha", lines: kept };
}
