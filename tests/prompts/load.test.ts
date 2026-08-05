import assert from "node:assert/strict";
import test from "node:test";

import { loadPrompts, renderDisclosure } from "../../src/prompts/load.ts";

const SECTIONS = [
  "search_description",
  "get_description",
  "remember_description",
  "search_disclosure",
  "mcp_search_disclosure",
  "get_disclosure",
  "deferred_hint",
  "get_hint",
  "forget_hint",
  "forget_redacted",
  "headers_fields",
  "headers_title",
  "in_context_title",
  "memory_policy",
] as const;

test("loadPrompts reads every prompt section from the yaml source", () => {
  const prompts = loadPrompts();
  for (const key of SECTIONS) {
    assert.ok(
      typeof prompts[key] === "string" && prompts[key].length > 0,
      `${key} must be a non-empty string`,
    );
  }
});

test("tool descriptions are neutral: they state capability, not when to call", () => {
  const prompts = loadPrompts();
  for (const key of ["search_description", "get_description", "remember_description"] as const) {
    const text = prompts[key];
    assert.doesNotMatch(text, /\buse when\b/i, `${key} must not advise when to call`);
    assert.doesNotMatch(text, /\bdo not use\b/i, `${key} must not advise when not to call`);
    assert.doesNotMatch(text, /personalized answer/i, `${key} must not bias toward personalization`);
    assert.doesNotMatch(text, /benchmark/i, `${key} must not reference the benchmark`);
  }
});

test("disclosures keep placeholders for runtime substitution", () => {
  const prompts = loadPrompts();
  assert.match(prompts.search_disclosure, /\{count\}/);
  assert.match(prompts.search_disclosure, /\{next_step\}/);
  assert.match(prompts.get_disclosure, /\{count\}/);
});

test("renderDisclosure substitutes placeholders and drops emptied lines", () => {
  const template = "NMG results: {count}\n{next_step}\n{forget_hint}\n- data";
  // Callers pass every known placeholder; absent values are passed as empty strings
  // so their lines are dropped.
  const rendered = renderDisclosure(template, {
    count: "3",
    next_step: "Use nmg_get now.",
    forget_hint: "",
  });
  assert.equal(rendered, "NMG results: 3\nUse nmg_get now.\n- data");
});

test("renderDisclosure leaves unknown placeholders untouched", () => {
  const rendered = renderDisclosure("{count} items {unknown}", { count: "2" });
  assert.equal(rendered, "2 items {unknown}");
});
