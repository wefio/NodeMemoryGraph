/**
 * Renders the graph projection into one self-contained HTML file.
 *
 * The view assets (assets/template.html + graph.{css,js}) stay on disk as
 * editable, reusable templates; this module only inlines them plus the data
 * payload. The HTML shell is named template.html so generated graph.html
 * exports stay untracked without colliding with the ignore rule.
 * Assets are resolved relative to this module so both the type-stripped
 * source tree (src/cli/graph/assets) and the compiled package
 * (dist/cli/graph/assets, copied by the build) work unchanged.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { openInspectDb } from "./inspect-data.ts";
import { readGraphData, type GraphData } from "./graph-data.ts";

export interface GraphTemplates {
  html: string;
  css: string;
  js: string;
}

const STYLE_PLACEHOLDER = "<!--NMG_STYLE-->";
const DATA_PLACEHOLDER = "<!--NMG_DATA-->";
const SCRIPT_PLACEHOLDER = "<!--NMG_SCRIPT-->";

export function loadGraphTemplates(
  assetsDirectory: URL = new URL("./graph/assets/", import.meta.url),
): GraphTemplates {
  return {
    html: readFileSync(new URL("template.html", assetsDirectory), "utf8"),
    css: readFileSync(new URL("graph.css", assetsDirectory), "utf8"),
    js: readFileSync(new URL("graph.js", assetsDirectory), "utf8"),
  };
}

export function renderGraphHtml(data: GraphData, templates: GraphTemplates): string {
  // `</` inside a statement would close the inline <script> early; the JSON
  // spec permits escaping the slash, and JSON.parse accepts it verbatim.
  const payload = JSON.stringify(data).replaceAll("</", "<\\/");
  return templates.html
    .replace(STYLE_PLACEHOLDER, () => templates.css)
    .replace(DATA_PLACEHOLDER, () => payload)
    .replace(SCRIPT_PLACEHOLDER, () => templates.js);
}

/**
 * Reads the graph projection from a (possibly live) database and writes the
 * rendered HTML. Returns the output path for the CLI message.
 */
export function exportGraphHtml(databasePath: string, outputPath: string): string {
  const db = openInspectDb(databasePath);
  try {
    const html = renderGraphHtml(readGraphData(db), loadGraphTemplates());
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, html);
    return outputPath;
  } finally {
    db.close();
  }
}
