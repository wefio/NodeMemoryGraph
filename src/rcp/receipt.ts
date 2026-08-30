import { canonicalJson, digestCanonical } from "./canonical.ts";
import type { RepositoryReceipt } from "./types.ts";

export interface ReceiptValidation {
  valid: boolean;
  errors: string[];
}

export function validateReceipt(receipt: RepositoryReceipt): ReceiptValidation {
  const errors: string[] = [];
  if (receipt.receiptSchema !== "repository.receipt/v1alpha1") {
    errors.push("unsupported receipt schema");
  }
  if (!receipt.contractId || !receipt.contractDigest) errors.push("missing contract identity");
  if (!receipt.observedRevisionBefore || !receipt.observedRevisionAfter) {
    errors.push("missing observed revision binding");
  }
  if (!receipt.verifier.id || !receipt.verifier.digest) errors.push("missing verifier identity");
  if (!receipt.workOrder?.id || !receipt.workOrder.routeDigest) {
    errors.push("missing work order identity");
  }
  if (
    !Array.isArray(receipt.workOrder?.routes) ||
    !Array.isArray(receipt.workOrder?.verificationChecks)
  ) {
    errors.push("missing work order route/check binding");
  }
  if (
    receipt.workOrder?.budget?.maxAttempts !== 1 ||
    !Number.isSafeInteger(receipt.workOrder?.budget?.timeoutMs) ||
    receipt.workOrder.budget.timeoutMs <= 0
  ) {
    errors.push("missing or invalid work order budget");
  }
  if (!receipt.scope.matched) errors.push("actual scope does not match declared scope");
  if (receipt.decision === "verified") {
    if (receipt.harness.status !== "completed")
      errors.push("verified receipt has incomplete harness");
    if (!receipt.checks.length || receipt.checks.some((check) => check.status !== "passed")) {
      errors.push("verified receipt requires every check to pass");
    }
    if (receipt.forge && (!receipt.commit || receipt.forge.headCommit !== receipt.commit)) {
      errors.push("verified forge receipt is not bound to its commit");
    }
  }
  const expectedId = receiptId({ ...receipt, receiptId: "" });
  if (receipt.receiptId !== expectedId) errors.push("receiptId does not match canonical content");
  return { valid: errors.length === 0, errors };
}

export function receiptId(
  receipt: Omit<RepositoryReceipt, "receiptId"> | RepositoryReceipt,
): string {
  const value = JSON.parse(canonicalJson(receipt)) as Record<string, unknown>;
  delete value.receiptId;
  return digestCanonical(value);
}
