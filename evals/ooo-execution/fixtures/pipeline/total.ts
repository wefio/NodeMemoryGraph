import type { Step } from "./frozen.ts";

/** The whole pipeline in one number: the sum of the steps it was given. */
export function total(_steps: readonly Step[]): number {
  throw new Error("not implemented");
}
