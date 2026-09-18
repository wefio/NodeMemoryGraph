import type { Step } from "./frozen.ts";

/** The report: every step it was given, and the total it was given, rendered. Its input is the other
 *  three builders' results, which is why it can only be built once they exist. */
export function summarize(_normalized: readonly Step[], _totalMs: number): string {
  throw new Error("not implemented");
}
