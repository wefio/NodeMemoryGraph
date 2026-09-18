/** The reference answer for the summarize unit. */
import type { Step } from "./frozen.ts";
import { renderStep } from "./frozen.ts";

export function summarize(normalized: readonly Step[], totalMs: number): string {
  return [...normalized.map(renderStep), renderStep({ name: "total", ms: totalMs })].join("\n");
}
