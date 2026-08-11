import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function installSkillOptAdapter(checkout: string): void {
  const source = resolve(import.meta.dirname, "adapter", "nmg_policy");
  const target = resolve(checkout, "skillopt", "envs", "nmg_policy");
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true, force: true });
  cpSync(
    resolve(import.meta.dirname, "adapter", "default.yaml"),
    resolve(checkout, "configs", "nmg_policy.yaml"),
    { force: true },
  );
  for (const script of ["train.py", "eval_only.py"]) {
    const path = resolve(checkout, "scripts", script);
    insertRegistry(path);
  }
}

function insertRegistry(path: string): void {
  const source = readFileSync(path, "utf8");
  if (source.includes('_ENV_REGISTRY["nmg_policy"]')) return;
  const marker = "def get_adapter(cfg: dict):";
  if (!source.includes(marker)) throw new Error(`Unsupported SkillOpt registry: ${path}`);
  const registration = [
    "    try:",
    "        from skillopt.envs.nmg_policy.adapter import NmgPolicyAdapter",
    '        _ENV_REGISTRY["nmg_policy"] = NmgPolicyAdapter',
    "    except ImportError:",
    "        pass",
    "",
    "",
  ].join("\n");
  writeFileSync(path, source.replace(marker, `${registration}${marker}`), "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const checkout = resolve(
    process.argv[2] ?? resolve(import.meta.dirname, "../..", ".benchmarks", "official", "SkillOpt"),
  );
  installSkillOptAdapter(checkout);
  process.stdout.write(`Installed NMG policy adapter into ${checkout}\n`);
}
