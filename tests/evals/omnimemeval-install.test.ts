import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installOmniMemEvalAdapter } from "../../evals/omnimemeval/install-adapter.ts";

test("OmniMemEval adapter installer patches the registry idempotently", () => {
  const checkout = mkdtempSync(join(tmpdir(), "omnimemeval-checkout-"));
  const factory = join(checkout, "scripts", "client_factory");
  const utils = join(checkout, "scripts", "utils");
  const locomo = join(checkout, "scripts", "locomo");
  mkdirSync(factory, { recursive: true });
  mkdirSync(utils, { recursive: true });
  mkdirSync(locomo, { recursive: true });
  const registry = join(factory, "registry.py");
  writeFileSync(registry, "_LIB_CLIENT_REGISTRY = {\n}\n", "utf8");
  const searchHelpers = join(utils, "search_helpers.py");
  writeFileSync(
    searchHelpers,
    'DEFAULT_SEARCH_DISPATCH = {\n    "memos": generic_text_search,\n}\n',
    "utf8",
  );
  const ingestHelpers = join(utils, "ingest_helpers.py");
  writeFileSync(
    ingestHelpers,
    '_CONV_ID_LIBS = frozenset({"memos", "everos"})\n',
    "utf8",
  );
  const locomoSearch = join(locomo, "locomo_search.py");
  writeFileSync(
    locomoSearch,
    '_search_dispatch = {\n        "memos": generic_text_search,\n}\n',
    "utf8",
  );

  try {
    installOmniMemEvalAdapter(checkout);
    installOmniMemEvalAdapter(checkout);
    const source = readFileSync(registry, "utf8");
    assert.equal(source.match(/"nmg": \("nmg_client", "NmgClient"\)/g)?.length, 1);
    assert.equal(existsSync(join(factory, "nmg_client.py")), true);
    assert.match(
      readFileSync(join(factory, "nmg_client.py"), "utf8"),
      /ensure_ascii=True/,
    );
    assert.equal(
      readFileSync(searchHelpers, "utf8").match(/"nmg": generic_text_search/g)?.length,
      1,
    );
    assert.match(readFileSync(ingestHelpers, "utf8"), /"memos", "everos", "nmg"/);
    assert.equal(
      readFileSync(locomoSearch, "utf8").match(/"nmg": generic_text_search/g)?.length,
      1,
    );
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
});
