import { serializeScope } from "../core/scope.ts";
import type { MemoryRecord, MemorySearchResult } from "../core/types.ts";

export const SOURCE_EXCERPT_CHARS = 320;

export function displayExcerpt(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function uniformEvidenceScope(results: readonly MemorySearchResult[]): string | undefined {
  const first = results[0];
  if (!first || results.length < 2) return;
  const scope = serializeScope(first.memory.scope);
  if (scope !== "{}" && results.every((row) => serializeScope(row.memory.scope) === scope))
    return scope;
}

export function isDefaultMemoryType(type: string): boolean {
  return type === "fact" || type === "conversation_evidence";
}

/** Share the presentation fields with the budget estimate without copying the statement. */
export function evidenceRecordParts(
  {
    memory,
    node,
    evidence,
    evidenceRecords,
  }: Pick<MemorySearchResult, "memory" | "evidence"> &
    Partial<Pick<MemorySearchResult, "node" | "evidenceRecords">>,
  options: { chainLabel?: string; pageScope?: string; fullSources?: boolean } = {},
): { parts: string[]; withdrawn: boolean } {
  const external = memory.markers?.find((marker) => marker.kind === "external_source");
  const withdrawn = memory.markers?.some((marker) => marker.kind === "forget") ?? false;
  const flags = [
    options.chainLabel ? `[${options.chainLabel}]` : "",
    external ? `[external, ${memory.truthStatus}]` : "",
    memory.resolution === "open" || memory.resolution === "reopened" ? "[open]" : "",
  ].filter(Boolean);
  const statement = withdrawn ? "[forget] (content withdrawn)" : memory.statement;
  return {
    parts: [
      flags.length ? `- ${flags.join(" ")} ` : "- ",
      statement,
      "\n  ",
      evidenceDetails(memory, Boolean(external), options.pageScope, node?.canonicalName),
      externalSourceLine(external?.attributes),
      options.fullSources
        ? fullSourceLines(memory.statement, [evidence, ...(evidenceRecords ?? [])], withdrawn)
        : primarySourceLine(memory.statement, evidence.content, withdrawn),
    ],
    withdrawn,
  };
}

function evidenceDetails(
  memory: MemoryRecord,
  hasExternalSource: boolean,
  pageScope?: string,
  nodeName?: string,
): string {
  const scope = pageScope ? undefined : serializeScope(memory.scope);
  const type = memory.memoryType;
  const details = [`memory=${memory.id}`];
  if (nodeName) details.push(`node=${nodeName}`);
  if (!isDefaultMemoryType(type)) details.push(`type=${type}`);
  if (!hasExternalSource && memory.truthStatus !== "asserted")
    details.push(`truth=${memory.truthStatus}`);
  if (scope && scope !== "{}") details.push(`scope=${scope}`);
  if (memory.eventTime) details.push(`time=${memory.eventTime}`);
  return details.join("; ");
}

function externalSourceLine(attributes?: Record<string, unknown>): string {
  if (!attributes?.source) return "";
  return `\n  EXTERNAL_SOURCE=${String(attributes.source)}; retrievedAt=${String(attributes.retrievedAt ?? "unknown")}`;
}

function primarySourceLine(statement: string, content: string, withdrawn: boolean): string {
  if (withdrawn || content.trim() === statement.trim()) return "";
  return `\n  SOURCE=${displayExcerpt(content, SOURCE_EXCERPT_CHARS)}`;
}

function fullSourceLines(
  statement: string,
  sources: readonly MemorySearchResult["evidence"][],
  withdrawn: boolean,
): string {
  if (withdrawn) return "";
  const seen = new Set(["", statement.trim()]);
  const unique: string[] = [];
  for (const { content } of sources) {
    const key = content.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(`\n  SOURCE=${content}`);
  }
  return unique.join("");
}
