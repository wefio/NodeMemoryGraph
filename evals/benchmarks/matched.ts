export const MATCHED_MODES = ["no-memory", "nmg-deterministic", "nmg-shadow"] as const;
export const BACKEND_ABLATION_MODES = [
  "no-memory",
  "flat-hybrid",
  "nmg-lite",
  "nmg-graph",
] as const;

export type MatchedMode = (typeof MATCHED_MODES)[number];

export function matchedUserPrompt(input: {
  benchmark?: "BEAM" | "LoCoMo" | "LongMemEval" | "PersonaMem";
  question: string;
  questionDate?: string;
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
    input.questionDate ? `Question date: ${input.questionDate}` : "",
    `Question: ${input.question}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function isMatchedMode(value: string): value is MatchedMode {
  return (MATCHED_MODES as readonly string[]).includes(value);
}

/** Deterministic rotation prevents provider cold-start cost from always landing on one arm. */
export function counterbalancedOrder<T>(items: readonly T[], key: string): T[] {
  if (items.length < 2) return [...items];
  const offset = [...key].reduce((sum, character) => sum + character.codePointAt(0)!, 0) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

export function benchmarkIsolationArgs(nmgExtensionPath?: string): string[] {
  const isolation = [
    "--no-extensions",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
  ];
  return nmgExtensionPath
    ? [
        ...isolation,
        "--tools",
        "nmg_remember,nmg_search,nmg_get",
        "--extension",
        nmgExtensionPath,
      ]
    : [...isolation, "--no-tools"];
}

export function controllerShadowEnvironment(mode: MatchedMode): Record<string, string> {
  if (mode === "nmg-deterministic") return { NMG_CONTROLLER_SHADOW: "0" };
  if (mode === "nmg-shadow") return { NMG_CONTROLLER_SHADOW: "1" };
  return {};
}
