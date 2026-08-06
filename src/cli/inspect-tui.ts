/**
 * `nmg inspect` — read-only TUI for browsing memories and retrieval traces.
 *
 * pi-tui is imported lazily so the dependency (and its native prebuilds) is
 * only loaded when the interactive command actually runs — CLI unit tests
 * and the daemon never pay for it. The database is opened read-only via
 * inspect-data.ts; this command is safe against a live database.
 *
 * Key model (conflict-free by construction):
 *   printable chars  → list filter (fuzzy, via SelectList.setFilter)
 *   Backspace        → edit filter
 *   Tab              → switch memories / traces
 *   ↑/↓              → navigate (handled by SelectList)
 *   Esc              → clear filter; press again to quit
 *   Ctrl+C           → quit immediately
 */
import type {
  InspectMemoryDetail,
  InspectTraceDetail,
} from "./inspect-data.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";

export async function runInspectTui(databasePath: string): Promise<void> {
  if (!process.stdout.isTTY) {
    throw new Error("nmg inspect requires an interactive terminal (TTY)");
  }
  const { TUI, ProcessTerminal, Text, SelectList } = await import("@earendil-works/pi-tui");
  const data = await import("./inspect-data.ts");

  const db = data.openInspectDb(databasePath);
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  type Tab = "memories" | "traces";
  let tab: Tab = "memories";
  let filter = "";

  const theme = {
    selectedPrefix: (text: string) => `${CYAN}${text}${RESET}`,
    selectedText: (text: string) => `${CYAN}${BOLD}${text}${RESET}`,
    description: (text: string) => `${DIM}${text}${RESET}`,
    scrollInfo: (text: string) => `${DIM}${text}${RESET}`,
    noMatch: (text: string) => `${YELLOW}${text}${RESET}`,
  };

  const header = new Text("");
  const detail = new Text("");
  let list = buildList();

  function memoryItems() {
    return data.listMemories(db).map((row) => ({
      value: row.id,
      label: `L${row.tier} ${row.memoryType} ${row.nodeName}  ${row.statement}`,
      description: row.createdAt.slice(0, 16).replace("T", " "),
    }));
  }

  function traceItems() {
    return data.listTraces(db).map((row) => ({
      value: row.id,
      label: `${row.hasQpp ? "Q" : "-"} ${row.query}`,
      description: `${row.createdAt.slice(0, 19).replace("T", " ")}  ${row.resultCount} hits`,
    }));
  }

  function buildList(): InstanceType<typeof SelectList> {
    const items = tab === "memories" ? memoryItems() : traceItems();
    const next = new SelectList(items, Math.min(Math.max(items.length, 1), 12), theme);
    next.onSelectionChange = (item) => updateDetail(item?.value);
    next.setFilter(filter);
    return next;
  }

  function updateDetail(id: string | undefined): void {
    if (!id) {
      detail.setText(`${DIM}(no selection)${RESET}`);
      return;
    }
    detail.setText(
      tab === "memories"
        ? formatMemoryDetail(data.getMemoryDetail(db, id))
        : formatTraceDetail(data.getTraceDetail(db, id)),
    );
  }

  function refreshHeader(): void {
    const filterNote = filter ? `  filter: ${YELLOW}${filter}${RESET}` : "";
    header.setText(
      `${BOLD}NMG inspect${RESET}  ` +
        `${tab === "memories" ? CYAN + BOLD : DIM}[1 memories]${RESET} ` +
        `${tab === "traces" ? CYAN + BOLD : DIM}[2 traces]${RESET}` +
        `${filterNote}\n${DIM}type to filter · Tab/1/2 switch · Esc clear/quit · Ctrl+C quit${RESET}`,
    );
  }

  function remountList(): void {
    tui.removeChild(list);
    list = buildList();
    tui.addChild(list);
    // Keep detail as the last child: remove and re-add after the new list.
    tui.removeChild(detail);
    tui.addChild(detail);
    tui.setFocus(list);
    updateDetail(list.getSelectedItem()?.value);
  }

  tui.addChild(header);
  tui.addChild(list);
  tui.addChild(detail);
  refreshHeader();
  updateDetail(list.getSelectedItem()?.value);

  const closed = new Promise<void>((resolve) => {
    tui.addInputListener((input) => {
      if (input === "\x03") {
        // Ctrl+C
        resolve();
        return { consume: true };
      }
      if (input === "\x1b") {
        // Esc alone: clear filter first, quit when already empty.
        if (filter) {
          filter = "";
          list.setFilter(filter);
          refreshHeader();
          return { consume: true };
        }
        resolve();
        return { consume: true };
      }
      if (input === "\t" || input === "1" || input === "2") {
        // Tab always switches; digits switch only when the filter is empty
        // (otherwise they are filter text).
        if (input === "\t" || !filter) {
          const next: Tab = input === "1" ? "memories" : input === "2" ? "traces" : tab === "memories" ? "traces" : "memories";
          if (next !== tab) {
            tab = next;
            remountList();
            refreshHeader();
          }
          return { consume: true };
        }
      }
      if (input === "\x7f") {
        // Backspace
        if (filter) {
          filter = [...filter].slice(0, -1).join("");
          list.setFilter(filter);
          refreshHeader();
        }
        return { consume: true };
      }
      // Printable text (including CJK, which arrives as multi-byte strings)
      // goes to the filter; escape sequences pass through to the list.
      if (!input.startsWith("\x1b") && [...input].every((ch) => ch >= " ")) {
        filter += input;
        list.setFilter(filter);
        refreshHeader();
        return { consume: true };
      }
      return undefined;
    });
  });

  tui.setFocus(list);
  tui.start();
  await closed;
  tui.stop();
  db.close();
}

