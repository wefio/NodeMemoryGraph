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
  invariants: string[];
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
  invariants: string[];
  verificationChecks: string[];
  routes: string[];
  authority: AuthorityMode;
  operationKey: string;
  expectedArtifacts: string[];
}

export interface HarnessResult {
  provider: ProviderDescriptor;
  status: "completed" | "blocked" | "failed";
  summary: string;
  artifacts?: string[];
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
  scope: {
    declared: string[];
    excluded: string[];
    actual: string[];
    matched: boolean;
  };
  checks: VerificationCheckResult[];
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
