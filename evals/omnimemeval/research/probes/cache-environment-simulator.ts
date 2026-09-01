/**
 * Offline prefix-cache environment simulator for hashed HTTP request traces.
 * Prompt text is consumed only while producing fixed-byte prefix checkpoints.
 */
import { createHash } from "node:crypto";

export const DEFAULT_PREFIX_BLOCK_BYTES = 512;

export type PrefixCheckpoint = {
  length: number;
  hash: string;
};

export type PromptTraceRequest = {
  id: string;
  arrivalMs: number;
  totalBytes: number;
  requestHash: string;
  checkpoints: PrefixCheckpoint[];
  outputTokens?: number;
};

export type CacheEnvironment = {
  concurrency: number;
  networkRttMs: number;
  networkJitterMs: number;
  cacheLookupMs: number;
  cacheBuildMs: number;
  cacheTtlMs: number;
  prefillMsPerKb: number;
  decodeMsPerToken: number;
};

export const DEFAULT_CACHE_ENVIRONMENTS: Record<string, CacheEnvironment> = {
  local: {
    concurrency: 8,
    networkRttMs: 5,
    networkJitterMs: 1,
    cacheLookupMs: 1,
    cacheBuildMs: 50,
    cacheTtlMs: 300_000,
    prefillMsPerKb: 1,
    decodeMsPerToken: 1,
  },
  "normal-cloud": {
    concurrency: 8,
    networkRttMs: 80,
    networkJitterMs: 20,
    cacheLookupMs: 3,
    cacheBuildMs: 500,
    cacheTtlMs: 300_000,
    prefillMsPerKb: 4,
    decodeMsPerToken: 2,
  },
  "slow-cache": {
    concurrency: 8,
    networkRttMs: 120,
    networkJitterMs: 40,
    cacheLookupMs: 5,
    cacheBuildMs: 2_000,
    cacheTtlMs: 300_000,
    prefillMsPerKb: 8,
    decodeMsPerToken: 3,
  },
};

type CacheEntry = {
  readyAtMs: number;
  expiresAtMs: number;
};

export type CacheSimulationReport = {
  environment: CacheEnvironment;
  requests: number;
  promptBytes: number;
  reusablePrefixBytes: number;
  estimatedHitRate: number;
  hitRequests: number;
  coldWaveMisses: number;
  latencyMs: { mean: number; p50: number; p95: number };
  requestResults: Array<{
    id: string;
    requestHash: string;
    promptBytes: number;
    reusablePrefixBytes: number;
    queueWaitMs: number;
    latencyMs: number;
  }>;
};

function validateBlockBytes(blockBytes: number): void {
  if (!Number.isSafeInteger(blockBytes) || blockBytes < 1) {
    throw new Error("prefix block size must be a positive safe integer");
  }
}

/**
 * Build cumulative chained hashes at fixed byte boundaries. The last partial
 * block is an exact whole-request hash; shared-prefix estimates compare only
 * checkpoints with identical cumulative lengths.
 */
export function buildPrefixCheckpoints(
  body: string | Buffer,
  blockBytes = DEFAULT_PREFIX_BLOCK_BYTES,
): Pick<PromptTraceRequest, "totalBytes" | "requestHash" | "checkpoints"> {
  validateBlockBytes(blockBytes);
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const checkpoints: PrefixCheckpoint[] = [];
  let previousHash = createHash("sha256").update("nmg-prefix-trace-v1").digest("hex");

  for (let offset = 0; offset < bytes.length; offset += blockBytes) {
    const end = Math.min(bytes.length, offset + blockBytes);
    const block = bytes.subarray(offset, end);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(end));
    previousHash = createHash("sha256")
      .update(previousHash, "hex")
      .update(length)
      .update(block)
      .digest("hex");
    checkpoints.push({ length: end, hash: previousHash });
  }

  return {
    totalBytes: bytes.length,
    requestHash: previousHash,
    checkpoints,
  };
}

function cacheKey(checkpoint: PrefixCheckpoint): string {
  return `${checkpoint.length}:${checkpoint.hash}`;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.round((ordered.length - 1) * fraction))]!;
}

function deterministicJitter(id: string, rangeMs: number): number {
  if (rangeMs <= 0) return 0;
  const value = createHash("sha256").update(id).digest().readUInt32BE(0) / 0xffffffff;
  return (value * 2 - 1) * rangeMs;
}

