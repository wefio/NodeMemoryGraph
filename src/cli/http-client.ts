import type { ServerState } from "./lifecycle.ts";
import type { NmgMethod } from "./protocol.ts";

/**
 * The JSON-RPC-over-HTTP client surface (Node built-in fetch, no deps).
 *
 * This module must stay free of the server implementation (`service.ts` ->
 * the core store) so the Pi extension loads only the thin client and never
 * drags the core dependency tree into the Pi process. See
 * tests/cli/http-boundary.test.ts.
 */
export async function httpCall(
  state: ServerState,
  method: NmgMethod,
  params: unknown = {},
): Promise<unknown> {
  if (state.transport !== "http" || !state.host || !state.port || !state.token) {
    throw new Error("NMG daemon state does not contain an HTTP endpoint");
  }
  const response = await fetch(`http://${state.host}:${state.port}/`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.token}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(text || `nmg ${method} failed (${response.status})`);
  }
  const parsed = JSON.parse(text) as {
    result?: unknown;
    error?: { code?: number; message?: string };
  };
  if (parsed.error) {
    throw new Error(parsed.error.message ?? `nmg ${method} error`);
  }
  return parsed.result;
}
