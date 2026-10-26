import { createHash } from "node:crypto";

import type {
  InformationOutputEntry,
  InformationOutputReceipt,
  InformationPurpose,
  InformationSource,
  InformationView,
  PreparedInformationOutput,
} from "../core/information-view.ts";

import {
  DEFAULT_CONTEXT_OUTPUT_CHARACTERS,
  DEFAULT_INFORMATION_OUTPUT_CHARACTERS,
} from "../core/information-view.ts";

export interface InformationOutputOptions {
  maxCharacters?: number;
  /** Plain tool output is compatible; context output shares one grouped budget. */
  format?: "flat" | "context";
}

interface OutputRow {
  view: InformationView;
  text: string;
  fingerprint?: string;
  notice?: boolean;
}

const PURPOSE_ENVELOPES: Record<InformationPurpose, readonly [string, string]> = {
  state: ["<nmg_state>", "</nmg_state>"],
  material: ["<nmg_material>", "</nmg_material>"],
  reasoning: ["<nmg_reasoning>", "</nmg_reasoning>"],
  guidance: ["<nmg_guidance>", "</nmg_guidance>"],
  diagnostic: ["<nmg_diagnostics>", "</nmg_diagnostics>"],
};

const SELECTION_PRIORITY: Record<InformationPurpose, number> = {
  state: 0,
  reasoning: 1,
  diagnostic: 2,
  material: 3,
  guidance: 4,
};

/** Pure preparation: no storage, host API, disclosure write or tool execution.
 * Bodies/required labels are indivisible; omissions are explicit, not previews.
 */
export function prepareInformationOutput(
  views: readonly InformationView[],
  options: InformationOutputOptions = {},
): PreparedInformationOutput {
  const format = options.format ?? "flat";
  if (format !== "flat" && format !== "context") throw new RangeError("Unsupported output format");
  const defaultBudget =
    format === "context"
      ? DEFAULT_CONTEXT_OUTPUT_CHARACTERS
      : DEFAULT_INFORMATION_OUTPUT_CHARACTERS;
  const maxCharacters = options.maxCharacters ?? defaultBudget;
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 0) {
    throw new RangeError("Information output budget must be a nonnegative safe integer");
  }
  const snapshot = Object.freeze(views.map(copyView));
  const ordered =
    format === "context"
      ? [...snapshot].sort(
          (a, b) => SELECTION_PRIORITY[purposeOf(a)] - SELECTION_PRIORITY[purposeOf(b)],
        )
      : snapshot;
  const rows: OutputRow[] = [];
  const omitted: InformationView[] = [];
  const seen = new Set<string>();
  const size = new OutputSize(format);
  for (const view of ordered) {
    const row = prepareRow(view, seen);
    if (!row) continue;
    size.update(row, 1);
    if (size.length > maxCharacters) {
      size.update(row, -1);
      omitted.push(view);
    } else rows.push(row);
  }
  appendOmissionNotice(rows, omitted, maxCharacters, format, size);
  return Object.freeze({
    text: renderRows(rows, format),
    views: snapshot,
    included: Object.freeze(rows.flatMap(outputEntry)),
    omitted: Object.freeze(omitted),
  });
}

/** A host reports the exact prepared fragment, not arbitrary surrounding text.
 * Clipping/rewriting has no verifiable source association and confirms nothing.
 * This receipt is not authentication, acceptance, or a disclosure-ledger write.
 */
export function confirmInformationOutput(
  output: PreparedInformationOutput,
  confirmation: { sessionId: string; text: string },
): InformationOutputReceipt {
  const matches = confirmation.sessionId.trim().length > 0 && confirmation.text === output.text;
  const entries = matches
    ? output.included.filter(
        (entry) =>
          (entry.source.kind !== "ag" && entry.source.kind !== "workspace") ||
          entry.source.sessionId === confirmation.sessionId,
      )
    : [];
  return Object.freeze({
    sessionId: confirmation.sessionId,
    entries: Object.freeze(entries),
  });
}

function purposeOf(view: InformationView): InformationPurpose {
  const purpose = view.purpose ?? "material";
  if (!Object.hasOwn(PURPOSE_ENVELOPES, purpose))
    throw new RangeError("Unsupported information purpose");
  return purpose;
}

function prepareRow(view: InformationView, seen: Set<string>): OutputRow | undefined {
  const text = [...(view.requiredLabels ?? []), view.body].filter(Boolean).join(" ");
  if (!text) return undefined;
  const fingerprint = view.source ? viewFingerprint(view, text) : undefined;
  if (fingerprint && seen.has(fingerprint)) return undefined;
  if (fingerprint) seen.add(fingerprint);
  return { view, text, fingerprint };
}

function renderRows(rows: readonly OutputRow[], format: "flat" | "context"): string {
  if (format === "flat") return rows.map((row) => row.text).join("\n");
  const groups = (Object.keys(PURPOSE_ENVELOPES) as InformationPurpose[]).flatMap((purpose) => {
    const items = rows.filter((row) => !row.notice && purposeOf(row.view) === purpose);
    if (items.length === 0) return [];
    const [open, close] = contextEnvelope(
      purpose,
      items.every((row) => row.view.source?.kind === "ag"),
    );
    return [`${open}\n${items.map((row) => row.text).join("\n")}\n${close}`];
  });
  return [...groups, ...rows.filter((row) => row.notice).map((row) => row.text)].join("\n\n");
}

function contextEnvelope(purpose: InformationPurpose, allAg: boolean): readonly [string, string] {
  if (purpose === "state" && allAg) {
    return ['<nmg_state space="ag">\n<nmg_working_state>', "</nmg_working_state>\n</nmg_state>"];
  }
  return PURPOSE_ENVELOPES[purpose];
}

