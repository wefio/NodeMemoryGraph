import { createHash, randomUUID } from "node:crypto";
import { createEmbeddingClientFromEnv, type EmbeddingClient } from "../core/embedding-provider.ts";
import {
  OperatorStore,
  managedEmbeddingEnvironment,
  publicEmbedding,
  type ManagedEmbedding,
  type OperatorSettings,
} from "./operator-store.ts";
import type { PortableMemoryService } from "./portable-memory.ts";

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Operator parameters must be an object");
  return value as Record<string, unknown>;
}

function embeddingConfig(value: unknown): ManagedEmbedding {
  const input = object(value);
  if (!["openai", "gemini", "jina", "cloudflare"].includes(String(input.provider)))
    throw new Error("Unknown embedding provider");
  if (typeof input.model !== "string" || !input.model.trim())
    throw new Error("Embedding model is required");
  const result: ManagedEmbedding = { provider: String(input.provider), model: input.model.trim() };
  for (const field of ["baseUrl", "apiKey", "profile"] as const) {
    if (input[field] !== undefined && typeof input[field] !== "string")
      throw new Error(`Invalid ${field}`);
    if (input[field]) result[field] = String(input[field]);
  }
  if (result.baseUrl) result.baseUrl = embeddingEndpoint(result.baseUrl);
  if (result.profile && !["qwen3", "bge-en", "plain"].includes(result.profile))
    throw new Error("Invalid embedding profile");
  if (input.dimensions !== undefined) {
    if (
      !Number.isInteger(input.dimensions) ||
      Number(input.dimensions) < 1 ||
      Number(input.dimensions) > 65536
    )
      throw new Error("Invalid embedding dimensions");
    result.dimensions = Number(input.dimensions);
  }
  return result;
}

function embeddingEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("Invalid embedding endpoint");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["https:", "http:"].includes(url.protocol)
  )
    throw new Error("Invalid embedding endpoint");
  return url.href.replace(/\/$/, "");
}

function configuredClient(config: ManagedEmbedding, base: NodeJS.ProcessEnv): EmbeddingClient {
  const environment = managedEmbeddingEnvironment(base, {
    revision: 0,
    active: config,
    useManaged: true,
  });
  const client = createEmbeddingClientFromEnv(environment, { required: true })!;
  const endpoint = createHash("sha256")
    .update(JSON.stringify([config.provider, config.baseUrl ?? "default"]))
    .digest("hex")
    .slice(0, 24);
  return {
    indexId: `${client.indexId}:managed-${endpoint}`,
    model: client.model,
    profile: client.profile,
    batchSize: client.batchSize,
    embed: client.embed.bind(client),
    embedQueries: client.embedQueries.bind(client),
    embedDocuments: client.embedDocuments.bind(client),
  };
}

type CandidateJob = {
  id: string;
  revision: number;
  indexId: string;
  state: "running" | "ready" | "failed" | "cancelled";
  error?: string;
};

/** Operator calls are exposed to the authenticated management page, outside model tools. */
export class NmgOperator {
  private readonly store: OperatorStore;
  private readonly memory: PortableMemoryService;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly activated: () => void;
  private settings: OperatorSettings;
  private job?: CandidateJob;
  private pending?: Promise<void>;
  private cancel?: AbortController;
  private snapshotCache?: { at: number; result: unknown };

  constructor(
    path: string,
    memory: PortableMemoryService,
    environment: NodeJS.ProcessEnv,
    activated: () => void,
  ) {
    this.store = new OperatorStore(path);
    this.settings = this.store.read();
    this.memory = memory;
    this.environment = environment;
    this.activated = activated;
  }

  effectiveEnvironment(): NodeJS.ProcessEnv {
    return managedEmbeddingEnvironment(this.environment, this.settings);
  }

  client(): EmbeddingClient | undefined {
    return this.settings.useManaged && this.settings.active
      ? configuredClient(this.settings.active, this.environment)
      : undefined;
  }

  record(params: unknown, result?: unknown, failed = false): void {
    const input = object(params);
    if (input.persistTrace === false) return;
    const context = result as { results?: unknown[] } | undefined;
    this.store.record(
      input.autoRecall === true ? "automaticRecall" : "search",
      failed ? "failure" : context?.results?.length ? "success" : "empty",
    );
  }

