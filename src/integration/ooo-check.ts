/** Host-issued identity for one external check, separate from an Agent execution lease. */
export interface CheckTicket {
  runId: string;
  taskId: string;
  checkId: string;
  attempt: number;
  inputDigest: string;
  owner: string;
  expiresAt: number;
}

export interface CheckResult {
  ticket: CheckTicket;
  outcome: "passed" | "failed" | "undecidable";
  log: string;
}

/** Terminal evidence is data; even a failed check may unblock a repair task.
 * This never marks that task accepted. Persistence and atomicity belong to the host. */
export function checkResultValid(result: CheckResult): boolean {
  return (
    ["passed", "failed", "undecidable"].includes(result.outcome) &&
    typeof result.log === "string" &&
    Buffer.byteLength(result.log, "utf8") <= 4_000
  );
}

export function sameCheck(actual: CheckTicket, expected: CheckTicket): boolean {
  return (
    actual.runId === expected.runId &&
    actual.taskId === expected.taskId &&
    actual.checkId === expected.checkId &&
    actual.attempt === expected.attempt &&
    actual.inputDigest === expected.inputDigest &&
    actual.owner === expected.owner &&
    actual.expiresAt === expected.expiresAt
  );
}