/** Counts the same UTF-16 units as renderRows without rebuilding admitted text.
 * State wrappers can shrink when a non-AG item enters, so rejected additions
 * must restore both counts, not just subtract the candidate body length.
 */
class OutputSize {
  private count = 0;
  private characters = 0;
  private readonly groups = new Map<
    InformationPurpose,
    { count: number; characters: number; nonAg: number }
  >();
  private readonly format: "flat" | "context";

  constructor(format: "flat" | "context") {
    this.format = format;
  }

  update(row: OutputRow, direction: 1 | -1): void {
    this.count += direction;
    this.characters += direction * row.text.length;
    if (this.format === "flat") return;
    const purpose = purposeOf(row.view);
    const group = this.groups.get(purpose) ?? { count: 0, characters: 0, nonAg: 0 };
    group.count += direction;
    group.characters += direction * row.text.length;
    group.nonAg += direction * Number(row.view.source?.kind !== "ag");
    this.groups.set(purpose, group);
  }

  get length(): number {
    if (this.format === "flat") return this.characters + Math.max(0, this.count - 1);
    let total = 0;
    let groupCount = 0;
    for (const [purpose, group] of this.groups) {
      if (group.count === 0) continue;
      const [open, close] = contextEnvelope(purpose, group.nonAg === 0);
      total += open.length + close.length + group.characters + group.count + 1;
      groupCount++;
    }
    return total + Math.max(0, groupCount - 1) * 2;
  }
}

function appendOmissionNotice(
  rows: OutputRow[],
  omitted: InformationView[],
  maxCharacters: number,
  format: "flat" | "context",
  size: OutputSize,
): void {
  if (omitted.length === 0) return;
  let notice = `omitted=${omitted.length}`;
  if (format === "context") {
    appendContextOmissionNotice(rows, omitted, maxCharacters, size);
    return;
  }
  let used = size.length;
  while (rows.length > 0 && used + 1 + notice.length > maxCharacters) {
    const row = rows.pop()!;
    used -= row.text.length + Number(rows.length > 0);
    omitted.unshift(row.view);
    notice = `omitted=${omitted.length}`;
  }
  if (notice.length <= maxCharacters) rows.push({ view: { body: notice }, text: notice });
}

function appendContextOmissionNotice(
  rows: OutputRow[],
  omitted: InformationView[],
  maxCharacters: number,
  size: OutputSize,
): void {
  for (;;) {
    const text = `omitted=${omitted.length}`;
    const notice: OutputRow = { view: { body: text }, text, notice: true };
    if (size.length + (rows.length > 0 ? 2 : 0) + text.length <= maxCharacters) {
      rows.push(notice);
      return;
    }
    // Never sacrifice state, recovery or a diagnostic just to fit bookkeeping.
    const index = rows.findLastIndex(
      (row) =>
        !["state", "diagnostic"].includes(purposeOf(row.view)) &&
        row.view.source?.kind !== "workspace",
    );
    if (index < 0) return;
    const [removed] = rows.splice(index, 1);
    size.update(removed!, -1);
    omitted.unshift(removed!.view);
  }
}

function outputEntry(row: OutputRow): InformationOutputEntry[] {
  if (!row.view.source) return [];
  return [
    Object.freeze({
      source: row.view.source,
      contentHash: row.fingerprint!,
      disclosure: row.view.preview ? ("preview" as const) : ("full" as const),
    }),
  ];
}

function copySource(source: InformationSource): InformationSource {
  switch (source.kind) {
    case "ag":
      return Object.freeze({
        kind: source.kind,
        sessionId: source.sessionId,
        taskFrameId: source.taskFrameId,
        itemId: source.itemId,
      });
    case "board":
      return Object.freeze({
        kind: source.kind,
        taskId: source.taskId,
        entryId: source.entryId,
      });
    case "memory":
      return Object.freeze({
        kind: source.kind,
        memoryId: source.memoryId,
        activeGraphId: source.activeGraphId,
      });
    case "workspace":
      return Object.freeze({
        kind: source.kind,
        sessionId: source.sessionId,
        generatedAt: source.generatedAt,
      });
    case "event":
      return Object.freeze({
        kind: source.kind,
        eventId: source.eventId,
        revision: source.revision,
        part: source.part,
      });
    case "agent":
      return Object.freeze({ kind: source.kind, agentId: source.agentId });
    default:
      throw new RangeError("Unsupported information source");
  }
}

function sourceIdentity(source: InformationSource): string {
  switch (source.kind) {
    case "ag":
      return JSON.stringify([source.kind, source.sessionId, source.taskFrameId, source.itemId]);
    case "board":
      return JSON.stringify([source.kind, source.taskId, source.entryId]);
    case "memory":
      return JSON.stringify([source.kind, source.memoryId, source.activeGraphId ?? null]);
    case "workspace":
      return JSON.stringify([source.kind, source.sessionId, source.generatedAt]);
    case "event":
      return JSON.stringify([source.kind, source.eventId, source.revision, source.part]);
    case "agent":
      return JSON.stringify([source.kind, source.agentId]);
  }
}

function viewFingerprint(view: InformationView, text: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        sourceIdentity(view.source!),
        text,
        Boolean(view.preview),
        ...(view.purpose === undefined ? [] : [view.purpose]),
      ]),
    )
    .digest("hex");
}

function copyView(view: InformationView): InformationView {
  if (view.purpose !== undefined) purposeOf(view);
  return Object.freeze({
    body: view.body,
    ...(view.purpose ? { purpose: view.purpose } : {}),
    source: view.source ? copySource(view.source) : undefined,
    requiredLabels: view.requiredLabels ? Object.freeze([...view.requiredLabels]) : undefined,
    preview: view.preview,
  });
}
