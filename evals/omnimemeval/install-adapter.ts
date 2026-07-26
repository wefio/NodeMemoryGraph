import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const registryEntry = '    "nmg": ("nmg_client", "NmgClient"),';

export function installOmniMemEvalAdapter(checkout: string): void {
  const target = resolve(checkout, "scripts", "client_factory");
  const registry = resolve(target, "registry.py");
  const adapter = resolve(import.meta.dirname, "nmg_client.py");
  const source = readFileSync(registry, "utf8");

  copyFileSync(adapter, resolve(target, "nmg_client.py"));
  if (source.includes('"nmg": ("nmg_client", "NmgClient")')) return;

  const marker = "_LIB_CLIENT_REGISTRY = {";
  if (!source.includes(marker)) {
    throw new Error(`Unsupported OmniMemEval registry format: ${registry}`);
  }
  writeFileSync(registry, source.replace(marker, `${marker}\n${registryEntry}`), "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const root = resolve(import.meta.dirname, "../..");
  const checkout = resolve(
    process.argv[2] ?? resolve(root, ".benchmarks", "official", "OmniMemEval"),
  );
  installOmniMemEvalAdapter(checkout);
  process.stdout.write(`Installed NMG adapter into ${checkout}\n`);
}
