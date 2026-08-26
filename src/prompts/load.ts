import { GENERATED_NMG_PROMPTS } from "./nmg-prompts.generated.ts";

/**
 * Prompt source of truth (see nmg-prompts.yaml). The generated TypeScript copy
 * keeps runtime adapters free of YAML parser and filesystem dependencies.
 */
export interface NmgPrompts {
  search_description: string;
  get_description: string;
  remember_description: string;
  mcp_remember_description: string;
  board_description: string;
  lab_description: string;
  reason_description: string;
  reason_action_parameter_description: string;
  reason_node_id_parameter_description: string;
  reason_kind_parameter_description: string;
  reason_content_parameter_description: string;
  reason_status_parameter_description: string;
  reason_importance_parameter_description: string;
  reason_evidence_refs_parameter_description: string;
  reason_source_id_parameter_description: string;
  reason_target_id_parameter_description: string;
  reason_relation_parameter_description: string;
  board_action_parameter_description: string;
  board_task_id_parameter_description: string;
  board_content_parameter_description: string;
  remember_action_parameter_description: string;
  mcp_remember_action_parameter_description: string;
  remember_memory_id_parameter_description: string;
  remember_new_memory_id_parameter_description: string;
  remember_superseded_memory_id_parameter_description: string;
  remember_related_memory_id_parameter_description: string;
  remember_relation_judgement_parameter_description: string;
  remember_board_source_parameter_description: string;
  node_name_parameter_description: string;
  state_key_parameter_description: string;
  external_source_parameter_description: string;
  evidence_parameter_description: string;
  source_actor_parameter_description: string;
  active_graph_id_parameter_description: string;
  mcp_active_graph_id_parameter_description: string;
  feedback_note_parameter_description: string;
  feedback_label_parameter_description: string;
  semantic_task_id_parameter_description: string;
  claim_outcome_parameter_description: string;
  claim_outcome_source_parameter_description: string;
  claim_source_lineage_parameter_description: string;
  claim_indexes_parameter_description: string;
  search_query_parameter_description: string;
  search_queries_parameter_description: string;
  search_progression_required: string;
  search_recommendation: string;
  completion_nudge: string;
  shadow_feedback_nudge: string;
  shadow_claim_outcome_nudge: string;
  search_disclosure: string;
  get_disclosure: string;
  deferred_hint: string;
  get_hint: string;
  forget_hint: string;
  in_context_title: string;
  memory_policy: string;
}

export function loadPrompts(): NmgPrompts {
  return GENERATED_NMG_PROMPTS as NmgPrompts;
}

/**
 * Progressive-disclosure renderer: substitutes {placeholders} with the given
 * values (missing ones become empty) and drops the lines they leave empty.
 * Unknown placeholders are left untouched.
 */
export function renderDisclosure(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{(\w+)\}/g, (_match, key: string) => vars[key] ?? _match)
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .join("\n");
}
