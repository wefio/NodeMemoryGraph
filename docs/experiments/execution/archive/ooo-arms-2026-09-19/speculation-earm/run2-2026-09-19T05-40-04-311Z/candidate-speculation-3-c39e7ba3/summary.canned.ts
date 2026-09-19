import type { Section } from "./interface.ts";

export function summarySection(sections: readonly Section[]): Section {
  return { id: "summary", title: "Summary", lines: sections.map((section) => `- ${section.title}`) };
}
