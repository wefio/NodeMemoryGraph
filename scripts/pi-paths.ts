import { resolve } from "node:path";

export interface PiControlPaths {
  agentDirectory: string;
  dataDirectory: string;
  projectDirectory: string;
}

/** Keep the headless Pi helper's reported paths identical to its child env. */
export function resolvePiControlPaths(
  root: string,
  environment: NodeJS.ProcessEnv = process.env,
): PiControlPaths {
  return {
    agentDirectory: resolve(environment.NMG_PI_AGENT_DIR || resolve(root, ".nmg", "pi-agent")),
    dataDirectory: resolve(environment.NMG_DATA_DIR || resolve(root, ".nmg")),
    projectDirectory: resolve(environment.NMG_PROJECT_DIR || root),
  };
}
