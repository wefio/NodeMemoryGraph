import type { Section } from "./interface.ts";

/** The summary section: one line per section, in the order the sections were given. Its input is the
 *  other three sections, which is why it can only be built once they exist. */
export function summarySection(_sections: readonly Section[]): Section {
  throw new Error("not implemented");
}
