import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { digestCanonical } from "./canonical.ts";
import {
  RCP_CONTRACT_API_VERSION,
  RCP_CONTRACT_KIND,
  type AuthorityMode,
  type CompileContractResult,
  type ContractDiagnostic,
  type RepositoryContractIr,
  type SourceLocation,
} from "./types.ts";

const TOP_LEVEL_FIELDS = new Set(["apiVersion", "kind", "metadata", "spec"]);
const METADATA_FIELDS = new Set(["id"]);
const SPEC_FIELDS = new Set([
  "intent",
  "scope",
  "preserve",
  "invariants",
  "verification",
  "authority",
  "extensions",
]);
const SCOPE_FIELDS = new Set(["include", "exclude"]);
const VERIFICATION_FIELDS = new Set(["routes", "checks", "forgeChecks"]);
const AUTHORITY_FIELDS = new Set(["mode"]);
const AUTHORITY_MODES = new Set<AuthorityMode>(["plan", "apply", "continuous"]);

export interface ContractSource {
  text: string;
  path: string;
}

type ContractError = (code: string, message: string, field?: string) => void;
type NormalizedContract = Omit<RepositoryContractIr, "source" | "contractDigest">;

interface ContractIdentity {
  id: string | undefined;
  intent: string | undefined;
}

interface ContractSpecFields {
  scope: NormalizedContract["scope"];
  preserve: string[];
  invariants: string[];
  verification: NormalizedContract["verification"];
  authority: NormalizedContract["authority"];
  extensions: Record<string, unknown>;
}

export function compileContractFile(path: string): CompileContractResult {
  const resolved = resolve(path);
  return compileContract({ text: readFileSync(resolved, "utf8"), path: resolved });
}

export function compileContract(source: ContractSource): CompileContractResult {
  const diagnostics: ContractDiagnostic[] = [];
  const error = createContractError(source, diagnostics);
  const raw = parseContractDocument(source.text, error);
  if (!raw) return { ok: false, diagnostics };

  const normalized = compileContractDocument(raw, error, diagnostics);
  if (!normalized) return { ok: false, diagnostics };

  const contract: RepositoryContractIr = {
    ...normalized,
    source: { path: source.path },
    contractDigest: digestCanonical(normalized),
  };
  return { ok: true, diagnostics, contract };
}

function createContractError(
  source: ContractSource,
  diagnostics: ContractDiagnostic[],
): ContractError {
  return (code, message, field) => {
    const location: SourceLocation = {
      path: source.path,
      ...(field ? locateField(source.text, field) : {}),
    };
    diagnostics.push({ severity: "error", code, message, field, source: location });
  };
}

function parseContractDocument(
  text: string,
  error: ContractError,
): Record<string, unknown> | undefined {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (cause) {
    error("contract.parse", cause instanceof Error ? cause.message : String(cause));
    return undefined;
  }
  if (!isRecord(raw)) {
    error("contract.shape", "contract root must be an object");
    return undefined;
  }
  return raw;
}

function compileContractDocument(
  raw: Record<string, unknown>,
  error: ContractError,
  diagnostics: ContractDiagnostic[],
): NormalizedContract | undefined {
  rejectUnknown(raw, TOP_LEVEL_FIELDS, "", error);
  if (raw.apiVersion !== RCP_CONTRACT_API_VERSION) {
    error("contract.api-version", `apiVersion must be ${RCP_CONTRACT_API_VERSION}`, "apiVersion");
  }
  if (raw.kind !== RCP_CONTRACT_KIND) {
    error("contract.kind", `kind must be ${RCP_CONTRACT_KIND}`, "kind");
  }

  const metadata = recordField(raw, "metadata", error);
  const spec = recordField(raw, "spec", error);
  if (!metadata || !spec) return undefined;
  rejectUnknown(metadata, METADATA_FIELDS, "metadata", error);
  rejectUnknown(spec, SPEC_FIELDS, "spec", error);

  const identity = compileContractIdentity(metadata, spec, error);
  const fields = compileContractSpec(spec, error);
  if (!fields) return undefined;
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
    !identity.id ||
    !identity.intent
  ) {
    return undefined;
  }
  return {
    apiVersion: RCP_CONTRACT_API_VERSION,
    kind: RCP_CONTRACT_KIND,
    id: identity.id,
    intent: identity.intent,
    ...fields,
  };
}

function compileContractIdentity(
  metadata: Record<string, unknown>,
  spec: Record<string, unknown>,
  error: ContractError,
): ContractIdentity {
  const id = requiredText(metadata.id, "metadata.id", error);
  if (id && !/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(id)) {
    error(
      "contract.id",
      "metadata.id must be 3-128 characters using letters, digits, dot, underscore or dash",
      "metadata.id",
    );
  }
  return { id, intent: requiredText(spec.intent, "spec.intent", error) };
}

