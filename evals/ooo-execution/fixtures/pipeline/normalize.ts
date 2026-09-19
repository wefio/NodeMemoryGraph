import type { Step } from "./frozen.ts";

/** The steps the report is built from: only the ones that took time, in name order. */
export function normalize(_steps: readonly Step[]): Step[] {
  throw new Error("not implemented");
}
