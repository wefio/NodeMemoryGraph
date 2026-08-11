import { createHash } from "node:crypto";

const MAX_POLICY_CHARACTERS = 12_000;
const MIN_POLICY_CHARACTERS = 128;
const RESERVED_RUNTIME_TAGS = [
  "<nmg_automatic_recall",
  "<nmg_runtime_ag",
  "<nmg_nudge",
  "<nmg_status",
];

export interface SkillOptPolicyResolution {
  text: string;
  source: "canonical" | "skillopt_lab";
  sha256: string;
}

/**
 * Resolve an explicitly isolated SkillOpt candidate. Production and ordinary
 * Pi processes always receive the canonical YAML policy. The candidate is an
 * evaluation input, never a persistent second source of truth.
 */
export function resolveSkillOptLabPolicy(
  canonical: string,
  environment: NodeJS.ProcessEnv = process.env,
): SkillOptPolicyResolution {
  if (environment.NMG_SKILLOPT_EVAL !== "1") return resolved(canonical, "canonical");
  const encoded = environment.NMG_SKILLOPT_POLICY_B64;
  if (!encoded) throw new Error("NMG_SKILLOPT_EVAL=1 requires NMG_SKILLOPT_POLICY_B64");
  const candidate = Buffer.from(encoded, "base64url").toString("utf8").trim();
  if (candidate.length < MIN_POLICY_CHARACTERS || candidate.length > MAX_POLICY_CHARACTERS) {
    throw new Error(
      `SkillOpt policy must contain ${MIN_POLICY_CHARACTERS}-${MAX_POLICY_CHARACTERS} characters`,
    );
  }
  if (candidate.includes("\0")) throw new Error("SkillOpt policy contains a NUL byte");
  const normalized = candidate.toLocaleLowerCase();
  const reserved = RESERVED_RUNTIME_TAGS.find((tag) => normalized.includes(tag));
  if (reserved) throw new Error(`SkillOpt policy may not inject reserved runtime tag ${reserved}`);
  return resolved(candidate, "skillopt_lab");
}

function resolved(
  text: string,
  source: SkillOptPolicyResolution["source"],
): SkillOptPolicyResolution {
  return {
    text,
    source,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}
