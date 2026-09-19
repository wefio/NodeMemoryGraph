import type { Step } from "./frozen.ts";

/** The same steps at another size: whole milliseconds, rounded down. */
export function scale(_steps: readonly Step[], _factor: number): Step[] {
  throw new Error("not implemented");
}