  async invoke(value: unknown): Promise<Record<string, unknown>> {
    const input = object(value);
    if (input.action === "snapshot") return this.snapshot();
    if (!this.memory.local)
      throw new Error("Managed embedding configuration requires a local memory backend");
    if (input.revision !== this.settings.revision)
      throw new Error("Operator configuration revision conflict");
    switch (input.action) {
      case "saveCandidate":
        return this.saveCandidate(input);
      case "testCandidate":
        return this.testCandidate();
      case "buildCandidate":
        return this.buildCandidate();
      case "activateCandidate":
        return this.activateCandidate(input);
      case "cancelCandidate": {
        this.cancel?.abort();
        this.settings = this.store.write(this.settings.revision, {
          ...this.settings,
          candidate: undefined,
        });
        return this.configuration();
      }
      default:
        throw new Error("Unknown NMG operator action");
    }
  }

  private configuration(): Record<string, unknown> {
    return {
      revision: this.settings.revision,
      source: this.settings.useManaged ? "managed" : "environment",
      active: publicEmbedding(this.settings.active),
      candidate: publicEmbedding(this.settings.candidate),
      job: this.job ?? null,
    };
  }

  private async snapshot(): Promise<Record<string, unknown>> {
    if (!this.snapshotCache || Date.now() - this.snapshotCache.at > 2000) {
      const result = await this.memory.counts();
      this.snapshotCache = { at: Date.now(), result };
    }
    return {
      measuredAt: new Date(this.snapshotCache.at).toISOString(),
      counts: this.snapshotCache.result,
      configuration: this.configuration(),
      activity: this.store.activity(),
      activityScope: "service search attempts; UTC days; 30-day retention",
      tokenUsage: null,
      injectionCount: null,
    };
  }

  private saveCandidate(input: Record<string, unknown>): Record<string, unknown> {
    if (this.job?.state === "running")
      throw new Error("Cancel the running candidate build before changing configuration");
    const candidate = embeddingConfig(input.config);
    const previous = this.settings.candidate ?? this.settings.active;
    if (
      !candidate.apiKey &&
      previous?.provider === candidate.provider &&
      previous.baseUrl === candidate.baseUrl
    )
      candidate.apiKey = previous.apiKey;
    configuredClient(candidate, this.environment);
    this.settings = this.store.write(this.settings.revision, { ...this.settings, candidate });
    this.job = undefined;
    return this.configuration();
  }

  private candidate(): EmbeddingClient {
    if (!this.settings.candidate) throw new Error("Save a candidate embedding configuration first");
    return configuredClient(this.settings.candidate, this.environment);
  }

  private async testCandidate(): Promise<Record<string, unknown>> {
    try {
      const client = this.candidate();
      const dimensions = await checkConnection(client);
      return { ok: true, dimensions, indexId: client.indexId };
    } catch {
      throw new Error("Embedding connection test failed");
    }
  }

  private buildCandidate(): Record<string, unknown> {
    if (this.job?.state === "running") return this.configuration();
    const client = this.candidate();
    const controller = new AbortController();
    const job: CandidateJob = {
      id: randomUUID(),
      revision: this.settings.revision,
      indexId: client.indexId,
      state: "running",
    };
    this.job = job;
    this.cancel = controller;
    this.pending = checkConnection(client, controller.signal)
      .then(() => this.memory.prepareEmbeddingIndex(client, controller.signal))
      .then(
        () => {
          job.state = controller.signal.aborted ? "cancelled" : "ready";
        },
        () => {
          job.state = controller.signal.aborted ? "cancelled" : "failed";
          job.error = "Candidate index build did not complete";
        },
      );
    return this.configuration();
  }

  private activateCandidate(input: Record<string, unknown>): Record<string, unknown> {
    const client = this.candidate();
    if (
      this.job?.state !== "ready" ||
      this.job.revision !== this.settings.revision ||
      this.memory.embeddingHealth(client.indexId)?.pending?.records !== 0
    )
      throw new Error("Candidate index is not ready");
    if (!this.settings.useManaged && input.useManaged !== true)
      throw new Error("Explicit useManaged approval is required to select managed configuration");
    this.settings = this.store.write(this.settings.revision, {
      ...this.settings,
      active: this.settings.candidate,
      candidate: undefined,
      useManaged: true,
    });
    this.activated();
    return this.configuration();
  }

  close(): Promise<void> | undefined {
    this.store.close();
    this.cancel?.abort();
    return this.pending;
  }
}

async function checkConnection(client: EmbeddingClient, signal?: AbortSignal): Promise<number> {
  const [vector] = await client.embedQueries(["NMG embedding connection test"], { signal });
  if (!vector?.length || !vector.every(Number.isFinite)) throw new Error("Invalid embedding");
  return vector.length;
}
