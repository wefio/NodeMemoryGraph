import type { NmgStore } from "../../src/core/store.ts";
import type { TaskBoardEntry } from "../../src/core/types.ts";

interface ClaimAndDeliverInput {
  agentId: string;
  digest: string;
  now: string;
  leaseSeconds: number;
}

/** Acts on an existing entry. The two store writes are not an atomic transaction. */
export function claimAndDeliver(
  store: NmgStore,
  entry: Pick<TaskBoardEntry, "taskId" | "id">,
  input: ClaimAndDeliverInput,
): TaskBoardEntry {
  const reference = { taskId: entry.taskId, entryId: entry.id, agentId: input.agentId };
  store.claimTaskBoardEntry({ ...reference, now: input.now, leaseSeconds: input.leaseSeconds });
  return store.deliverTaskBoardEntry({ ...reference, now: input.now, digest: input.digest });
}