function formatMemoryDetail(row: InspectMemoryDetail | null): string {
  if (!row) return `${DIM}(memory not found)${RESET}`;
  const lines = [
    `${BOLD}${row.statement}${RESET}`,
    `${DIM}${row.id} · ${row.nodeName} · L${row.tier} ${row.memoryType} · importance ${row.importance}${RESET}`,
    `actor=${row.sourceActor} truth=${row.truthStatus} residence=${row.residence} role=${row.evidenceRole}`,
    `status=${row.status} access=${row.accessCount}${row.lastAccessedAt ? ` last=${row.lastAccessedAt.slice(0, 10)}` : ""}${row.expiresAt ? ` expires=${row.expiresAt.slice(0, 10)}` : ""}`,
  ];
  const scopeEntries = Object.entries(row.scope);
  if (scopeEntries.length > 0) {
    lines.push(`scope: ${scopeEntries.map(([key, value]) => `${key}=${value}`).join(" ")}`);
  }
  for (const evidence of row.evidence) {
    lines.push(`${DIM}evidence[${evidence.role} ${evidence.createdAt.slice(0, 10)}]${RESET} ${evidence.content}`);
  }
  return lines.join("\n");
}

function formatTraceDetail(row: InspectTraceDetail | null): string {
  if (!row) return `${DIM}(trace not found)${RESET}`;
  const lines = [
    `${BOLD}${row.query}${RESET}`,
    `${DIM}${row.id} · ${row.createdAt} · ${row.resultCount} hits${RESET}`,
  ];
  const render = (title: string, value: unknown) => {
    if (value === null || value === undefined) return;
    const text = JSON.stringify(value, null, 1);
    const compact = text.length > 600 ? `${text.slice(0, 600)}…` : text;
    lines.push(`${CYAN}${title}${RESET} ${compact}`);
  };
  render("qpp:", row.qpp);
  render("filter:", row.filterUsage);
  render("timings:", row.timings);
  render("selections:", row.selections);
  render("expansions:", row.expansions);
  return lines.join("\n");
}
