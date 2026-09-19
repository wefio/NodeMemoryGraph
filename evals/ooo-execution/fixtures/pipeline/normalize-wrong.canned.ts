/** A wrong answer, not a stub: it returns the steps in reverse name order where the frozen check says
 *  name order, so a run that accepts it would be accepting on something other than the check. */
import type { Step } from "./frozen.ts";

export function normalize(steps: readonly Step[]): Step[] {
  return steps
    .filter((step) => step.ms > 0)
    .slice()
    .sort((a, b) => b.name.localeCompare(a.name));
}
