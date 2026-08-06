import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

/**
 * Prompt source of truth (see nmg-prompts.yaml). Loaded once per process;
 * editing the yaml takes effect on the next process start (restart the daemon
 * or rerun the eval bridge) without touching code.
 */
export interface NmgPrompts {
  search_description: string;
  get_description: string;
  remember_description: string;
  completion_nudge: string;
  search_disclosure: string;
  mcp_search_disclosure: string;
  get_disclosure: string;
  deferred_hint: string;
  get_hint: string;
  forget_hint: string;
  forget_redacted: string;
  headers_fields: string;
  headers_title: string;
  in_context_title: string;
  memory_policy: string;
}

let cached: NmgPrompts | undefined;

export function loadPrompts(): NmgPrompts {
  cached ??= parse(
    readFileSync(join(import.meta.dirname, "nmg-prompts.yaml"), "utf8"),
  ) as NmgPrompts;
  return cached;
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
