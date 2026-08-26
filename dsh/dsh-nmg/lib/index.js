import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
//#region ../../src/integration/config.ts
/** Cross-Agent coordination is available by default. Explicit false-like values
* disable the adapter tool and wake loop without disabling daemon/CLI storage. */
function coordinationEnabled(environment = process.env) {
	const configured = environment.NMG_ENABLE_COORDINATION?.trim().toLowerCase();
	return configured === void 0 || !(/* @__PURE__ */ new Set([
		"0",
		"false",
		"off",
		"no"
	])).has(configured);
}
//#endregion
//#region ../../src/integration/tool-contract.ts
/** Host-neutral action contracts. Adapters keep their native schema library and
* host-only fields, but must not silently omit these shared lifecycle actions. */
const COMMON_REMEMBER_ACTIONS = [
	"save",
	"supersede",
	"relate",
	"forget",
	"resolve",
	"reopen",
	"claim_outcome"
];
[...COMMON_REMEMBER_ACTIONS.slice(0, -1)];
const COMMON_BOARD_ACTIONS = [
	"put",
	"read",
	"resolve",
	"acknowledge",
	"claim",
	"release",
	"unsubscribe",
	"subscribe",
	"discover"
];
[...COMMON_BOARD_ACTIONS];
//#endregion
//#region ../../src/integration/chain-projection.ts
const DEFAULT_LOGICAL_CHAIN_MAX_CHARS = 2048;
function logicalChainNames(result) {
	return [...new Set((result.chainMemberships ?? []).filter((membership) => membership.chainType === "logical").map((membership) => membership.topic ?? membership.chainId.slice(0, 8)))];
}
function logicalChainCount(context) {
	return new Set(context.results.flatMap((result) => (result.chainMemberships ?? []).filter((membership) => membership.chainType === "logical").map((membership) => membership.chainId))).size;
}
function memoryLabel(index) {
	let value = index + 1;
	let label = "";
	while (value > 0) {
		value -= 1;
		label = String.fromCharCode(65 + value % 26) + label;
		value = Math.floor(value / 26);
	}
	return label;
}
function compactEdgeLines(edges, labels) {
	const unique = [...new Map(edges.map((edge) => [`${edge.sourceMemoryId}\0${edge.targetMemoryId}`, edge])).values()];
	const grouped = (incoming) => {
		const groups = /* @__PURE__ */ new Map();
		for (const edge of unique) {
			const key = incoming ? edge.targetMemoryId : edge.sourceMemoryId;
			const member = incoming ? edge.sourceMemoryId : edge.targetMemoryId;
			const members = groups.get(key) ?? /* @__PURE__ */ new Set();
			members.add(member);
			groups.set(key, members);
		}
		return [...groups.entries()].map(([key, members]) => {
			const keyLabel = labels.get(key);
			const memberLabels = [...members].map((id) => labels.get(id)).join(" & ");
			return incoming ? `${memberLabels} --> ${keyLabel}` : `${keyLabel} --> ${memberLabels}`;
		});
	};
	const outgoing = grouped(false);
	const incoming = grouped(true);
	const cost = (lines) => lines.reduce((sum, line) => sum + line.length + 1, 0);
	return cost(incoming) < cost(outgoing) ? incoming : outgoing;
}
/**
* Host-neutral, budgeted projection of logical chain structure.
*
* Evidence statements remain outside this projection. Adapters render each
* statement once, prefix it with the returned local label, then append `text`
* (or consume `chains` as structured data).
*/
function projectLogicalChains(context, maxChars = DEFAULT_LOGICAL_CHAIN_MAX_CHARS) {
	if (maxChars <= 0) return {
		labels: /* @__PURE__ */ new Map(),
		chains: [],
		foldedChainCount: 0,
		text: ""
	};
	const available = new Set(context.results.map((result) => result.memory.id));
	const labels = new Map(context.results.map((result, index) => [result.memory.id, memoryLabel(index)]));
	const groupedChains = /* @__PURE__ */ new Map();
	for (const result of context.results) for (const membership of result.chainMemberships ?? []) {
		if (membership.chainType !== "logical") continue;
		const chain = groupedChains.get(membership.chainId) ?? {
			topic: membership.topic,
			members: []
		};
		chain.members.push({
			memoryId: result.memory.id,
			position: membership.position
		});
		if (!chain.topic && membership.topic) chain.topic = membership.topic;
		groupedChains.set(membership.chainId, chain);
	}
	const blocks = [];
	for (const [chainId, chain] of groupedChains) {
		const members = [...chain.members].sort((left, right) => left.position - right.position || left.memoryId.localeCompare(right.memoryId));
		const edges = (context.chainEdges ?? []).filter((edge) => edge.chainId === chainId && available.has(edge.sourceMemoryId) && available.has(edge.targetMemoryId));
		const lines = edges.length > 0 ? compactEdgeLines(edges, labels) : members.length > 1 ? [members.map((member) => labels.get(member.memoryId)).join(" --> ")] : [];
		if (lines.length === 0) continue;
		const topic = (chain.topic ?? chainId).replace(/[\r\n]+/gu, " ").trim();
		const projected = {
			chainId,
			topic,
			memoryIds: members.map((member) => member.memoryId),
			lines
		};
		blocks.push({
			chain: projected,
			text: `[logical chain: ${topic}]\nflowchart LR\n${lines.map((line) => `  ${line}`).join("\n")}`
		});
	}
	if (blocks.length === 0) return {
		labels: /* @__PURE__ */ new Map(),
		chains: [],
		foldedChainCount: 0,
		text: ""
	};
	const open = "<nmg_logical_chains>";
	const close = "</nmg_logical_chains>";
	const folded = "[additional logical chains folded by structure budget]";
	const accepted = [];
	for (const block of blocks) if ([
		open,
		...accepted.map((item) => item.text),
		block.text,
		close
	].join("\n").length <= maxChars) accepted.push(block);
	if (accepted.length === 0) return {
		labels: /* @__PURE__ */ new Map(),
		chains: [],
		foldedChainCount: blocks.length,
		text: ""
	};
	const foldedChainCount = blocks.length - accepted.length;
	let text = [
		open,
		...accepted.map((item) => item.text),
		close
	].join("\n");
	if (foldedChainCount > 0) {
		const withFolded = [
			open,
			...accepted.map((item) => item.text),
			folded,
			close
		].join("\n");
		if (withFolded.length <= maxChars) text = withFolded;
	}
	const usedMemoryIds = new Set(accepted.flatMap((item) => item.chain.memoryIds));
	return {
		labels: new Map([...labels].filter(([memoryId]) => usedMemoryIds.has(memoryId))),
		chains: accepted.map((item) => item.chain),
		foldedChainCount,
		text
	};
}
function searchPreview(memory) {
	if ((memory.markers ?? []).some((marker) => marker.kind === "forget")) return "[forget] (content withdrawn)";
	const normalized = memory.statement.replace(/\s+/gu, " ").trim();
	return normalized.length <= 320 ? normalized : `${normalized.slice(0, 319)}…`;
}
/** Agent-facing search projection. Exact records and evidence remain behind `nmg get`. */
function compactSearchContext(context) {
	return {
		candidates: context.results.map((result) => ({
			id: result.memory.id,
			node: result.node.canonicalName,
			type: result.memory.memoryType,
			resolution: result.memory.resolution,
			tier: result.memory.tier,
			preview: searchPreview(result.memory),
			matches: result.hitTerms && result.hitTerms.length > 0 ? result.hitTerms : [result.recallReason ?? "hybrid"],
			eventTime: result.memory.eventTime,
			expiresAt: result.memory.expiresAt ?? result.memory.validUntil,
			score: result.combinedScore,
			chains: logicalChainNames(result)
		})),
		logicalChainCount: logicalChainCount(context),
		activeGraphId: context.activeGraph?.id ?? null,
		tokens: context.activeGraph?.usage.estimatedTokens ?? null,
		deferredMemoryIds: context.progressiveDisclosure?.deferredMemoryIds ?? [],
		qpp: context.activeGraph?.qpp ? {
			trigger: context.activeGraph.qpp.trigger,
			reason: context.activeGraph.qpp.reason,
			score: context.activeGraph.qpp.qpp,
			threshold: context.activeGraph.qpp.threshold
		} : null,
		retrieval: context.retrieval,
		totalMs: context.timings?.totalMs
	};
}
//#endregion
//#region ../../src/integration/agent-surface.ts
function excerpt(value, maxLength) {
	const normalized = value.replace(/\s+/gu, " ").trim();
	return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
function hasMarker(context, kind) {
	return context.results.some(({ memory }) => (memory.markers ?? []).some((marker) => marker.kind === kind));
}
function matchLabel(result) {
	if (result.hitTerms && result.hitTerms.length > 0) return result.hitTerms.join(",");
	return result.recallReason === "learned_route" ? "graph" : result.recallReason === "vector_match" ? "semantic" : result.recallReason ?? "hybrid";
}
function temporalLabels(result) {
	const day = (value) => value ? value.slice(0, 10) : null;
	const labels = [];
	const event = day(result.memory.eventTime);
	if (event) labels.push(`time=${event}`);
	const expires = day(result.memory.expiresAt ?? result.memory.validUntil);
	if (expires) labels.push(`expires=${expires}`);
	return labels;
}
/**
* Host-neutral default rendering for the progressive search surface. Adapters
* may supply host prompt copy, but candidate fields, redaction, chain labels,
* and next-step placement stay identical across hosts.
*/
function renderSearchSurface(context, options = {}) {
	if (context.results.length === 0) return options.emptyText ?? "No matching NMG memory found.";
	const lines = context.results.map((result) => {
		const { memory, node } = result;
		const flags = [(memory.markers ?? []).some((marker) => marker.kind === "external_source") ? "[external]" : "", memory.resolution === "open" || memory.resolution === "reopened" ? "[open]" : ""].filter(Boolean);
		const fields = [
			`memory=${memory.id}`,
			`node=${node.canonicalName}`,
			`type=${memory.memoryType}`,
			...options.includeTier === false ? [] : [`tier=L${memory.tier}`],
			`matches=${matchLabel(result)}`,
			...temporalLabels(result),
			...logicalChainNames(result).length > 0 ? [`chains=${logicalChainNames(result).join(",")}`] : [],
			`preview=${searchPreview(memory)}`
		];
		return `- ${flags.length > 0 ? `${flags.join(" ")} ` : ""}${fields.join("; ")}`;
	});
	const chainCount = logicalChainCount(context);
	return [
		options.preamble,
		...options.candidateHeading ?? [],
		...lines,
		chainCount > 0 ? `logical_chains=${chainCount}; use nmg_get for compact chain structure with exact evidence.` : "",
		context.activeGraph?.id ? `activeGraphId=${context.activeGraph.id}` : "",
		options.performanceLine,
		options.nextStep,
		hasMarker(context, "forget") ? options.forgetHint : ""
	].filter(Boolean).join("\n");
}
/** Exact-evidence surface. Statements are emitted once; logical structure has
* an independent budget and refers to stable local labels. */
function renderEvidenceSurface(context, options = {}) {
	const chains = projectLogicalChains(context, options.logicalChainMaxChars ?? 2048);
	const sourceMaxChars = options.sourceMaxChars ?? 320;
	const records = context.results.map(({ memory, node, evidence }) => {
		const external = (memory.markers ?? []).find((marker) => marker.kind === "external_source");
		const forgotten = (memory.markers ?? []).some((marker) => marker.kind === "forget");
		const flags = [
			chains.labels.get(memory.id) ? `[${chains.labels.get(memory.id)}]` : "",
			external ? `[external, ${memory.truthStatus}]` : "",
			memory.resolution === "open" || memory.resolution === "reopened" ? "[open]" : ""
		].filter(Boolean);
		const details = [
			`memory=${memory.id}`,
			`node=${node.canonicalName}`,
			`type=${memory.memoryType}`,
			`truth=${memory.truthStatus}`,
			`scope=${JSON.stringify(memory.scope)}`,
			...options.includeEventTime && memory.eventTime ? [`time=${memory.eventTime}`] : []
		];
		const externalSource = external?.attributes?.source ? `\n  EXTERNAL_SOURCE=${String(external.attributes.source)}; retrievedAt=${String(external.attributes.retrievedAt ?? "unknown")}` : "";
		const source = !(forgotten && options.redactForgotten) && evidence.content.trim() !== memory.statement.trim() ? `\n  SOURCE=${excerpt(evidence.content, sourceMaxChars)}` : "";
		const statement = forgotten && options.redactForgotten ? "[forget] (content withdrawn)" : memory.statement;
		const annotation = options.annotations?.get(memory.id);
		return `- ${flags.length > 0 ? `${flags.join(" ")} ` : ""}${statement}\n  ${details.join("; ")}${externalSource}${source}${annotation ? `\n  ${annotation}` : ""}`;
	});
	const missing = options.missingMemoryIds?.length ? `MISSING: ${options.missingMemoryIds.join(", ")}` : "";
	return [
		options.preamble,
		...records,
		missing,
		chains.text,
		options.nextStep,
		options.forgetHint
	].filter(Boolean).join("\n") || options.emptyText || "No active memory found.";
}
/** Default follow-up guidance after a durable save. The model remains the
* semantic judge; NMG only exposes bounded candidates. */
function renderRememberSurface(result) {
	const memoryId = result.memory?.id;
	const lines = [`Saved${memoryId ? ` ${memoryId}` : " memory"}.`];
	const supersede = (result.supersedeCandidates ?? []).slice(0, 3);
	if (supersede.length > 0 && memoryId) lines.push("NMG found possible older values. Similarity is only a candidate signal; decide semantically.", ...supersede.map((candidate) => `- ${candidate.memoryId}: ${excerpt(candidate.statement, 180)}`), "If exactly one candidate is genuinely replaced in the same scope, call nmg_remember again with action=supersede, newMemoryId, supersededMemoryId, and a short reason. Otherwise do nothing.");
	const duplicates = (result.duplicates ?? []).filter((candidate) => candidate.memoryId !== memoryId);
	if (duplicates.length > 0) lines.push("Possible semantic neighbours were retained as distinct nodes:", ...duplicates.slice(0, 3).map((candidate) => `- ${candidate.memoryId}: ${excerpt(candidate.statement, 180)}`), "Only if a relationship is useful, call nmg_remember again with action=relate, newMemoryId, relatedMemoryId, and relationJudgement. Similarity alone is not identity; otherwise do nothing.");
	return lines.join("\n");
}
const TASK_BOARD_CONVENTIONS = "Board conventions (on use): entries may carry memory=<id> references to LTG records — readers expand them with nmg_get; open entries can be claimed by one Agent (lease-based, expired claims return to the pool) and released; resolve a request once it is answered — a resolved entry is closed and must not be replied to (reopen only with new substance); keep entries concise and temporary; taskId is the only channel boundary (no DMs, mentions, groups, or pinning).";
/** Host-neutral board rendering. Host-only actions such as Pi rename remain in
* the adapter and can bypass this renderer. */
function renderTaskBoardSurface(result, options) {
	if (result.action === "discover") {
		const agents = result.agents ?? [];
		return agents.length === 0 ? "No online NMG agents match the requested capability." : [
			"Online NMG agents:",
			...agents.map((agent) => `- ${agent.agentName}${agent.description ? ` — ${agent.description}` : ""}${agent.capabilities ? ` capabilities=${agent.capabilities}` : ""} (id=${agent.id ?? agent.agentName}; lastSeen=${agent.lastSeenAt})`),
			"Use nmg_board action=put with to=<agent name> for directed delivery."
		].join("\n");
	}
	const entries = result.entries ?? (result.entry ? [result.entry] : []);
	const lines = [];
	for (const board of options.directory ?? []) {
		if (lines.length === 0) lines.push("Active named channels (world channel lobby):");
		lines.push(`- ${board.taskId} (${board.entryCount} open · updated ${board.lastUpdatedAt.slice(0, 10)})`);
	}
	if (lines.length > 0) lines.push("");
	if (entries.length === 0) lines.push(options.emptyText ?? `Task board ${options.taskId} has no matching entries.`);
	else {
		for (const entry of entries) {
			const claim = entry.claimedBy ? ` [claimed by ${entry.claimedBy}]` : "";
			const ack = entry.ackedBy?.length ? ` (✅ acked by ${entry.ackedBy.join(", ")})` : "";
			lines.push(`- #${String(entry.sequence ?? "?")} ${String(entry.id ?? "?")} [${String(entry.kind ?? "entry")}/${String(entry.status ?? "open")}]${claim}${ack} ${String(entry.agentId ?? "unknown")}: ${excerpt(String(entry.content ?? ""), 500)}`);
		}
		if (result.action === "read") lines.push(`nextCursor=${String(result.nextCursor ?? 0)}`);
	}
	lines.push("Temporary coordination only; use nmg_remember separately for durable knowledge.");
	if (options.includeConventions !== false) lines.push(TASK_BOARD_CONVENTIONS);
	return lines.join("\n");
}
//#endregion
//#region src/plugin/index.ts
const inject = [
	"tools",
	"subprocess",
	"sandboxPolicy",
	"systemPrompt",
	"timer"
];
/** Tool output shape: a single pre-rendered text block. */
const textOutput = {
	schema: { type: "string" },
	render: (_args, value) => [{
		type: "text",
		text: String(value)
	}]
};
/** CJK-aware fallback token estimator used only when the daemon is down. */
function estimateTokens(text) {
	let cjk = 0;
	let latin = 0;
	for (const ch of String(text || "")) if (ch.codePointAt(0) > 12287) cjk += 1;
	else if (!/\s/.test(ch)) latin += 1;
	return Math.ceil(cjk + latin / 4);
}
function apply(ctx) {
	const tools = ctx.tools;
	const subprocess = ctx.subprocess;
	const sandboxPolicy = ctx.sandboxPolicy;
	const systemPrompt = ctx.systemPrompt;
	const coordinationEnabled$1 = coordinationEnabled();
	const workspaceRoot = process.env.NMG_PROJECT_DIR && process.env.NMG_PROJECT_DIR.trim() || sandboxPolicy && typeof sandboxPolicy.workspaceRoot === "string" && sandboxPolicy.workspaceRoot || "C:\\Documents\\GitHub\\NodeMemoryGraph";
	const binPath = workspaceRoot.replace(/[\\/]+$/, "") + "\\bin\\nmg.mjs";
	let nodePromise;
	function resolveNode() {
		if (nodePromise === void 0) nodePromise = subprocess.resolveExecutable("node").catch(() => "node");
		return nodePromise;
	}
	function truncate(value, max) {
		const t = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
		return t.length <= max ? t : t.slice(0, max - 1) + "…";
	}
	function clampInt(raw, min, max, fallback) {
		const value = Number(raw);
		return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback;
	}
	function isProcessAlive(pid) {
		if (!Number.isInteger(pid) || pid <= 0) return false;
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			return error.code !== "ESRCH";
		}
	}
	let daemon = null;
	function resolveDaemon() {
		if (daemon) return daemon;
		try {
			const home = process.env.USERPROFILE || process.env.HOME || "";
			const envDir = (process.env.NMG_DATA_DIR || "").replace(/[\\/]+$/, "");
			const candidates = [];
			if (envDir) candidates.push(envDir);
			candidates.push(join(home, ".nmg"));
			const projectDir = join(workspaceRoot, ".nmg");
			if (!candidates.includes(projectDir)) candidates.push(projectDir);
			for (const dataDir of candidates) try {
				const state = JSON.parse(readFileSync(join(dataDir, "nmg.sqlite.server.json"), "utf8"));
				if (state.transport !== "http" || !state.host || !state.port || !state.token) continue;
				if (!isProcessAlive(state.pid)) continue;
				daemon = {
					host: state.host,
					port: state.port,
					token: state.token,
					pid: state.pid
				};
				return daemon;
			} catch {}
		} catch {
			daemon = null;
		}
		return daemon;
	}
	async function daemonCall(method, params, signal) {
		const endpoint = resolveDaemon();
		if (!endpoint) return null;
		try {
			const response = await fetch("http://" + endpoint.host + ":" + endpoint.port + "/", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: "Bearer " + endpoint.token
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					method,
					params,
					id: 1
				}),
				signal
			});
			const text = await response.text();
			if (!response.ok) throw new Error(text || "nmg " + method + " failed (" + response.status + ")");
			const parsed = JSON.parse(text);
			if (parsed.error) throw new Error(parsed.error.message || "nmg " + method + " error");
			return parsed.result;
		} catch (error) {
			if (error && error.name === "AbortError") throw error;
			daemon = null;
			return null;
		}
	}
	function probePort(host, port, timeoutMs = 800) {
		return new Promise((resolve) => {
			let socket;
			try {
				socket = connect({
					host,
					port
				});
			} catch {
				return resolve(false);
			}
			let done = false;
			const finish = (ok) => {
				if (done) return;
				done = true;
				try {
					socket.destroy();
				} catch {}
				resolve(ok);
			};
			socket.setTimeout(timeoutMs);
			socket.once("connect", () => finish(true));
			socket.once("timeout", () => finish(false));
			socket.once("error", () => finish(false));
		});
	}
	async function ensureDaemon(signal) {
		let endpoint = resolveDaemon();
		if (endpoint && await probePort(endpoint.host, endpoint.port)) return endpoint;
		if (endpoint && endpoint.pid) try {
			process.kill(endpoint.pid);
		} catch {}
		daemon = null;
		try {
			await runNmg(["daemon", "start"], signal);
			await new Promise((resolve) => setTimeout(resolve, 2500));
		} catch {}
		daemon = null;
		endpoint = resolveDaemon();
		if (endpoint && await probePort(endpoint.host, endpoint.port)) return endpoint;
		return null;
	}
	async function runNmg(args, signal) {
		const node = await resolveNode();
		const handle = subprocess.spawn({
			argv: [node, binPath].concat(args),
			cwd: workspaceRoot,
			stdio: {
				stdin: "ignore",
				stdout: { maxBytes: 524288 },
				stderr: { maxBytes: 65536 }
			},
			graceMs: 8e3,
			signal
		});
		const outcome = await handle.done;
		const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : "";
		const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : "";
		return {
			exitCode: outcome.exitCode,
			stdout,
			stderr
		};
	}
	async function nmgJson(args, signal) {
		let run;
		try {
			run = await runNmg(args, signal);
		} catch (error) {
			return {
				ok: false,
				error: "NMG spawn failed: " + truncate(error && error.message ? error.message : String(error), 500)
			};
		}
		if (run.exitCode !== 0) {
			const detail = (run.stderr || run.stdout || "").trim();
			return {
				ok: false,
				error: "NMG exit " + run.exitCode + (detail ? ": " + truncate(detail, 500) : "")
			};
		}
		let data;
		try {
			data = JSON.parse(run.stdout);
		} catch {
			return {
				ok: false,
				error: "NMG non-JSON output: " + truncate(run.stdout, 500)
			};
		}
		return {
			ok: true,
			data
		};
	}
	function scopeArgs(scope) {
		if (scope === null || typeof scope !== "object") return [];
		return Object.keys(scope).map((key) => ["--scope", String(key) + "=" + String(scope[key])]);
	}
	function coerceScope(scope) {
		const out = {};
		for (const key of Object.keys(scope || {})) out[key] = String(scope[key]);
		return out;
	}
	function projectDaemonStatus(raw) {
		const endpoint = resolveDaemon();
		return {
			running: true,
			pid: endpoint && endpoint.pid != null ? endpoint.pid : null,
			endpoint: endpoint ? endpoint.host + ":" + endpoint.port : null,
			compatible: true,
			status: raw
		};
	}
	async function invoke(method, params, cliArgs, signal, project) {
		try {
			const raw = await daemonCall(method, params, signal);
			if (raw != null) return {
				ok: true,
				data: project ? project(raw) : raw
			};
		} catch {
			return {
				ok: false,
				error: "NMG call aborted"
			};
		}
		return nmgJson(cliArgs, signal);
	}
	async function invokeRpcOnly(method, params, signal) {
		try {
			let raw = await daemonCall(method, params, signal);
			if (raw == null) {
				await ensureDaemon(signal);
				raw = await daemonCall(method, params, signal);
			}
			return raw == null ? {
				ok: false,
				error: "NMG daemon is unavailable for " + method
			} : {
				ok: true,
				data: raw
			};
		} catch {
			return {
				ok: false,
				error: "NMG call aborted"
			};
		}
	}
	const recallWindows = /* @__PURE__ */ new Map();
	const sessionTokenTotals = /* @__PURE__ */ new Map();
	const recallBatch = /* @__PURE__ */ new Map();
	const MAX_RECALL_HISTORY = 5;
	const openSearches = /* @__PURE__ */ new Map();
	function nextGeneration(sessionId) {
		let window = recallWindows.get(sessionId);
		if (!window) {
			window = {
				generation: 0,
				injected: /* @__PURE__ */ new Map()
			};
			recallWindows.set(sessionId, window);
		}
		window.generation += 1;
		return window;
	}
	function filterRecallCandidates(window, generation, candidates) {
		const fresh = [];
		for (const candidate of candidates || []) {
			const previousGeneration = window.injected.get(candidate.id);
			if (previousGeneration != null && generation - previousGeneration <= 12) continue;
			fresh.push(candidate);
		}
		for (const [id, injectedGeneration] of window.injected) if (generation - injectedGeneration > 12) window.injected.delete(id);
		return fresh;
	}
	function extractUserPrompt(message) {
		const parts = [];
		if (!message || typeof message !== "object") return "";
		for (const block of message.content || []) if (block.type === "text" && block.text) parts.push(block.text);
		const joined = parts.join(" ").replace(/\s+/g, " ").trim();
		return joined.length > 500 ? joined.slice(0, 500) : joined;
	}
	function formatRecall(candidates, activeGraphId, tokens, sessionTotal) {
		const lines = candidates.map((c) => "mid=" + c.id + "	node=" + c.node + "	type=" + c.type + "	L" + c.tier + "	" + truncate(c.preview, 160));
		if (activeGraphId) lines.push("activeGraphId=" + activeGraphId);
		if (tokens != null) lines.push("recall tokens ~" + tokens + (sessionTotal != null ? " · session ~" + sessionTotal : ""));
		lines.push("Load exact records with nmg_get (mids + activeGraphId).");
		return "NMG memory (automatic recall):\n" + lines.join("\n");
	}
	function recallBudget(signal) {
		try {
			return AbortSignal.any([signal, AbortSignal.timeout(1500)]);
		} catch {
			return signal;
		}
	}
	async function autoRecall(query, sessionId, signal) {
		const limit = clampInt(process.env.NMG_AUTO_RECALL_LIMIT, 1, 50, 13);
		const tier = clampInt(process.env.NMG_AUTO_RECALL_TIER, 0, 3, 1);
		const budget = recallBudget(signal);
		try {
			const context = await daemonCall("search", {
				query,
				limit,
				maxTier: tier,
				graphHops: 1,
				tieredDisclosure: true,
				projectDir: workspaceRoot,
				sessionId
			}, budget);
			if (context) return compactSearchContext(context);
		} catch {
			return null;
		}
		const result = await nmgJson([
			"search",
			query,
			"--limit",
			String(limit),
			"--max-tier",
			String(tier),
			"--graph-hops",
			"1",
			"--tiered-disclosure",
			"--project-dir",
			workspaceRoot,
			"--session-id",
			sessionId,
			"--compact-json"
		], budget);
		return result.ok ? result.data : null;
	}
	function onInboxInserted(payload) {
		try {
			const { agent, message } = payload || {};
			if (!agent || !message) return;
			lastAgents.set(String(agent.id), agent);
			const sessionId = String(agent.id);
			const query = extractUserPrompt(message);
			if (!query) return;
			const window = nextGeneration(sessionId);
			const generation = window.generation;
			const run = (async () => {
				try {
					const recall = await autoRecall(query, sessionId, void 0);
					if (!recall || !Array.isArray(recall.candidates) || recall.candidates.length === 0) return;
					const fresh = filterRecallCandidates(window, generation, recall.candidates);
					if (fresh.length === 0) return;
					const thisTokens = recall.tokens != null ? recall.tokens : estimateTokens(fresh.map((c) => c.preview).join(" "));
					const sessionTotal = (sessionTokenTotals.get(sessionId) || 0) + thisTokens;
					sessionTokenTotals.set(sessionId, sessionTotal);
					const text = formatRecall(fresh, recall.activeGraphId, thisTokens, sessionTotal);
					const entry = {
						generation,
						text,
						tokens: thisTokens,
						sessionTotal,
						candidates: fresh,
						activeGraphId: recall.activeGraphId
					};
					const history = recallBatch.get(sessionId);
					recallBatch.set(sessionId, [entry, ...history || []].slice(0, MAX_RECALL_HISTORY));
					for (const candidate of fresh) window.injected.set(candidate.id, generation);
				} catch {}
			})();
			openSearches.set(sessionId, run);
			run.finally(() => {
				if (openSearches.get(sessionId) === run) openSearches.delete(sessionId);
			});
		} catch {}
	}
	function recallTextFor(agent) {
		if (!agent) return "";
		try {
			const stack = recallBatch.get(String(agent.id));
			const latest = Array.isArray(stack) ? stack[0] : stack;
			return latest && latest.text ? latest.text : "";
		} catch {
			return "";
		}
	}
	function recallDataFor(sessionId) {
		if (!sessionId) return null;
		try {
			const stack = recallBatch.get(String(sessionId));
			const list = Array.isArray(stack) ? stack : stack ? [stack] : [];
			if (list.length === 0) return null;
			return { recalls: list.map((snapshot) => ({
				generation: snapshot.generation,
				tokens: snapshot.tokens,
				sessionTotal: snapshot.sessionTotal,
				activeGraphId: snapshot.activeGraphId || null,
				candidates: (snapshot.candidates || []).map((c) => ({
					id: c.id,
					node: c.node,
					type: c.type,
					tier: c.tier,
					preview: c.preview
				}))
			})) };
		} catch {
			return null;
		}
	}
	function onAgentDisposed(payload) {
		try {
			if (payload && payload.agent) {
				const id = String(payload.agent.id);
				recallWindows.delete(id);
				sessionTokenTotals.delete(id);
				recallBatch.delete(id);
				openSearches.delete(id);
				wakeBatch.delete(id);
				lastAgents.delete(id);
			}
		} catch {}
	}
	const hostSessionId = (process.env.DSH_SESSION_ID || "").trim() || "dsh";
	const projectName = workspaceRoot.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "dsh";
	const WAKE_AGENT_ID = "dsh:" + projectName;
	const WAKE_AGENT_NAME = projectName;
	const WAKE_WORLD_TASK = "default";
	const WAKE_MAX_ENTRIES = 50;
	const WAKE_KINDS = /* @__PURE__ */ new Set([
		"question",
		"blocker",
		"handoff"
	]);
	const KIND_RANK = {
		question: 0,
		blocker: 1,
		handoff: 2
	};
	const BROADCAST_PREFIX = "[NMG board 协作广播]";
	const WORLD_BROADCAST_SESSION = "world-broadcast";
	const BROADCAST_KINDS = /* @__PURE__ */ new Set([
		"question",
		"blocker",
		"handoff"
	]);
	const BROADCAST_TTL_SECONDS = 86400;
	const WAKE_INTERVAL_MS = clampInt(process.env.NMG_BOARD_WAKE_INTERVAL_SEC, 5, 3600, 30) * 1e3;
	const wakeBatch = /* @__PURE__ */ new Map();
	let wakeAgentRegistered = false;
	let wakeConfig = null;
	let lastAgents = /* @__PURE__ */ new Map();
	function wakeEntryKey(entry) {
		return entry && entry.id ? String(entry.id) : "";
	}
	function wakeEntryLine(entry) {
		return "#" + entry.sequence + " " + entry.id + " [" + entry.kind + "/" + entry.status + "] " + (entry.agentId || "?") + ": " + truncate(entry.content, 200);
	}
	function loadWakeConfig() {
		try {
			const home = process.env.USERPROFILE || process.env.HOME || "";
			const dataDir = (process.env.NMG_DATA_DIR || join(home, ".nmg")).replace(/[\\/]+$/, "");
			wakeConfig = JSON.parse(readFileSync(join(dataDir, "board-wake.json"), "utf8"));
		} catch {
			wakeConfig = null;
		}
	}
	function pushWakeEntry(entry, targetSessionId) {
		if (!entry || !targetSessionId) return;
		const key = wakeEntryKey(entry);
		if (!key) return;
		const existing = wakeBatch.get(targetSessionId) || [];
		if (existing.some((e) => wakeEntryKey(e) === key)) return;
		wakeBatch.set(targetSessionId, [entry].concat(existing).slice(0, WAKE_MAX_ENTRIES));
	}
	function isWakeCandidate(entry, extraTargets) {
		const now = Date.now();
		const liveClaim = entry.claimExpiresAt != null && new Date(entry.claimExpiresAt).getTime() > now;
		const addressedToOther = entry.to != null && entry.to !== WAKE_AGENT_ID && entry.to !== WAKE_AGENT_NAME && !(extraTargets && extraTargets.has(entry.to));
		const serialQueued = entry.serialState === "pending";
		return entry.status === "open" && WAKE_KINDS.has(entry.kind) && !liveClaim && !addressedToOther && !serialQueued && !String(entry.content || "").startsWith(BROADCAST_PREFIX);
	}
	function removeWakeEntry(entryId) {
		for (const [key, list] of wakeBatch) {
			const next = list.filter((entry) => wakeEntryKey(entry) !== String(entryId));
			if (next.length) wakeBatch.set(key, next);
			else wakeBatch.delete(key);
		}
	}
	async function maybeBroadcastToWorld(entry, agentId, sessionId) {
		if (!entry || String(entry.content || "").startsWith(BROADCAST_PREFIX)) return false;
		if (!BROADCAST_KINDS.has(entry.kind)) return false;
		const worldCheck = await daemonCall("taskBoard", {
			action: "deliveryCheck",
			taskId: WAKE_WORLD_TASK,
			agentId,
			sessionId: WORLD_BROADCAST_SESSION,
			entryIds: [wakeEntryKey(entry)]
		});
		if (worldCheck && Array.isArray(worldCheck.delivered) && worldCheck.delivered.includes(wakeEntryKey(entry))) return false;
		const excerpt = String(entry.content || "").length > 140 ? String(entry.content || "").slice(0, 140) + "…" : String(entry.content || "");
		const label = entry.kind === "question" ? "问题" : entry.kind === "blocker" ? "阻塞" : "交接";
		const broadcast = "[NMG board 协作广播] 频道 " + (entry.taskId || "?") + " 有 #" + entry.sequence + " 未认领的" + label + "（open）：" + excerpt + "。有空的 agent 可用 nmg_board read taskId=" + (entry.taskId || "?") + " 查看详情、claim 认领处理。";
		await daemonCall("taskBoard", {
			action: "put",
			taskId: WAKE_WORLD_TASK,
			agentId,
			sourceSessionId: sessionId,
			kind: "handoff",
			content: broadcast,
			ttlSeconds: BROADCAST_TTL_SECONDS
		});
		await daemonCall("taskBoard", {
			action: "recordDelivery",
			entryId: wakeEntryKey(entry),
			sessionId: WORLD_BROADCAST_SESSION,
			agentId,
			source: "wake-broadcast"
		});
		return true;
	}
	async function boardWakeOnce() {
		if (!await ensureDaemon()) {
			wakeAgentRegistered = false;
			return;
		}
		try {
			loadWakeConfig();
			if (wakeConfig && wakeConfig.enabled === false) return;
			if (!wakeAgentRegistered) {
				await daemonCall("taskBoard", {
					action: "registerAgent",
					id: WAKE_AGENT_ID,
					agentName: WAKE_AGENT_NAME,
					description: "DSH NMG adapter (NodeMemoryGraph host package)",
					capabilities: "dsh-nmg",
					supportedInterfaces: "dsh-harness"
				});
				wakeAgentRegistered = true;
			}
			await daemonCall("taskBoard", {
				action: "heartbeat",
				id: WAKE_AGENT_ID
			});
			const candidates = [];
			const seen = /* @__PURE__ */ new Set();
			const collect = (taskId, entries) => {
				for (const entry of entries || []) {
					const key = wakeEntryKey(entry);
					if (!key || seen.has(key)) continue;
					seen.add(key);
					candidates.push(taskId == null ? entry : {
						...entry,
						taskId
					});
				}
			};
			const agentsService = ctx.get("agents");
			if (agentsService && typeof agentsService.list === "function") {
				for (const agent of agentsService.list()) if (agent && agent.id) lastAgents.set(String(agent.id), agent);
			}
			const subagents = ctx.get("subagents");
			const childTargets = /* @__PURE__ */ new Set();
			const childMap = /* @__PURE__ */ new Map();
			if (subagents && typeof subagents.listChildren === "function") for (const [parentSessionId, parent] of lastAgents) {
				if (!parent) continue;
				let children;
				try {
					children = await subagents.listChildren(parentSessionId);
				} catch {
					continue;
				}
				for (const child of children || []) {
					if (!child || child.kind !== "child" || child.mode !== "continuable") continue;
					const childId = String(child.id);
					childTargets.add(childId);
					childMap.set(childId, parent);
					const childDirected = await daemonCall("taskBoard", {
						action: "readDirected",
						agentId: childId,
						agentName: childId,
						limit: WAKE_MAX_ENTRIES
					});
					collect(null, childDirected && childDirected.entries);
				}
			}
			const directed = await daemonCall("taskBoard", {
				action: "readDirected",
				agentId: WAKE_AGENT_ID,
				agentName: WAKE_AGENT_NAME,
				limit: WAKE_MAX_ENTRIES
			});
			collect(null, directed && directed.entries);
			const world = await daemonCall("taskBoard", {
				action: "read",
				taskId: WAKE_WORLD_TASK,
				agentId: WAKE_AGENT_ID,
				limit: WAKE_MAX_ENTRIES
			});
			collect(WAKE_WORLD_TASK, world && world.entries);
			const subs = await daemonCall("taskBoard", {
				action: "listSubscriptions",
				agentId: WAKE_AGENT_ID,
				sessionId: hostSessionId
			});
			for (const board of subs && Array.isArray(subs.subscriptions) && subs.subscriptions || []) {
				if (!board.taskId || board.taskId === WAKE_WORLD_TASK) continue;
				const read = await daemonCall("taskBoard", {
					action: "read",
					taskId: board.taskId,
					agentId: WAKE_AGENT_ID,
					limit: WAKE_MAX_ENTRIES
				});
				collect(board.taskId, read && read.entries);
			}
			const mine = candidates.filter((entry) => isWakeCandidate(entry, childTargets));
			if (wakeConfig && wakeConfig.worldBroadcast) for (const entry of mine) try {
				await maybeBroadcastToWorld(entry, WAKE_AGENT_ID, hostSessionId);
			} catch {}
			if (mine.length === 0) return;
			for (const [agentSessionId, agent] of lastAgents) {
				if (!agent || typeof agent.send !== "function") continue;
				const theirs = mine.filter((entry) => {
					if (childTargets.has(String(entry.to || ""))) return false;
					return !(entry.sourceSessionId === agentSessionId && entry.agentId === WAKE_AGENT_ID || entry.sourceSessionId === agentSessionId || entry.sourceSessionId == null && entry.agentId === WAKE_AGENT_ID);
				});
				if (theirs.length === 0) continue;
				const fresh = [];
				for (const taskId of new Set(theirs.map((c) => c.taskId))) {
					const group = theirs.filter((c) => c.taskId === taskId);
					const check = await daemonCall("taskBoard", {
						action: "deliveryCheck",
						agentId: WAKE_AGENT_ID,
						sessionId: agentSessionId,
						taskId: taskId || WAKE_WORLD_TASK,
						entryIds: group.map(wakeEntryKey)
					});
					if (check && check.suppressed) continue;
					const delivered = new Set(check && Array.isArray(check.delivered) && check.delivered || []);
					const acked = new Set(check && Array.isArray(check.acked) && check.acked || []);
					for (const entry of group) if (!delivered.has(wakeEntryKey(entry)) && !acked.has(wakeEntryKey(entry))) fresh.push(entry);
				}
				if (fresh.length === 0) continue;
				fresh.sort((left, right) => (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) || String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
				const pick = fresh[0];
				pushWakeEntry(pick, agentSessionId);
				if (wakeAgent(agent, pick)) await daemonCall("taskBoard", {
					action: "recordDelivery",
					agentId: WAKE_AGENT_ID,
					sessionId: agentSessionId,
					entryId: wakeEntryKey(pick),
					source: "wake"
				});
			}
			for (const [childId, parent] of childMap) {
				const theirs = mine.filter((entry) => String(entry.to || "") === childId && entry.sourceSessionId !== childId);
				if (theirs.length === 0) continue;
				const fresh = [];
				for (const taskId of new Set(theirs.map((c) => c.taskId))) {
					const group = theirs.filter((c) => c.taskId === taskId);
					const check = await daemonCall("taskBoard", {
						action: "deliveryCheck",
						agentId: childId,
						sessionId: childId,
						taskId: taskId || WAKE_WORLD_TASK,
						entryIds: group.map(wakeEntryKey)
					});
					if (check && check.suppressed) continue;
					const delivered = new Set(check && Array.isArray(check.delivered) && check.delivered || []);
					const acked = new Set(check && Array.isArray(check.acked) && check.acked || []);
					for (const entry of group) if (!delivered.has(wakeEntryKey(entry)) && !acked.has(wakeEntryKey(entry))) fresh.push(entry);
				}
				if (fresh.length === 0) continue;
				fresh.sort((left, right) => (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) || String(left.createdAt || "").localeCompare(String(right.createdAt || "")));
				const pick = fresh[0];
				try {
					await subagents.followup(parent, childId, [{
						type: "text",
						text: wakeMessageText(pick)
					}], {
						source: {
							kind: "plugin",
							plugin: "@nmg/dsh-nmg"
						},
						signal: AbortSignal.timeout(5e3)
					});
				} catch {
					continue;
				}
				await daemonCall("taskBoard", {
					action: "recordDelivery",
					agentId: childId,
					sessionId: childId,
					entryId: wakeEntryKey(pick),
					source: "wake"
				});
				pushWakeEntry(pick, childId);
			}
		} catch {
			wakeAgentRegistered = false;
		}
	}
	function wakeMessageText(entry) {
		return "[NMG board] 新黑板条目 #" + entry.sequence + " [" + entry.kind + "] " + (entry.taskId || "?") + " by " + (entry.agentId || "?") + ":\n" + truncate(entry.content, 400);
	}
	function wakeAgent(agent, entry) {
		if (!agent || typeof agent.send !== "function") return false;
		try {
			agent.send({
				id: randomUUID(),
				role: "user",
				content: [{
					type: "text",
					text: wakeMessageText(entry)
				}],
				source: {
					kind: "plugin",
					plugin: "@nmg/dsh-nmg"
				}
			}, "next-turn", true);
			return true;
		} catch {
			return false;
		}
	}
	function wakeTextFor(agent) {
		if (!agent) return "";
		try {
			const batch = wakeBatch.get(String(agent.id));
			if (!Array.isArray(batch) || batch.length === 0) return "";
			const lines = batch.map(wakeEntryLine);
			lines.push("Claim with nmg_board claim (claim=接手), resolve with nmg_board resolve.");
			return "NMG board wake (" + batch.length + " pending):\n" + lines.join("\n");
		} catch {
			return "";
		}
	}
	function wakeDataFor(targetSessionId) {
		if (!targetSessionId) return null;
		try {
			const batch = wakeBatch.get(String(targetSessionId));
			if (!Array.isArray(batch) || batch.length === 0) return null;
			return { entries: batch.map((entry) => ({
				id: entry.id,
				sequence: entry.sequence,
				taskId: entry.taskId,
				kind: entry.kind,
				status: entry.status,
				agentId: entry.agentId,
				claimedBy: entry.claimedBy || null,
				content: entry.content
			})) };
		} catch {
			return null;
		}
	}
	const searchTool = {
		name: "nmg_search",
		description: "Search NMG durable memory and return compact headers (mid/node/type/tier/preview) plus an activeGraphId. Load exact statements with nmg_get. Treat results as candidates, not proof of completeness.",
		parameters: {
			type: "object",
			properties: {
				query: {
					type: "string",
					description: "Focused recall query."
				},
				limit: {
					type: "integer",
					description: "Return 1..50 records (default 8)."
				},
				maxTier: {
					type: "integer",
					description: "Deepest memory tier 0..3."
				},
				graphHops: {
					type: "integer",
					description: "Graph expansion 0..3."
				},
				nodeName: {
					type: "string",
					description: "Restrict to one semantic node."
				},
				sourceActor: {
					type: "string",
					enum: [
						"user",
						"assistant",
						"system",
						"tool"
					],
					description: "Restrict evidence actor."
				},
				includeHistorical: {
					type: "boolean",
					description: "Include inactive/superseded memories."
				},
				scope: {
					type: "object",
					additionalProperties: true,
					description: "Applicability scope, e.g. {\"project\":\"nmg\"}."
				}
			},
			required: ["query"]
		},
		output: textOutput,
		async execute(args, exec) {
			const params = {
				query: args.query,
				projectDir: workspaceRoot
			};
			if (args.limit != null) params.limit = args.limit;
			if (args.maxTier != null) params.maxTier = args.maxTier;
			if (args.graphHops != null) params.graphHops = args.graphHops;
			if (args.nodeName) params.nodeName = args.nodeName;
			if (args.sourceActor) params.sourceActor = args.sourceActor;
			if (args.includeHistorical) params.includeHistorical = true;
			if (args.scope) params.scope = coerceScope(args.scope);
			const argv = ["search", args.query];
			if (args.limit != null) argv.push("--limit", String(args.limit));
			if (args.maxTier != null) argv.push("--max-tier", String(args.maxTier));
			if (args.graphHops != null) argv.push("--graph-hops", String(args.graphHops));
			if (args.nodeName) argv.push("--node", args.nodeName);
			if (args.sourceActor) argv.push("--source-actor", args.sourceActor);
			if (args.includeHistorical) argv.push("--include-historical");
			for (const pair of scopeArgs(args.scope)) argv.push(pair[0], pair[1]);
			argv.push("--project-dir", workspaceRoot, "--json");
			const r = await invoke("search", params, argv, exec.signal, null);
			if (!r.ok) return r.error;
			const data = r.data;
			const deferred = data.progressiveDisclosure && data.progressiveDisclosure.deferredMemoryIds;
			const text = renderSearchSurface(data, { nextStep: Array.isArray(deferred) && deferred.length ? "More ranked records are folded. Expand selected memory IDs first; deferred IDs: " + deferred.join(",") : "Select exact records with nmg_get (memory IDs + activeGraphId)." });
			const tokens = data.activeGraph && data.activeGraph.usage && data.activeGraph.usage.estimatedTokens;
			return text + "\nrecall tokens ~" + (tokens != null ? tokens : estimateTokens(text));
		}
	};
	const getTool = {
		name: "nmg_get",
		description: "Expand selected memory IDs into exact statements and bounded source evidence. Pass the activeGraphId returned by nmg_search to record actual use.",
		parameters: {
			type: "object",
			properties: {
				memoryIds: {
					type: "array",
					items: { type: "string" },
					description: "Memory IDs from nmg_search."
				},
				activeGraphId: {
					type: "string",
					description: "activeGraphId returned by the matching nmg_search."
				},
				graphHops: {
					type: "integer",
					description: "Graph expansion 0..3."
				}
			},
			required: ["memoryIds"]
		},
		output: textOutput,
		async execute(args, exec) {
			const ids = Array.isArray(args.memoryIds) ? args.memoryIds : [];
			if (ids.length === 0) return "nmg_get requires at least one memory ID.";
			const params = {
				memoryIds: ids,
				projectDir: workspaceRoot
			};
			if (args.activeGraphId) params.activeGraphId = args.activeGraphId;
			if (args.graphHops != null) params.graphHops = args.graphHops;
			const argv = ["get"].concat(ids);
			if (args.activeGraphId) argv.push("--active-graph-id", args.activeGraphId);
			if (args.graphHops != null) argv.push("--graph-hops", String(args.graphHops));
			argv.push("--project-dir", workspaceRoot, "--json");
			const r = await invoke("get", params, argv, exec.signal, null);
			if (!r.ok) return r.error;
			return renderEvidenceSurface(r.data, {
				missingMemoryIds: Array.isArray(r.data.missingMemoryIds) ? r.data.missingMemoryIds : void 0,
				sourceMaxChars: 280
			});
		}
	};
	const rememberTool = {
		name: "nmg_remember",
		description: "Save or update durable memory through the shared NMG lifecycle contract. Never save secrets, chatter, unverified model claims, or transient failures.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [...COMMON_REMEMBER_ACTIONS],
					description: "Memory action (default save)."
				},
				memoryId: {
					type: "string",
					description: "Existing memory for forget/resolve/reopen/claim_outcome."
				},
				newMemoryId: {
					type: "string",
					description: "Newer memory for supersede/relate."
				},
				supersededMemoryId: {
					type: "string",
					description: "Older memory replaced by newMemoryId."
				},
				relatedMemoryId: {
					type: "string",
					description: "Existing memory related to newMemoryId."
				},
				relatedMemoryIds: {
					type: "array",
					items: { type: "string" },
					description: "Evidence anchors for resolve/reopen."
				},
				relationJudgement: {
					type: "string",
					enum: [
						"conflict",
						"distinct",
						"refines",
						"related",
						"same_entity"
					]
				},
				relationConfidence: {
					type: "number",
					description: "Relation confidence 0..1."
				},
				resolutionReason: {
					type: "string",
					description: "Reason for supersede/resolve/reopen."
				},
				semanticTaskId: {
					type: "string",
					description: "Independent task identity for claim_outcome."
				},
				activeGraphId: {
					type: "string",
					description: "Active graph that produced the evaluated claim."
				},
				claimOutcome: {
					type: "string",
					enum: ["supported", "contradicted"]
				},
				claimSourceLineage: {
					type: "string",
					description: "Stable attributable source lineage."
				},
				claimIndexes: {
					type: "array",
					items: { type: "integer" }
				},
				claimWeight: {
					type: "number",
					description: "Claim reliability in (0,1]."
				},
				statement: {
					type: "string",
					description: "Self-contained semantic statement."
				},
				nodeName: {
					type: "string",
					description: "Stable node grouping related memories."
				},
				memoryType: {
					type: "string",
					enum: [
						"fact",
						"state",
						"event",
						"preference",
						"constraint",
						"strategy"
					],
					description: "Memory type."
				},
				stateKey: {
					type: "string",
					description: "Replaceable property identity; a new value in the same scope supersedes the old."
				},
				sourceActor: {
					type: "string",
					enum: [
						"user",
						"assistant",
						"system",
						"tool"
					],
					description: "Evidence actor (default user)."
				},
				truthStatus: {
					type: "string",
					enum: [
						"asserted",
						"inferred",
						"unverified",
						"verified"
					],
					description: "Truth status."
				},
				evidence: {
					type: "string",
					description: "Exact supporting source excerpt."
				},
				eventTime: {
					type: "string",
					description: "ISO event time when it differs from write time."
				},
				tier: {
					type: "integer",
					description: "Initial tier 0..3."
				},
				importance: {
					type: "number",
					description: "Importance 0..1."
				},
				residence: {
					type: "string",
					enum: ["ltg", "stg"],
					description: "ltg (durable) or stg (session/task-local)."
				},
				writeReason: {
					type: "string",
					description: "Durable-write justification."
				},
				scope: {
					type: "object",
					additionalProperties: true,
					description: "Applicability scope, e.g. {\"project\":\"nmg\"}."
				}
			},
			required: []
		},
		output: textOutput,
		async execute(args, exec) {
			const action = args.action || "save";
			const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : hostSessionId;
			if (action === "claim_outcome") {
				if (!args.memoryId || !args.claimOutcome || !args.semanticTaskId || !args.claimSourceLineage) return "nmg_remember claim_outcome requires memoryId, claimOutcome, semanticTaskId, and claimSourceLineage.";
				const result = await invokeRpcOnly("recordClaimOutcomes", {
					semanticTaskId: args.semanticTaskId,
					activeGraphId: args.activeGraphId,
					sessionId,
					collectionOrigin: "natural",
					projectDir: workspaceRoot,
					votes: [{
						memoryId: args.memoryId,
						claimIndexes: args.claimIndexes,
						outcome: args.claimOutcome,
						source: "task",
						sourceLineage: args.claimSourceLineage,
						weight: args.claimWeight
					}]
				}, exec.signal);
				return result.ok ? JSON.stringify(result.data) : result.error;
			}
			if (action !== "save") {
				const params = {
					action,
					projectDir: workspaceRoot,
					sessionId
				};
				if (args.memoryId) params.memoryId = args.memoryId;
				if (args.newMemoryId) params.newMemoryId = args.newMemoryId;
				if (args.supersededMemoryId) params.supersededMemoryId = args.supersededMemoryId;
				if (args.relatedMemoryId) params.relatedMemoryId = args.relatedMemoryId;
				if (args.relatedMemoryIds) params.relatedMemoryIds = args.relatedMemoryIds;
				if (args.relationJudgement) params.relationJudgement = args.relationJudgement;
				if (args.relationConfidence != null) params.confidence = args.relationConfidence;
				if (args.resolutionReason) params.reason = args.resolutionReason;
				const result = await invokeRpcOnly("resolveRemember", params, exec.signal);
				return result.ok ? JSON.stringify(result.data) : result.error;
			}
			if (!args.statement || !args.nodeName) return "nmg_remember save requires statement and nodeName.";
			const params = {
				statement: args.statement,
				nodeName: args.nodeName,
				projectDir: workspaceRoot
			};
			if (args.memoryType) params.memoryType = args.memoryType;
			if (args.stateKey) params.stateKey = args.stateKey;
			if (args.sourceActor) params.sourceActor = args.sourceActor;
			if (args.truthStatus) params.truthStatus = args.truthStatus;
			if (args.evidence) params.evidence = args.evidence;
			if (args.eventTime) params.eventTime = args.eventTime;
			if (args.tier != null) params.tier = args.tier;
			if (args.importance != null) params.importance = args.importance;
			if (args.residence) params.residence = args.residence;
			if (args.writeReason) params.writeReason = args.writeReason;
			if (args.scope) params.scope = coerceScope(args.scope);
			const argv = [
				"remember",
				args.statement,
				"--node",
				args.nodeName
			];
			if (args.memoryType) argv.push("--type", args.memoryType);
			if (args.stateKey) argv.push("--state-key", args.stateKey);
			if (args.sourceActor) argv.push("--actor", args.sourceActor);
			if (args.truthStatus) argv.push("--truth", args.truthStatus);
			if (args.evidence) argv.push("--evidence", args.evidence);
			if (args.eventTime) argv.push("--event-time", args.eventTime);
			if (args.tier != null) argv.push("--tier", String(args.tier));
			if (args.importance != null) argv.push("--importance", String(args.importance));
			if (args.residence) argv.push("--residence", args.residence);
			if (args.writeReason) argv.push("--write-reason", args.writeReason);
			for (const pair of scopeArgs(args.scope)) argv.push(pair[0], pair[1]);
			argv.push("--project-dir", workspaceRoot, "--json");
			const r = await invoke("remember", params, argv, exec.signal, null);
			if (!r.ok) return r.error;
			return renderRememberSurface(r.data);
		}
	};
	const boardTool = {
		name: "nmg_board",
		description: "Temporary, task-scoped cross-agent coordination (not durable memory). Entries expire. Use a stable taskId; default agent identity is \"dsh\". Promote durable conclusions only through a separate nmg_remember.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [...COMMON_BOARD_ACTIONS],
					description: "Board action."
				},
				taskId: {
					type: "string",
					description: "Task channel; omit for the shared world channel."
				},
				content: {
					type: "string",
					description: "Entry text (put)."
				},
				kind: {
					type: "string",
					enum: [
						"goal",
						"note",
						"question",
						"result",
						"handoff",
						"decision",
						"blocker"
					],
					description: "Entry kind (put)."
				},
				agentId: {
					type: "string",
					description: "Writer/reader identity (default \"dsh\")."
				},
				entryId: {
					type: "string",
					description: "Entry to resolve/claim/release."
				},
				resolution: {
					type: "string",
					description: "Resolution note (resolve)."
				},
				reason: {
					type: "string",
					description: "Reason for acknowledge/subscribe/unsubscribe."
				},
				afterCursor: {
					type: "integer",
					description: "Read only entries after this sequence (read)."
				},
				limit: {
					type: "integer",
					description: "Max entries (read)."
				},
				includeResolved: {
					type: "boolean",
					description: "Include resolved entries (read)."
				},
				ttlSeconds: {
					type: "integer",
					description: "Entry lifetime 60..2592000 (put)."
				},
				to: {
					type: "string",
					description: "Directed delivery to a stable agent name (put)."
				},
				leaseSeconds: {
					type: "integer",
					description: "Claim lease 60..86400 (claim)."
				},
				capabilities: {
					type: "string",
					description: "Capability substring filter (discover)."
				}
			},
			required: ["action"]
		},
		output: textOutput,
		async execute(args, exec) {
			const agent = args.agentId || WAKE_AGENT_ID;
			const sourceSessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : hostSessionId;
			const taskId = args.taskId || WAKE_WORLD_TASK;
			if ([
				"resolve",
				"acknowledge",
				"claim",
				"release"
			].includes(args.action) && (!args.taskId || !args.entryId)) return "nmg_board " + args.action + " requires taskId and entryId.";
			if (!COMMON_BOARD_ACTIONS.includes(args.action)) return "Unsupported board action: " + args.action;
			const params = {
				action: args.action,
				agentId: agent
			};
			const argv = ["board", args.action];
			if (args.action === "subscribe" || args.action === "unsubscribe") {
				const result = await invokeRpcOnly("taskBoard", {
					action: args.action,
					taskId,
					sessionId: sourceSessionId,
					agentId: agent,
					reason: args.reason
				}, exec.signal);
				return result.ok ? JSON.stringify(result.data) : result.error;
			} else if (args.action === "acknowledge") {
				const result = await invokeRpcOnly("taskBoard", {
					action: args.action,
					taskId,
					entryId: args.entryId,
					agentId: agent,
					sourceSessionId,
					reason: args.reason
				}, exec.signal);
				return result.ok ? JSON.stringify(result.data) : result.error;
			} else if (args.action === "discover") {
				params.taskId = "default";
				if (args.capabilities) params.capabilities = args.capabilities;
				argv.push("--agent", agent);
				if (args.capabilities) argv.push("--capabilities", args.capabilities);
			} else if (args.action === "put") {
				params.taskId = taskId;
				params.content = args.content || "";
				if (args.kind) params.kind = args.kind;
				if (args.to) params.to = args.to;
				if (args.ttlSeconds != null) params.ttlSeconds = args.ttlSeconds;
				params.sourceSessionId = sourceSessionId;
				argv.push(taskId, args.content || "");
				argv.push("--agent", agent);
				argv.push("--session-id", sourceSessionId);
				if (args.kind) argv.push("--kind", args.kind);
				if (args.to) argv.push("--to", args.to);
				if (args.ttlSeconds != null) argv.push("--ttl-seconds", String(args.ttlSeconds));
			} else if (args.action === "read") {
				params.taskId = taskId;
				if (args.afterCursor != null) params.afterCursor = args.afterCursor;
				if (args.limit != null) params.limit = args.limit;
				if (args.includeResolved) params.includeResolved = true;
				argv.push(taskId, "--agent", agent);
				if (args.afterCursor != null) argv.push("--after-cursor", String(args.afterCursor));
				if (args.limit != null) argv.push("--limit", String(args.limit));
				if (args.includeResolved) argv.push("--include-resolved");
			} else {
				params.taskId = taskId;
				params.entryId = args.entryId;
				if (args.action === "resolve" && args.resolution) params.resolution = args.resolution;
				if (args.action === "claim" && args.leaseSeconds != null) params.leaseSeconds = args.leaseSeconds;
				argv.push(taskId, args.entryId, "--agent", agent);
				if (args.action === "resolve" && args.resolution) argv.push("--resolution", args.resolution);
				if (args.action === "claim" && args.leaseSeconds != null) argv.push("--lease-seconds", String(args.leaseSeconds));
			}
			argv.push("--json");
			const r = await invoke("taskBoard", params, argv, exec.signal, null);
			if (!r.ok) return r.error;
			if (args.entryId && (args.action === "claim" || args.action === "resolve")) removeWakeEntry(args.entryId);
			return renderTaskBoardSurface(r.data, { taskId });
		}
	};
	const daemonTool = {
		name: "nmg_daemon",
		description: "Read-only NMG daemon health check. The adapter may ensure a daemon is running for requests, but it does not expose lifecycle ownership or stop it on plugin disposal.",
		parameters: {
			type: "object",
			properties: { action: {
				type: "string",
				enum: ["status"],
				description: "Health check."
			} },
			required: ["action"]
		},
		output: textOutput,
		async execute(args, exec) {
			const r = await invoke("status", {}, [
				"daemon",
				args.action,
				"--json"
			], exec.signal, projectDaemonStatus);
			if (!r.ok) return r.error;
			const data = r.data;
			if (args.action === "status") {
				if (!data.running) return "NMG daemon: not running (one-shot CLI still works in-process).";
				return "NMG daemon: running pid=" + data.pid + " endpoint=" + data.endpoint + " compatible=" + data.compatible;
			}
			return JSON.stringify(data);
		}
	};
	const labTool = {
		name: "nmg_lab",
		description: "Discover and temporarily enable optional NMG capabilities for this session. Reasoning workspace, graph reasoner, and controller shadow are self-service; controlled/active controller modes remain gated.",
		parameters: {
			type: "object",
			properties: {
				action: {
					type: "string",
					enum: [
						"list",
						"status",
						"enable",
						"disable",
						"invoke"
					]
				},
				capability: {
					type: "string",
					enum: [
						"reasoning_workspace",
						"memory_graph_reasoner",
						"controller_shadow",
						"controller_controlled",
						"controller_active"
					]
				},
				reason: { type: "string" },
				ttlSeconds: { type: "integer" },
				operation: { type: "string" },
				input: {
					type: "object",
					additionalProperties: true
				}
			},
			required: ["action"]
		},
		output: textOutput,
		async execute(args, exec) {
			const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : hostSessionId;
			if (args.action !== "list" && !args.capability) return args.action + " requires capability.";
			if (args.action === "enable" && !args.reason) return "enable requires reason.";
			if (args.action === "invoke" && !args.operation) return "invoke requires operation.";
			const params = {
				action: args.action,
				capability: args.capability,
				sessionId,
				requester: args.action === "enable" ? "agent:dsh" : void 0,
				reason: args.reason,
				ttlSeconds: args.ttlSeconds,
				operation: args.operation,
				input: args.input
			};
			const argv = ["lab", args.action];
			if (args.capability) argv.push(args.capability);
			if (args.action !== "list") argv.push("--session-id", sessionId);
			if (args.action === "enable") {
				argv.push("--requester", "agent:dsh", "--reason", args.reason);
				if (args.ttlSeconds != null) argv.push("--ttl-seconds", String(args.ttlSeconds));
			}
			if (args.action === "invoke") {
				argv.push("--operation", args.operation);
				if (args.input != null) argv.push("--input-json", JSON.stringify(args.input));
			}
			argv.push("--json");
			const r = await invoke("lab", params, argv, exec.signal, null);
			if (!r.ok) return r.error;
			return JSON.stringify(r.data, null, 2);
		}
	};
	const contextDisposer = systemPrompt.context({
		name: "nmg:recall",
		order: 90,
		text: (assembleContext) => recallTextFor(assembleContext && assembleContext.agent)
	});
	const boardWakeContextDisposer = coordinationEnabled$1 ? systemPrompt.context({
		name: "nmg:board-wake",
		order: 85,
		text: (assembleContext) => wakeTextFor(assembleContext && assembleContext.agent)
	}) : void 0;
	const ROUTE_PATH = "/nmg/recall";
	let routeRegistered = false;
	let routeDisposer = void 0;
	function tryRegisterRoute(server) {
		if (routeRegistered || !server || typeof server.register !== "function") return;
		const dispose = server.register({
			kind: "prefix",
			path: ROUTE_PATH,
			handler(req, res) {
				try {
					const url = req.url || "/nmg/recall";
					const data = recallDataFor(new URL(url, "http://x").searchParams.get("session") || "");
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(JSON.stringify({
						ok: true,
						data
					}));
				} catch (error) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						ok: false,
						error: error && error.message ? String(error.message) : String(error)
					}));
				}
			}
		});
		routeDisposer = typeof dispose === "function" ? dispose : void 0;
		routeRegistered = true;
	}
	tryRegisterRoute((() => {
		try {
			return ctx.reflect.get("webServer", false);
		} catch {
			return;
		}
	})());
	ctx.on("internal/service", (name, value) => {
		if (name === "webServer") tryRegisterRoute(value);
	});
	const WAKE_ROUTE_PATH = "/nmg/board-wake";
	let wakeRouteRegistered = false;
	let wakeRouteDisposer = void 0;
	function tryRegisterWakeRoute(server) {
		if (wakeRouteRegistered || !server || typeof server.register !== "function") return;
		const dispose = server.register({
			kind: "prefix",
			path: WAKE_ROUTE_PATH,
			handler(req, res) {
				try {
					const url = req.url || WAKE_ROUTE_PATH;
					const data = wakeDataFor(new URL(url, "http://x").searchParams.get("session") || "");
					res.writeHead(200, {
						"content-type": "application/json; charset=utf-8",
						"cache-control": "no-store"
					});
					res.end(JSON.stringify({
						ok: true,
						data
					}));
				} catch (error) {
					res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
					res.end(JSON.stringify({
						ok: false,
						error: error && error.message ? String(error.message) : String(error)
					}));
				}
			}
		});
		wakeRouteDisposer = typeof dispose === "function" ? dispose : void 0;
		wakeRouteRegistered = true;
	}
	if (coordinationEnabled$1) tryRegisterWakeRoute((() => {
		try {
			return ctx.reflect.get("webServer", false);
		} catch {
			return;
		}
	})());
	const wakeServiceDisposer = coordinationEnabled$1 ? ctx.on("internal/service", (name, value) => {
		if (name === "webServer") tryRegisterWakeRoute(value);
	}) : void 0;
	const wakeTimerDisposer = coordinationEnabled$1 ? ctx.interval(boardWakeOnce, WAKE_INTERVAL_MS) : void 0;
	const initialWakeDisposer = coordinationEnabled$1 ? ctx.timeout(boardWakeOnce, 0) : void 0;
	const disposers = [
		tools.register(searchTool),
		tools.register(getTool),
		tools.register(rememberTool),
		tools.register(labTool),
		tools.register(daemonTool),
		contextDisposer,
		ctx.on("agent/inbox/inserted", onInboxInserted),
		ctx.on("agent/disposed", onAgentDisposed)
	];
	if (coordinationEnabled$1) disposers.push(tools.register(boardTool), boardWakeContextDisposer, wakeServiceDisposer, wakeTimerDisposer, initialWakeDisposer);
	if (routeDisposer) disposers.push(routeDisposer);
	if (wakeRouteDisposer) disposers.push(wakeRouteDisposer);
	return () => {
		for (const dispose of disposers) if (typeof dispose === "function") dispose();
		recallWindows.clear();
		sessionTokenTotals.clear();
		recallBatch.clear();
		openSearches.clear();
		wakeBatch.clear();
	};
}
//#endregion
export { apply, inject };
