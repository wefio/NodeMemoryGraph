import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { resolveNmgDataDir } from "../cli/data-path.ts";

export interface AgentIdentity {
  /** Stable unique routing key — never changes (industry practice: A2A
   * AgentCard id, Microsoft resolve-by-id). Equal to the anchor on first
   * creation. */
  id: string;
  /** Mutable display label — runtime-renamable through state write board rename. */
  agentName: string;
}

const cachedIdentities = new Map<string, AgentIdentity>();

/** Stable agent identity: a persistent per-agent file under
 * ~/.nmg/agents/<anchor>/identity.json, where anchor = NMG_AGENT_ID (the
 * agent's own stable id, set by the agent itself) or the session id. The id
 * (routing key) never changes; agentName is a mutable display label that a
 * runtime `rename` updates. Multiple agents on one machine never collide
 * because each has its own anchor directory. Survives reload (session-boundary
 * fix): the identity file is re-read, so id and name persist across a host
 * restart. `hostPrefix` namespaces the process-level fallback anchor
 * (<hostPrefix>:<pid>) so two adapters cannot route through the same row. */
export function loadOrCreateAgentIdentity(sessionId: string, hostPrefix = "agent"): AgentIdentity {
  const anchor = process.env.NMG_AGENT_ID?.trim() || sessionId || `${hostPrefix}:${process.pid}`;
  const cachedIdentity = cachedIdentities.get(anchor);
  if (cachedIdentity) return cachedIdentity;
  const dir = join(resolveNmgDataDir(), "agents", anchor);
  const file = join(dir, "identity.json");
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as AgentIdentity;
    if (raw.id && raw.agentName) {
      const identity = { id: raw.id, agentName: raw.agentName };
      cachedIdentities.set(anchor, identity);
      return identity;
    }
  } catch {
    // no identity file yet — create below
  }
  const identity: AgentIdentity = { id: anchor, agentName: anchor };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(identity, null, 2), "utf8");
  } catch {
    // read-only directory — fall back to the in-memory identity
  }
  cachedIdentities.set(anchor, identity);
  return identity;
}

/** Update the mutable display label for an anchor's identity and persist it.
 * The id (routing key) never changes; a later load re-reads the file, so the
 * rename survives a host reload. */
export function renameAgentIdentity(input: {
  anchor: string;
  id: string;
  agentName: string;
}): AgentIdentity {
  const identity: AgentIdentity = { id: input.id, agentName: input.agentName };
  cachedIdentities.set(input.anchor, identity);
  try {
    mkdirSync(join(resolveNmgDataDir(), "agents", input.anchor), { recursive: true });
    writeFileSync(
      join(resolveNmgDataDir(), "agents", input.anchor, "identity.json"),
      JSON.stringify(identity, null, 2),
      "utf8",
    );
  } catch {
    // read-only dir — rename stays in-memory only for this process
  }
  return identity;
}
