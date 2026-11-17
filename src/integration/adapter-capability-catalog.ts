import { Unsafe } from "typebox";
import { Value } from "typebox/value";
import type { AdapterCapability } from "./adapter-capability-assembly.ts";
import manifestSchema from "./adapter-manifests/adapter-manifest.schema.json" with { type: "json" };
import codex from "./adapter-manifests/codex.json" with { type: "json" };
import dsh from "./adapter-manifests/dsh.json" with { type: "json" };
import kimi from "./adapter-manifests/kimi.json" with { type: "json" };
import mcp from "./adapter-manifests/mcp.json" with { type: "json" };
import opencode from "./adapter-manifests/opencode.json" with { type: "json" };
import pi from "./adapter-manifests/pi.json" with { type: "json" };
import workbuddy from "./adapter-manifests/workbuddy.json" with { type: "json" };

export interface AdapterManifest {
  readonly entry: string;
  readonly capabilities: readonly AdapterCapability[];
}

/** JSON module imports are loader-dependent: native ESM hands back the parsed
 * value, while transpiling loaders such as jiti (which the Pi harness uses to
 * load extensions) also attach a non-enumerable self-referencing `default` to
 * it. TypeBox clones and validates own properties, so that wrapper overflows the
 * stack in Unsafe() and reads as an unknown property in Value.Check(). Copying
 * the enumerable own properties keeps the catalog identical under every loader.
 */
function plainModuleValue<Value>(source: Value): Value {
  return (
    typeof source === "object" && source !== null && !Array.isArray(source)
      ? { ...(source as Record<string, unknown>) }
      : source
  ) as Value;
}

const schema = Unsafe<AdapterManifest>(plainModuleValue(manifestSchema));
export const ADAPTER_MANIFEST_SCHEMA = manifestSchema;

export function readAdapterManifest(id: string, manifest: unknown): AdapterManifest {
  const data = plainModuleValue(manifest);
  if (!Value.Check(schema, data)) throw new Error(`Invalid NMG capability manifest: ${id}`);
  return Object.freeze({
    entry: data.entry,
    capabilities: Object.freeze([...data.capabilities]),
  });
}

export const ADAPTER_CAPABILITY_CATALOG = {
  codex: readAdapterManifest("codex", codex),
  dsh: readAdapterManifest("dsh", dsh),
  kimi: readAdapterManifest("kimi", kimi),
  mcp: readAdapterManifest("mcp", mcp),
  opencode: readAdapterManifest("opencode", opencode),
  pi: readAdapterManifest("pi", pi),
  workbuddy: readAdapterManifest("workbuddy", workbuddy),
};
