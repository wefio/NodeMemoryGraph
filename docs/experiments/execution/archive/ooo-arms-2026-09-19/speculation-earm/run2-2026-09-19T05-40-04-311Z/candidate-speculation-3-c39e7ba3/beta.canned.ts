import type { Section } from "./interface.ts";

export function betaSection(rows: readonly string[]): Section {
  return { id: "beta", title: "Beta", lines: rows.map((row, index) => `${index + 1}. ${row}`) };
}
