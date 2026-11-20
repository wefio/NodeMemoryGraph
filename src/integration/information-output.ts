import { createHash } from "node:crypto";

import type {
  AutomaticRecallEconomyLimit,
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
  identity?: string;
  notice?: boolean;
  recallHeader?: boolean;
  fingerprintText?: string;
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

const RECALL_CHARACTER_STAGES = [1_500, 2_000, 2_500, 3_000, 4_000, 5_000, 6_000, 8_000, 12_000];
const RECALL_CHARACTERS_PER_SLOT = 125;
const MIN_RECALL_SLOTS = 20;
const MAX_RECALL_SLOTS = 48;
const RECALL_RANK_DAMPING = 40;
const RECALL_LENGTH_FLOOR = 400;
const RECALL_LENGTH_EXPONENT = 0.5;
const ECONOMY_RECALL_BUDGETS = new Map<AutomaticRecallEconomyLimit, number>([
  [3, 1_000],
  [5, 1_500],
  [10, 2_500],
]);

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
  const size = new OutputSize(format);
  const { rows, omitted } = selectRows(ordered, size, format, maxCharacters);
  appendOmissionNotice(rows, omitted, maxCharacters, format, size);
  let included: readonly InformationOutputEntry[] | undefined;
  return Object.freeze({
    text: renderRows(rows, format),
    views: snapshot,
    // Text-only consumers need no disclosure hashes. The frozen snapshot makes
    // this per-output memoization safe without revision or invalidation rules.
    get included() {
      return (included ??= Object.freeze(rows.flatMap(outputEntry)));
    },
    omitted: Object.freeze(omitted),
  });
}

function selectRows(
  ordered: readonly InformationView[],
  size: OutputSize,
  format: "flat" | "context",
  maximum: number,
): { rows: OutputRow[]; omitted: InformationView[] } {
  const seen = new Map<string, Set<string>>();
  const prepared = ordered.map((view) => prepareRow(view, seen)).filter((row) => row !== undefined);
  const staged = format === "context" ? prepared.filter(isAutomaticRecall) : [];
  const stagedRows = new Set(staged);
  const rows: OutputRow[] = [];
  const omitted: InformationView[] = [];
  let packedRecall = false;
  for (const row of prepared) {
    if (!stagedRows.has(row)) {
      if (tryAppend(row, size, maximum)) rows.push(row);
      else omitted.push(row.view);
    } else if (!packedRecall) {
      const selected = packAutomaticRecall(staged, size, maximum, prepared.length);
      rows.push(...selected);
      const retained = new Set(selected.map(({ view }) => view));
      for (const candidate of staged)
        if (!retained.has(candidate.view)) omitted.push(candidate.view);
      packedRecall = true;
    }
  }
  return { rows, omitted };
}

function isAutomaticRecall(row: OutputRow): boolean {
  const { view } = row;
  return (
    (view.automaticRecall === "full" || ECONOMY_RECALL_BUDGETS.has(view.automaticRecall!)) &&
    view.purpose === "material" &&
    view.source?.kind === "memory" &&
    view.preview === true
  );
}

function tryAppend(row: OutputRow, size: OutputSize, ceiling: number): boolean {
  size.update(row, 1);
  if (size.length <= ceiling) return true;
  size.update(row, -1);
  return false;
}

function packAutomaticRecall(
  recall: readonly OutputRow[],
  size: OutputSize,
  maximum: number,
  rowCount: number,
): OutputRow[] {
  const used = size.length;
  const stages = automaticRecallStages(recall, maximum - used);
  const group = compactRecallGroup(recall);
  const fullMode = !recall.some(({ view }) => typeof view.automaticRecall === "number");
  const selected: OutputRow[] = [];
  const remaining = new Set(orderRecallCandidates(group.rows, fullMode));
  if (group.header) size.update(group.header, 1);
  // The notice can always fit after a successful admission without removing its source row.
  const noticeRoom = `\n\nomitted=${rowCount}`.length;
  for (const { characters, slots } of stages) {
    for (const row of remaining) {
      if (selected.length >= slots) break;
      if (!tryAppend(row, size, used + characters - noticeRoom)) continue;
      selected.push(row);
      remaining.delete(row);
    }
  }
  if (group.header) {
    if (selected.length > 0) return [group.header, ...selected];
    size.update(group.header, -1);
  }
  return selected;
}

