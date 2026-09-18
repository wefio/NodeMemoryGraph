/**
 * The reference answer for the normalize unit, used by the canned worker: the instrument has to show
 * the task family accepts a correct submission before a model is paid to produce one.
 */
import type { Step } from "./frozen.ts";

export function normalize(steps: readonly Step[]): Step[] {
  return steps.filter((step) => step.ms > 0).slice().sort((a, b) => a.name.localeCompare(b.name));
}
