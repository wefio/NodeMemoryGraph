import assert from "node:assert/strict";
import test from "node:test";

import {
  SEARCH_REQUIRED_PARAMETERS,
  SEARCH_TOOL_PARAMETERS,
  searchParameterDescription,
  searchParameterProperties,
} from "../../src/integration/tool-contract.ts";

/**
 * The table is the single description of what a search accepts. Host adapters
 * project it into their own schema library; the per-host tests assert that
 * projection, so a capability added here cannot reach one host and miss another.
 */
test("the shared retrieval contract is well formed", () => {
  const names = SEARCH_TOOL_PARAMETERS.map((parameter) => parameter.name);
  assert.equal(new Set(names).size, names.length, "parameter names must be unique");
  assert.deepEqual([...SEARCH_REQUIRED_PARAMETERS], ["query"]);
  for (const parameter of SEARCH_TOOL_PARAMETERS) {
    assert.ok(
      ["string", "integer", "boolean", "object"].includes(String(parameter.schema.type)),
      `${parameter.name} needs a JSON Schema type`,
    );
    assert.equal(
      typeof parameter.schema.description,
      "string",
      `${parameter.name} needs a description: it is the only text a host can show`,
    );
  }
});

test("the projection hands each adapter a fresh properties object", () => {
  const first = searchParameterProperties();
  assert.deepEqual(
    Object.keys(first),
    SEARCH_TOOL_PARAMETERS.map((p) => p.name),
  );
  first.query!.description = "mutated";
  assert.equal(searchParameterProperties().query!.description, "Focused recall query.");
});

test("a description lookup names what is missing", () => {
  assert.match(searchParameterDescription("eventTimeFrom"), /Earliest event time/u);
  assert.throws(() => searchParameterDescription("nope"), /unknown search parameter/u);
});
