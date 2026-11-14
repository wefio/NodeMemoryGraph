import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  connectDaemon,
  invokeDaemon,
  shutdownOwnedDaemon,
} from "../../../src/cli/daemon-client.ts";
import { resolveNmgDataDir } from "../../../src/cli/data-path.ts";
import { coordinationEnabled } from "../../../src/integration/config.ts";
import { createNmgMcpServer } from "../../../src/integration/mcp-tools.ts";
import { ADAPTER_CAPABILITY_CATALOG } from "../../../src/integration/adapter-capability-catalog.ts";

const sessionId = process.env.NMG_SESSION_ID?.trim() || `mcp:${process.pid}`;
const binding = { sessionId, agentId: process.env.NMG_AGENT_ID?.trim() || sessionId };
const connection = await connectDaemon(join(resolveNmgDataDir(), "nmg.sqlite"));
const adapter = createNmgMcpServer({
  resolveBinding: () => binding,
  invoke: (method, params, signal) => invokeDaemon(connection, method, params, { signal }),
  capabilities: ADAPTER_CAPABILITY_CATALOG.mcp.capabilities,
});
await adapter.ready;
if (coordinationEnabled()) await adapter.registerPresence(binding);
await adapter.server.connect(new StdioServerTransport());
const done = async () => {
  await invokeDaemon(connection, "sessionActiveGraph", { action: "release", sessionId }).catch(
    () => undefined,
  );
  await shutdownOwnedDaemon(connection);
  process.exit(0);
};
process.on("SIGINT", done);
process.on("SIGTERM", done);