/** Guard short records (<=400 UTF-16 units) from length distortion while letting
 * concise high-rank records outcompete oversized full statements under budget. */
function orderRecallCandidates(rows: readonly OutputRow[], fullMode: boolean): OutputRow[] {
  if (!fullMode) return [...rows];
  return rows
    .map((row, rank) => ({
      row,
      rank,
      score:
        RECALL_RANK_DAMPING /
        (RECALL_RANK_DAMPING + rank) /
        Math.pow(Math.max(row.text.length, RECALL_LENGTH_FLOOR), RECALL_LENGTH_EXPONENT),
    }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank)
    .map(({ row }) => row);
}

/** Keep per-record source labels for typed views and receipts, and show their common text once. */
function compactRecallGroup(recall: readonly OutputRow[]): {
  rows: readonly OutputRow[];
  header?: OutputRow;
} {
  const labelText = recall[0]?.view.requiredLabels?.filter(Boolean).join(" ");
  if (!labelText || !recall.every(isCompactRecallWithLabels(labelText))) return { rows: recall };
  return {
    header: { view: { purpose: "material", body: labelText }, text: labelText, recallHeader: true },
    rows: recall.map((row) => ({ ...row, text: row.view.body, fingerprintText: row.text })),
  };
}

function isCompactRecallWithLabels(labelText: string) {
  return ({ view }: OutputRow) =>
    typeof view.automaticRecall === "number" &&
    Boolean(view.body) &&
    view.requiredLabels?.filter(Boolean).join(" ") === labelText;
}

function automaticRecallStages(
  recall: readonly OutputRow[],
  available: number,
): { characters: number; slots: number }[] {
  const economy = recall
    .map(({ view }) => view.automaticRecall)
    .filter((limit): limit is AutomaticRecallEconomyLimit => typeof limit === "number");
  if (economy.length) {
    const stages: ReturnType<typeof automaticRecallStages> = [];
    const limit = Math.min(...economy);
    for (const [slots, budget] of ECONOMY_RECALL_BUDGETS) {
      const characters = Math.min(budget, available);
      stages.push({ characters, slots });
      if (budget >= available || slots === limit) break;
    }
    return stages;
  }
  return RECALL_CHARACTER_STAGES.filter((stage) => stage < available)
    .concat(available)
    .map((characters) => ({
      characters,
      slots: Math.min(
        MAX_RECALL_SLOTS,
        Math.max(MIN_RECALL_SLOTS, Math.floor(characters / RECALL_CHARACTERS_PER_SLOT)),
      ),
    }));
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

function prepareRow(view: InformationView, seen: Map<string, Set<string>>): OutputRow | undefined {
  const text = [...(view.requiredLabels ?? []), view.body].filter(Boolean).join(" ");
  if (!text) return undefined;
  const identity = view.source ? sourceIdentity(view.source) : undefined;
  if (identity) {
    const key = JSON.stringify([
      identity,
      Boolean(view.preview),
      ...(view.purpose === undefined ? [] : [view.purpose]),
    ]);
    const texts = seen.get(key) ?? new Set<string>();
    if (texts.has(text)) return undefined;
    texts.add(text);
    seen.set(key, texts);
  }
  return { view, text, identity };
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
        row.view.source?.kind !== "workspace" &&
        !row.recallHeader &&
        !isAutomaticRecall(row),
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
      contentHash: viewFingerprint(row),
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
      return Object.freeze({
        kind: source.kind,
        agentId: source.agentId,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
      });
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
      return source.sessionId
        ? JSON.stringify([source.kind, source.agentId, source.sessionId])
        : JSON.stringify([source.kind, source.agentId]);
  }
}

function viewFingerprint({ view, text, identity, fingerprintText = text }: OutputRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        identity,
        fingerprintText,
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
    ...(view.automaticRecall !== undefined ? { automaticRecall: view.automaticRecall } : {}),
  });
}
