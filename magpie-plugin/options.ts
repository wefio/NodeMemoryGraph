import { isAbsolute } from "node:path";
import { Unsafe } from "typebox";
import { Value } from "typebox/value";
import schema from "./options.schema.json" with { type: "json" };
import {
  ADAPTER_CAPABILITY_IDS,
  adapterToolCapability,
} from "../src/integration/adapter-capability-assembly.ts";
import type { MagpieOptions } from "./types.ts";

export function readMagpieOptions(value: unknown = {}): MagpieOptions {
  if (!Value.Check(Unsafe(schema), value)) throw new Error("Invalid NMG Magpie options");
  const options = value as MagpieOptions;
  if (options.dataDirectory && !isAbsolute(options.dataDirectory))
    throw new Error("NMG dataDirectory must be absolute");
  for (const capabilities of Object.values(options.nativeCapabilities ?? {}))
    for (const capability of capabilities) {
      if (!ADAPTER_CAPABILITY_IDS.includes(capability) || adapterToolCapability(capability))
        throw new Error("nativeCapabilities selects registered lifecycle capabilities");
    }
  return structuredClone(options);
}
