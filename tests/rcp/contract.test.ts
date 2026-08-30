import assert from "node:assert/strict";
import test from "node:test";

import { compileContract } from "../../src/rcp/contract.ts";
import { contractText } from "./fixture.ts";

test("YAML and JSON compile to the same canonical Contract digest", () => {
  const yaml = compileContract({ text: contractText(), path: "contract.yaml" });
  assert.equal(yaml.ok, true, JSON.stringify(yaml.diagnostics));
  const document = {
    kind: "AgentChange",
    apiVersion: "repository.nmg.dev/v1alpha1",
    spec: {
      authority: { mode: "apply" },
      verification: { checks: ["check"], forgeChecks: ["product"], routes: ["source"] },
      invariants: ["do not modify outside scope"],
      preserve: ["public API"],
      scope: { exclude: ["src/generated/**"], include: ["src/**"] },
      intent: "Update the fixture source",
    },
    metadata: { id: "fixture-change" },
  };
  const json = compileContract({ text: JSON.stringify(document), path: "contract.json" });
  assert.equal(json.ok, true, JSON.stringify(json.diagnostics));
  assert.equal(json.contract?.contractDigest, yaml.contract?.contractDigest);
});

test("compiler preserves extension data but fails closed on unknown core fields", () => {
  const withExtension = compileContract({
    text: contractText("  extensions:\n    example.dev/options:\n      enabled: true"),
    path: "contract.yaml",
  });
  assert.equal(withExtension.ok, true, JSON.stringify(withExtension.diagnostics));
  assert.deepEqual(withExtension.contract?.extensions, {
    "example.dev/options": { enabled: true },
  });

  const unknown = compileContract({
    text: contractText().replace("  intent:", "  surprise: true\n  intent:"),
    path: "contract.yaml",
  });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.diagnostics.some((diagnostic) => diagnostic.code === "contract.unknown-field"));
});

test("compiler rejects repository escape and reports a source line", () => {
  const result = compileContract({
    text: contractText().replace("include: [src/**]", "include: [../secrets/**]"),
    path: "contract.yaml",
  });
  assert.equal(result.ok, false);
  const diagnostic = result.diagnostics.find((entry) => entry.code === "contract.scope-path");
  assert.ok(diagnostic);
  assert.equal(typeof diagnostic.source.line, "number");
});

test("compiler requires stable identity, non-empty scope, and independent checks", () => {
  const text = contractText()
    .replace("fixture-change", "x")
    .replace("include: [src/**]", "include: []")
    .replace("checks: [check]", "checks: []");
  const result = compileContract({ text, path: "contract.yaml" });
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((entry) => entry.code === "contract.id"));
  assert.equal(
    result.diagnostics.filter((entry) => entry.code === "contract.string-array").length,
    2,
  );
});
