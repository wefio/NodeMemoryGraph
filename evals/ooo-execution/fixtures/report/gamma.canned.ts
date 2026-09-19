import type { Section } from "./interface.ts";

export function gammaSection(rows: readonly string[]): Section {
  const lines: string[] = [];
  for (const row of rows) {
    const upper = row.toUpperCase();
    if (!lines.includes(upper)) lines.push(upper);
  }
  return { id: "gamma", title: "Gamma", lines };
}
