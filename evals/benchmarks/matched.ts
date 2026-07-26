export const MATCHED_MODES = ["no-memory", "nmg-deterministic", "nmg-shadow"] as const;

export type MatchedMode = (typeof MATCHED_MODES)[number];

export function matchedUserPrompt(input: {
  benchmark?: "BEAM" | "LoCoMo" | "PersonaMem";
  question: string;
  options?: readonly string[];
}): string {
  if (input.benchmark === "PersonaMem") {
    return [
      input.question,
      "Find the most appropriate model response and give your final answer (a), (b), (c), or (d) after the special token <final_answer>.",
      input.options?.join("\n") ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }
  return [
    "Answer concisely. If the required information is unavailable, explicitly say you do not know.",
    input.options?.length ? `Options:\n${input.options.join("\n")}` : "",
    `Question: ${input.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function isMatchedMode(value: string): value is MatchedMode {
  return (MATCHED_MODES as readonly string[]).includes(value);
}

export function controllerShadowEnvironment(mode: MatchedMode): Record<string, string> {
  if (mode === "nmg-deterministic") return { NMG_CONTROLLER_SHADOW: "0" };
  if (mode === "nmg-shadow") return { NMG_CONTROLLER_SHADOW: "1" };
  return {};
}
