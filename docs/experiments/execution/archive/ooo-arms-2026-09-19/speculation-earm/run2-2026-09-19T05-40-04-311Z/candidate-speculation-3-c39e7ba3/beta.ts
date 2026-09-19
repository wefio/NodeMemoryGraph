import type { Section } from "./interface.ts";

/** The beta section: the rows it was given, numbered from one, in the order given. */
export function betaSection(rows: readonly string[]): Section {
  return {
    id: "beta",
    title: "Beta",
    rows: rows.map((row, index) => `${index + 1}. ${row}`),
  };
}
