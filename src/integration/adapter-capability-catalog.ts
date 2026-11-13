import type { AdapterCapability } from "./adapter-capability-assembly.ts";

/** Implemented bindings only. Host lifecycle validation remains separate.
 * Consumers select this declaration instead of maintaining their own tool list.
 */
export const ADAPTER_CAPABILITY_CATALOG = {
  codex: {
    entry: "codex-plugin/index.ts",
    capabilities: [
      "memory-tools",
      "state-tool",
      "lab-tools",
      "automatic-recall",
      "state-context",
      "tool-observation",
      "completion-nudge",
      "board-delivery",
    ],
  },
  pi: {
    entry: ".pi/extensions/nmg/index.ts",
    capabilities: [
      "lab-tools",
      "memory-tools",
      "state-tool",
      "automatic-recall",
      "state-context",
      "answer-attribution",
      "tool-observation",
      "board-delivery",
    ],
  },
  opencode: {
    entry: "opencode-plugin/index.ts",
    capabilities: [
      "memory-tools",
      "state-tool",
      "automatic-recall",
      "state-context",
      "answer-attribution",
      "tool-observation",
      "board-delivery",
    ],
  },
  dsh: {
    entry: "dsh/dsh-nmg/src/plugin/index.ts",
    capabilities: [
      "memory-tools",
      "state-tool",
      "lab-tools",
      "automatic-recall",
      "state-context",
      "answer-attribution",
      "tool-observation",
      "board-delivery",
    ],
  },
  mcp: {
    entry: "claude-plugins/nmg-memory/agents/memory-copilot.ts",
    capabilities: ["memory-tools", "state-tool", "lab-tools"],
  },
  workbuddy: {
    entry: "workbuddy-plugin/nmg-hook.ts",
    capabilities: ["automatic-recall", "completion-nudge", "board-delivery"],
  },
  kimi: {
    entry: "kimi-plugin/nmg-hook.mjs",
    capabilities: ["completion-nudge"],
  },
} as const satisfies Record<string, { entry: string; capabilities: readonly AdapterCapability[] }>;
