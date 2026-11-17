import { createHash } from "node:crypto";
import {
  normalizeAbsoluteEventTime,
  resolveEventTime,
  resolveWriteEventTime,
} from "../event-time.ts";
import { normalizeClaims } from "../claims.ts";
import { serializeScope } from "../scope.ts";
import { recallTriggerMarkers } from "../recall-triggers.ts";
import { assertTemporalValidity } from "../semantic-domain.ts";
import { normalizeMarkers } from "../memory-normalization.ts";
import { defaultResidence } from "../memory-residence.ts";
import { validateEvidenceSource } from "../memory-evidence.ts";
import { assessMemoryWrite, MemoryWriteRejected } from "../write-policy.ts";
import type {
  HistoryRecord,
  MemoryActor,
  MemoryNode,
  MemoryRecord,
  RememberInput,
} from "../types.ts";

export type MemoryInput = RememberInput & {
  unsafe?: boolean;
  importedEvidence?: Pick<
    HistoryRecord,
    "sessionId" | "sourceMessageId" | "role" | "sourceRef" | "content"
  >;
};

export function memoryResidence(input: MemoryInput) {
  return input.residence ?? defaultResidence({ ...input, truthStatus: memoryTruthStatus(input) });
}

function memoryTruthStatus(input: MemoryInput): MemoryRecord["truthStatus"] {
  return (
    input.truthStatus ??
    (input.markers?.some((marker) => marker.kind?.trim() === "external_source")
      ? "unverified"
      : "asserted")
  );
}

export function memoryIdentity(...parts: string[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function stateAliasId(key: string, scope: MemoryRecord["scope"]): string {
  return memoryIdentity(key, serializeScope(scope));
}

export function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined || (typeof value === "number" && !Number.isFinite(value)))
    throw new Error("Memory requests must contain finite JSON values");
  return encoded;
}

export function validateMemoryInput(input: MemoryInput): void {
  if (!input.statement.trim() || !input.nodeName.trim())
    throw new Error("Statement and node name are required");
  if (input.judgeDuplicates)
    throw new Error("Portable memory does not support duplicate callbacks");
  const assessment = assessMemoryWrite({
    ...input,
    bypass: input.unsafe,
  });
  if (!assessment.allowed) throw new MemoryWriteRejected(assessment.reason);
  validateMemoryStructure(input);
  validateEvidenceSource(input, memoryResidence(input));
  // Resolve date phrases before the timestamp guard, so "上周三" and "2026年11月6日"
  // are accepted as the instants they name while genuine garbage is still refused.
  assertTemporalValidity({
    eventTime: resolveWriteEventTime(input.eventTime, input),
    validFrom: resolveEventTime(input.validFrom),
    validUntil: resolveEventTime(input.validUntil),
  });
}

function validateMemoryStructure(input: MemoryInput): void {
  if (input.memoryType === "state" && !input.stateKey?.trim())
    throw new Error("State memories require stateKey");
  if (input.residence === "stg" && !input.sessionId?.trim())
    throw new Error("Provisional memories require sessionId");
  if (input.resolution && input.resolution !== "resolved" && !input.relatedMemoryIds?.length)
    throw new Error("Open memories require relatedMemoryIds");
  if (input.expiresAt && !Number.isFinite(Date.parse(input.expiresAt)))
    throw new Error("Invalid expiry timestamp");
}

export function visibleMemory(
  memory: MemoryRecord,
  sessionId: string | undefined,
  now: string,
): boolean {
  return (
    memory.status === "active" &&
    !memory.markers.some((marker) => marker.kind === "forget") &&
    (!memory.sessionId || memory.sessionId === sessionId) &&
    (!memory.expiresAt || Date.parse(memory.expiresAt) > Date.parse(now)) &&
    (!memory.validFrom || Date.parse(memory.validFrom) <= Date.parse(now)) &&
    (!memory.validUntil || Date.parse(memory.validUntil) > Date.parse(now))
  );
}

export function searchableMemory(
  memory: MemoryRecord,
  options: { sessionId?: string; includeHistorical?: boolean; sourceActor?: MemoryActor },
  now: string,
  includeRetained = false,
): boolean {
  if (memory.storageState && !includeRetained) return false;
  if (options.sourceActor && memory.sourceActor !== options.sourceActor) return false;
  if (!options.includeHistorical) return visibleMemory(memory, options.sessionId, now);
  return (
    memory.status !== "deleted" &&
    !memory.markers.some((marker) => marker.kind === "forget") &&
    (!memory.sessionId || memory.sessionId === options.sessionId) &&
    (!memory.expiresAt || Date.parse(memory.expiresAt) > Date.parse(now))
  );
}

