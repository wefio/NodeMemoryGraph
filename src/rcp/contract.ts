import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse as parseYaml } from "yaml";

import { digestCanonical } from "./canonical.ts";
import {
  ASSERTION_KINDS,
  ASSERTION_STAGES,
  ASSERTION_STRENGTHS,
  RCP_CONTRACT_API_VERSION,
  RCP_CONTRACT_KIND,
  type AuthorityMode,
  type CompileContractResult,
  type ContractAssertion,
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
  "assertions",
  "verification",
  "authority",
  "extensions",
]);
const SCOPE_FIELDS = new Set(["include", "exclude"]);
const VERIFICATION_FIELDS = new Set(["routes", "checks", "forgeChecks"]);
const AUTHORITY_FIELDS = new Set(["mode"]);
const ASSERTION_FIELDS = new Set([
  "id",
  "statement",
  "domain",
  "assumes",
  "strength",
  "check",
  "documentedOnly",
  "kind",
  "stage",
  "context",
]);
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
  assertions: ContractAssertion[];
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
  const assertions = compileAssertions(spec.assertions, error);
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
    assertions,
    verification: {
      routes: uniqueSorted(routes),
      checks: uniqueSorted(checks),
      forgeChecks: uniqueSorted(forgeChecks),
    },
    authority: { mode },
    extensions,
  };
}

function compileAssertions(value: unknown, error: ContractError): ContractAssertion[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    error("contract.assertions", "spec.assertions must be an array", "spec.assertions");
    return [];
  }
  const assertions: ContractAssertion[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const assertion = compileAssertion(raw, index, error);
    if (!assertion) return;
    if (seen.has(assertion.id)) {
      error(
        "contract.assertion-id",
        `spec.assertions[${index}].id is duplicated: ${assertion.id}`,
        `spec.assertions[${index}].id`,
      );
      return;
    }
    seen.add(assertion.id);
    assertions.push(assertion);
  });
  return assertions;
}

function checkClaim(
  domain: string | undefined,
  assumes: string[] | undefined,
  field: string,
  error: ContractError,
): void {
  if (!domain) {
    error(
      "contract.assertion-claim",
      `${field}.domain is required: name the cases the statement covers`,
      field,
    );
  }
  if (assumes === undefined) {
    error(
      "contract.assertion-claim",
      `${field}.assumes is required; use [] when the claim rests on nothing registered`,
      field,
    );
  }
}

function checkEvidence(
  raw: Record<string, unknown>,
  check: string | undefined,
  documentedOnly: boolean,
  field: string,
  error: ContractError,
): void {
  if (raw.documentedOnly !== undefined && typeof raw.documentedOnly !== "boolean") {
    error(
      "contract.assertion-evidence",
      `${field}.documentedOnly must be a boolean`,
      `${field}.documentedOnly`,
    );
  }
  if (!check && !documentedOnly) {
    error("contract.assertion-evidence", `${field} needs a check or documentedOnly: true`, field);
  }
  if (check && documentedOnly) {
    error(
      "contract.assertion-evidence",
      `${field} cannot declare both a check and documentedOnly`,
      field,
    );
  }
}

function compileAssertion(
  raw: unknown,
  index: number,
  error: ContractError,
): ContractAssertion | undefined {
  const field = `spec.assertions[${index}]`;
  if (!isRecord(raw)) {
    error("contract.assertion", `${field} must be an object`, field);
    return undefined;
  }
  for (const key of Object.keys(raw)) {
    if (!ASSERTION_FIELDS.has(key)) {
      error("contract.assertion-field", `${field}.${key} is not supported`, `${field}.${key}`);
    }
  }
  const id = requiredText(raw.id, `${field}.id`, error);
  const statement = requiredText(raw.statement, `${field}.statement`, error);
  const check = optionalText(raw.check, `${field}.check`, error);
  const documentedOnly = raw.documentedOnly === true;
  checkEvidence(raw, check, documentedOnly, field, error);
  const domain = optionalText(raw.domain, `${field}.domain`, error);
  const assumes = optionalTextList(raw.assumes, `${field}.assumes`, error);
  const strength = enumField(raw.strength, ASSERTION_STRENGTHS, `${field}.strength`, error);
  checkClaim(domain, assumes, field, error);
  const kind = enumField(raw.kind, ASSERTION_KINDS, `${field}.kind`, error);
  const stage = enumField(raw.stage, ASSERTION_STAGES, `${field}.stage`, error);
  const context = optionalText(raw.context, `${field}.context`, error);
  if (!id || !statement) return undefined;
  return {
    id,
    statement,
    ...(domain ? { domain } : {}),
    ...(assumes ? { assumes } : {}),
    ...(strength ? { strength } : {}),
    ...(check ? { check } : {}),
    ...(documentedOnly ? { documentedOnly: true } : {}),
    ...(kind ? { kind } : {}),
    ...(stage ? { stage } : {}),
    ...(context ? { context } : {}),
  };
}

function optionalText(value: unknown, field: string, error: ContractError): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, error);
}

function optionalTextList(
  value: unknown,
  field: string,
  error: ContractError,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    error("contract.assertion-list", `${field} must be an array`, field);
    return undefined;
  }
  const entries: string[] = [];
  for (const [index, entry] of value.entries()) {
    const text = requiredText(entry, `${field}[${index}]`, error);
    if (text) entries.push(text);
  }
  return entries;
}

function enumField<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  error: ContractError,
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    error("contract.assertion-enum", `${field} must be one of ${allowed.join(", ")}`, field);
    return undefined;
  }
  return value as T;
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
