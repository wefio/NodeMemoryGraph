import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { connect } from "node:net";
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
	function searchPreviewOf(memory) {
		const normalized = String(memory && memory.statement || "").replace(/\s+/g, " ").trim();
		return normalized.length <= 320 ? normalized : normalized.slice(0, 319) + "…";
	}
	function projectCompact(context) {
		return {
			candidates: (Array.isArray(context.results) ? context.results : []).map((r) => ({
				id: r.memory.id,
				node: r.node && r.node.canonicalName || "",
				type: r.memory.memoryType,
				tier: r.memory.tier,
				preview: searchPreviewOf(r.memory)
			})),
			activeGraphId: context.activeGraph ? context.activeGraph.id : null,
			deferredMemoryIds: context.progressiveDisclosure && context.progressiveDisclosure.deferredMemoryIds || [],
			tokens: context.activeGraph && context.activeGraph.usage && context.activeGraph.usage.estimatedTokens || null
		};
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
	async function autoRecall(query, signal) {
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
				projectDir: workspaceRoot
			}, budget);
			if (context) return projectCompact(context);
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
					const recall = await autoRecall(query, void 0);
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
			argv.push("--project-dir", workspaceRoot, "--compact-json");
			const r = await invoke("search", params, argv, exec.signal, projectCompact);
			if (!r.ok) return r.error;
			const data = r.data;
			const candidates = Array.isArray(data.candidates) ? data.candidates : [];
			const lines = candidates.length ? candidates.map((c) => "mid=" + c.id + "	node=" + c.node + "	type=" + c.type + "	L" + c.tier + "	" + truncate(c.preview, 160)) : ["No NMG match."];
			if (data.activeGraphId) lines.push("activeGraphId=" + data.activeGraphId);
			if (Array.isArray(data.deferredMemoryIds) && data.deferredMemoryIds.length) lines.push("deferred: " + data.deferredMemoryIds.join(","));
			if (data.tokens != null) lines.push("recall tokens ~" + data.tokens);
			else if (candidates.length) lines.push("recall tokens ~" + estimateTokens(lines.join("\n")));
			lines.push("Select exact records with nmg_get (mids + activeGraphId).");
			return lines.join("\n");
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
			const data = r.data;
			const results = Array.isArray(data.results) ? data.results : [];
			const lines = [];
			for (const item of results) {
				const m = item.memory || {};
				const n = item.node || {};
				lines.push("- " + m.statement);
				lines.push("  mid=" + m.id + " node=" + (n.canonicalName || "") + " type=" + m.memoryType + " truth=" + m.truthStatus);
				const ev = item.evidence && item.evidence.content;
				if (ev && String(ev).trim() !== String(m.statement || "").trim()) lines.push("  SRC: " + truncate(ev, 280));
			}
			if (Array.isArray(data.missingMemoryIds) && data.missingMemoryIds.length) lines.push("MISSING: " + data.missingMemoryIds.join(", "));
			return lines.length ? lines.join("\n") : "No active memory found.";
		}
	};
	const rememberTool = {
		name: "nmg_remember",
		description: "Save a durable typed memory (fact/preference/constraint/state/event/strategy). Requires a stable nodeName and self-contained statement. Never save secrets, chatter, unverified model claims, or transient failures.",
		parameters: {
			type: "object",
			properties: {
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
			required: ["statement", "nodeName"]
		},
		output: textOutput,
		async execute(args, exec) {
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
			const m = r.data.memory || {};
			const n = r.data.node || {};
			return "Saved " + m.id + " under \"" + (n.canonicalName || "") + "\" (type=" + (m.memoryType || "?") + ").";
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
					enum: [
						"put",
						"read",
						"resolve",
						"claim",
						"release",
						"discover"
					],
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
			if ((args.action === "resolve" || args.action === "claim" || args.action === "release") && (!args.taskId || !args.entryId)) return "nmg_board " + args.action + " requires taskId and entryId.";
			if (![
				"put",
				"read",
				"resolve",
				"claim",
				"release",
				"discover"
			].includes(args.action)) return "Unsupported board action: " + args.action;
			const params = {
				action: args.action,
				agentId: agent
			};
			const argv = ["board", args.action];
			if (args.action === "discover") {
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
			const data = r.data;
			if (data.action === "discover") {
				const agents = Array.isArray(data.agents) ? data.agents : [];
				if (!agents.length) return "No online NMG agents match.";
				return "Online NMG agents [v2]:\n" + agents.map((a) => "- " + a.agentName + (a.capabilities ? " capabilities=" + a.capabilities : "") + " lastSeen=" + a.lastSeenAt).join("\n");
			}
			const entries = Array.isArray(data.entries) ? data.entries : data.entry ? [data.entry] : [];
			if (entries.length === 0 && data.action === "read") return "No matching board entries.";
			const lines = entries.map((e) => "- #" + e.sequence + " " + e.id + " [" + e.kind + "/" + e.status + "] " + e.agentId + ": " + truncate(e.content, 400));
			if (data.action === "read" && data.nextCursor != null && data.nextCursor !== 0) lines.push("nextCursor=" + data.nextCursor);
			return lines.length ? lines.join("\n") : "No matching board entries.";
		}
	};
	const daemonTool = {
		name: "nmg_daemon",
		description: "Read-only NMG daemon health check. The adapter uses one-shot CLI calls and never owns a daemon, so start/stop is intentionally out of scope.",
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
	const contextDisposer = systemPrompt.context({
		name: "nmg:recall",
		order: 90,
		text: (assembleContext) => recallTextFor(assembleContext && assembleContext.agent)
	});
	const boardWakeContextDisposer = systemPrompt.context({
		name: "nmg:board-wake",
		order: 85,
		text: (assembleContext) => wakeTextFor(assembleContext && assembleContext.agent)
	});
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
	tryRegisterWakeRoute((() => {
		try {
			return ctx.reflect.get("webServer", false);
		} catch {
			return;
		}
	})());
	ctx.on("internal/service", (name, value) => {
		if (name === "webServer") tryRegisterWakeRoute(value);
	});
	const wakeTimerDisposer = ctx.interval(boardWakeOnce, WAKE_INTERVAL_MS);
	ctx.timeout(boardWakeOnce, 0);
	const disposers = [
		tools.register(searchTool),
		tools.register(getTool),
		tools.register(rememberTool),
		tools.register(boardTool),
		tools.register(daemonTool),
		contextDisposer,
		boardWakeContextDisposer,
		wakeTimerDisposer,
		ctx.on("agent/inbox/inserted", onInboxInserted),
		ctx.on("agent/disposed", onAgentDisposed)
	];
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
