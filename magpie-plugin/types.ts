import type { NmgMethod } from "../src/cli/protocol.ts";
import type { AdapterCapability } from "../src/integration/adapter-capability-assembly.ts";
import type { MagpieIdentity } from "./session.ts";
import type { GatewayProtocol } from "./protocol.ts";

export type MagpieInvoke = (
  method: NmgMethod,
  params: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;
export interface MagpieOptions {
  dataDirectory?: string;
  port?: number;
  maxCharacters?: number;
  gatewayTimeoutMs?: number;
  coordination?: boolean;
  nativeCapabilities?: Record<string, AdapterCapability[]>;
}
export interface MagpieHookContext extends MagpieIdentity {
  protocol: GatewayProtocol;
  query?: string;
  options?: MagpieOptions;
  state: Record<string, unknown>;
  signal?: AbortSignal;
  report?: (code: string, bytes: number) => void;
  request?: Record<string, unknown>;
  success?: boolean;
}
export interface MagpieTool {
  description: string;
  args: Record<string, unknown>;
  execute(
    args: Record<string, unknown>,
    context: { abort?: AbortSignal; agent?: string },
  ): Promise<string>;
}
