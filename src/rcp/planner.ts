import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { digestCanonical } from "./canonical.ts";
import { normalizeRepositoryPath } from "./repository.ts";
import type {
  ObservedRepository,
  RepositoryContractIr,
  RouteDeclaration,
  WorkOrder,
} from "./types.ts";

interface RouteFile {
  version: number;
  routes: RouteDeclaration[];
}

export function readRouteDeclarations(root: string): RouteDeclaration[] {
  const parsed = parseYaml(readFileSync(join(resolve(root), "agent-context.yaml"), "utf8")) as
    Partial<RouteFile> | undefined;
  if (parsed?.version !== 1 || !Array.isArray(parsed.routes)) {
    throw new Error("agent-context.yaml must declare version: 1 and a routes array");
  }
  return parsed.routes;
}

export function selectRoutes(
  contract: RepositoryContractIr,
  declarations: RouteDeclaration[],
): RouteDeclaration[] {
  const requested = new Set(contract.verification.routes);
  const selected = declarations.filter(
    (route) =>
      requested.has(route.id) ||
      route.paths.some((routePattern) =>
        contract.scope.include.some((scopePattern) =>
          patternsMayIntersect(routePattern, scopePattern),
        ),
      ),
  );
  const available = new Set(declarations.map((route) => route.id));
  const missing = [...requested].filter((route) => !available.has(route));
  if (missing.length) throw new Error(`unknown verification routes: ${missing.join(", ")}`);
  return selected;
}

export interface NarrowPlanInput {
  routeId: string;
  checks: string[];
  reason: string;
}

export function planWorkOrder(input: {
  contract: RepositoryContractIr;
  observation: ObservedRepository;
  routes: RouteDeclaration[];
  operationKey?: string;
  executionTimeoutMs?: number;
  narrow?: NarrowPlanInput;
}): WorkOrder {
  const narrow = input.narrow;
  const selected = narrow
    ? input.routes.filter((route) => route.id === narrow.routeId)
    : selectRoutes(input.contract, input.routes);
  if (narrow && selected.length !== 1) {
    throw new Error(`narrow verification route is unavailable: ${narrow.routeId}`);
  }
  const checks = narrow
    ? unique(narrow.checks)
    : unique([
        ...input.contract.verification.checks,
        ...selected.flatMap((route) => route.verify.blocking),
      ]);
  const gate: WorkOrder["gate"] = narrow
    ? { mode: "narrow", reason: narrow.reason, fullGateRun: false }
    : { mode: "full", fullGateRun: true };
  const owners = unique(selected.flatMap((route) => route.owners));
  const routeIds = selected.map((route) => route.id);
  const routeDigest = digestCanonical(selected);
  const operationKey = input.operationKey ?? "implement";
  const timeoutMs = executionTimeout(input.executionTimeoutMs);
  const budget: WorkOrder["budget"] = { maxAttempts: 1, timeoutMs };
  const identity = digestCanonical({
    contractDigest: input.contract.contractDigest,
    observedRevision: input.observation.observedRevision,
    operationKey,
    routeDigest,
    verificationChecks: checks,
    gate,
    budget,
  });
  return {
    schema: "repository.work-order/v1alpha1",
    id: `wo-${identity.slice("sha256:".length, "sha256:".length + 24)}`,
    contractId: input.contract.id,
    contractDigest: input.contract.contractDigest,
    intent: input.contract.intent,
    observedRevision: input.observation.observedRevision,
    baseCommit: input.observation.git.commit,
    allowedPaths: input.contract.scope.include,
    excludedPaths: input.contract.scope.exclude,
    owners,
    preserve: input.contract.preserve,
    assertions: input.contract.assertions,
    verificationChecks: checks,
    routes: routeIds,
    routeDigest,
    gate,
    authority: input.contract.authority.mode,
    operationKey,
    budget,
    expectedArtifacts: ["patch", "verification-receipt"],
  };
}

function executionTimeout(value: number | undefined): number {
  const timeoutMs = value ?? 30 * 60 * 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("execution timeout must be a positive integer");
  }
  return timeoutMs;
}

export function operationIdentity(workOrder: WorkOrder, verifierDigest: string): string {
  return digestCanonical({
    workOrderId: workOrder.id,
    contractDigest: workOrder.contractDigest,
    observedRevision: workOrder.observedRevision,
    operationKey: workOrder.operationKey,
    routeDigest: workOrder.routeDigest,
    verificationChecks: workOrder.verificationChecks,
    verifierDigest,
  });
}

export function attemptKey(workOrder: WorkOrder): string {
  return digestCanonical({
    contractDigest: workOrder.contractDigest,
    operationKey: workOrder.operationKey,
  });
}

function patternsMayIntersect(left: string, right: string): boolean {
  const leftPrefix = staticPrefix(left);
  const rightPrefix = staticPrefix(right);
  return (
    !leftPrefix ||
    !rightPrefix ||
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}

function staticPrefix(pattern: string): string {
  const normalized = normalizeRepositoryPath(pattern);
  const wildcard = normalized.search(/[?*]/);
  return (wildcard < 0 ? normalized : normalized.slice(0, wildcard)).replace(/\/$/, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
