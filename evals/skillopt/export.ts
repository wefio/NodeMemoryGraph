import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadPrompts } from "../../src/prompts/load.ts";
import { buildSkillOptPolicyDataset } from "./dataset.ts";
import { readShadowEvents, resolveShadowEventPath } from "../controller-shadow/report.ts";

export interface ExportSkillOptOptions {
  eventPath: string;
  outputDirectory: string;
  allowInsufficient?: boolean;
}

export function exportSkillOptDataset(options: ExportSkillOptOptions): {
  outputDirectory: string;
  ready: boolean;
  counts: ReturnType<typeof buildSkillOptPolicyDataset>["counts"];
  blockers: string[];
} {
  const dataset = buildSkillOptPolicyDataset(readShadowEvents(options.eventPath));
  if (!dataset.ready && !options.allowInsufficient) {
    throw new Error(
      `SkillOpt export refused: ${dataset.blockers.join("; ")}. ` +
        "Collect natural, explicit feedback or pass --allow-insufficient for an adapter smoke only.",
    );
  }
  rmSync(options.outputDirectory, { recursive: true, force: true });
  for (const split of ["train", "val", "test"] as const) {
    const directory = resolve(options.outputDirectory, split);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      resolve(directory, "items.json"),
      `${JSON.stringify(dataset.items.filter((item) => item.split === split), null, 2)}\n`,
      "utf8",
    );
  }
  const policy = loadPrompts().memory_policy.trim();
  writeFileSync(resolve(options.outputDirectory, "initial_skill.md"), `${policy}\n`, "utf8");
  const manifest = {
    version: 1,
    generated_at: new Date().toISOString(),
    source_event_path: resolve(options.eventPath),
    source_event_sha256: hashJson(readShadowEvents(options.eventPath)),
    initial_policy_sha256: createHash("sha256").update(policy).digest("hex"),
    ready: dataset.ready,
    allow_insufficient: Boolean(options.allowInsufficient),
    counts: dataset.counts,
    excluded_graphs: dataset.excluded_graphs,
    blockers: dataset.blockers,
    immutable_boundaries: [
      "history records",
      "memory statements",
      "source evidence",
      "STG/LTG/AG state",
      "node and edge identity",
    ],
    promotion_gate: "matched Pi+NMG evaluation plus untouched test split and human adoption",
  };
  writeFileSync(
    resolve(options.outputDirectory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return {
    outputDirectory: options.outputDirectory,
    ready: dataset.ready,
    counts: dataset.counts,
    blockers: dataset.blockers,
  };
}

function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseArguments(args: readonly string[]): ExportSkillOptOptions {
  let eventPath: string | undefined;
  let outputDirectory = resolve(".benchmarks", "skillopt", "nmg-policy");
  let allowInsufficient = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--events") eventPath = args[++index];
    else if (argument === "--output") outputDirectory = resolve(args[++index] ?? "");
    else if (argument === "--allow-insufficient") allowInsufficient = true;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return {
    eventPath: resolveShadowEventPath(eventPath),
    outputDirectory,
    allowInsufficient,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(exportSkillOptDataset(parseArguments(process.argv.slice(2))), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
