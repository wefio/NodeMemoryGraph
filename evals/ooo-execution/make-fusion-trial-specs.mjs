#!/usr/bin/env node
/**
 * Build the two specs of the quality field trial from the offline pipeline fixture: the control arm
 * (the fixture as it stands) and the fusion arm (the same plan, with one declaration added). Two
 * arms that differ in one field are the only way the comparison means anything, so the script
 * refuses a fixture that already declares fusion, and it refuses to guess the provider or model.
 *
 * Usage: node evals/ooo-execution/make-fusion-trial-specs.mjs <unitsPerSession>
 *
 * It lives with the harness it builds specs for, not beside the trial's markdown: a runnable
 * generator reports through stdout, and every `files:` block of the eslint config has to be anchored
 * in a directory `npm run lint` scans, so a script under docs/ would be read as an unexplained
 * console warning instead of the tool it is.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SOURCE = "evals/ooo-execution/fixtures/pipeline/fine.spec.json";
const OUT = ".temp/trial";
const unitsPerSession = Number(process.argv[2]);

if (!Number.isInteger(unitsPerSession) || unitsPerSession < 2) {
  console.error("refusing: pass a units-per-session of at least 2, e.g. 2");
  process.exit(2);
}
const provider = process.env.PI_PROVIDER;
const model = process.env.PI_MODEL;
if (!provider || !model) {
  console.error("refusing: PI_PROVIDER and PI_MODEL must both be set for a live run");
  process.exit(2);
}

const fixture = JSON.parse(readFileSync(SOURCE, "utf8"));
if (fixture.fusion) {
  console.error(`refusing: ${SOURCE} already declares fusion, so it is not a control arm`);
  process.exit(3);
}
if (fixture.worker?.kind !== "canned") {
  console.error(`refusing: ${SOURCE} is not the offline canned fixture (${fixture.worker?.kind})`);
  process.exit(3);
}

const live = { ...fixture, worker: { kind: "pi", provider, model } };
const control = { ...live, id: "pipeline-control" };
const fusion = { ...live, id: "pipeline-fusion", fusion: { unitsPerSession, constraints: ["repair-first"] } };

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/control.spec.json`, `${JSON.stringify(control, null, 2)}\n`);
writeFileSync(`${OUT}/fusion.spec.json`, `${JSON.stringify(fusion, null, 2)}\n`);

// The arms must differ in exactly one declaration, or the comparison measures the wrong thing.
const differences = Object.keys({ ...control, ...fusion }).filter(
  (key) => JSON.stringify(control[key]) !== JSON.stringify(fusion[key]),
);
if (differences.join(",") !== "id,fusion") {
  console.error(`refusing: the arms differ in ${differences.join(", ")}, not only id and fusion`);
  process.exit(4);
}

console.log(`wrote ${OUT}/control.spec.json and ${OUT}/fusion.spec.json`);
console.log(`provider ${provider}, model ${model}, unitsPerSession ${unitsPerSession}`);
console.log(`units: ${fixture.plan.map((unit) => unit.id).join(", ")}`);
