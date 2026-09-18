/** The reference answer for the total unit. */
import type { Step } from "./frozen.ts";

export function total(steps: readonly Step[]): number {
  return steps.reduce((sum, step) => sum + step.ms, 0);
}
