import type { NmgStatusResult } from "../cli/protocol.ts";
import type { AdapterToolSession } from "./adapter-tool-session.ts";

interface DaemonHealth {
  running: boolean;
  pid?: number | null;
  endpoint?: string | null;
  compatible?: boolean;
}

export function createDaemonHealthTool() {
  return {
    name: "nmg_daemon" as const,
    requiresNativeSession: false,
    label: "NMG daemon health",
    description: "Read the running NMG daemon's health and compatibility.",
    inputSchema: {
      type: "object" as const,
      properties: {
        action: { type: "string", enum: ["status"], description: "Health check." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(args: Record<string, unknown>, session: AdapterToolSession) {
      if (args.action !== "status") throw new Error("nmg_daemon requires action=status.");
      const result = (await session.invoke("status", {}, ["daemon", "status", "--json"])) as
        DaemonHealth | NmgStatusResult;
      const health = projectHealth(result, session);
      return {
        details: result,
        text: health.running
          ? `NMG daemon: running pid=${health.pid ?? "unknown"} endpoint=${health.endpoint ?? "unknown"} compatible=${health.compatible}`
          : "NMG daemon: not running (one-shot CLI still works in-process).",
      };
    },
  };
}

function projectHealth(
  result: DaemonHealth | NmgStatusResult,
  session: AdapterToolSession,
): DaemonHealth {
  if ("running" in result) return result;
  return {
    running: true,
    pid: result.process?.pid,
    endpoint: session.daemonAddress?.(),
    compatible: true,
  };
}

export type SharedDaemonHealthTool = ReturnType<typeof createDaemonHealthTool>;
