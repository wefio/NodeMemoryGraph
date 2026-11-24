import assert from "node:assert/strict";

function inspectArrayValue(
  array: unknown[],
  path: string,
  seen: Set<object>,
  issues: string[],
): void {
  for (let i = 0; i < array.length; i++) {
    if (!(i in array)) {
      issues.push(`${path}[${i}]: sparse array hole`);
      continue;
    }
    collectNonJsonPaths(array[i], `${path}[${i}]`, seen, issues);
  }
}

function inspectObjectValue(
  obj: Record<string, unknown>,
  path: string,
  seen: Set<object>,
  issues: string[],
): void {
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    const name = proto?.constructor?.name ?? "unknown";
    issues.push(`${path}: non-plain instance (${String(name)})`);
  }
  for (const key of Object.keys(obj)) {
    collectNonJsonPaths(obj[key], `${path}.${key}`, seen, issues);
  }
}

function collectNonJsonPaths(
  value: unknown,
  path: string,
  seen: Set<object>,
  issues: string[],
): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) issues.push(`${path}: non-finite number (${String(value)})`);
    return;
  }
  if (kind !== "object") {
    issues.push(`${path}: unsupported ${kind}`);
    return;
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    issues.push(`${path}: circular reference`);
    return;
  }
  seen.add(objectValue);
  if (Array.isArray(objectValue)) inspectArrayValue(objectValue, path, seen, issues);
  else inspectObjectValue(objectValue as Record<string, unknown>, path, seen, issues);
  seen.delete(objectValue);
}

/**
 * Mirrors `@deepseek-ai/dsh-util-values`'s `snapshotJsonValue` constraints:
 * rejects explicit `undefined` properties, functions, symbols, `BigInt`,
 * non-finite numbers (`NaN`/`Infinity`), sparse array holes, non-plain class
 * instances, and circular references.
 */
export function findNonJsonValuePaths(value: unknown, rootPath = "$"): string[] {
  const issues: string[] = [];
  collectNonJsonPaths(value, rootPath, new Set<object>(), issues);
  return issues;
}

/** Assert a tool definition payload can be snapshotted cleanly as strict JSON. */
export function assertSnapshotJsonSafe(value: unknown, label: string): void {
  const issues = findNonJsonValuePaths(value);
  assert.deepEqual(
    issues,
    [],
    `${label} failed strict JSON snapshot validation:\n  - ${issues.join("\n  - ")}`,
  );
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, "string", `${label} must JSON.stringify cleanly`);
  assert.deepEqual(
    JSON.parse(serialized),
    value,
    `${label} must round-trip identically through JSON.stringify/JSON.parse`,
  );
}
