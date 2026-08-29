import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

import { NMG_METHODS } from "../../src/cli/protocol.ts";

/**
 * Module-boundary guard for the JSON-RPC-over-HTTP transport.
 *
 * After gRPC was retired, the daemon speaks JSON-RPC over HTTP (built-in
 * fetch / http, no third-party deps). The thin `http-client.ts` is what the
 * Pi extension loads through `daemon-client.ts`, so it MUST NOT pull the
 * server implementation (`service.ts` -> the 4,485-line `core/store.ts` +
 * ~30 core modules) into the Pi process.
 *
 * This guard pins the boundary with five checks:
 *   1. `http-client.ts` exports the client surface and must NOT import
 *      `./service.ts` nor any `../core/*` module.
 *   2. `http-server.ts` exports `serveHttp` and imports `./service.ts`.
 *   3. callers migrated: `daemon-client.ts` imports the client; `cli/main.ts`
 *      imports both split files.
 *   4. anti-regression contract: gRPC must not be reintroduced — no module may
 *      import the retired gRPC modules (`grpc.ts`, `grpc-client.ts`,
 *      `grpc-server.ts`) and `package.json` must not list `@grpc`.
 *   5. the server implements every method `service.invoke` supports.
 *
 * Source is read as text (no compiler), so the scan is fast and safe for npm test.
 */

const ROOT = resolve(import.meta.dirname, "../..");

const CLIENT_FILE = "src/cli/http-client.ts";
const SERVER_FILE = "src/cli/http-server.ts";
const DAEMON_CLIENT = "src/cli/daemon-client.ts";
const CLI_MAIN = "src/cli/main.ts";
const SERVICE_FILE = "src/cli/service.ts";
// Retired transport modules. These files no longer exist; the guard fails if any
// source file imports them (e.g. after an accidental git revert re-creates them),
// pinning the HTTP transport as a contract rather than a one-time cleanup.
const RETIRED = ["src/cli/grpc.ts", "src/cli/grpc-client.ts", "src/cli/grpc-server.ts"];
const PKG = "package.json";

const SCAN_DIRS = ["src", "tests", "evals", "claude-plugins", ".pi"];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "coverage", ".nmg", "build"]);

function tsFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory))) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(ROOT, directory, entry);
    if (statSync(full).isDirectory()) files.push(...tsFiles(join(directory, entry)));
    else if (/\.(ts|mts|cts|tsx)$/.test(entry)) files.push(join(directory, entry));
  }
  return files;
}

function fileText(relative: string): string {
  return readFileSync(join(ROOT, relative), "utf8");
}

function relativeSpecifiers(relative: string): string[] {
  const source = fileText(relative);
  const specifiers: string[] = [];
  const re = /(?:from\s+|import\s+)(['"])(\.{1,2}\/[^'"]+)\1/g;
  for (const match of source.matchAll(re)) specifiers.push(match[2]!);
  return specifiers;
}

function exportsSymbol(relative: string, symbol: string): boolean {
  const re = new RegExp(
    `^export\\s+(?:async\\s+)?(?:function|const|class|interface|enum)\\s+${symbol}\\b`,
    "m",
  );
  return re.test(fileText(relative));
}

function importsSpecifier(relative: string, target: string): boolean {
  const base = dirname(join(ROOT, relative));
  const key = moduleKey(join(base, target));
  return relativeSpecifiers(relative).some((spec) => moduleKey(join(base, spec)) === key);
}

function moduleKey(path: string): string {
  return resolve(path)
    .replace(/\.[cm]?tsx?$/, "")
    .toLocaleLowerCase();
}

test("http client module is thin and free of the core dependency tree", () => {
  assert.ok(existsSync(join(ROOT, CLIENT_FILE)), `${CLIENT_FILE} must exist`);
  assert.ok(exportsSymbol(CLIENT_FILE, "httpCall"), `${CLIENT_FILE} must export httpCall`);

  assert.ok(
    !importsSpecifier(CLIENT_FILE, "./service.ts"),
    `${CLIENT_FILE} must not import ./service.ts (would pull store.ts into the Pi process)`,
  );
  const coreSpecifiers = relativeSpecifiers(CLIENT_FILE).filter((spec) => spec.includes("/core/"));
  assert.deepEqual(
    coreSpecifiers,
    [],
    `${CLIENT_FILE} must not import any ../core/* module: ${coreSpecifiers.join(", ")}`,
  );
});

test("http server module carries the server implementation", () => {
  assert.ok(existsSync(join(ROOT, SERVER_FILE)), `${SERVER_FILE} must exist`);
  assert.ok(exportsSymbol(SERVER_FILE, "serveHttp"), `${SERVER_FILE} must export serveHttp`);
  assert.ok(
    importsSpecifier(SERVER_FILE, "./service.ts"),
    `${SERVER_FILE} must import ./service.ts (it owns the server)`,
  );
});

test("callers import the http modules, not the retired gRPC modules", () => {
  assert.ok(
    importsSpecifier(DAEMON_CLIENT, "./http-client.ts"),
    `${DAEMON_CLIENT} must import the client from ./http-client.ts`,
  );
  assert.ok(
    importsSpecifier(CLI_MAIN, "./http-client.ts"),
    `${CLI_MAIN} must import httpCall from ./http-client.ts`,
  );
  assert.ok(
    importsSpecifier(CLI_MAIN, "./http-server.ts"),
    `${CLI_MAIN} must import serveHttp from ./http-server.ts`,
  );
});

test("gRPC must not be reintroduced: no module imports it and no @grpc dependency", () => {
  const targetKeys = new Set(RETIRED.map((file) => moduleKey(join(ROOT, file))));
  const offenders: string[] = [];
  for (const directory of SCAN_DIRS) {
    if (!existsSync(join(ROOT, directory))) continue;
    for (const file of tsFiles(directory)) {
      if (targetKeys.has(moduleKey(join(ROOT, file)))) continue;
      for (const spec of relativeSpecifiers(file)) {
        if (targetKeys.has(moduleKey(join(dirname(join(ROOT, file)), spec)))) {
          offenders.push(`${file}: imports ${spec}`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `gRPC must not be reintroduced; these files import retired gRPC modules:\n${offenders.join("\n")}`,
  );

  const pkg = fileText(PKG);
  assert.ok(
    !/"@grpc\/(?:grpc-js|proto-loader)"/.test(pkg),
    "package.json must not re-add the @grpc dependencies",
  );
});

test("http server implements every method the service supports", () => {
  // Methods served by NmgService.invoke's switch, e.g. `case "remember":`.
  const serviceText = fileText(SERVICE_FILE);
  const serviceMethods = new Set(
    [...serviceText.matchAll(/case\s+"([A-Za-z0-9_]+)":/g)].map((m) => m[1]!),
  );
  assert.ok(serviceMethods.size > 0, "service.invoke must declare methods");

  // The server's known-method guard is driven by NMG_METHODS (protocol.ts) —
  // the same list the NmgMethod type derives from.
  const missing = [...serviceMethods].filter(
    (m) => !(NMG_METHODS as readonly string[]).includes(m),
  );
  assert.deepEqual(
    missing,
    [],
    `${SERVER_FILE} must serve every service method; missing: ${missing.join(", ")}`,
  );

  const unimplemented = (NMG_METHODS as readonly string[]).filter(
    (method) => !serviceMethods.has(method),
  );
  assert.deepEqual(
    unimplemented,
    [],
    `protocol registry must not advertise methods without service handlers: ${unimplemented.join(", ")}`,
  );
});
