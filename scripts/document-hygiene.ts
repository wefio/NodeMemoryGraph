// Required workflow documents remain present in addition to role-based coverage.
// Mechanical policy is owned by docs/README.md#ci-contract.
export const DOCUMENT_HYGIENE_PATHS = [
  "docs/design/documentation-governance.md",
  "docs/design/ooo-execution-bootstrap.md",
  "skills/doc-maintenance/references/reader-review.md",
] as const;

interface Heading {
  level: number;
  title: string;
  line: number;
}

interface ContentLine {
  visible: string;
  heading?: Heading;
}

function withoutComments(line: string, state: { comment: boolean }): string {
  let visible = "";
  let cursor = 0;
  while (cursor < line.length) {
    const marker = state.comment ? "-->" : "<!--";
    const end = line.indexOf(marker, cursor);
    if (end === -1) {
      if (!state.comment) visible += line.slice(cursor);
      break;
    }
    if (!state.comment) visible += line.slice(cursor, end);
    state.comment = !state.comment;
    cursor = end + marker.length;
  }
  return visible;
}

function contentLines(text: string): ContentLine[] {
  let fence: { character: string; length: number } | undefined;
  const comments = { comment: false };
  return text.split(/\r?\n/).map((line, index) => {
    const visible = fence ? line : withoutComments(line, comments);
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(visible);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.character &&
        marker[1].length >= fence.length &&
        marker[2].trim() === ""
      ) {
        fence = undefined;
        return { visible: "" };
      }
      return { visible };
    }
    if (marker && (marker[1][0] === "~" || !marker[2].includes("`"))) {
      fence = { character: marker[1][0], length: marker[1].length };
      return { visible: "" };
    }
    const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|$)/.exec(visible);
    if (!match) return { visible };
    const title = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
    return { visible, heading: { level: match[1].length, title, line: index + 1 } };
  });
}

/** Literal ATX titles only: not Setext headings, HTML headings or semantic aliases. */
export function documentHeadingTitles(text: string): string[] {
  return contentLines(text).flatMap((line) => (line.heading ? [line.heading.title] : []));
}

function emptySection(lines: ContentLine[], index: number, heading: Heading): boolean {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line.heading && line.heading.level <= heading.level) break;
    if (!line.heading && line.visible.trim()) return false;
  }
  return true;
}

export function checkDocumentHygiene(text: string): string[] {
  const lines = contentLines(text);
  const parents: Heading[] = [];
  const siblings = new Set<string>();
  const errors: string[] = [];
  for (const [index, line] of lines.entries()) {
    const heading = line.heading;
    if (!heading) continue;
    while (parents.length && parents[parents.length - 1].level >= heading.level) parents.pop();
    const parent = parents[parents.length - 1]?.line ?? 0;
    const title = heading.title.replace(/\s+/g, " ").toLowerCase();
    const key = `${parent}:${heading.level}:${title}`;
    if (!title) errors.push(`empty heading at line ${heading.line}`);
    else if (siblings.has(key)) {
      errors.push(`duplicate sibling heading '${heading.title}' at line ${heading.line}`);
    }
    siblings.add(key);
    if (emptySection(lines, index, heading)) {
      errors.push(`empty section '${heading.title}' at line ${heading.line}`);
    }
    parents.push(heading);
  }
  return errors;
}