export function newHistory(input: MemoryInput, id: string, now: string): HistoryRecord {
  if (input.importedEvidence) return { id, createdAt: now, ...input.importedEvidence };
  return {
    id,
    sessionId: memoryResidence(input) === "stg" ? (input.sessionId ?? null) : null,
    sourceMessageId: input.evidenceSource?.sourceMessageId.trim() || null,
    role: input.evidenceSource?.actor ?? "explicit",
    content: (input.evidenceSource?.content ?? input.evidence ?? input.statement).trim(),
    sourceRef: input.evidenceSource?.sourceRef ?? input.sourceRef ?? null,
    createdAt: now,
  };
}

export function newNode(input: MemoryInput, id: string, now: string): MemoryNode {
  return {
    id,
    canonicalName: input.nodeName.trim(),
    summary: input.nodeSummary ?? input.nodeName.trim(),
    kind: input.nodeKind ?? "topic",
    createdAt: now,
    updatedAt: now,
    status: "active",
    residence: memoryResidence(input),
  };
}

/** Actual ingestion time; also the event-time fallback for live writes. */
function writeClock(now: string): Date {
  const clock = new Date(now);
  return Number.isFinite(clock.getTime()) ? clock : new Date();
}

export function newMemory(
  input: MemoryInput,
  id: string,
  nodeId: string,
  historyId: string,
  now: string,
): MemoryRecord {
  const markers = normalizeMarkers([
    ...(input.markers ?? []),
    ...recallTriggerMarkers(input.recallTriggers),
    ...(input.unsafe ? [{ kind: "write_bypass", attributes: { policy: "unsafe" } }] : []),
  ]);
  // One canonical shape on the way in: `event_time` is compared as TEXT by the
  // candidate SQL, so every writer lands in the same form. A source clock,
  // when supplied, anchors event phrases independently of ingestion time.
  // Resolution happens once here, preventing reading-clock drift. An unparseable phrase keeps the
  // agent's words for evidence, but never reaches `valid_from`.
  const resolved = resolveWriteEventTime(input.eventTime, input, writeClock(now));
  const timed = { ...input, eventTime: resolved ?? undefined };
  const orderable = { ...input, eventTime: normalizeAbsoluteEventTime(resolved) ?? undefined };
  return {
    id,
    nodeId,
    evidenceId: historyId,
    evidenceIds: [historyId],
    statement: input.statement.trim(),
    ...semanticFields(timed),
    ...claimFields(input),
    ...timeFields(orderable, now),
    ...residenceFields(input, now),
    truthStatus: memoryTruthStatus(input),
    markers,
    scope: input.scope ?? {},
    status: "active",
    evidenceRole: input.evidenceRole ?? "support",
    supersedesId: input.supersedesId ?? null,
    tier: input.tier ?? 1,
    importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
    accessCount: 0,
    lastAccessedAt: null,
    writeReason: input.writeReason ?? "confirmed_memory",
    writeSource: input.writeSource ?? "agent",
    createdAt: now,
  };
}

function semanticFields(
  input: MemoryInput,
): Pick<
  MemoryRecord,
  "memoryType" | "stateKey" | "eventTime" | "sourceActor" | "resolution" | "relatedMemoryIds"
> {
  return {
    memoryType: input.memoryType ?? "fact",
    stateKey: input.stateKey ?? null,
    eventTime: input.eventTime ?? null,
    sourceActor: input.sourceActor ?? "user",
    resolution: input.resolution ?? "resolved",
    relatedMemoryIds: input.relatedMemoryIds ?? [],
  };
}

function claimFields(
  input: MemoryInput,
): Pick<MemoryRecord, "confidence" | "polarity" | "predicateKey" | "extractMethod" | "claims"> {
  const normalized = normalizeClaims(input.claims);
  if (normalized) return normalized;
  return {
    confidence: input.confidence ?? null,
    polarity: input.polarity ?? null,
    predicateKey: input.predicateKey ?? null,
    extractMethod: input.extractMethod ?? null,
    claims: null,
  };
}

function timeFields(
  input: MemoryInput,
  now: string,
): Pick<MemoryRecord, "validFrom" | "validUntil" | "openedAt" | "expiresAt"> {
  return {
    validFrom: input.validFrom ?? input.eventTime ?? now,
    validUntil: input.validUntil ?? null,
    openedAt: !input.resolution || input.resolution === "resolved" ? null : (input.openedAt ?? now),
    expiresAt: input.expiresAt ?? null,
  };
}

function residenceFields(
  input: MemoryInput,
  now: string,
): Pick<MemoryRecord, "residence" | "sessionId" | "promotedAt"> {
  const residence = memoryResidence(input);
  return {
    residence,
    sessionId: residence === "stg" ? (input.sessionId ?? null) : null,
    promotedAt: residence === "ltg" ? now : null,
  };
}
