// NMG adapter for DeepSeek Harness — community-standard dual-face host package.
//
// Host half: registers model tools (nmg_search / nmg_get / nmg_remember /
// nmg_board / nmg_lab / nmg_daemon) into the host `tools` registry and implements
// AUTOMATIC RECALL on `agent/pre-step`. Inside this package the half runs in the
// real node process (full fetch / fs / process), so it talks to the running NMG
// daemon over HTTP JSON-RPC first (single-digit-ms fast path) and falls back to
// the one-shot `node bin/nmg.mjs` CLI via the `subprocess` service only when no
// live daemon exists. It publishes no service; the browser half (exports
// ./client) renders the tool call cards.
//
// The three consumed services are hard dependencies of a host contribution, so
// they are injected: cordis starts this plugin only after `tools`, `subprocess`
// and `sandboxPolicy` are bound in composition.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { coordinationEnabled as configuredCoordinationEnabled } from '../../../../src/integration/config.ts'
import { COMMON_BOARD_ACTIONS, COMMON_REMEMBER_ACTIONS } from '../../../../src/integration/tool-contract.ts'
import { compactSearchContext } from '../../../../src/integration/search-projection.ts'
import {
  renderCompactSearchSurface,
  renderEvidenceSurface,
  renderRememberSurface,
  renderSearchSurface,
  renderTaskBoardSurface,
} from '../../../../src/integration/agent-surface.ts'
import { loadPrompts, renderDisclosure } from '../../../../src/prompts/load.ts'

const nmgPrompts = loadPrompts()

export const inject = ['tools', 'subprocess', 'sandboxPolicy', 'systemPrompt', 'timer']

/** Tool output shape: a single pre-rendered text block. */
const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
}

/** CJK-aware fallback token estimator used only when the daemon is down. */
function estimateTokens(text) {
  let cjk = 0
  let latin = 0
  for (const ch of String(text || '')) {
    if (ch.codePointAt(0) > 0x2fff) cjk += 1
    else if (!/\s/.test(ch)) latin += 1
  }
  return Math.ceil(cjk + latin / 4)
}

