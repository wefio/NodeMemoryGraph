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

const schema = Unsafe<AdapterManifest>(manifestSchema);
export const ADAPTER_MANIFEST_SCHEMA = manifestSchema;

export function readAdapterManifest(id: string, manifest: unknown): AdapterManifest {
  if (!Value.Check(schema, manifest)) throw new Error(`Invalid NMG capability manifest: ${id}`);
  return Object.freeze({
    entry: manifest.entry,
    capabilities: Object.freeze([...manifest.capabilities]),
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
