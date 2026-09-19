/** The reference answer for the scale unit. */
import type { Step } from "./frozen.ts";

export function scale(steps: readonly Step[], factor: number): Step[] {
  return steps.map((step) => ({ name: step.name, ms: Math.floor(step.ms * factor) }));
}
