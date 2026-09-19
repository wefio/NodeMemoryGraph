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
export interface HttpCallOptions {
  /**
   * How long to wait for an answer before giving up.
   *
   * Omitted by default, which leaves the platform's own behaviour (undici's ~300s headers timeout)
   * in place: this is an opt-in bound, not a change of the product's default. A caller that can be
   * held up by a process it does not control - a harness whose host may be blocked, or a client
   * whose agent must not sit for five minutes - passes one, and gets a failure that names the bound
   * instead of the transport's.
   */
  timeoutMs?: number;
}

export async function httpCall(
  state: ServerState,
  method: NmgMethod,
  params: unknown = {},
  options: HttpCallOptions = {},
): Promise<unknown> {
  if (state.transport !== "http" || !state.host || !state.port || !state.token) {
    throw new Error("NMG daemon state does not contain an HTTP endpoint");
  }
  let response: Response;
  try {
    response = await fetch(`http://${state.host}:${state.port}/`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
      ...(options.timeoutMs === undefined
        ? {}
        : { signal: AbortSignal.timeout(options.timeoutMs) }),
    });
  } catch (error) {
    // A bound that fired is a fact about this call, not a transport quirk to report as one: name it
    // here so the caller's message can say what the wait was for.
    if (options.timeoutMs !== undefined && isTimeout(error)) {
      throw new TimeoutError(`nmg ${method} did not answer within ${options.timeoutMs}ms`);
    }
    throw error;
  }
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

/** A call that was given a bound and reached it. Distinct from a transport failure on purpose. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

function isTimeout(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return true;
  const cause = (error as { cause?: { name?: unknown } } | null)?.cause;
  return cause?.name === "TimeoutError" || cause?.name === "HeadersTimeoutError";
}
