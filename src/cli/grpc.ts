import {
  ChannelCredentials,
  Client,
  Metadata,
  Server,
  ServerCredentials,
  loadPackageDefinition,
  status,
  type handleUnaryCall,
  type ServiceDefinition,
} from "@grpc/grpc-js";
import { loadSync } from "@grpc/proto-loader";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import type { ServerLease, ServerState } from "./lifecycle.ts";
import type { NmgMethod } from "./protocol.ts";
import { NmgProtocolError } from "./protocol.ts";
import { NmgService } from "./service.ts";

const PROTO_PATH = resolve(import.meta.dirname, "../../proto/nmg/v1/memory.proto");
const AUTHORIZATION = "authorization";

interface StructValue {
  nullValue?: 0;
  numberValue?: number;
  stringValue?: string;
  boolValue?: boolean;
  structValue?: StructMessage;
  listValue?: { values: StructValue[] };
}

interface StructMessage {
  fields: Record<string, StructValue>;
}

interface ValueResponse {
  value: StructMessage;
}

interface MemoryServicePackage {
  service: ServiceDefinition;
  new (
    address: string,
    credentials: ChannelCredentials,
  ): Client & Record<string, UnaryClientMethod>;
}

type UnaryClientMethod = (
  request: Record<string, unknown>,
  metadata: Metadata,
  callback: (error: Error | null, response?: ValueResponse) => void,
) => void;

const MemoryService = loadMemoryService();

export async function serveGrpc(service: NmgService, lease: ServerLease): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const server = new Server();
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((resolveStop) => {
    resolveStopped = resolveStop;
  });

  const implementation = Object.fromEntries(
    (
      [
        "hello",
        "status",
        "remember",
        "search",
        "get",
        "retentionCandidates",
        "setStorageState",
        "deleteMemory",
        "mergeNodes",
        "splitNode",
        "shutdown",
      ] as const
    ).map((method) => [
      method,
      unaryHandler(service, token, method, () => {
        setImmediate(() => server.tryShutdown(resolveStopped));
      }),
    ]),
  );
  server.addService(MemoryService.service, implementation);
  const port = await bind(server);
  lease.update({ transport: "grpc", host: "127.0.0.1", port, token });
  await stopped;
}

export async function callGrpc(
  state: ServerState,
  method: NmgMethod,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const client = new NmgGrpcClient(state);
  try {
    return await client.invoke(method, params);
  } finally {
    client.close();
  }
}

export class NmgGrpcClient {
  readonly #client: Client & Record<string, UnaryClientMethod>;
  readonly #metadata: Metadata;

  constructor(state: ServerState) {
    if (state.transport !== "grpc" || !state.host || !state.port || !state.token) {
      throw new Error("NMG daemon state does not contain a gRPC endpoint");
    }
    this.#client = new MemoryService(
      `${state.host}:${state.port}`,
      ChannelCredentials.createInsecure(),
    );
    this.#metadata = new Metadata();
    this.#metadata.set(AUTHORIZATION, `Bearer ${state.token}`);
  }

  async invoke(method: NmgMethod, params: Record<string, unknown> = {}): Promise<unknown> {
    const response = await new Promise<ValueResponse>((resolveResponse, reject) => {
      const call = this.#client[method];
      if (typeof call !== "function") {
        reject(new Error(`gRPC method is unavailable: ${method}`));
        return;
      }
      call.call(this.#client, params, this.#metadata, (error, value) => {
        if (error) reject(error);
        else if (!value) reject(new Error(`gRPC method returned no response: ${method}`));
        else resolveResponse(value);
      });
    });
    return fromStruct(response.value);
  }

  close(): void {
    this.#client.close();
  }
}

function unaryHandler(
  service: NmgService,
  token: string,
  method: NmgMethod,
  afterResponse: () => void,
): handleUnaryCall<Record<string, unknown>, ValueResponse> {
  return async (call, callback) => {
    if (call.metadata.get(AUTHORIZATION)[0] !== `Bearer ${token}`) {
      callback({
        name: "Unauthenticated",
        message: "invalid NMG daemon token",
        code: status.UNAUTHENTICATED,
      });
      return;
    }
    try {
      const result = await service.invoke(method, call.request);
      callback(null, { value: toStruct(result) });
      if (method === "shutdown") afterResponse();
    } catch (error) {
      callback({
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof NmgProtocolError ? status.INVALID_ARGUMENT : status.INTERNAL,
      });
    }
  };
}

function bind(server: Server): Promise<number> {
  return new Promise((resolvePort, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) => {
      if (error) reject(error);
      else resolvePort(port);
    });
  });
}

function loadMemoryService(): MemoryServicePackage {
  const definition = loadSync(PROTO_PATH, {
    defaults: false,
    enums: String,
    keepCase: false,
    longs: Number,
    oneofs: true,
  });
  const loaded = loadPackageDefinition(definition) as unknown as {
    nmg: { v1: { MemoryService: MemoryServicePackage } };
  };
  return loaded.nmg.v1.MemoryService;
}

function toStruct(value: unknown): StructMessage {
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : { value };
  return {
    fields: Object.fromEntries(
      Object.entries(object)
        .filter((entry) => entry[1] !== undefined)
        .map(([key, field]) => [key, toStructValue(field)]),
    ),
  };
}

function toStructValue(value: unknown): StructValue {
  if (value === null) return { nullValue: 0 };
  if (typeof value === "number") return { numberValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Array.isArray(value)) return { listValue: { values: value.map(toStructValue) } };
  if (typeof value === "object") return { structValue: toStruct(value) };
  return { stringValue: String(value) };
}

function fromStruct(struct: StructMessage): unknown {
  return Object.fromEntries(
    Object.entries(struct.fields ?? {}).map(([key, value]) => [key, fromStructValue(value)]),
  );
}

function fromStructValue(value: StructValue): unknown {
  if ("nullValue" in value) return null;
  if ("numberValue" in value) return value.numberValue;
  if ("stringValue" in value) return value.stringValue;
  if ("boolValue" in value) return value.boolValue;
  if (value.structValue) return fromStruct(value.structValue);
  if (value.listValue) return (value.listValue.values ?? []).map(fromStructValue);
  return null;
}
