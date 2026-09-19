/**
 * The frozen interface of the pipeline report this task family builds.
 *
 * Nothing here is anyone's unit: it is the contract the builders are written to, and the only
 * renderer. A finer plan is the same work precisely because this file stays as it is.
 */
export interface Step {
  readonly name: string;
  readonly ms: number;
}

/** The one renderer: a step is its name and its duration. */
export function renderStep(step: Step): string {
  return `${step.name}: ${step.ms}ms`;
}
