import { COMPUTE_CACHE_TOKEN } from "./compute-contracts.ts";

const FUNCTION_INSTANCE_IDS = new WeakMap<object, number>();
let nextFunctionId = 1;

/** Stable per-closure/function identity token using explicit COMPUTE_CACHE_TOKEN or monotonic WeakMap ID. */
export function functionIdentityToken(fn: object): string {
  const explicit = (fn as { [COMPUTE_CACHE_TOKEN]?: unknown })[COMPUTE_CACHE_TOKEN];
  if (typeof explicit === "string" && explicit.length > 0) return `[fn_tok:${explicit}]`;
  let id = FUNCTION_INSTANCE_IDS.get(fn);
  if (id === undefined) {
    id = nextFunctionId;
    nextFunctionId += 1;
    FUNCTION_INSTANCE_IDS.set(fn, id);
  }
  return `[fn_id:${id}]`;
}

function isMutableBuiltInContainer(value: object): boolean {
  return (
    value instanceof Map ||
    value instanceof Set ||
    value instanceof WeakMap ||
    value instanceof WeakSet ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(value) ||
    value instanceof Error ||
    value instanceof Promise
  );
}

/**
 * Verify whether a value has no mutable slots anywhere in its object graph.
 * Built-in containers such as Map, Set, Date, RegExp, ArrayBuffer, and TypedArrays
 * remain internally mutable even after Object.freeze(), so they always return false.
 */
export function isDeeplyFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return true;
  if (typeof value === "function") return Object.isFrozen(value);
  if (isMutableBuiltInContainer(value)) return false;
  if (!Object.isFrozen(value)) return false;
  if (seen.has(value)) return true;
  seen.add(value);
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  for (const desc of descriptors) {
    if (desc.get || desc.set) return false;
    if (!isDeeplyFrozen(desc.value, seen)) return false;
  }
  return true;
}

function bufferHex(view: ArrayBufferView): string {
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength).toString("hex");
}

function canonicalizeBuiltIn(value: object, seen: WeakSet<object>): string | undefined {
  if (value instanceof Date) {
    const ms = value.getTime();
    return `[date:${Number.isFinite(ms) ? ms : "NaN"}]`;
  }
  if (value instanceof RegExp) return `[re:${value.source}/${value.flags}:${value.lastIndex}]`;
  if (value instanceof Map) {
    const entries = [...value.entries()]
      .map(([k, v]) => `${canonicalizeComputeValue(k, seen)}=>${canonicalizeComputeValue(v, seen)}`)
      .sort();
    return `[map:${entries.join(",")}]`;
  }
  if (value instanceof Set) {
    const items = [...value.values()].map((item) => canonicalizeComputeValue(item, seen)).sort();
    return `[set:${items.join(",")}]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[ab:${value.byteLength}:${Buffer.from(value).toString("hex")}]`;
  }
  if (typeof SharedArrayBuffer !== "undefined" && value instanceof SharedArrayBuffer) {
    return `[sab:${value.byteLength}:${Buffer.from(value).toString("hex")}]`;
  }
  if (ArrayBuffer.isView(value)) {
    return `[view:${value.constructor.name}:${value.byteLength}:${bufferHex(value)}]`;
  }
  return undefined;
}

function canonicalizePlainObject(value: object, seen: WeakSet<object>): string {
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalizeComputeValue(item, seen)}`);
  return `{${entries.join(",")}}`;
}

/** Deterministic canonical serialization covering primitives, closures, and built-in containers. */
export function canonicalizeComputeValue(value: unknown, seen = new WeakSet<object>()): string {
  if (typeof value === "function") return functionIdentityToken(value);
  if (typeof value === "bigint") return `[bigint:${value.toString()}]`;
  if (typeof value === "symbol") return `[sym:${String(value.description ?? "")}]`;
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value)) return `[num:${String(value)}]`;
    const encoded = JSON.stringify(value);
    return encoded === undefined ? "null" : encoded;
  }
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  try {
    const builtIn = canonicalizeBuiltIn(value, seen);
    if (builtIn !== undefined) return builtIn;
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalizeComputeValue(item, seen)).join(",")}]`;
    }
    return canonicalizePlainObject(value, seen);
  } finally {
    seen.delete(value);
  }
}
