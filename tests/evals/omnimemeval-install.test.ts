import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installOmniMemEvalAdapter } from "../../evals/omnimemeval/install-adapter.ts";

test("OmniMemEval adapter installer patches the registry idempotently", () => {
  const checkout = mkdtempSync(join(tmpdir(), "omnimemeval-checkout-"));
  const factory = join(checkout, "scripts", "client_factory");
  mkdirSync(factory, { recursive: true });
  const registry = join(factory, "registry.py");
  writeFileSync(registry, "_LIB_CLIENT_REGISTRY = {\n}\n", "utf8");

  try {
    installOmniMemEvalAdapter(checkout);
    installOmniMemEvalAdapter(checkout);
    const source = readFileSync(registry, "utf8");
    assert.equal(source.match(/"nmg": \("nmg_client", "NmgClient"\)/g)?.length, 1);
    assert.equal(existsSync(join(factory, "nmg_client.py")), true);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
