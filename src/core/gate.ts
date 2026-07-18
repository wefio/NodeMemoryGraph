import type { MemoryGateDecision } from "./types.ts";

const EXPLICIT_RECALL_PATTERNS = [
  /(?:之前|以前|上次|曾经|当时|还记得|回忆|记忆中)/u,
  /(?:我|我们).{0,16}(?:用过|说过|提过|决定过|选择过|讨论过|告诉过)/u,
  /(?:我|我们).{0,12}(?:现在|当前|最近|最新).{0,12}(?:什么|哪个|多少|是谁|用|使用|喜欢|偏好|决定|选择)/u,
  /(?:根据|按照)我的(?:偏好|习惯|要求|历史)/u,
  /\b(?:remember|previously|before|last time|earlier|used to|did (?:i|we)|have (?:i|we))\b/i,
  /\b(?:what|how many|how long)\b.{0,32}\b(?:i|we)\b/i,
  /^(?:what|when|where|who|which|how many|how long)\b.{0,32}\bmy\b/i,
  /\bmy (?:current|latest|previous|last|preference|preferences|history)\b/i,
];

const OPTIONAL_RECALL_PATTERNS = [
  /(?:推荐|建议|方案|规划|计划|怎么做|如何选择|帮我选)/u,
  /\b(?:recommend|recommendation|suggest|suggestion|advice|plan|planning)\b/i,
  /\b(?:which|what) should (?:i|we)\b/i,
  /\bhow should (?:i|we)\b/i,
];

/**
 * Chooses how much long-term memory to expose before a model turn.
 * It deliberately does not choose memories or decide whether they are true.
 */
export function decideMemoryLoad(query: string): MemoryGateDecision {
  const normalized = query.trim();
  if (normalized && EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "retrieve",
      confidence: 0.95,
      reason: "explicit_recall",
      maxTier: 1,
      limit: 12,
      graphHops: 1,
    };
  }
  if (normalized && OPTIONAL_RECALL_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      mode: "cue",
      confidence: 0.75,
      reason: "memory_may_help",
      maxTier: 3,
      limit: 5,
      graphHops: 0,
    };
  }
  return {
    mode: "none",
    confidence: 0.9,
    reason: "memory_not_needed",
    maxTier: 0,
    limit: 0,
    graphHops: 0,
  };
}
