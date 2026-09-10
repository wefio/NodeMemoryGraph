export const RCP_CONTRACT_API_VERSION = "repository.nmg.dev/v1alpha1" as const;
export const RCP_CONTRACT_KIND = "AgentChange" as const;

export type AuthorityMode = "plan" | "apply" | "continuous";
export type DiagnosticSeverity = "error" | "warning";

export interface SourceLocation {
  path: string;
  line?: number;
  column?: number;
}

export interface ContractDiagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  field?: string;
  source: SourceLocation;
}

export const ASSERTION_KINDS = [
  "test",
  "property",
  "runtime-assertion",
  "metamorphic",
  "coverage",
  "proof",
] as const;
export type AssertionKind = (typeof ASSERTION_KINDS)[number];

export const ASSERTION_STAGES = [
  "requirement",
  "acceptance",
  "unit",
  "integration",
  "e2e",
  "deploy",
  "observability",
  "outcome",
] as const;
export type AssertionStage = (typeof ASSERTION_STAGES)[number];

/** What the evidence behind an assertion actually buys. `decision` is a
 *  deterministic procedure that decides the property for every case in the stated
 *  domain; `witness` is a sample that passed. Absent means `witness`, so an
 *  incomplete backfill can never overstate. An assertion with no evidence at all
 *  is marked `documentedOnly`, which is a different axis. */
export const ASSERTION_STRENGTHS = ["decision", "witness"] as const;
export type AssertionStrength = (typeof ASSERTION_STRENGTHS)[number];

/** One declared design claim plus the evidence that supports it. `check` names
 *  a runnable check; `documentedOnly` marks a claim that nothing checks yet, so
 *  the gap stays visible instead of being implied by a green suite.
 *
 *  A claim is a triple: `statement` is P, `domain` is D, `assumes` is A. The
 *  compiler requires `domain` and `assumes`, so a compiled contract always states
 *  what the evidence covers and what it rests on. */
export interface ContractAssertion {
  id: string;
  statement: string;
  /** D — the cases the statement is claimed over. */
  domain?: string;
  /** A — ids in `docs/design/assumptions.yaml`. May be empty. */
  assumes?: string[];
  /** What the evidence buys; absent means `witness`. */
  strength?: AssertionStrength;
  check?: string;
  documentedOnly?: boolean;
  kind?: AssertionKind;
  stage?: AssertionStage;
  context?: string;
}

export interface RepositoryContractIr {
  apiVersion: typeof RCP_CONTRACT_API_VERSION;
  kind: typeof RCP_CONTRACT_KIND;
  id: string;
  intent: string;
  scope: {
    include: string[];
    exclude: string[];
  };
  preserve: string[];
  assertions: ContractAssertion[];
  verification: {
    routes: string[];
    checks: string[];
    forgeChecks: string[];
  };
  authority: {
    mode: AuthorityMode;
  };
  extensions: Record<string, unknown>;
  source: SourceLocation;
  contractDigest: string;
}

export interface CompileContractResult {
  ok: boolean;
  diagnostics: ContractDiagnostic[];
  contract?: RepositoryContractIr;
}

export interface GitObservation {
  available: boolean;
  branch?: string;
  commit?: string;
  dirtyFiles: string[];
  error?: string;
}

export interface ObservedFile {
  path: string;
  digest: string;
  kind: "file" | "symlink";
}

export interface ObservedRepository {
  root: string;
  observedRevision: string;
  git: GitObservation;
  files: ObservedFile[];
  diagnostics: string[];
  /** Bytes of file content actually read for the digest (soft cost signal). */
  observedBytes?: number;
}

export interface ProviderDescriptor {
  id: string;
  version: string;
  capabilities: string[];
  operations: string[];
  authority: AuthorityMode[];
}

export interface RouteDeclaration {
  id: string;
  paths: string[];
  owners: string[];
  tests: string[];
  verify: {
    blocking: string[];
    advisory: string[];
  };
}

/** Which gate a verification run actually exercised, recorded so a narrow
 *  result can never be read as a full-gate result. */
export interface VerificationGate {
  mode: "narrow" | "full";
  reason?: string;
  /** True only when the declared whole blocking set was run. */
  fullGateRun: boolean;
}

export interface WorkOrder {
  schema: "repository.work-order/v1alpha1";
  id: string;
  contractId: string;
  contractDigest: string;
  intent: string;
  observedRevision: string;
  baseCommit?: string;
  allowedPaths: string[];
  excludedPaths: string[];
  owners: string[];
  preserve: string[];
  assertions: ContractAssertion[];
  verificationChecks: string[];
  routes: string[];
  routeDigest: string;
  gate: VerificationGate;
  authority: AuthorityMode;
  operationKey: string;
  budget: {
    maxAttempts: 1;
    timeoutMs: number;
  };
}

export interface HarnessResult {
  provider: ProviderDescriptor;
  status: "completed" | "blocked" | "failed";
  summary: string;
  diagnostics?: string[];
}

export interface VerificationCheckResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  exitCode?: number;
  reason?: string;
  evidence?: string;
}

export interface VerificationEvidence {
  provider: ProviderDescriptor;
  verifierDigest: string;
  ok: boolean;
  checks: VerificationCheckResult[];
}

export interface ForgeObservation {
  provider: ProviderDescriptor;
  number: number;
  url: string;
  state: string;
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  headCommit: string;
  contractId?: string;
  contractDigest?: string;
  checks: Array<{ name: string; status: string; conclusion?: string }>;
}

export interface RepositoryReceipt {
  receiptSchema: "repository.receipt/v1alpha1";
  receiptId: string;
  operationIdentity: string;
  contractId: string;
  contractDigest: string;
  observedRevisionBefore: string;
  observedRevisionAfter: string;
  commit?: string;
  invocationId: string;
  startedAt: string;
  finishedAt: string;
  harness: {
    id: string;
    version: string;
    status: HarnessResult["status"];
    summary: string;
  };
  verifier: {
    id: string;
    version: string;
    digest: string;
  };
  workOrder: {
    id: string;
    routeDigest: string;
    routes: string[];
    verificationChecks: string[];
    gate: VerificationGate;
    budget: WorkOrder["budget"];
  };
  scope: {
    declared: string[];
    excluded: string[];
    actual: string[];
    matched: boolean;
  };
  checks: VerificationCheckResult[];
  /** The gate this receipt actually exercised; narrow receipts carry
   *  fullGateRun: false so they cannot be read as a full-gate result. */
  gate: VerificationGate;
  forge?: Omit<ForgeObservation, "provider" | "checks"> & {
    provider: string;
    requiredChecks: string[];
    checks: ForgeObservation["checks"];
  };
  decision: "verified" | "failed" | "blocked";
  diagnostics: string[];
}

export interface ReconciliationCondition {
  type: "Compiled" | "Observed" | "Authorized" | "Executed" | "Verified" | "Recorded";
  status: "true" | "false" | "unknown";
  reason: string;
}

export interface ReconciliationResult {
  status: "planned" | "verified" | "failed" | "blocked" | "reused";
  contract: RepositoryContractIr;
  observation: ObservedRepository;
  workOrder: WorkOrder;
  conditions: ReconciliationCondition[];
  receipt?: RepositoryReceipt;
  receiptPath?: string;
  memoryDiagnostics: string[];
}

export interface ReconciliationAttempt {
  attemptSchema: "repository.attempt/v1alpha1";
  attemptKey: string;
  operationIdentity: string;
  contractId: string;
  contractDigest: string;
  operationKey: string;
  observedRevision: string;
  workOrderId: string;
  verifierDigest: string;
  invocationId: string;
  startedAt: string;
}
