/**
 * The frozen interface of the report this task family builds.
 *
 * Nothing in this file is anyone's unit: it is the contract the sections are built to, and the only
 * renderer. A refinement of the work is legal precisely because this file stays as it is - the units
 * change bodies, never this shape.
 */
export interface Section {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly string[];
}

/** The one renderer: a section is its title and its lines, and the composition is the join. */
export function render(section: Section): string {
  return [`## ${section.title}`, ...section.lines].join("\n") + "\n";
}
