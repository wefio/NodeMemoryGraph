import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const registryEntry = '    "nmg": ("nmg_client", "NmgClient"),';

export function installOmniMemEvalAdapter(checkout: string): void {
  const target = resolve(checkout, "scripts", "client_factory");
  const registry = resolve(target, "registry.py");
  const adapter = resolve(import.meta.dirname, "nmg_client.py");

  copyFileSync(adapter, resolve(target, "nmg_client.py"));
  insertAfter(
    registry,
    "_LIB_CLIENT_REGISTRY = {",
    registryEntry,
    '"nmg": ("nmg_client", "NmgClient")',
  );

  insertAfter(
    resolve(checkout, "scripts", "utils", "search_helpers.py"),
    '    "memos": generic_text_search,',
    '    "nmg": generic_text_search,',
    '"nmg": generic_text_search',
  );
  insertAfter(
    resolve(checkout, "scripts", "locomo", "locomo_search.py"),
    '        "memos": generic_text_search,',
    '        "nmg": generic_text_search,',
    '"nmg": generic_text_search',
  );
  replaceOnce(
    resolve(checkout, "scripts", "utils", "ingest_helpers.py"),
    '_CONV_ID_LIBS = frozenset({"memos", "everos"})',
    '_CONV_ID_LIBS = frozenset({"memos", "everos", "nmg"})',
    '"nmg"',
  );
}

function insertAfter(path: string, marker: string, line: string, present: string): void {
  const source = readFileSync(path, "utf8");
  if (source.includes(present)) return;
  if (!source.includes(marker)) throw new Error(`Unsupported OmniMemEval format: ${path}`);
  writeFileSync(path, source.replace(marker, `${marker}\n${line}`), "utf8");
}

function replaceOnce(path: string, marker: string, replacement: string, present: string): void {
  const source = readFileSync(path, "utf8");
  if (source.includes(present)) return;
  if (!source.includes(marker)) throw new Error(`Unsupported OmniMemEval format: ${path}`);
  writeFileSync(path, source.replace(marker, replacement), "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(import.meta.dirname, "../..");
  const checkout = resolve(
    process.argv[2] ?? resolve(root, ".benchmarks", "official", "OmniMemEval"),
  );
  installOmniMemEvalAdapter(checkout);
  process.stdout.write(`Installed NMG adapter into ${checkout}\n`);
}
