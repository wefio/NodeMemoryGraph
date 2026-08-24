import assert from "node:assert/strict";
import test from "node:test";

import { loadPrompts, renderDisclosure } from "../../src/prompts/load.ts";

const SECTIONS = [
  "search_description",
  "get_description",
  "remember_description",
  "board_description",
  "reason_description",
  "reason_action_parameter_description",
  "reason_node_id_parameter_description",
  "reason_kind_parameter_description",
  "reason_content_parameter_description",
  "reason_status_parameter_description",
  "reason_importance_parameter_description",
  "reason_evidence_refs_parameter_description",
  "reason_source_id_parameter_description",
  "reason_target_id_parameter_description",
  "reason_relation_parameter_description",
  "board_action_parameter_description",
  "board_task_id_parameter_description",
  "board_content_parameter_description",
  "remember_action_parameter_description",
  "remember_memory_id_parameter_description",
  "remember_new_memory_id_parameter_description",
  "remember_superseded_memory_id_parameter_description",
  "remember_related_memory_id_parameter_description",
  "remember_relation_judgement_parameter_description",
  "node_name_parameter_description",
  "state_key_parameter_description",
  "external_source_parameter_description",
  "evidence_parameter_description",
  "source_actor_parameter_description",
  "active_graph_id_parameter_description",
  "feedback_note_parameter_description",
  "feedback_label_parameter_description",
  "semantic_task_id_parameter_description",
  "claim_outcome_parameter_description",
  "claim_outcome_source_parameter_description",
  "claim_source_lineage_parameter_description",
  "claim_indexes_parameter_description",
  "search_query_parameter_description",
  "search_queries_parameter_description",
  "search_progression_required",
  "search_recommendation",
  "shadow_claim_outcome_nudge",
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

test("stateKey guidance explains reuse, separation, scope, and supersession consequence", () => {
  const text = loadPrompts().state_key_parameter_description;
  assert.match(text, /Good:/u);
  assert.match(text, /Bad:/u);
  assert.match(text, /Reuse the key when the new value makes the old value no longer current/u);
  assert.match(text, /different keys when both values can remain true/u);
  assert.match(text, /canonical scope/u);
  assert.match(text, /automatically supersedes/u);
  assert.match(text, /incorrectly retire/u);
});

test("tool descriptions are neutral: they state capability, not when to call", () => {
  const prompts = loadPrompts();
  for (const key of [
    "search_description",
    "get_description",
    "remember_description",
    "board_description",
    "reason_description",
  ] as const) {
    const text = prompts[key];
    assert.doesNotMatch(text, /\buse when\b/i, `${key} must not advise when to call`);
    assert.doesNotMatch(text, /\bdo not use\b/i, `${key} must not advise when not to call`);
    assert.doesNotMatch(
      text,
      /personalized answer/i,
      `${key} must not bias toward personalization`,
    );
    assert.doesNotMatch(text, /benchmark/i, `${key} must not reference the benchmark`);
  }
});

test("memory policy stops repeated searches for live-source facts", () => {
  const prompts = loadPrompts();
  assert.match(prompts.memory_policy, /historical memory, not a live code\/file\/web source/u);
  assert.match(prompts.memory_policy, /after one deliberate search and selected get/u);
  assert.match(prompts.memory_policy, /stop reformulating/u);
});

test("memory policy exposes the independently verified claim-outcome boundary", () => {
  const text = loadPrompts().memory_policy;
  assert.match(text, /nmg_remember action=claim_outcome/u);
  assert.match(text, /exact current-session user message or successful tool result/u);
  assert.match(text, /independently supports or contradicts/u);
  assert.match(text, /otherwise omit it/u);
  assert.match(text, /Retrieval, answer reuse, task completion/u);
  assert.match(text, /silence, or lack of correction are not claim evidence/u);
});

test("claim-outcome reminder is advisory and keeps the exact evidence boundary", () => {
  const text = loadPrompts().shadow_claim_outcome_nudge;
  assert.match(text, /\{memory_ids\}/u);
  assert.match(text, /current user message or a successful tool result/u);
  assert.match(text, /independently and unambiguously supports or contradicts/u);
  assert.match(text, /claimOutcomeSource=user/u);
  assert.match(text, /exact evidence excerpt/u);
  assert.match(text, /Otherwise omit the call/u);
  assert.match(text, /failed tool output are not claim evidence/u);
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
