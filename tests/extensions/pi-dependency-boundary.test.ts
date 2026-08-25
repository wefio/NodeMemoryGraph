import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

test("Pi harness stays an optional adapter peer instead of a runtime dependency", () => {
  assert.equal(
    packageJson.dependencies?.["@earendil-works/pi-coding-agent"],
    undefined,
  );
  assert.ok(packageJson.devDependencies?.["@earendil-works/pi-coding-agent"]);
  assert.ok(packageJson.peerDependencies?.["@earendil-works/pi-coding-agent"]);
  assert.equal(
    packageJson.peerDependenciesMeta?.["@earendil-works/pi-coding-agent"]
      ?.optional,
    true,
  );
});

test("the standalone TUI uses the Pi harness-compatible pi-tui line", () => {
  const harnessVersion = packageJson.devDependencies?.[
    "@earendil-works/pi-coding-agent"
  ];
  const tuiVersion = packageJson.dependencies?.["@earendil-works/pi-tui"];

  assert.equal(harnessVersion, "^0.84.1");
  assert.equal(tuiVersion, "^0.84.1");
});

test("the installed Pi TUI line exposes the renderer used by nmg inspect", async () => {
  const piTui = await import("@earendil-works/pi-tui");
  assert.equal(typeof piTui.TuiMainScreen, "function");
});
