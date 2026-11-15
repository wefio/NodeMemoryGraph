import type { MemoryRecord, MemoryResidence } from "./types.ts";

export function defaultResidence(input: {
  memoryType?: MemoryRecord["memoryType"];
  sourceActor?: MemoryRecord["sourceActor"];
  truthStatus?: MemoryRecord["truthStatus"];
}): MemoryResidence {
  if (input.memoryType === "derived" || input.truthStatus === "inferred") return "stg";
  if (input.sourceActor === "assistant" && input.truthStatus === "unverified") return "stg";
  return "ltg";
}
