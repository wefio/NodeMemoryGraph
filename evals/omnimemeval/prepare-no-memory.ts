import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type SearchRecord = Record<string, unknown>;
type GroupedSearchResults = Record<string, SearchRecord[]>;

export function prepareNoMemoryResults(
  sourcePath: string,
  targetPath: string,
): { groups: number; questions: number } {
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as GroupedSearchResults;
  const output: GroupedSearchResults = {};
  let questions = 0;

  for (const [groupId, records] of Object.entries(source)) {
    if (!Array.isArray(records)) {
      throw new TypeError(`Expected an array for search group ${groupId}`);
    }
    output[groupId] = records.map((record) => {
      questions += 1;
      return {
        ...record,
        context: "",
        raw_context: "",
        search_context: "",
        reflect_answer: null,
        duration_ms: 0,
        search_duration_ms: 0,
        status: "success_empty",
      };
    });
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return { groups: Object.keys(output).length, questions };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const sourcePath = process.argv[2];
  const targetPath = process.argv[3];
  if (!sourcePath || !targetPath) {
    throw new Error("Usage: prepare-no-memory.ts <source-search-results.json> <target.json>");
  }
  const counts = prepareNoMemoryResults(resolve(sourcePath), resolve(targetPath));
  process.stdout.write(
    `Prepared no-memory baseline: ${counts.groups} groups, ${counts.questions} questions\n`,
  );
}
