import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { connect } from "@lancedb/lancedb";
import { removeTempDirectory } from "../helpers/temp-directory.ts";

test("Lance conditional publication chooses one concurrent writer and branches preserve readers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "nmg-lance-contract-"));
  const connection = await connect(directory, { readConsistencyInterval: 0 });
  try {
    const first = await connection.createTable("head", [
      { revision: 0, branch: "main", version: 1 },
    ]);
    const second = await connection.openTable("head");
    const winners = await Promise.all([
      first.update({ where: "revision = 0", values: { revision: 1, branch: "a" } }),
      second.update({ where: "revision = 0", values: { revision: 1, branch: "b" } }),
    ]);
    assert.equal(
      winners.reduce((total, result) => total + Number(result.rowsUpdated), 0),
      1,
    );
    const data = await connection.createTable("data", [{ id: "a", content: "before" }]);
    const version = await data.version();
    const branch = await (await data.branches()).create("next", "main", version);
    await branch
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute([
        { id: "a", content: "after" },
        { id: "b", content: "new" },
      ]);
    assert.equal((await data.query().toArray()).length, 1);
    assert.equal((await branch.query().toArray()).length, 2);
    data.close();
    branch.close();
    first.close();
    second.close();
  } finally {
    connection.close();
    removeTempDirectory(directory);
  }
});