function validateEnvironment(environment: CacheEnvironment): void {
  if (!Number.isInteger(environment.concurrency) || environment.concurrency < 1) {
    throw new Error("cache environment concurrency must be a positive integer");
  }
  for (const [key, value] of Object.entries(environment)) {
    if (key === "concurrency") continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`cache environment ${key} must be a non-negative finite number`);
    }
  }
}

function longestCachedPrefix(
  checkpoints: readonly PrefixCheckpoint[],
  cache: ReadonlyMap<string, CacheEntry>,
  atMs: number,
): { readyBytes: number; buildingBytes: number } {
  let readyBytes = 0;
  let buildingBytes = 0;
  for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
    const checkpoint = checkpoints[index]!;
    const entry = cache.get(cacheKey(checkpoint));
    if (!entry || entry.expiresAtMs <= atMs) continue;
    if (entry.readyAtMs <= atMs) {
      readyBytes = checkpoint.length;
      break;
    }
    buildingBytes = Math.max(buildingBytes, checkpoint.length);
  }
  return { readyBytes, buildingBytes };
}

export function simulateCacheEnvironment(
  requests: readonly PromptTraceRequest[],
  environment: CacheEnvironment,
): CacheSimulationReport {
  validateEnvironment(environment);
  const cache = new Map<string, CacheEntry>();
  const workerAvailableAt = Array.from({ length: environment.concurrency }, () => 0);
  const requestResults: CacheSimulationReport["requestResults"] = [];
  let coldWaveMisses = 0;

  for (const request of [...requests].sort((left, right) => left.arrivalMs - right.arrivalMs)) {
    const networkMs = Math.max(
      0,
      environment.networkRttMs + deterministicJitter(request.id, environment.networkJitterMs),
    );
    const serverArrivalMs = request.arrivalMs + networkMs / 2;
    const workerIndex = workerAvailableAt.indexOf(Math.min(...workerAvailableAt));
    const serviceStartMs = Math.max(serverArrivalMs, workerAvailableAt[workerIndex]!);
    const queueWaitMs = serviceStartMs - serverArrivalMs;
    const prefix = longestCachedPrefix(request.checkpoints, cache, serviceStartMs);
    if (prefix.buildingBytes > prefix.readyBytes) coldWaveMisses += 1;

    const missingBytes = Math.max(0, request.totalBytes - prefix.readyBytes);
    const prefillMs = (missingBytes / 1024) * environment.prefillMsPerKb;
    const decodeMs = (request.outputTokens ?? 0) * environment.decodeMsPerToken;
    const serviceMs = environment.cacheLookupMs + prefillMs + decodeMs;
    const cacheReadyAtMs = serviceStartMs + environment.cacheLookupMs + prefillMs + environment.cacheBuildMs;
    const cacheEntry = {
      readyAtMs: cacheReadyAtMs,
      expiresAtMs: cacheReadyAtMs + environment.cacheTtlMs,
    };
    for (const checkpoint of request.checkpoints) {
      const key = cacheKey(checkpoint);
      const existing = cache.get(key);
      if (!existing || existing.expiresAtMs <= serviceStartMs) cache.set(key, cacheEntry);
    }

    workerAvailableAt[workerIndex] = serviceStartMs + serviceMs;
    requestResults.push({
      id: request.id,
      requestHash: request.requestHash,
      promptBytes: request.totalBytes,
      reusablePrefixBytes: prefix.readyBytes,
      queueWaitMs,
      latencyMs: queueWaitMs + networkMs + serviceMs,
    });
  }

  const promptBytes = requestResults.reduce((sum, result) => sum + result.promptBytes, 0);
  const reusablePrefixBytes = requestResults.reduce(
    (sum, result) => sum + result.reusablePrefixBytes,
    0,
  );
  const latencies = requestResults.map((result) => result.latencyMs);
  return {
    environment: { ...environment },
    requests: requestResults.length,
    promptBytes,
    reusablePrefixBytes,
    estimatedHitRate: promptBytes === 0 ? 0 : reusablePrefixBytes / promptBytes,
    hitRequests: requestResults.filter((result) => result.reusablePrefixBytes > 0).length,
    coldWaveMisses,
    latencyMs: {
      mean:
        latencies.length === 0
          ? 0
          : latencies.reduce((sum, value) => sum + value, 0) / latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
    },
    requestResults,
  };
}