function compileContractSpec(
  spec: Record<string, unknown>,
  error: ContractError,
): ContractSpecFields | undefined {
  const scope = recordField(spec, "scope", error);
  const verification = recordField(spec, "verification", error);
  const authority = optionalRecordField(spec.authority, "spec.authority", error) ?? {};
  const extensions = optionalRecordField(spec.extensions, "spec.extensions", error) ?? {};
  if (!scope || !verification) return undefined;
  rejectUnknown(scope, SCOPE_FIELDS, "spec.scope", error);
  rejectUnknown(verification, VERIFICATION_FIELDS, "spec.verification", error);
  rejectUnknown(authority, AUTHORITY_FIELDS, "spec.authority", error);

  const include = stringArray(scope.include, "spec.scope.include", error, { required: true });
  const exclude = stringArray(scope.exclude, "spec.scope.exclude", error);
  const preserve = stringArray(spec.preserve, "spec.preserve", error);
  const invariants = stringArray(spec.invariants, "spec.invariants", error);
  const routes = stringArray(verification.routes, "spec.verification.routes", error);
  const checks = stringArray(verification.checks, "spec.verification.checks", error, {
    required: true,
  });
  const forgeChecks = stringArray(verification.forgeChecks, "spec.verification.forgeChecks", error);
  const mode = (authority.mode ?? "plan") as AuthorityMode;
  if (!AUTHORITY_MODES.has(mode)) {
    error("contract.authority", "spec.authority.mode must be plan, apply or continuous", "mode");
  }
  for (const [field, patterns] of [
    ["spec.scope.include", include],
    ["spec.scope.exclude", exclude],
  ] as const) {
    for (const pattern of patterns) validateRepositoryPattern(pattern, field, error);
  }
  return {
    scope: { include: uniqueSorted(include), exclude: uniqueSorted(exclude) },
    preserve: uniqueSorted(preserve),
    invariants: uniqueSorted(invariants),
    verification: {
      routes: uniqueSorted(routes),
      checks: uniqueSorted(checks),
      forgeChecks: uniqueSorted(forgeChecks),
    },
    authority: { mode },
    extensions,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: Set<string>,
  prefix: string,
  error: (code: string, message: string, field?: string) => void,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const field = prefix ? `${prefix}.${key}` : key;
      error("contract.unknown-field", `unknown core field: ${field}`, field);
    }
  }
}

function recordField(
  value: Record<string, unknown>,
  field: string,
  error: (code: string, message: string, field?: string) => void,
): Record<string, unknown> | undefined {
  const entry = value[field];
  if (!isRecord(entry)) {
    error("contract.required-object", `${field} must be an object`, field);
    return undefined;
  }
  return entry;
}

function optionalRecordField(
  value: unknown,
  field: string,
  error: (code: string, message: string, field?: string) => void,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    error("contract.object", `${field} must be an object`, field);
    return undefined;
  }
  return value;
}

function requiredText(
  value: unknown,
  field: string,
  error: (code: string, message: string, field?: string) => void,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    error("contract.required-text", `${field} must be a non-empty string`, field);
    return undefined;
  }
  return value.trim();
}

function stringArray(
  value: unknown,
  field: string,
  error: (code: string, message: string, field?: string) => void,
  options: { required?: boolean } = {},
): string[] {
  if (value === undefined && !options.required) return [];
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string" || !entry.trim()) ||
    (options.required && value.length === 0)
  ) {
    error(
      "contract.string-array",
      `${field} must be ${options.required ? "a non-empty" : "an"} array of non-empty strings`,
      field,
    );
    return [];
  }
  return value.map((entry) => (entry as string).trim());
}

function validateRepositoryPattern(
  pattern: string,
  field: string,
  error: (code: string, message: string, field?: string) => void,
): void {
  const normalized = pattern.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").includes("..") ||
    normalized.includes("\0")
  ) {
    error(
      "contract.scope-path",
      `${field} entries must be repository-relative and cannot contain '..': ${pattern}`,
      field,
    );
  }
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function locateField(text: string, field: string): Pick<SourceLocation, "line" | "column"> {
  const key = field.split(".").at(-1) ?? field;
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) =>
    new RegExp(`^\\s*["']?${escapeRegex(key)}["']?\\s*:`).test(line),
  );
  if (index < 0) return {};
  return { line: index + 1, column: Math.max(1, lines[index].indexOf(key) + 1) };
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
