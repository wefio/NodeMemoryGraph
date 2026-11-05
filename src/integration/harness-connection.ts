import { NMG_PROTOCOL_VERSION } from "../cli/protocol.ts";
import type { NmgHelloResult, NmgMethod, NmgMethodResult } from "../cli/protocol.ts";

export type HarnessMemoryMethod = "remember" | "rememberBatch" | "search" | "get" | "deleteMemory";
export interface HarnessEndpoint {
  readonly location: "local" | "cloud";
  /** The host supplies authentication and propagates this signal through its transport. */
  call(method: NmgMethod, params: unknown, options: { signal?: AbortSignal }): Promise<unknown>;
}

export interface HarnessSessionIdentity {
  /** Trusted host identity, not a model-authored tool parameter. */
  sessionId: string;
  generation: string;
}

/** Shared endpoint/capability/session boundary; the Harness still owns execution and checkpoints. */
export class HarnessConnection {
  private readonly endpoint: HarnessEndpoint;
  private readonly identity: HarnessSessionIdentity;
  private readonly sessionId: string;
  private readonly methods: ReadonlySet<string>;
  private readonly capabilities: ReadonlySet<string>;
  private closed = false;

  private constructor(
    endpoint: HarnessEndpoint,
    identity: HarnessSessionIdentity,
    hello: NmgHelloResult,
  ) {
    this.endpoint = endpoint;
    this.identity = { ...identity };
    this.sessionId = JSON.stringify([identity.sessionId, identity.generation]);
    this.methods = new Set(hello.methods ?? []);
    this.capabilities = new Set(hello.capabilities);
  }

  static async open(
    endpoint: HarnessEndpoint,
    identity: HarnessSessionIdentity,
    signal?: AbortSignal,
  ): Promise<HarnessConnection> {
    if (!identity.sessionId.trim() || !identity.generation.trim())
      throw new Error("Harness session and generation are required");
    signal?.throwIfAborted();
    const hello = (await endpoint.call("hello", {}, { signal })) as NmgHelloResult;
    if (
      hello.service !== "node-memory-graph" ||
      hello.protocol !== NMG_PROTOCOL_VERSION ||
      !Array.isArray(hello.capabilities)
    )
      throw new Error("Invalid NMG endpoint handshake");
    signal?.throwIfAborted();
    return new HarnessConnection(endpoint, identity, hello);
  }

  async memory<M extends HarnessMemoryMethod>(
    method: M,
    params: Record<string, unknown>,
    invocation?: { id: string; slot: string },
    signal?: AbortSignal,
  ): Promise<NmgMethodResult[M]> {
    this.requireMethod(method, signal);
    if (!["remember", "rememberBatch", "search", "get", "deleteMemory"].includes(method))
      throw new Error("Not a memory operation");
    const bound = { ...params, sessionId: this.sessionId };
    if (method === "remember" || method === "rememberBatch" || method === "deleteMemory") {
      if (!invocation?.id.trim() || !invocation.slot.trim())
        throw new Error("Memory writes require a persisted invocation identity");
      if (!this.capabilities.has("portable-memory"))
        throw new Error("Endpoint does not support durable write replay");
      Object.assign(bound, {
        operationId: JSON.stringify([
          this.identity.sessionId,
          this.identity.generation,
          invocation.id,
          invocation.slot,
        ]),
      });
      if (method === "rememberBatch") boundBatch(bound, this.sessionId);
    }
    const result = await this.endpoint.call(method, bound, { signal });
    this.requireOpen(signal);
    return result as NmgMethodResult[M];
  }

  async coordination(
    method: "taskBoard" | "taskRun",
    params: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requireMethod(method, signal);
    if (this.endpoint.location !== "local")
      throw new Error("NMG coordination requires a local endpoint");
    const result = await this.endpoint.call(method, params, { signal });
    this.requireOpen(signal);
    return result;
  }

  /** Closes this binding only. It never shuts down the shared service. */
  close(): void {
    this.closed = true;
  }

  private requireMethod(method: string, signal?: AbortSignal): void {
    this.requireOpen(signal);
    if (!this.methods.has(method)) throw new Error(`NMG endpoint does not support ${method}`);
  }

  private requireOpen(signal?: AbortSignal): void {
    signal?.throwIfAborted();
    if (this.closed) throw new Error("Harness binding is closed");
  }
}

function boundBatch(params: Record<string, unknown>, sessionId: string): void {
  if (!Array.isArray(params.items)) throw new Error("Memory batch items are required");
  params.items = params.items.map((item: Record<string, unknown>) => ({ ...item, sessionId }));
}
