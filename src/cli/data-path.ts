import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Resolve the durable NMG data directory from one shared contract.
 *
 * Ordinary clients default to the user-level store. Controlled/headless runs
 * may pass a project-local fallback so their state remains isolated.
 */
export function resolveNmgDataDir(
  environment: NodeJS.ProcessEnv = process.env,
  fallbackDirectory = join(homedir(), ".nmg"),
): string {
  const configured = environment.NMG_DATA_DIR?.trim();
  return resolve(configured || fallbackDirectory);
}