export function apply(ctx: Context): () => void {
  const tools = ctx.tools
  const subprocess = ctx.subprocess
  const sandboxPolicy = ctx.sandboxPolicy
  const systemPrompt = ctx.systemPrompt
  const coordinationEnabled = configuredCoordinationEnabled()

  const workspaceRoot =
    (process.env.NMG_PROJECT_DIR && process.env.NMG_PROJECT_DIR.trim()) ||
    (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) ||
    'C:\\Documents\\GitHub\\NodeMemoryGraph'
  const binPath = workspaceRoot.replace(/[\\/]+$/, '') + '\\bin\\nmg.mjs'

  let nodePromise
  function resolveNode() {
    if (nodePromise === undefined) {
      nodePromise = subprocess.resolveExecutable('node').catch(() => 'node')
    }
    return nodePromise
  }

  function truncate(value, max) {
    const t = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
    return t.length <= max ? t : t.slice(0, max - 1) + '…'
  }

  function clampInt(raw, min, max, fallback) {
    const value = Number(raw)
    return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.floor(value))) : fallback
  }

  function isProcessAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code !== 'ESRCH'
    }
  }

  // ── daemon JSON-RPC (fast path) ────────────────────────────────────────────
  let daemon = null
  function resolveDaemon() {
    if (daemon) return daemon
    try {
      const home = process.env.USERPROFILE || process.env.HOME || ''
      const envDir = (process.env.NMG_DATA_DIR || '').replace(/[\\/]+$/, '')
      const candidates = []
      if (envDir) candidates.push(envDir)
      candidates.push(join(home, '.nmg'))
      const projectDir = join(workspaceRoot, '.nmg')
      if (!candidates.includes(projectDir)) candidates.push(projectDir)
      for (const dataDir of candidates) {
        try {
          const state = JSON.parse(readFileSync(join(dataDir, 'nmg.sqlite.server.json'), 'utf8'))
          if (state.transport !== 'http' || !state.host || !state.port || !state.token) continue
          if (!isProcessAlive(state.pid)) continue
          daemon = { host: state.host, port: state.port, token: state.token, pid: state.pid }
          return daemon
        } catch {
          // try the next candidate location
        }
      }
    } catch {
      daemon = null
    }
    return daemon
  }

  async function daemonCall(method, params, signal?) {
    const endpoint = resolveDaemon()
    if (!endpoint) return null
    try {
      const response = await fetch('http://' + endpoint.host + ':' + endpoint.port + '/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + endpoint.token },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal,
      })
      const text = await response.text()
      if (!response.ok) throw new Error(text || 'nmg ' + method + ' failed (' + response.status + ')')
      const parsed = JSON.parse(text)
      if (parsed.error) throw new Error(parsed.error.message || 'nmg ' + method + ' error')
      return parsed.result
    } catch (error) {
      if (error && error.name === 'AbortError') throw error
      daemon = null
      return null
    }
  }

  // TCP 端口探测：进程活着 ≠ 服务可用（僵尸 daemon：pid 在但端口已释放，
  // resolveDaemon 会被 isProcessAlive 骗过）。超时短，失败即视为不可用。
  function probePort(host, port, timeoutMs = 800) {
    return new Promise((resolve) => {
      let socket
      try {
        socket = connect({ host, port })
      } catch {
        return resolve(false)
      }
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        try { socket.destroy() } catch {}
        resolve(ok)
      }
      socket.setTimeout(timeoutMs)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })
  }

  // "再叫一遍"：daemon 不可用（没起 / 僵尸）→ kill 残留进程 + `nmg daemon start`
  // 重启，等它就绪后重试探测。启动失败（如沙箱权限）静默，下个 tick 再试。
  async function ensureDaemon(signal?) {
    let endpoint = resolveDaemon()
    if (endpoint && (await probePort(endpoint.host, endpoint.port))) return endpoint
    if (endpoint && endpoint.pid) {
      try { process.kill(endpoint.pid) } catch { /* already gone */ }
    }
    daemon = null
    try {
      await runNmg(['daemon', 'start'], signal)
      await new Promise((resolve) => setTimeout(resolve, 2500))
    } catch {
      // spawn/permission failure: silent, retried next tick
    }
    daemon = null
    endpoint = resolveDaemon()
    if (endpoint && (await probePort(endpoint.host, endpoint.port))) return endpoint
    return null
  }

  // ── one-shot CLI fallback ──────────────────────────────────────────────────
  async function runNmg(args, signal) {
    const node = await resolveNode()
    const handle = subprocess.spawn({
      argv: [node, binPath].concat(args),
      cwd: workspaceRoot,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: 512 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 8000,
      signal,
    })
    const outcome = await handle.done
    const stdout = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
    const stderr = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
    return { exitCode: outcome.exitCode, stdout, stderr }
  }

  async function nmgJson(args, signal) {
    let run
    try {
      run = await runNmg(args, signal)
    } catch (error) {
      const msg = error && error.message ? error.message : String(error)
      return { ok: false, error: 'NMG spawn failed: ' + truncate(msg, 500) }
    }
    if (run.exitCode !== 0) {
      const detail = (run.stderr || run.stdout || '').trim()
      return { ok: false, error: 'NMG exit ' + run.exitCode + (detail ? ': ' + truncate(detail, 500) : '') }
    }
    let data
    try {
      data = JSON.parse(run.stdout)
    } catch {
      return { ok: false, error: 'NMG non-JSON output: ' + truncate(run.stdout, 500) }
    }
    return { ok: true, data }
  }

  function scopeArgs(scope) {
    if (scope === null || typeof scope !== 'object') return []
    return Object.keys(scope).map((key) => ['--scope', String(key) + '=' + String(scope[key])])
  }

  function coerceScope(scope) {
    const out = {}
    for (const key of Object.keys(scope || {})) out[key] = String(scope[key])
    return out
  }

  function projectDaemonStatus(raw) {
    const endpoint = resolveDaemon()
    return {
      running: true,
      pid: endpoint && endpoint.pid != null ? endpoint.pid : null,
      endpoint: endpoint ? endpoint.host + ':' + endpoint.port : null,
      compatible: true,
      status: raw,
    }
  }

  async function invoke(method, params, cliArgs, signal, project) {
    try {
      const raw = await daemonCall(method, params, signal)
      if (raw != null) return { ok: true, data: project ? project(raw) : raw }
    } catch {
      return { ok: false, error: 'NMG call aborted' }
    }
    return nmgJson(cliArgs, signal)
  }

  async function invokeRpcOnly(method, params, signal) {
    try {
      let raw = await daemonCall(method, params, signal)
      if (raw == null) {
        await ensureDaemon(signal)
        raw = await daemonCall(method, params, signal)
      }
      return raw == null
        ? { ok: false, error: 'NMG daemon is unavailable for ' + method }
        : { ok: true, data: raw }
    } catch {
      return { ok: false, error: 'NMG call aborted' }
    }
  }

  // ── automatic recall (DSH-native: systemPrompt.context) ───────────────────
  //
  // DSH's native way to feed the model dynamic context is `systemPrompt.context`:
  // a named contribution whose resolved text is "materialized as a durable
  // user-role snapshot" and APPENDED to the turn's messages by the agent loop
  // itself (the `[...claimed, context]` default `enter` decision). We register
  // `nmg:recall` as such a contribution and drop all manual user-message
  // fabrication in `agent/pre-step`.
  //
  // Ordering in the agent loop matters: `assemble()` runs BEFORE `agent/pre-step`
  // on each step, so a provider that searched inside itself would land one step
  // late. Instead we start the (async, ~10 ms daemon) search when the user
  // message first ENTERS the inbox (`agent/inbox/inserted`, which precedes the
  // turn's first assemble), stash the formatted snapshot per agent, and let the
  // synchronous `context()` provider simply serve the current stash. On the
  // (rare) fast path where the search has not landed by the first assembly, the
  // snapshot appears from the next step — and, being runtime context, stays in
  // front of the model for the whole turn rather than only the first step.

  const recallWindows = new Map() // sessionId -> { generation, injected: Map<id, generation> }
  const sessionTokenTotals = new Map() // sessionId -> total estimated recall tokens
  const recallBatch = new Map() // sessionId -> recall[] (newest first, capped at MAX_RECALL_HISTORY)
  const MAX_RECALL_HISTORY = 5 // per-session recall rounds kept for the floating indicator
  const openSearches = new Map() // sessionId -> Promise that resolves once the stash is written

  function nextGeneration(sessionId) {
    let window = recallWindows.get(sessionId)
    if (!window) {
      window = { generation: 0, injected: new Map() }
      recallWindows.set(sessionId, window)
    }
    window.generation += 1
    return window
  }

  function filterRecallCandidates(window, generation, candidates) {
    const fresh = []
    for (const candidate of candidates || []) {
      const previousGeneration = window.injected.get(candidate.id)
      if (previousGeneration != null && generation - previousGeneration <= 12) continue
      fresh.push(candidate)
    }
    for (const [id, injectedGeneration] of window.injected) {
      if (generation - injectedGeneration > 12) window.injected.delete(id)
    }
    return fresh
  }

  function extractUserPrompt(message) {
    const parts = []
    if (!message || typeof message !== 'object') return ''
    for (const block of message.content || []) {
      if (block.type === 'text' && block.text) parts.push(block.text)
    }
    const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
    return joined.length > 500 ? joined.slice(0, 500) : joined
  }

  function formatRecall(recall, candidates) {
    const chainCount = new Set(candidates.flatMap((candidate) => candidate.chains || [])).size
    const deferred = Array.isArray(recall.deferredMemoryIds) ? recall.deferredMemoryIds : []
    const nextStep = deferred.length
      ? nmgPrompts.deferred_hint + ' Memory IDs: ' + deferred.join(',')
      : nmgPrompts.get_hint
    const forget = candidates.some((candidate) => candidate.forgotten)
    return renderCompactSearchSurface(
      {
        candidates,
        logicalChainCount: chainCount,
        activeGraphId: recall.activeGraphId || null,
        deferredMemoryIds: deferred,
      },
      {
        preamble: renderDisclosure(nmgPrompts.search_disclosure, {
          count: String(candidates.length),
          next_step: nextStep,
          forget_hint: forget ? nmgPrompts.forget_hint : '',
        }),
      },
    )
  }

  function recallBudget(signal) {
    try {
      return AbortSignal.any([signal, AbortSignal.timeout(1500)])
    } catch {
      return signal
    }
  }

  async function autoRecall(query, sessionId, signal) {
    const limit = clampInt(process.env.NMG_AUTO_RECALL_LIMIT, 1, 50, 13)
    const tier = clampInt(process.env.NMG_AUTO_RECALL_TIER, 0, 3, 1)
    const budget = recallBudget(signal)
    try {
      const context = await daemonCall('search', {
        query,
        limit,
        maxTier: tier,
        graphHops: 1,
        tieredDisclosure: true,
        projectDir: workspaceRoot,
        sessionId,
      }, budget)
      if (context) return compactSearchContext(context)
    } catch {
      return null
    }
    const argv = [
      'search', query,
      '--limit', String(limit),
      '--max-tier', String(tier),
      '--graph-hops', '1',
      '--tiered-disclosure',
      '--project-dir', workspaceRoot,
      '--session-id', sessionId,
      '--compact-json',
    ]
    const result = await nmgJson(argv, budget)
    return result.ok ? result.data : null
  }

  // Kick the recall search when a user message enters the inbox. This precedes
  // the turn's first system-prompt assembly, so the stash is normally ready
  // before the model sees `nmg:recall`. Never awaited in the message path: a
  // slow/failed search leaves the previous (or no) snapshot and the turn goes on.
  function onInboxInserted(payload) {
    try {
      const { agent, message } = payload || {}
      if (!agent || !message) return
      // 缓存活跃 agent 实例——定时器唤醒（agent.send）需要它，而事件
      // payload 只在用户消息进入时才有。多会话：每个 agent 独立缓存。
      lastAgents.set(String(agent.id), agent)
      const sessionId = String(agent.id)
      const query = extractUserPrompt(message)
      if (!query) return
      const window = nextGeneration(sessionId)
      const generation = window.generation
      const run = (async () => {
        try {
          // An empty/no-match search for this new turn must NOT clear the
          // session's last successful recall snapshot — the floating indicator
          // (and the model context out-of-band) should keep showing the most
          // recent memory until a new successful recall overwrites it. Flickering
          // to "暂无召回" on every fresh round that happens to find nothing is the
          // bug we avoid by leaving the previous snapshot in place.
          const recall = await autoRecall(query, sessionId, undefined)
          if (!recall || !Array.isArray(recall.candidates) || recall.candidates.length === 0) {
            return
          }
          const fresh = filterRecallCandidates(window, generation, recall.candidates)
          if (fresh.length === 0) return
          const thisTokens =
            recall.tokens != null
              ? recall.tokens
              : estimateTokens(fresh.map((c) => c.preview).join(' '))
          const sessionTotal = (sessionTokenTotals.get(sessionId) || 0) + thisTokens
          sessionTokenTotals.set(sessionId, sessionTotal)
          const text = formatRecall(recall, fresh)
          const entry = {
            generation,
            text,
            tokens: thisTokens,
            sessionTotal,
            candidates: fresh,
            activeGraphId: recall.activeGraphId,
          }
          const history = recallBatch.get(sessionId)
          recallBatch.set(sessionId, [entry, ...(history || [])].slice(0, MAX_RECALL_HISTORY))
          for (const candidate of fresh) window.injected.set(candidate.id, generation)
        } catch {
          // Keep the last successful snapshot on any recall failure.
        }
      })()
      openSearches.set(sessionId, run)
      run.finally(() => {
        if (openSearches.get(sessionId) === run) openSearches.delete(sessionId)
      })
    } catch {
      // never let a recall computation throw into the inbox event
    }
  }

  // The `systemPrompt.context` provider: return the current recall snapshot for
  // the assembling agent, or empty text (contributes nothing). The agent loop
  // materializes the resolved text as a user-role snapshot appended to the turn's
  // messages — DSH-native, no manual message fabrication.
  function recallTextFor(agent) {
    if (!agent) return ''
    try {
      const stack = recallBatch.get(String(agent.id))
      const latest = Array.isArray(stack) ? stack[0] : stack
      return latest && latest.text ? latest.text : ''
    } catch {
      return ''
    }
  }

  // Structured recall snapshot for one session id (used by the webServer route).
  // Pure projection of the in-memory recallBatch — no live objects cross the
  // boundary, only plain JSON. Returns the per-session recall stack (newest
  // first, capped) so the pill can show the latest recall's candidates and page
  // through earlier recalls, or null when the session has never recalled.
  function recallDataFor(sessionId) {
    if (!sessionId) return null
    try {
      const stack = recallBatch.get(String(sessionId))
      const list = Array.isArray(stack) ? stack : (stack ? [stack] : [])
      if (list.length === 0) return null
      return {
        recalls: list.map((snapshot) => ({
          generation: snapshot.generation,
          tokens: snapshot.tokens,
          sessionTotal: snapshot.sessionTotal,
          activeGraphId: snapshot.activeGraphId || null,
          candidates: (snapshot.candidates || []).map((c) => ({
            id: c.id,
            node: c.node,
            type: c.type,
            tier: c.tier,
            preview: c.preview,
          })),
        })),
      }
    } catch {
      return null
    }
  }

  function onAgentDisposed(payload) {
    try {
      if (payload && payload.agent) {
        const id = String(payload.agent.id)
        recallWindows.delete(id)
        sessionTokenTotals.delete(id)
        recallBatch.delete(id)
        openSearches.delete(id)
        wakeBatch.delete(id)
        lastAgents.delete(id)
      }
    } catch {
      // cleanup is best-effort
    }
  }

  // ── board wake loop (the "waker") ──────────────────────────────────────────
  // NMG task-board waker: a host-side timer that polls the daemon for work
  // addressed to THIS DSH session — directed `to=` entries plus the world
  // channel (`default`) broadcast — records a delivery receipt for each fresh
  // entry so it never re-wakes, and surfaces the pending batch to the model as
  // native runtime context (`nmg:board-wake`, order 85, before recall at 90).
  //
  // The daemon only provides primitives (readDirected / read / deliveryCheck /
  // recordDelivery / registerAgent / heartbeat); the loop itself is the
  // client's job — this package is that client.
  //
  // Claim ≠ notify: the waker only NOTIFIES ("通知决定谁知道"). Taking over
  // work ("claim 决定谁工作") is the model's call via `nmg_board claim`, so we
  // never auto-claim — we surface entries and let the model decide.

  const hostSessionId = (process.env.DSH_SESSION_ID || '').trim() || 'dsh'
  const projectName = workspaceRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'dsh'
  const WAKE_AGENT_ID = 'dsh:' + projectName // stable routing key (never the session id)
  const WAKE_AGENT_NAME = projectName // display label; renaming never loses routing
  const WAKE_WORLD_TASK = 'default' // the world channel is always scanned
  const WAKE_MAX_ENTRIES = 50
  // 对齐 NMG 唤醒器参考实现 (kimi-plugin/nmg-hook.mjs isBoardWakeCandidate)：
  // 只有 actionable 种类会唤醒——推送 note/result/decision/goal 是"确认风暴"
  // (3f9d62b notify-only-is-silent)。广播 meta 条目永不唤醒 (ed51a8f)。
  const WAKE_KINDS = new Set(['question', 'blocker', 'handoff'])
  const KIND_RANK = { question: 0, blocker: 1, handoff: 2 }
  const BROADCAST_PREFIX = '[NMG board 协作广播]'
  // 照抄 pi 版 (.pi/extensions/nmg/index.ts) 的世界广播设计：
  // - WORLD_BROADCAST_SESSION: 哨兵投递回执，每个条目最多广播一次（(entry, sentinel) 去重）
  // - BROADCAST_KINDS: 协作类才值得广播公告；note/result/decision 静默（世界频道保持安静）
  // - BROADCAST_TTL_SECONDS: RAII——广播是临时 pull 公告，TTL 回收而不是永久 open 死状态
  const WORLD_BROADCAST_SESSION = 'world-broadcast'
  const BROADCAST_KINDS = new Set(['question', 'blocker', 'handoff'])
  const BROADCAST_TTL_SECONDS = 86_400
  const WAKE_INTERVAL_MS = clampInt(process.env.NMG_BOARD_WAKE_INTERVAL_SEC, 5, 3600, 30) * 1000

  const wakeBatch = new Map() // sessionId -> entry[] (deduped, newest first)
  let wakeAgentRegistered = false
  let wakeConfig = null // <dataDir>/board-wake.json (enabled/intervalMs/budget/cooldownMs)
  const lastAgents = new Map() // 已注册的活跃 agent 实例（key=String(agent.id)），供定时器按会话唤醒用

  function wakeEntryKey(entry) {
    return entry && entry.id ? String(entry.id) : ''
  }

  function wakeEntryLine(entry) {
    return (
      '#' + entry.sequence + ' ' + entry.id + ' [' + entry.kind + '/' + entry.status + '] ' +
      (entry.agentId || '?') + ': ' + truncate(entry.content, 200)
    )
  }

  function loadWakeConfig() {
    try {
      const home = process.env.USERPROFILE || process.env.HOME || ''
      const dataDir = (process.env.NMG_DATA_DIR || join(home, '.nmg')).replace(/[\\/]+$/, '')
      wakeConfig = JSON.parse(readFileSync(join(dataDir, 'board-wake.json'), 'utf8'))
    } catch {
      wakeConfig = null
    }
  }

  function pushWakeEntry(entry, targetSessionId) {
    if (!entry || !targetSessionId) return
    const key = wakeEntryKey(entry)
    if (!key) return
    const existing = wakeBatch.get(targetSessionId) || []
    if (existing.some((e) => wakeEntryKey(e) === key)) return
    wakeBatch.set(targetSessionId, [entry].concat(existing).slice(0, WAKE_MAX_ENTRIES))
  }

  // 唤醒候选判定，对齐 nmg-hook.mjs isBoardWakeCandidate：open && actionable
  // kind && 无活跃 claim && 非定向他人 && 非串行排队 && 非广播 meta。
  // 自回声（ownEcho）判断依赖具体会话，移到 per-agent delivery 阶段做。
  function isWakeCandidate(entry, extraTargets) {
    const now = Date.now()
    const liveClaim =
      entry.claimExpiresAt != null && new Date(entry.claimExpiresAt).getTime() > now
    const addressedToOther =
      entry.to != null && entry.to !== WAKE_AGENT_ID && entry.to !== WAKE_AGENT_NAME && !(extraTargets && extraTargets.has(entry.to))
    const serialQueued = entry.serialState === 'pending'
    return (
      entry.status === 'open' &&
      WAKE_KINDS.has(entry.kind) &&
      !liveClaim &&
      !addressedToOther &&
      !serialQueued &&
      !String(entry.content || '').startsWith(BROADCAST_PREFIX)
    )
  }

  // 条目被 claim/resolve 后从所有会话的 wake batch 移除（谁处理的都可能）。
  function removeWakeEntry(entryId) {
    for (const [key, list] of wakeBatch) {
      const next = list.filter((entry) => wakeEntryKey(entry) !== String(entryId))
      if (next.length) wakeBatch.set(key, next)
      else wakeBatch.delete(key)
    }
  }

  // 照抄 pi 版 maybeBroadcastToWorld (.pi/extensions/nmg/index.ts:2609)：
  // 为一条 open 协作条目在世界频道发 pull 广播公告，让其他 agent 注意到并能
  // 认领。广播是广播风格（pull 公告，绝不定向）；WORLD_BROADCAST_SESSION 哨兵
  // 回执去重（每条目至多一次），ownEcho 过滤（sourceSessionId === 本会话）阻止
  // 广播者被自己的帖子唤醒。广播条目本身（带 BROADCAST_PREFIX）绝不重播——
  // 否则广播唤醒会话、会话再广播，递归刷屏（实测 #12→#13→#16…）。
  async function maybeBroadcastToWorld(entry, agentId, sessionId) {
    if (!entry || String(entry.content || '').startsWith(BROADCAST_PREFIX)) return false
    if (!BROADCAST_KINDS.has(entry.kind)) return false
    const worldCheck = await daemonCall('taskBoard', {
      action: 'deliveryCheck',
      taskId: WAKE_WORLD_TASK,
      agentId,
      sessionId: WORLD_BROADCAST_SESSION,
      entryIds: [wakeEntryKey(entry)],
    })
    if (worldCheck && Array.isArray(worldCheck.delivered) && worldCheck.delivered.includes(wakeEntryKey(entry))) return false
    const excerpt = String(entry.content || '').length > 140 ? String(entry.content || '').slice(0, 140) + '…' : String(entry.content || '')
    const label = entry.kind === 'question' ? '问题' : entry.kind === 'blocker' ? '阻塞' : '交接'
    const broadcast =
      '[NMG board 协作广播] 频道 ' + (entry.taskId || '?') + ' 有 #' + entry.sequence +
      ' 未认领的' + label + '（open）：' + excerpt +
      '。有空的 agent 可用 nmg_board read taskId=' + (entry.taskId || '?') + ' 查看详情、claim 认领处理。'
    await daemonCall('taskBoard', {
      action: 'put',
      taskId: WAKE_WORLD_TASK,
      agentId,
      sourceSessionId: sessionId,
      kind: 'handoff',
      content: broadcast,
      ttlSeconds: BROADCAST_TTL_SECONDS,
    })
    await daemonCall('taskBoard', {
      action: 'recordDelivery',
      entryId: wakeEntryKey(entry),
      sessionId: WORLD_BROADCAST_SESSION,
      agentId,
      source: 'wake-broadcast',
    })
    return true
  }

  async function boardWakeOnce() {
    // "再叫一遍"：daemon 不可用（没起/僵尸）→ 自动 kill + restart
    const endpoint = await ensureDaemon()
    if (!endpoint) {
      wakeAgentRegistered = false
      return
    }
    try {
      // 配置门：读 <dataDir>/board-wake.json。enabled 显式 false 时停摆；无配置
      // 文件时默认开启（DSH 适配器是用户主动装的双面宿主包，不同于 NMG 本体
      // 保守默认 off）。intervalMs 可覆盖轮询间隔（当前配置 30000 与默认一致）。
      loadWakeConfig()
      if (wakeConfig && wakeConfig.enabled === false) return

      // Register on first contact / after a daemon restart (upsert + last_seen).
      if (!wakeAgentRegistered) {
        await daemonCall('taskBoard', {
          action: 'registerAgent',
          id: WAKE_AGENT_ID,
          agentName: WAKE_AGENT_NAME,
          description: 'DSH NMG adapter (NodeMemoryGraph host package)',
          capabilities: 'dsh-nmg',
          supportedInterfaces: 'dsh-harness',
        })
        wakeAgentRegistered = true
      }
      // Heartbeat keeps last_seen_at fresh (online window = 10 min).
      await daemonCall('taskBoard', { action: 'heartbeat', id: WAKE_AGENT_ID })

      // Collect candidates: directed inbox + world channel + subscribed channels.
      const candidates = []
      const seen = new Set()
      const collect = (taskId, entries) => {
        for (const entry of entries || []) {
          const key = wakeEntryKey(entry)
          if (!key || seen.has(key)) continue
          seen.add(key)
          candidates.push(taskId == null ? entry : { ...entry, taskId })
        }
      }
      // Continuable subagents: enumerate the live parents' children, then read
      // each child's directed inbox. A child may be cold (persisted, no live
      // Agent), so delivery below goes through subagents.followup, which
      // cold-resumes when needed.
      //
      // Ensure lastAgents has all live agents before enumeration: at cold start
      // no `agent/inbox/inserted` event has fired yet, so lastAgents is empty
      // and the loop below would skip every child. Use the agents registry's
      // list() to seed lastAgents with every live agent (including the main
      // session), bridging the startup window without waiting for a user message.
      const agentsService = ctx.get('agents')
      if (agentsService && typeof agentsService.list === 'function') {
        for (const agent of agentsService.list()) {
          if (agent && agent.id) lastAgents.set(String(agent.id), agent)
        }
      }
      // Resolve the optional subagents service per tick (not at apply time):
      // dsh-subagent may mount after this plugin, and ctx.get() is a point-in-
      // time lookup — a captured constant would stay undefined forever.
      const subagents = ctx.get('subagents')
      const childTargets = new Set()
      const childMap = new Map()
      if (subagents && typeof subagents.listChildren === 'function') {
        for (const [parentSessionId, parent] of lastAgents) {
          if (!parent) continue
          let children
          try { children = await subagents.listChildren(parentSessionId) } catch { continue }
          for (const child of children || []) {
            if (!child || child.kind !== 'child' || child.mode !== 'continuable') continue
            const childId = String(child.id)
            childTargets.add(childId)
            childMap.set(childId, parent)
            const childDirected = await daemonCall('taskBoard', {
              action: 'readDirected',
              agentId: childId,
              agentName: childId,
              limit: WAKE_MAX_ENTRIES,
            })
            collect(null, childDirected && childDirected.entries)
          }
        }
      }
      // or display name, across all named boards (no subscribe needed first).
      const directed = await daemonCall('taskBoard', {
        action: 'readDirected',
        agentId: WAKE_AGENT_ID,
        agentName: WAKE_AGENT_NAME,
        limit: WAKE_MAX_ENTRIES,
      })
      collect(null, directed && directed.entries)

      // World-channel broadcast + subscribed named channels.
      const world = await daemonCall('taskBoard', {
        action: 'read',
        taskId: WAKE_WORLD_TASK,
        agentId: WAKE_AGENT_ID,
        limit: WAKE_MAX_ENTRIES,
      })
      collect(WAKE_WORLD_TASK, world && world.entries)
      const subs = await daemonCall('taskBoard', {
        action: 'listSubscriptions',
        agentId: WAKE_AGENT_ID,
        sessionId: hostSessionId,
      })
      for (const board of (subs && Array.isArray(subs.subscriptions) && subs.subscriptions) || []) {
        if (!board.taskId || board.taskId === WAKE_WORLD_TASK) continue
        const read = await daemonCall('taskBoard', {
          action: 'read',
          taskId: board.taskId,
          agentId: WAKE_AGENT_ID,
          limit: WAKE_MAX_ENTRIES,
        })
        collect(board.taskId, read && read.entries)
      }

      const mine = candidates.filter((entry) => isWakeCandidate(entry, childTargets))

      // 世界广播公告：独立于"唤醒谁"，对每个新的协作类条目（question/blocker/
      // handoff，非广播自身）广播到 world 频道一次，让其他 agent 看到并认领。
      // 与 pi 原版一致（.pi/extensions/nmg/index.ts:1731）：ownEcho 过滤只阻止
      // 广播者唤醒自己，广播本身仍无条件触发——自己发的协作条目也要让 others
      // 注意到。dedup 靠 WORLD_BROADCAST_SESSION 哨兵回执（每条目至多一次）。
      if (wakeConfig && wakeConfig.worldBroadcast) {
        for (const entry of mine) {
          try {
            await maybeBroadcastToWorld(entry, WAKE_AGENT_ID, hostSessionId)
          } catch {
            // best-effort: 广播失败不打断唤醒循环
          }
        }
      }

      if (mine.length === 0) return

      // 多会话：对每个活跃 agent 分别做自回声过滤、投递回执（delivery
      // receipt 按 sessionId 区分）、入队和主动唤醒——同一 host 的多个 DSH
      // 会话各自独立收到黑板条目，互不抢占。
      for (const [agentSessionId, agent] of lastAgents) {
        if (!agent || typeof agent.send !== 'function') continue

        // per-agent 自回声：条目是当前会话自己放的（或 agentId 是项目身份
        // 且无 sourceSession）→ 不催自己。
        const theirs = mine.filter((entry) => {
          if (childTargets.has(String(entry.to || ''))) return false
          const ownEcho =
            (entry.sourceSessionId === agentSessionId && entry.agentId === WAKE_AGENT_ID) ||
            entry.sourceSessionId === agentSessionId ||
            (entry.sourceSessionId == null && entry.agentId === WAKE_AGENT_ID)
          return !ownEcho
        })
        if (theirs.length === 0) continue

        // Delivery receipt + suppression: skip entries this agent already
        // received/acked, or on a suppressed channel.
        const fresh = []
        for (const taskId of new Set(theirs.map((c) => c.taskId))) {
          const group = theirs.filter((c) => c.taskId === taskId)
          const check = await daemonCall('taskBoard', {
            action: 'deliveryCheck',
            agentId: WAKE_AGENT_ID,
            sessionId: agentSessionId,
            taskId: taskId || WAKE_WORLD_TASK,
            entryIds: group.map(wakeEntryKey),
          })
          if (check && check.suppressed) continue
          const delivered = new Set((check && Array.isArray(check.delivered) && check.delivered) || [])
          const acked = new Set((check && Array.isArray(check.acked) && check.acked) || [])
          for (const entry of group) {
            if (!delivered.has(wakeEntryKey(entry)) && !acked.has(wakeEntryKey(entry))) fresh.push(entry)
          }
        }
        if (fresh.length === 0) continue

        // 只推最高优先级一个（question > blocker > handoff，再按创建时间）——
        // 与 nmg-hook.mjs 一致，避免一次把多个条目塞进上下文造成刷屏。
        fresh.sort(
          (left, right) =>
            (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) ||
            String(left.createdAt || '').localeCompare(String(right.createdAt || '')),
        )
        const pick = fresh[0]

        // 先把条目推入 wake batch（context 数据源，模型无论何时醒来都能看到
        // 待办列表），再主动唤醒 agent。发送成功后才写 delivery receipt
        // （at-least-once 通知去重），避免 send 失败（agent 已 dispose）时写
        // 回执但消息没入队导致条目"已送达但未通知"下轮不重试。
        pushWakeEntry(pick, agentSessionId)
        if (wakeAgent(agent, pick)) {
          await daemonCall('taskBoard', {
            action: 'recordDelivery',
            agentId: WAKE_AGENT_ID,
            sessionId: agentSessionId,
            entryId: wakeEntryKey(pick),
            source: 'wake',
          })
        }
      }

      // Continuable child delivery: wake through subagents.followup (cold
      // resumes a persisted child), and only record the delivery receipt after
      // the inbox accepted the message so a failed resume retries next tick.
      for (const [childId, parent] of childMap) {
        const theirs = mine.filter((entry) => String(entry.to || '') === childId && entry.sourceSessionId !== childId)
        if (theirs.length === 0) continue
        const fresh = []
        for (const taskId of new Set(theirs.map((c) => c.taskId))) {
          const group = theirs.filter((c) => c.taskId === taskId)
          const check = await daemonCall('taskBoard', {
            action: 'deliveryCheck',
            agentId: childId,
            sessionId: childId,
            taskId: taskId || WAKE_WORLD_TASK,
            entryIds: group.map(wakeEntryKey),
          })
          if (check && check.suppressed) continue
          const delivered = new Set((check && Array.isArray(check.delivered) && check.delivered) || [])
          const acked = new Set((check && Array.isArray(check.acked) && check.acked) || [])
          for (const entry of group) {
            if (!delivered.has(wakeEntryKey(entry)) && !acked.has(wakeEntryKey(entry))) fresh.push(entry)
          }
        }
        if (fresh.length === 0) continue
        fresh.sort(
          (left, right) =>
            (KIND_RANK[left.kind] ?? 9) - (KIND_RANK[right.kind] ?? 9) ||
            String(left.createdAt || '').localeCompare(String(right.createdAt || '')),
        )
        const pick = fresh[0]
        try {
          await subagents.followup(
            parent,
            childId,
            [{ type: 'text', text: wakeMessageText(pick) }],
            { source: { kind: 'plugin', plugin: '@nmg/dsh-nmg' }, signal: AbortSignal.timeout(5000) },
          )
        } catch {
          continue
        }
        await daemonCall('taskBoard', {
          action: 'recordDelivery',
          agentId: childId,
          sessionId: childId,
          entryId: wakeEntryKey(pick),
          source: 'wake',
        })
        pushWakeEntry(pick, childId)
      }
    } catch {
      // A transient daemon/network error must never throw into the timer. Reset
      // the flag so a daemon restart re-registers cleanly on the next tick.
      wakeAgentRegistered = false
    }
  }

  function wakeMessageText(entry) {
    return (
      '[NMG board] 新黑板条目 #' + entry.sequence + ' [' + entry.kind + '] ' +
      (entry.taskId || '?') + ' by ' + (entry.agentId || '?') + ':\n' +
      truncate(entry.content, 400)
    )
  }

  // 构造一条 user-role 唤醒消息（MessageSource kind=plugin，与 dsh 生态一致）
  // 并推给指定 agent 会话。发送失败静默——context 兜底仍会展示。
  //
  // 不再手工判断 agent.status：本机 agent.send(input, 'next-turn', true) 的
  // 原生队列已自带"空闲立即唤醒、忙则排进 next-turn 队列、当前 turn 跑完后
  // 自动再取"的语义（dsh-agent-loop wakeDriver + kick() finally 的
  // wakeRequested/hasPending 再唤醒）。这里直接 send 即可，由 native 队列
  // 承担"没东西就发出去，有东西就等待"。内容直接携带黑板待办详情（纯展示，
  // 不带强制工具指令），模型看完自主决定是否用 nmg_board 处理。
  function wakeAgent(agent, entry) {
    if (!agent || typeof agent.send !== 'function') return false
    try {
      agent.send(
        {
          id: randomUUID(),
          role: 'user',
          content: [{ type: 'text', text: wakeMessageText(entry) }],
          source: { kind: 'plugin', plugin: '@nmg/dsh-nmg' },
        },
        'next-turn',
        true,
      )
      return true
    } catch {
      return false
    }
  }

  function wakeTextFor(agent) {
    if (!agent) return ''
    try {
      const batch = wakeBatch.get(String(agent.id))
      if (!Array.isArray(batch) || batch.length === 0) return ''
      const lines = batch.map(wakeEntryLine)
      lines.push('Claim with nmg_board claim (claim=接手), resolve with nmg_board resolve.')
      return 'NMG board wake (' + batch.length + ' pending):\n' + lines.join('\n')
    } catch {
      return ''
    }
  }

  function wakeDataFor(targetSessionId) {
    if (!targetSessionId) return null
    try {
      const batch = wakeBatch.get(String(targetSessionId))
      if (!Array.isArray(batch) || batch.length === 0) return null
      return {
        entries: batch.map((entry) => ({
          id: entry.id,
          sequence: entry.sequence,
          taskId: entry.taskId,
          kind: entry.kind,
          status: entry.status,
          agentId: entry.agentId,
          claimedBy: entry.claimedBy || null,
          content: entry.content,
        })),
      }
    } catch {
      return null
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────
  const searchTool = {
    name: 'nmg_search',
    description: nmgPrompts.search_description,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Focused recall query.' },
        limit: { type: 'integer', description: 'Return 1..50 records (default 8).' },
        maxTier: { type: 'integer', description: 'Deepest memory tier 0..3.' },
        graphHops: { type: 'integer', description: 'Graph expansion 0..3.' },
        nodeName: { type: 'string', description: 'Restrict to one semantic node.' },
        sourceActor: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'], description: 'Restrict evidence actor.' },
        includeHistorical: { type: 'boolean', description: 'Include inactive/superseded memories.' },
        scope: { type: 'object', additionalProperties: true, description: 'Applicability scope, e.g. {"project":"nmg"}.' },
      },
      required: ['query'],
    },
    output: textOutput,
    async execute(args, exec) {
      const params: Record<string, any> = { query: args.query, projectDir: workspaceRoot }
      if (args.limit != null) params.limit = args.limit
      if (args.maxTier != null) params.maxTier = args.maxTier
      if (args.graphHops != null) params.graphHops = args.graphHops
      if (args.nodeName) params.nodeName = args.nodeName
      if (args.sourceActor) params.sourceActor = args.sourceActor
      if (args.includeHistorical) params.includeHistorical = true
      if (args.scope) params.scope = coerceScope(args.scope)
      const argv = ['search', args.query]
      if (args.limit != null) argv.push('--limit', String(args.limit))
      if (args.maxTier != null) argv.push('--max-tier', String(args.maxTier))
      if (args.graphHops != null) argv.push('--graph-hops', String(args.graphHops))
      if (args.nodeName) argv.push('--node', args.nodeName)
      if (args.sourceActor) argv.push('--source-actor', args.sourceActor)
      if (args.includeHistorical) argv.push('--include-historical')
      for (const pair of scopeArgs(args.scope)) argv.push(pair[0], pair[1])
      argv.push('--project-dir', workspaceRoot, '--json')
      const r = await invoke('search', params, argv, exec.signal, null)
      if (!r.ok) return r.error
      const data = r.data
      const deferred = data.progressiveDisclosure && data.progressiveDisclosure.deferredMemoryIds
      const nextStep = Array.isArray(deferred) && deferred.length
        ? 'More ranked records are folded. Expand selected memory IDs first; deferred IDs: ' + deferred.join(',')
        : 'Select exact records with nmg_get (memory IDs + activeGraphId).'
      const forget = data.results.some((result) =>
        (result.memory.markers || []).some((marker) => marker.kind === 'forget'),
      )
      return renderSearchSurface(data, {
        preamble: renderDisclosure(nmgPrompts.search_disclosure, {
          count: String(data.results.length),
          next_step: nextStep,
          forget_hint: forget ? nmgPrompts.forget_hint : '',
        }),
      })
    },
  }

  const getTool = {
    name: 'nmg_get',
    description: nmgPrompts.get_description,
    parameters: {
      type: 'object',
      properties: {
        memoryIds: { type: 'array', items: { type: 'string' }, description: 'Memory IDs from nmg_search.' },
        activeGraphId: { type: 'string', description: 'activeGraphId returned by the matching nmg_search.' },
        graphHops: { type: 'integer', description: 'Graph expansion 0..3.' },
      },
      required: ['memoryIds'],
    },
    output: textOutput,
    async execute(args, exec) {
      const ids = Array.isArray(args.memoryIds) ? args.memoryIds : []
      if (ids.length === 0) return 'nmg_get requires at least one memory ID.'
      const params: Record<string, any> = { memoryIds: ids, projectDir: workspaceRoot }
      if (args.activeGraphId) params.activeGraphId = args.activeGraphId
      if (args.graphHops != null) params.graphHops = args.graphHops
      const argv = ['get'].concat(ids)
      if (args.activeGraphId) argv.push('--active-graph-id', args.activeGraphId)
      if (args.graphHops != null) argv.push('--graph-hops', String(args.graphHops))
      argv.push('--project-dir', workspaceRoot, '--json')
      const r = await invoke('get', params, argv, exec.signal, null)
      if (!r.ok) return r.error
      const forget = r.data.results.some((result) =>
        (result.memory.markers || []).some((marker) => marker.kind === 'forget'),
      )
      return renderEvidenceSurface(r.data, {
        preamble: renderDisclosure(nmgPrompts.get_disclosure, {
          count: String(r.data.results.length),
          next_step: '',
          forget_hint: forget ? nmgPrompts.forget_hint : '',
        }),
        missingMemoryIds: Array.isArray(r.data.missingMemoryIds) ? r.data.missingMemoryIds : undefined,
      })
    },
  }

  const rememberTool = {
    name: 'nmg_remember',
    description: 'Save or update durable memory through the shared NMG lifecycle contract. Never save secrets, chatter, unverified model claims, or transient failures.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...COMMON_REMEMBER_ACTIONS], description: 'Memory action (default save).' },
        memoryId: { type: 'string', description: 'Existing memory for forget/resolve/reopen/claim_outcome.' },
        newMemoryId: { type: 'string', description: 'Newer memory for supersede/relate.' },
        supersededMemoryId: { type: 'string', description: 'Older memory replaced by newMemoryId.' },
        relatedMemoryId: { type: 'string', description: 'Existing memory related to newMemoryId.' },
        relatedMemoryIds: { type: 'array', items: { type: 'string' }, description: 'Evidence anchors for resolve/reopen.' },
        relationJudgement: { type: 'string', enum: ['conflict', 'distinct', 'refines', 'related', 'same_entity'] },
        relationConfidence: { type: 'number', description: 'Relation confidence 0..1.' },
        resolutionReason: { type: 'string', description: 'Reason for supersede/resolve/reopen.' },
        semanticTaskId: { type: 'string', description: 'Independent task identity for claim_outcome.' },
        activeGraphId: { type: 'string', description: 'Active graph that produced the evaluated claim.' },
        claimOutcome: { type: 'string', enum: ['supported', 'contradicted'] },
        claimSourceLineage: { type: 'string', description: 'Stable attributable source lineage.' },
        claimIndexes: { type: 'array', items: { type: 'integer' } },
        claimWeight: { type: 'number', description: 'Claim reliability in (0,1].' },
        statement: { type: 'string', description: 'Self-contained semantic statement.' },
        nodeName: { type: 'string', description: 'Stable node grouping related memories.' },
        memoryType: { type: 'string', enum: ['fact', 'state', 'event', 'preference', 'constraint', 'strategy'], description: 'Memory type.' },
        recallTriggers: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 80 }, description: nmgPrompts.recall_triggers_parameter_description },
        stateKey: { type: 'string', description: 'Replaceable property identity; a new value in the same scope supersedes the old.' },
        sourceActor: { type: 'string', enum: ['user', 'assistant', 'system', 'tool'], description: 'Evidence actor (default user).' },
        truthStatus: { type: 'string', enum: ['asserted', 'inferred', 'unverified', 'verified'], description: 'Truth status.' },
        evidence: { type: 'string', description: 'Exact supporting source excerpt.' },
        eventTime: { type: 'string', description: 'ISO event time when it differs from write time.' },
        tier: { type: 'integer', description: 'Initial tier 0..3.' },
        importance: { type: 'number', description: 'Importance 0..1.' },
        residence: { type: 'string', enum: ['ltg', 'stg'], description: 'ltg (durable) or stg (session/task-local).' },
        writeReason: { type: 'string', description: 'Durable-write justification.' },
        scope: { type: 'object', additionalProperties: true, description: 'Applicability scope, e.g. {"project":"nmg"}.' },
      },
      required: [],
    },
    output: textOutput,
    async execute(args, exec) {
      const action = args.action || 'save'
      const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : hostSessionId
      if (action === 'claim_outcome') {
        if (!args.memoryId || !args.claimOutcome || !args.semanticTaskId || !args.claimSourceLineage) {
          return 'nmg_remember claim_outcome requires memoryId, claimOutcome, semanticTaskId, and claimSourceLineage.'
        }
        const result = await invokeRpcOnly('recordClaimOutcomes', {
          semanticTaskId: args.semanticTaskId,
          activeGraphId: args.activeGraphId,
          sessionId,
          collectionOrigin: 'natural',
          projectDir: workspaceRoot,
          votes: [{
            memoryId: args.memoryId,
            claimIndexes: args.claimIndexes,
            outcome: args.claimOutcome,
            source: 'task',
            sourceLineage: args.claimSourceLineage,
            weight: args.claimWeight,
          }],
        }, exec.signal)
        return result.ok ? JSON.stringify(result.data) : result.error
      }
      if (action !== 'save') {
        const params: Record<string, any> = { action, projectDir: workspaceRoot, sessionId }
        if (args.memoryId) params.memoryId = args.memoryId
        if (args.newMemoryId) params.newMemoryId = args.newMemoryId
        if (args.supersededMemoryId) params.supersededMemoryId = args.supersededMemoryId
        if (args.relatedMemoryId) params.relatedMemoryId = args.relatedMemoryId
        if (args.relatedMemoryIds) params.relatedMemoryIds = args.relatedMemoryIds
        if (args.relationJudgement) params.relationJudgement = args.relationJudgement
        if (args.relationConfidence != null) params.confidence = args.relationConfidence
        if (args.resolutionReason) params.reason = args.resolutionReason
        const result = await invokeRpcOnly('resolveRemember', params, exec.signal)
        return result.ok ? JSON.stringify(result.data) : result.error
      }
      if (!args.statement || !args.nodeName) {
        return 'nmg_remember save requires statement and nodeName.'
      }
      const params: Record<string, any> = { statement: args.statement, nodeName: args.nodeName, projectDir: workspaceRoot }
      if (args.memoryType) params.memoryType = args.memoryType
      if (args.recallTriggers) params.recallTriggers = args.recallTriggers
      if (args.stateKey) params.stateKey = args.stateKey
      if (args.sourceActor) params.sourceActor = args.sourceActor
      if (args.truthStatus) params.truthStatus = args.truthStatus
      if (args.evidence) params.evidence = args.evidence
      if (args.eventTime) params.eventTime = args.eventTime
      if (args.tier != null) params.tier = args.tier
      if (args.importance != null) params.importance = args.importance
      if (args.residence) params.residence = args.residence
      if (args.writeReason) params.writeReason = args.writeReason
      if (args.scope) params.scope = coerceScope(args.scope)
      const argv = ['remember', args.statement, '--node', args.nodeName]
      if (args.memoryType) argv.push('--type', args.memoryType)
      for (const trigger of args.recallTriggers || []) argv.push('--recall-trigger', trigger)
      if (args.stateKey) argv.push('--state-key', args.stateKey)
      if (args.sourceActor) argv.push('--actor', args.sourceActor)
      if (args.truthStatus) argv.push('--truth', args.truthStatus)
      if (args.evidence) argv.push('--evidence', args.evidence)
      if (args.eventTime) argv.push('--event-time', args.eventTime)
      if (args.tier != null) argv.push('--tier', String(args.tier))
      if (args.importance != null) argv.push('--importance', String(args.importance))
      if (args.residence) argv.push('--residence', args.residence)
      if (args.writeReason) argv.push('--write-reason', args.writeReason)
      for (const pair of scopeArgs(args.scope)) argv.push(pair[0], pair[1])
      argv.push('--project-dir', workspaceRoot, '--json')
      const r = await invoke('remember', params, argv, exec.signal, null)
      if (!r.ok) return r.error
      return renderRememberSurface(r.data)
    },
  }

  const boardTool = {
    name: 'nmg_board',
    description: 'Temporary, task-scoped cross-agent coordination (not durable memory). Entries expire. Use a stable taskId; default agent identity is "dsh". Promote durable conclusions only through a separate nmg_remember.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: [...COMMON_BOARD_ACTIONS], description: 'Board action.' },
        taskId: { type: 'string', description: 'Task channel; omit for the shared world channel.' },
        content: { type: 'string', description: 'Entry text (put).' },
        kind: { type: 'string', enum: ['goal', 'note', 'question', 'result', 'handoff', 'decision', 'blocker'], description: 'Entry kind (put).' },
        agentId: { type: 'string', description: 'Writer/reader identity (default "dsh").' },
        entryId: { type: 'string', description: 'Entry to resolve/claim/release.' },
        resolution: { type: 'string', description: 'Resolution note (resolve).' },
        reason: { type: 'string', description: 'Reason for acknowledge/subscribe/unsubscribe.' },
        afterCursor: { type: 'integer', description: 'Read only entries after this sequence (read).' },
        limit: { type: 'integer', description: 'Max entries (read).' },
        includeResolved: { type: 'boolean', description: 'Include resolved entries (read).' },
        ttlSeconds: { type: 'integer', description: 'Entry lifetime 60..2592000 (put).' },
        to: { type: 'string', description: 'Directed delivery to a stable agent name (put).' },
        leaseSeconds: { type: 'integer', description: 'Claim lease 60..86400 (claim).' },
        capabilities: { type: 'string', description: 'Capability substring filter (discover).' },
      },
      required: ['action'],
    },
    output: textOutput,
    async execute(args, exec) {
      const agent = args.agentId || WAKE_AGENT_ID
       const sourceSessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : hostSessionId
      const taskId = args.taskId || WAKE_WORLD_TASK
      if (['resolve', 'acknowledge', 'claim', 'release'].includes(args.action) && (!args.taskId || !args.entryId)) {
        return 'nmg_board ' + args.action + ' requires taskId and entryId.'
      }
      if (!COMMON_BOARD_ACTIONS.includes(args.action)) {
        return 'Unsupported board action: ' + args.action
      }
      const params: Record<string, any> = { action: args.action, agentId: agent }
      const argv = ['board', args.action]
      if (args.action === 'subscribe' || args.action === 'unsubscribe') {
        const result = await invokeRpcOnly('taskBoard', {
          action: args.action,
          taskId,
          sessionId: sourceSessionId,
          agentId: agent,
          reason: args.reason,
        }, exec.signal)
        return result.ok ? JSON.stringify(result.data) : result.error
      } else if (args.action === 'acknowledge') {
        const result = await invokeRpcOnly('taskBoard', {
          action: args.action,
          taskId,
          entryId: args.entryId,
          agentId: agent,
          sourceSessionId,
          reason: args.reason,
        }, exec.signal)
        return result.ok ? JSON.stringify(result.data) : result.error
      } else if (args.action === 'discover') {
        params.taskId = 'default'
        if (args.capabilities) params.capabilities = args.capabilities
        argv.push('--agent', agent)
        if (args.capabilities) argv.push('--capabilities', args.capabilities)
      } else if (args.action === 'put') {
        params.taskId = taskId
        params.content = args.content || ''
        if (args.kind) params.kind = args.kind
        if (args.to) params.to = args.to
        if (args.ttlSeconds != null) params.ttlSeconds = args.ttlSeconds
        params.sourceSessionId = sourceSessionId
        argv.push(taskId, args.content || '')
        argv.push('--agent', agent)
        argv.push('--session-id', sourceSessionId)
        if (args.kind) argv.push('--kind', args.kind)
        if (args.to) argv.push('--to', args.to)
        if (args.ttlSeconds != null) argv.push('--ttl-seconds', String(args.ttlSeconds))
      } else if (args.action === 'read') {
        params.taskId = taskId
        if (args.afterCursor != null) params.afterCursor = args.afterCursor
        if (args.limit != null) params.limit = args.limit
        if (args.includeResolved) params.includeResolved = true
        argv.push(taskId, '--agent', agent)
        if (args.afterCursor != null) argv.push('--after-cursor', String(args.afterCursor))
        if (args.limit != null) argv.push('--limit', String(args.limit))
        if (args.includeResolved) argv.push('--include-resolved')
      } else {
        params.taskId = taskId
        params.entryId = args.entryId
        if (args.action === 'resolve' && args.resolution) params.resolution = args.resolution
        if (args.action === 'claim' && args.leaseSeconds != null) params.leaseSeconds = args.leaseSeconds
        argv.push(taskId, args.entryId, '--agent', agent)
        if (args.action === 'resolve' && args.resolution) argv.push('--resolution', args.resolution)
        if (args.action === 'claim' && args.leaseSeconds != null) argv.push('--lease-seconds', String(args.leaseSeconds))
      }
      argv.push('--json')
      const r = await invoke('taskBoard', params, argv, exec.signal, null)
      if (!r.ok) return r.error
      // When the model claims or resolves a woken entry, drop it from the
      // pending wake batch — the work has been picked up.
      if (args.entryId && (args.action === 'claim' || args.action === 'resolve')) {
        removeWakeEntry(args.entryId)
      }
      return renderTaskBoardSurface(r.data, { taskId })
    },
  }

  const daemonTool = {
    name: 'nmg_daemon',
    description: 'Read-only NMG daemon health check. The adapter may ensure a daemon is running for requests, but it does not expose lifecycle ownership or stop it on plugin disposal.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status'], description: 'Health check.' },
      },
      required: ['action'],
    },
    output: textOutput,
    async execute(args, exec) {
      const argv = ['daemon', args.action, '--json']
      const r = await invoke('status', {}, argv, exec.signal, projectDaemonStatus)
      if (!r.ok) return r.error
      const data = r.data
      if (args.action === 'status') {
        if (!data.running) return 'NMG daemon: not running (one-shot CLI still works in-process).'
        return 'NMG daemon: running pid=' + data.pid + ' endpoint=' + data.endpoint + ' compatible=' + data.compatible
      }
      return JSON.stringify(data)
    },
  }

  const labTool = {
    name: 'nmg_lab',
    description: 'Discover and temporarily enable optional NMG capabilities for this session. Reasoning workspace, graph reasoner, and controller shadow are self-service; controlled/active controller modes remain gated.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'status', 'enable', 'disable', 'invoke'] },
        capability: { type: 'string', enum: ['reasoning_workspace', 'memory_graph_reasoner', 'controller_shadow', 'controller_controlled', 'controller_active'] },
        reason: { type: 'string' },
        ttlSeconds: { type: 'integer' },
        operation: { type: 'string' },
        input: { type: 'object', additionalProperties: true },
      },
      required: ['action'],
    },
    output: textOutput,
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.id ? String(exec.agent.id) : hostSessionId
      if (args.action !== 'list' && !args.capability) return args.action + ' requires capability.'
      if (args.action === 'enable' && !args.reason) return 'enable requires reason.'
      if (args.action === 'invoke' && !args.operation) return 'invoke requires operation.'
      const params: Record<string, any> = {
        action: args.action,
        capability: args.capability,
        sessionId,
        requester: args.action === 'enable' ? 'agent:dsh' : undefined,
        reason: args.reason,
        ttlSeconds: args.ttlSeconds,
        operation: args.operation,
        input: args.input,
      }
      const argv = ['lab', args.action]
      if (args.capability) argv.push(args.capability)
      if (args.action !== 'list') argv.push('--session-id', sessionId)
      if (args.action === 'enable') {
        argv.push('--requester', 'agent:dsh', '--reason', args.reason)
        if (args.ttlSeconds != null) argv.push('--ttl-seconds', String(args.ttlSeconds))
      }
      if (args.action === 'invoke') {
        argv.push('--operation', args.operation)
        if (args.input != null) argv.push('--input-json', JSON.stringify(args.input))
      }
      argv.push('--json')
      const r = await invoke('lab', params, argv, exec.signal, null)
      if (!r.ok) return r.error
      return JSON.stringify(r.data, null, 2)
    },
  }

  // DSH-native automatic recall: a named systemPrompt.context contribution. The
  // agent loop materializes its resolved text as a user-role snapshot appended to
  // the turn's messages (no manual message fabrication). The recall search is
  // started when the user message enters the inbox, before the turn's first
  // assembly. order 90 places it after the persona (0) and before tool guidance
  // (100-199) so the memory surfaces as part of the runtime context.
  const contextDisposer = systemPrompt.context({
    name: 'nmg:recall',
    order: 90,
    text: (assembleContext) => recallTextFor(assembleContext && assembleContext.agent),
  })

  // Board wake surfaces as a second native context contribution, ordered before
  // recall (85 < 90) so pending work reads ahead of memory.
  const boardWakeContextDisposer = coordinationEnabled
    ? systemPrompt.context({
        name: 'nmg:board-wake',
        order: 85,
        text: (assembleContext) => wakeTextFor(assembleContext && assembleContext.agent),
      })
    : undefined

  // ── webServer route: persistent host→browser channel ───────────────────────
  // Persistent (host-composition) packages have no harness.handle/host.call RPC
  // (that is the dynamic Cordis Runner's channel). The sanctioned way for the
  // browser half to read host-owned data is a same-origin HTTP route through
  // `ctx.webServer` (docs/subsystems/web-server.md). We expose the current
  // session's latest recall snapshot — plain JSON projected from recallBatch;
  // the daemon bearer token never leaves the host. The service binds late (like
  // genui's asset route), so probe now AND subscribe to `internal/service`.
  const ROUTE_PATH = '/nmg/recall'
  let routeRegistered = false
  let routeDisposer = undefined
  function tryRegisterRoute(server) {
    if (routeRegistered || !server || typeof server.register !== 'function') return
    const dispose = server.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler(req, res) {
        try {
          const url = req.url || '/nmg/recall'
          const sessionId = new URL(url, 'http://x').searchParams.get('session') || ''
          const data = recallDataFor(sessionId)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, data }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: error && error.message ? String(error.message) : String(error) }))
        }
      },
    })
    routeDisposer = typeof dispose === 'function' ? dispose : undefined
    routeRegistered = true
  }
  tryRegisterRoute((() => { try { return ctx.reflect.get('webServer', false) } catch { return undefined } })())
  ctx.on('internal/service', (name, value) => {
    if (name === 'webServer') tryRegisterRoute(value)
  })

  // Board-wake route: expose the pending board-wake batch to the browser pill
  // (same pattern as recall). Daemon token never crosses the boundary.
  const WAKE_ROUTE_PATH = '/nmg/board-wake'
  let wakeRouteRegistered = false
  let wakeRouteDisposer = undefined
  function tryRegisterWakeRoute(server) {
    if (wakeRouteRegistered || !server || typeof server.register !== 'function') return
    const dispose = server.register({
      kind: 'prefix',
      path: WAKE_ROUTE_PATH,
      handler(req, res) {
        try {
          const url = req.url || WAKE_ROUTE_PATH
          const targetSessionId = new URL(url, 'http://x').searchParams.get('session') || ''
          const data = wakeDataFor(targetSessionId)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, data }))
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: error && error.message ? String(error.message) : String(error) }))
        }
      },
    })
    wakeRouteDisposer = typeof dispose === 'function' ? dispose : undefined
    wakeRouteRegistered = true
  }
  if (coordinationEnabled) {
    tryRegisterWakeRoute((() => { try { return ctx.reflect.get('webServer', false) } catch { return undefined } })())
  }
  const wakeServiceDisposer = coordinationEnabled
    ? ctx.on('internal/service', (name, value) => {
        if (name === 'webServer') tryRegisterWakeRoute(value)
      })
    : undefined

  // ── wake timer + startup ───────────────────────────────────────────────────
  // Single host-side timer polls the daemon for board entries every
  // WAKE_INTERVAL_MS. The first poll also registers the agent and starts the
  // heartbeat cycle. If the daemon is not running at startup, the timer keeps
  // trying — the first successful poll registers the agent cleanly.
  //
  // Cordis-native timers (ctx.interval / ctx.timeout) instead of the Node
  // globals: they return disposers, are auto-released with the fiber on
  // dispose/update, and require the `timer` service in `inject`. Note
  // ctx.setInterval / ctx.setTimeout are deprecated in favor of these.
  const wakeTimerDisposer = coordinationEnabled
    ? ctx.interval(boardWakeOnce, WAKE_INTERVAL_MS)
    : undefined
  // First poll on next tick (let the event loop settle).
  const initialWakeDisposer = coordinationEnabled ? ctx.timeout(boardWakeOnce, 0) : undefined

  const disposers = [
    tools.register(searchTool),
    tools.register(getTool),
    tools.register(rememberTool),
    tools.register(labTool),
    tools.register(daemonTool),
    contextDisposer,
    ctx.on('agent/inbox/inserted', onInboxInserted),
    ctx.on('agent/disposed', onAgentDisposed),
  ]
  if (coordinationEnabled) {
    disposers.push(
      tools.register(boardTool),
      boardWakeContextDisposer,
      wakeServiceDisposer,
      wakeTimerDisposer,
      initialWakeDisposer,
    )
  }
  if (routeDisposer) disposers.push(routeDisposer)
  if (wakeRouteDisposer) disposers.push(wakeRouteDisposer)

  // Return the cordis dispose-time cleanup for this plugin contribution.
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
    recallWindows.clear()
    sessionTokenTotals.clear()
    recallBatch.clear()
    openSearches.clear()
    wakeBatch.clear()
  }
}
