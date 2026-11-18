# NMG for Magpie

[中文](README.zh-CN.md)

This plugin provides shared NMG tools, gateway context and a management page.
It targets Magpie 0.1.4338 with Bun and an already-running compatible NMG daemon.
The capability declaration is `src/integration/adapter-manifests/magpie.json`.
Plugin options are validated by `options.schema.json`.

## Build and install

From the repository run the following commands.

```text
npm ci
npm run magpie:package -- --output releases/magpie
magpie plugin add ./releases/magpie/nmg
```

Distribute the generated `nmg` directory or its npm archive. When installing from
the archive, extract it, rename the extracted `package` directory to `nmg`, and
run `magpie plugin add ./nmg`. Magpie uses the directory name for the tool prefix
and plugin options. The bundle embeds its runtime dependencies and connects to
the running daemon in the configured NMG data directory.

Magpie exposes the plugin's tools through its Library and plugin MCP server.
Use Library to select which clients receive them. Gateway hooks need the client's
model traffic to pass through Magpie. The NMG page appears in Magpie's navigation.

## Sessions and composition

Gateway requests from `local` or `magpie-key` with an agent and native session
receive an opaque `NMG_BINDING`. Supply that handle to the plugin's tools.
For tools used independently of gateway traffic, call `nmg_session action=open`
once and retain the returned handle in that conversation. Another conversation
opens its own session. A handle authenticates a daemon-owned session scope.

Magpie 0.1.4338 supplies an empty `sessionID` to plugin tools. The plugin uses
sealed handles valid for 24 hours to preserve isolation across this transport. Missing native
identity, remote origins and subagents with only a parent's session skip gateway
preparation. Explicit tool sessions remain available.

Options `nativeCapabilities` select lifecycle capabilities already handled by a
native adapter for each Magpie agent name. Configure this through Magpie's plugin
options. Tools remain independently available through Library selection.
State bodies, evidence budgets and board batches use shared InformationView.
Board delivery and answer diagnostics are recorded after a successful response
whose accepted request contains the prepared context. Reported external tool
outputs retain unknown execution outcome.

## Management

The page reports service-scoped counts, persistent automatic/explicit search
attempts and separately labelled gateway usage. Unknown measurements stay unknown.
The embedding usage table groups daemon HTTP attempts by provider and requested
model, with successful response latency and failure and cancellation counts
over the latest 30 UTC dates.
Embedding settings create a candidate configuration. Connection testing and
index building are explicit actions that can call the selected provider.
Activation requires a ready candidate and explicit selection of managed settings.
The active index stays available during candidate preparation. Keys remain in
the service-owned settings file with owner-only creation permissions and are
redacted from reads. Restart resumes saved settings. A cancelled or interrupted
build can be restarted against its durable pending vectors.

The page service binds loopback on port 3487, configurable by `port`. Its process
token protects management requests. The daemon requires the `operator` method
for management. Existing daemon versions continue to serve supported tools.
