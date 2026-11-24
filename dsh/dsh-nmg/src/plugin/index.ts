import { assembleAdapterCapabilities, disabledBoardCapability } from '../../../../src/integration/adapter-capability-assembly.ts'
import { ADAPTER_CAPABILITY_CATALOG } from '../../../../src/integration/adapter-capability-catalog.ts'
// NMG adapter for DeepSeek Harness — community-standard dual-face host package.
//
// HOST-ADAPTER BOUNDARY (shared layer rule): this package is a thin transport
// only. Every NMG capability (recall staging, context-use feedback / online
// learning, shadow events, nudges, …) lives in the SHARED layer — src/* core
// modules and the daemon RPC surface (NmgService methods) — never implemented
// or forked here. A capability that works in one adapter (pi / dsh / …) but not
// another is a defect: add it to src/ + the daemon, then have every adapter
// forward the same RPC. Duplicating logic adapter-side drifts and goes stale.
//
// Host half: registers model tools (nmg_search / nmg_get / nmg_remember /
// nmg_state / nmg_lab / nmg_daemon) into the host `tools` registry and implements
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

import { readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connect } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import { coordinationEnabled as configuredCoordinationEnabled } from '../../../../src/integration/config.ts'
import { requiresEventTimeReference } from '../../../../src/cli/protocol.ts'
import { maybeBroadcastToWorld as broadcastWakeEntry } from '../../../../src/integration/board-wake.ts'
import { loadOrCreateAgentIdentity, renameAgentIdentity } from '../../../../src/integration/agent-identity.ts'
import { compactSearchContext } from '../../../../src/integration/search-projection.ts'
import { loadPrompts, renderDisclosure } from '../../../../src/prompts/load.ts'
import { RecallBudget } from '../../../../src/integration/recall-budget.ts'
import { prepareInformationOutput } from '../../../../src/integration/information-output.ts'
import { DshNativeEvents } from './native-events.ts'
import { contextOnlineLearningEnabled } from '../../../../src/lab/context-router-online.ts'

const nmgPrompts = loadPrompts()

/** daemon 回了一个**领域**错误（请求格式对、规则不允许），不是"连不上"。 */
class NmgRpcError extends Error {
  readonly rpc = true
  constructor(message: string) {
    super(message)
    this.name = 'NmgRpcError'
  }
}

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

export function apply(ctx: Context): (() => Promise<void>) & { ready: Promise<void> } {
  let prepareAutomaticRecallSurface: typeof import('../../../../src/integration/agent-surface.ts').prepareAutomaticRecallSurface
  let contextStateViews: typeof import('../../../../src/integration/context-information.ts').contextStateViews
  const tools = ctx.tools
  const subprocess = ctx.subprocess
  const sandboxPolicy = ctx.sandboxPolicy
  const systemPrompt = ctx.systemPrompt
  const coordinationEnabled = configuredCoordinationEnabled()

  const workspaceRoot =
    (process.env.NMG_PROJECT_DIR && process.env.NMG_PROJECT_DIR.trim()) ||
    (sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot) ||
    'C:\\Documents\\GitHub\\NodeMemoryGraph'
  const binPath = join(workspaceRoot, 'bin', 'nmg.mjs')

  // 裸名 'node' 只有在 PATH 正确时才解析得出来。Windows 上把 User 作用域的变量
  // （NVM_HOME / NVM_SYMLINK）写进 Machine PATH，进程拿到的就是没展开的字面量
  // `%NVM_SYMLINK%` —— 这不是目录，于是 spawn('node') 直接 ENOENT。
  // 所以：先问宿主，再按常见安装位置探**绝对路径**，最后才退回裸名。
  const NODE_CANDIDATES = [
    process.env.NMG_NODE_BIN,
    process.env.NVM_SYMLINK && join(process.env.NVM_SYMLINK, 'node.exe'),
    'C:\\nvm4w\\nodejs\\node.exe',
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)

  let nodePromise
  function resolveNode() {
    if (nodePromise === undefined) {
      nodePromise = (async () => {
        try {
          return await subprocess.resolveExecutable('node')
        } catch {}
        for (const candidate of NODE_CANDIDATES) {
          try {
            if (statSync(candidate).isFile()) return candidate
          } catch {}
        }
        // 宿主是 Electron 时 execPath 是 Electron 本体，带着这个环境变量才当 node 用。
        if (process.versions.electron) return process.execPath
        return 'node'
      })()
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

  async function requireSourceClockOwner(method, params, signal) {
    if (requiresEventTimeReference(method, params)) {
      const hello = await daemonCall('hello', {}, signal, true)
      if (!hello?.capabilities?.includes('event-time-reference'))
        throw new NmgRpcError('NMG daemon does not advertise event-time-reference')
    }
  }

  async function daemonCall(method, params, signal?, propagateFailure = false) {
    const endpoint = resolveDaemon()
    if (!endpoint) return null
    await requireSourceClockOwner(method, params, signal)
    try {
      const response = await fetch('http://' + endpoint.host + ':' + endpoint.port + '/', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + endpoint.token },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
        signal,
      })
      const text = await response.text()
      // daemon 拒绝请求时带 HTTP 4xx **并且**给标准 JSON-RPC error 体。必须先把这种
      // "领域拒绝"和"连不上"分开 —— 否则 !response.ok 抢先降级到 CLI 兜底，一个能修的
      // 错误（缺 stateKey 之类）就变成看不懂的 spawn ENOENT。
      let parsed: any
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
      if (parsed && typeof parsed === 'object' && parsed.error) {
        throw new NmgRpcError(parsed.error.message || 'nmg ' + method + ' error')
      }
      if (!response.ok) throw new Error(text || 'nmg ' + method + ' failed (' + response.status + ')')
      if (parsed === undefined) throw new Error('nmg ' + method + ': non-JSON response')
      return parsed.result
    } catch (error) {
      if (error instanceof NmgRpcError) throw error
      if (propagateFailure || (error && error.name === 'AbortError')) throw error
      daemon = null
      return null
    }
  }

  function readAdapterEndpoint() {
    if (!resolveDaemon()) return undefined
    return daemonCall('hello', {}, AbortSignal.timeout(2000)).catch(() => undefined)
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
    // 子进程也继承坏 PATH 的话，nmg CLI 内部再 spawn 任何东西照样 ENOENT ——
    // 把 node 自己所在目录顶到 PATH 最前，整条链就都对了。
    const nodeDir = node.includes('/') || node.includes('\\') ? node.slice(0, Math.max(node.lastIndexOf('/'), node.lastIndexOf('\\'))) : ''
    const env: Record<string, string> = {}
    if (nodeDir) env.PATH = nodeDir + delimiter + (process.env.PATH ?? '')
    // Electron 宿主：execPath 就是 Electron 本体，必须显式声明按 node 运行。
    if (node === process.execPath && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
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
      ...(Object.keys(env).length ? { env: { ...process.env, ...env } } : {}),
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

  async function invoke(method, params, cliArgs, signal) {
    try {
      const raw = await daemonCall(method, params, signal)
      if (raw != null) return { ok: true, data: raw }
    } catch (error) {
      if (error instanceof NmgRpcError) return { ok: false, error: 'NMG ' + method + ': ' + error.message }
      return { ok: false, error: 'NMG call aborted' }
    }
    return nmgJson(cliArgs, signal)
  }


  // ── automatic recall (DSH-native: systemPrompt.context) ───────────────────
  //
  // Inbox arrival starts bounded recall. Request admission awaits preparation;
  // the native loop then refreshes this synchronous, logged context channel.
  // State has its own complete-body projection and survives an empty recall.

  const recallGenerations = new Map() // sessionId -> generation
  let recallSequence = 0
  const sessionTokenTotals = new Map() // sessionId -> total estimated recall tokens
  const recallBatch = new Map() // sessionId -> recall[] (newest first, capped at MAX_RECALL_HISTORY)
  const MAX_RECALL_HISTORY = 5 // per-session recall rounds kept for the floating indicator
  const openSearches = new Map() // sessionId -> Promise that resolves once the stash is written
  const maintainedState = new Map()
  let nativeEvents: DshNativeEvents
  let collectWakeCandidates: typeof import('../../../../src/integration/board-wake.ts').collectWakeCandidates
  let enqueueBoardWakeBatch: typeof import('../../../../src/integration/board-wake-batch.ts').enqueueBoardWakeBatch
  let reportHarnessActivity: typeof import('../../../../src/integration/board-wake-batch.ts').reportHarnessActivity

  // Activity ledger for the right-pane tab: what the adapter did for a session —
  // automatic recalls, explicit searches, evidence reads. In-memory only; the
  // daemon owns the durable traces, this is the live session view.
  const activityLog = new Map() // sessionId -> entry[] (newest first)
  const MAX_ACTIVITY = 60
  let lastActiveSessionId = ''
  function recordActivity(sessionId, entry) {
    if (!sessionId) return
    const id = String(sessionId)
    lastActiveSessionId = id
    const list = activityLog.get(id) || []
    activityLog.set(id, [{ at: new Date().toISOString(), ...entry }, ...list].slice(0, MAX_ACTIVITY))
  }
  function activityFor(sessionId) {
    if (!sessionId) return []
    return activityLog.get(String(sessionId)) || []
  }

  function nextGeneration(sessionId) {
    const generation = ++recallSequence
    recallGenerations.set(sessionId, generation)
    return generation
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
    return prepareAutomaticRecallSurface(
      {
        ...recall,
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
        postamble: recallFeedbackAffordance(recall.activeGraphId),
      },
    )
  }

  async function autoRecall(query, sessionId, searchBudgetMs, signal) {
    const limit = clampInt(process.env.NMG_AUTO_RECALL_LIMIT, 1, 50, 13)
    const tier = clampInt(process.env.NMG_AUTO_RECALL_TIER, 0, 3, 1)
    try {
      const context = await daemonCall('search', {
        query,
        limit,
        maxTier: tier,
        graphHops: 1,
        tieredDisclosure: true,
        autoRecall: true,
        autoRecallBudgetMs: searchBudgetMs,
        projectDir: workspaceRoot,
        sessionId,
      }, signal)
      if (context) return context
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
      '--json',
    ]
    const result = await nmgJson(argv, signal)
    return result.ok ? result.data : null
  }

  // Start before assembly without blocking inbox delivery. The generation fence
  // prevents late work or an empty turn from reusing a historical fragment.
  function onInboxInserted(payload) {
    try {
      const { agent, message } = payload || {}
      if (!agent || !message || hostDisposed || disposedAgents.has(agent)) return
      // 缓存活跃 agent 实例——定时器唤醒（agent.send）需要它，而事件
      // payload 只在用户消息进入时才有。多会话：每个 agent 独立缓存。
      lastAgents.set(String(agent.id), agent)
      const sessionId = String(agent.id)
      const generation = nextGeneration(sessionId)
      const query = extractUserPrompt(message)
      if (!query) return
      const run = (async () => {
        const budget = new RecallBudget(1500)
        try {
          await budget.run('disclosure.begin', (signal) => daemonCall('sessionActiveGraph', {
            action: 'beginDisclosureTurn',
            sessionId,
            prompt: query,
            projectDir: workspaceRoot,
          }, signal))
          if (recallGenerations.get(sessionId) !== generation) return
          // Keep historical snapshots for the indicator. Only this generation
          // can contribute a fresh automatic fragment to model input.
          const context = await budget.run('search', (signal) =>
            autoRecall(query, sessionId, budget.searchBudgetMs(), signal))
          if (recallGenerations.get(sessionId) !== generation) return
          const recall = context ? compactSearchContext(context) : null
          if (!recall || !Array.isArray(recall.candidates) || recall.candidates.length === 0) {
            return
          }
          // A context contribution has no final transport witness. Its source
          // metadata describes only the budget-admitted preview, not disclosure.
          const output = formatRecall(recall, recall.candidates)
          const freshIds = new Set(output.included.flatMap((entry) =>
            entry.source.kind === 'memory' ? [entry.source.memoryId] : []))
          const fresh = recall.candidates.filter((candidate) => freshIds.has(candidate.id))
          if (fresh.length === 0) return
          const text = output.text
          const thisTokens = estimateTokens(text)
          const sessionTotal = (sessionTokenTotals.get(sessionId) || 0) + thisTokens
          sessionTokenTotals.set(sessionId, sessionTotal)
          const entry = {
            generation,
            output,
            context,
            text,
            tokens: thisTokens,
            sessionTotal,
            candidates: fresh,
            activeGraphId: recall.activeGraphId,
            fedBack: false,
          }
          const history = recallBatch.get(sessionId)
          recallBatch.set(sessionId, [entry, ...(history || [])].slice(0, MAX_RECALL_HISTORY))
          recordActivity(sessionId, {
            kind: 'recall',
            candidates: fresh.length,
            tokens: thisTokens,
            activeGraphId: recall.activeGraphId || null,
          })
        } catch {
          // Historical UI snapshots remain, but their generation cannot enter a new turn.
        } finally {
          budget.close()
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

  function onInboxClaimed(payload) {
    if (!payload?.agent?.id || !Number.isSafeInteger(payload.turn)) return
    nativeEvents.begin(String(payload.agent.id), payload.turn, extractUserPrompt(payload.message))
  }

  // Admission is asynchronous; the native loop refreshes the synchronous
  // context contribution afterwards, before committing the request surface.
  async function prepareMaintainedState(sessionId, generation, budget) {
    const state = await budget.run('state.read', (signal) => daemonCall('state', {
      action: 'read', space: 'ag', sessionId,
    }, signal))
    if (recallGenerations.get(sessionId) !== generation || hostDisposed) return
    const views = state?.space === 'ag' && state.result?.action === 'snapshot'
      ? contextStateViews(state.result.snapshot, sessionId) : []
    const nudge = nativeEvents.takeNudge(sessionId)
      ? [{ purpose: 'guidance' as const, body: renderDisclosure(nmgPrompts.completion_nudge, {}) }] : []
    maintainedState.set(sessionId, { generation, views: [...views, ...nudge] })
  }

  async function onRequest(payload, next) {
    await capabilityAssembly.ready
    const sessionId = String(payload?.agent?.id ?? '')
    if (!sessionId || hostDisposed || disposedAgents.has(payload.agent)) return next()
    const generation = recallGenerations.get(sessionId)
    if (maintainedState.get(sessionId)?.generation === generation && maintainedState.has(sessionId)) return next()
    maintainedState.delete(sessionId)
    const budget = new RecallBudget(1500, payload.signal)
    try {
      await prepareMaintainedState(sessionId, generation, budget)
      await budget.run('recall.ready', async () => { await openSearches.get(sessionId) })
    } catch {
      // Optional context failure leaves the admitted owner state or no state.
    } finally {
      budget.close()
    }
    payload.signal?.throwIfAborted()
    return next()
  }

  // Feedback guidance participates in the same prepared budget. Repeated
  // assembly within this turn returns identical text, not a new disclosure.
  function recallFeedbackAffordance(graphId) {
    if (!graphId || !contextOnlineLearningEnabled()) return ''
    return renderDisclosure(nmgPrompts.recall_feedback_affordance, { graph_id: String(graphId) })
  }

  // The `systemPrompt.context` provider: return the current recall snapshot for
  // the assembling agent, or empty text (contributes nothing). The agent loop
  // materializes the resolved text as a user-role snapshot appended to the turn's
  // messages — DSH-native, no manual message fabrication.
  function recallTextFor(agent) {
    if (!agent) return ''
    try {
      const id = String(agent.id)
      const stack = recallBatch.get(id)
      const latest = Array.isArray(stack) ? stack[0] : stack
      // Historical snapshots remain available to the UI, but a new turn cannot
      // inherit an old automatic injection after a failed/empty search.
      const generation = recallGenerations.get(id)
      const state = maintainedState.get(id)
      const views = state?.generation === generation ? state.views : []
      const output = prepareInformationOutput([
        ...views,
        ...(latest?.generation === generation ? latest.output.views : []),
      ], { format: 'context' })
      if (latest?.generation === generation) {
        const ids = new Set(output.included.flatMap((entry) =>
          entry.source.kind === 'memory' ? [entry.source.memoryId] : []))
        nativeEvents.note(id, { ...latest.context, results: latest.context.results.filter((result) => ids.has(result.memory.id)) })
      }
      return output.text
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
    // The browser's idea of "current session" and the host's agent id are not
    // guaranteed to be the same string, so fall back to the session that most
    // recently produced activity instead of showing an empty pane.
    const requested = sessionId ? String(sessionId) : ''
    const id = requested && (recallBatch.has(requested) || activityLog.has(requested))
      ? requested
      : lastActiveSessionId
    if (!id) return null
    const activity = activityFor(id)
    try {
      const stack = recallBatch.get(id)
      const list = Array.isArray(stack) ? stack : (stack ? [stack] : [])
      if (list.length === 0) return activity.length ? { session: id, recalls: [], activity } : null
      return {
        session: id,
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
        activity,
      }
    } catch {
      return null
    }
  }

  async function onAgentDisposed(payload) {
    try {
      if (payload && payload.agent) {
        const id = String(payload.agent.id)
        disposedAgents.add(payload.agent)
        if (lastAgents.has(id) && lastAgents.get(id) !== payload.agent) return
        recallGenerations.delete(id)
        sessionTokenTotals.delete(id)
        recallBatch.delete(id)
        openSearches.delete(id)
        maintainedState.delete(id)
        activityLog.delete(id)
        wakeBatch.delete(id)
        if (lastAgents.get(id) === payload.agent) lastAgents.delete(id)
        const retirements = [...boardRegistrations.entries()]
          .filter(
            ([sessionId, record]) =>
              (sessionId === id && record.owner === payload.agent) ||
              record.parentId === id,
          )
          .map(([sessionId, record]) =>
            retireBoardRegistration(sessionId, record),
          )
        await Promise.allSettled([
          nativeEvents.clear(id),
          ...retirements,
          daemonCall('sessionActiveGraph', {
            action: 'release',
            sessionId: id,
          }),
        ])
      }
    } catch {
      // cleanup is best-effort
    }
  }

  // ── board wake loop (the "waker") ──────────────────────────────────────────
  // Native status observations are reported to the board's session activity
  // owner. Shared batch dispatch reads that owner and preserves per-source
  // delivery identities. The web pill retains an independent display history.

  const hostSessionId = (process.env.DSH_SESSION_ID || '').trim() || 'dsh'
  const projectName =
    workspaceRoot
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop() || 'dsh'
  const legacyAdapterId = 'dsh:' + projectName
  const WAKE_WORLD_TASK = 'default' // the world channel is always scanned
  const WAKE_MAX_ENTRIES = 50
  const WAKE_INTERVAL_MS =
    clampInt(process.env.NMG_BOARD_WAKE_INTERVAL_SEC, 5, 3600, 30) * 1000

  const wakeBatch = new Map() // sessionId -> entry[] (deduped, newest first)
  let legacyPresenceRetired = false
  const boardRegistrations = new Map()
  const presenceWrites = new Map()
  const disposedAgents = new WeakSet()
  let hostDisposed = false
  let wakeConfig = null // <dataDir>/board-wake.json (enabled/intervalMs/budget/cooldownMs)
  const lastAgents = new Map() // 已注册的活跃 agent 实例（key=String(agent.id)），供定时器按会话唤醒用

  function wakeEntryKey(entry) {
    return entry && entry.id ? String(entry.id) : ''
  }

  function loadWakeConfig() {
    try {
      const home = process.env.USERPROFILE || process.env.HOME || ''
      const dataDir = (process.env.NMG_DATA_DIR || join(home, '.nmg')).replace(
        /[\\/]+$/,
        '',
      )
      wakeConfig = JSON.parse(
        readFileSync(join(dataDir, 'board-wake.json'), 'utf8'),
      )
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
    wakeBatch.set(
      targetSessionId,
      [entry].concat(existing).slice(0, WAKE_MAX_ENTRIES),
    )
  }

  // A resolved or claimed source leaves the display history of every session.
  function removeWakeEntry(entryId) {
    for (const [key, list] of wakeBatch) {
      const next = list.filter(
        (entry) => wakeEntryKey(entry) !== String(entryId),
      )
      if (next.length) wakeBatch.set(key, next)
      else wakeBatch.delete(key)
    }
  }

  async function preparePresenceOwner(signal) {
    const hello = await daemonCall('hello', {}, signal, true)
    if (!hello || !hello.capabilities?.includes('board-agent-presence'))
      throw new Error('NMG daemon does not advertise board-agent-presence')
    if (!legacyPresenceRetired) {
      await retireBoardRegistration(legacyAdapterId, { agentId: legacyAdapterId })
      legacyPresenceRetired = true
    }
  }

  function writeSessionPresence(sessionId, write) {
    const previous = presenceWrites.get(sessionId) || Promise.resolve()
    const next = previous.catch(() => {}).then(write)
    const tracked = next.finally(() => {
      if (presenceWrites.get(sessionId) === tracked)
        presenceWrites.delete(sessionId)
    })
    presenceWrites.set(sessionId, tracked)
    return tracked
  }

  function retireBoardRegistration(sessionId, record) {
    return writeSessionPresence(sessionId, () =>
      withdrawBoardRegistration(sessionId, record),
    )
  }

  async function withdrawBoardRegistration(sessionId, record) {
    const result = await daemonCall(
      'taskBoard',
      {
        action: 'unregisterAgent',
        id: record.agentId,
        presenceToken: record.token,
      },
      undefined,
      true,
    )
    if (!result || result.action !== 'unregisterAgent' || result.id !== record.agentId)
      throw new Error('NMG presence withdrawal was not confirmed')
    if (boardRegistrations.get(sessionId) === record)
      boardRegistrations.delete(sessionId)
  }

  function targetIsLive(target) {
    const owner = target.parent || target.agent
    return (
      !hostDisposed &&
      owner &&
      !disposedAgents.has(owner) &&
      lastAgents.get(String(owner.id)) === owner
    )
  }

  function registerBoardTarget(target, signal) {
    return writeSessionPresence(target.sessionId, () =>
      publishBoardTarget(target, signal),
    )
  }

  async function publishBoardTarget(target, signal) {
    if (!targetIsLive(target))
      throw new Error('DSH Agent endpoint is unavailable')
    const { sessionId } = target
    const owner = target.parent || target.agent
    const identity = loadOrCreateAgentIdentity(sessionId, 'dsh', sessionId)
    let record = boardRegistrations.get(sessionId)
    if (!record || record.owner !== owner) {
      record = {
        owner,
        parentId: target.parent ? String(target.parent.id) : null,
        agentId: identity.id,
        token: randomUUID(),
      }
      boardRegistrations.set(sessionId, record)
    }
    const result = await daemonCall(
      'taskBoard',
      {
        action: 'registerAgent',
        id: identity.id,
        agentName: identity.agentName,
        description: 'DSH Agent session in ' + projectName,
        capabilities: 'dsh-nmg',
        supportedInterfaces: 'dsh-harness',
        presenceToken: record.token,
      },
      signal,
      true,
    )
    if (!result || result.action !== 'registerAgent' || result.id !== identity.id)
      throw new Error('NMG session registration was not confirmed')
    if (!targetIsLive(target)) {
      await withdrawBoardRegistration(sessionId, record)
      throw new Error('DSH Agent session ended during registration')
    }
    return identity
  }

  async function readContinuableChildren() {
    const children = new Map()
    const subagents = ctx.get('subagents')
    if (
      !subagents ||
      typeof subagents.listChildren !== 'function' ||
      typeof subagents.followup !== 'function'
    )
      return children
    for (const [sessionId, parent] of lastAgents) {
      let list
      try {
        list = await subagents.listChildren(sessionId)
      } catch {
        continue
      }
      for (const child of list || [])
        if (child && child.kind === 'child' && child.mode === 'continuable')
          children.set(String(child.id), parent)
    }
    return children
  }

  async function readBoardTargets() {
    const service = ctx.get('agents')
    if (service && typeof service.list === 'function') {
      const current = service.list()
      lastAgents.clear()
      for (const agent of current)
        if (agent && agent.id && !disposedAgents.has(agent))
          lastAgents.set(String(agent.id), agent)
    }
    const children = await readContinuableChildren()
    const targets = []
    for (const [sessionId, agent] of lastAgents)
      if (typeof agent.send === 'function' && !children.has(sessionId))
        targets.push({ sessionId, agent })
    for (const [sessionId, parent] of children)
      targets.push({ sessionId, agent: lastAgents.get(sessionId), parent })
    return targets
  }

  async function deliverBoardTarget(target) {
    try {
      const identity = await registerBoardTarget(target)
      const capabilities = target.parent
        ? ['resume', 'batch-enqueue']
        : ['batch-enqueue']
      if (
        !(await observeHostActivity(
          target.sessionId,
          identity.id,
          target.agent,
          capabilities,
        ))
      )
        return
      if (wakeConfig && wakeConfig.enabled === false) return
      await deliverHostBatch(
        target.sessionId,
        identity.id,
        identity.agentName,
        async (text) => {
          if (target.parent) {
            await ctx
              .get('subagents')
              .followup(
                target.parent,
                target.sessionId,
                [{ type: 'text', text }],
                {
                  source: { kind: 'plugin', plugin: '@nmg/dsh-nmg' },
                  signal: AbortSignal.timeout(5000),
                },
              )
          } else {
            await target.agent.send(
              {
                id: randomUUID(),
                role: 'user',
                content: [{ type: 'text', text }],
                source: { kind: 'plugin', plugin: '@nmg/dsh-nmg' },
              },
              'next-turn',
              true,
            )
          }
        },
      )
    } catch {
      // One unavailable native endpoint leaves its sources pending.
    }
  }

  async function boardWakeOnce() {
    if (hostDisposed) return
    try {
      loadWakeConfig()
      const targets = await readBoardTargets()
      if (!targets.length && !boardRegistrations.size && legacyPresenceRetired)
        return
      if (targets.length && !(await ensureDaemon())) return
      await preparePresenceOwner()
      const active = new Set(targets.map((target) => target.sessionId))
      await Promise.allSettled(
        [...boardRegistrations.entries()]
          .filter(([sessionId]) => !active.has(sessionId))
          .map(([sessionId, record]) =>
            retireBoardRegistration(sessionId, record),
          ),
      )
      for (const target of targets) await deliverBoardTarget(target)
    } catch {
      // Recheck native endpoints and the owner on the next tick.
    }
  }

  async function observeHostActivity(sessionId, agentId, agent, capabilities) {
    try {
      const status = agent && agent.status
      const state =
        status === 'running' ? 'busy' : status === 'idle' ? 'idle' : 'unknown'
      const reported =
        state === 'unknown'
          ? capabilities
          : capabilities.concat(['processing-observation', 'idle-boundary'])
      await reportHarnessActivity(
        daemonCall,
        agentId,
        sessionId,
        state,
        reported,
      )
      return true
    } catch {
      return false
    }
  }

  async function deliverHostBatch(sessionId, agentId, agentName, sendWake) {
    try {
      const entries = await collectWakeCandidates(daemonCall, {
        agentId,
        agentName,
        sessionId,
      })
      const delivered = await enqueueBoardWakeBatch({
        invoke: daemonCall,
        sendWake,
        entries,
        agentId,
        sessionId,
        dataDir: workspaceRoot,
      })
      for (const entry of delivered) {
        pushWakeEntry(entry, sessionId)
        if (wakeConfig && wakeConfig.worldBroadcast)
          await broadcastWakeEntry({
            invoke: daemonCall,
            entry,
            agentId,
            sessionId,
          })
      }
    } catch {
      /* a failed recipient remains pending without blocking other agents */
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
          taskId: entry.taskId,
          kind: entry.kind,
          status: entry.status,
          agentId: entry.agentId,
          claimedBy: entry.claimedBy || null,
          content: entry.content,
          to: entry.to,
          eventId: entry.eventId,
          eventRevision: entry.eventRevision,
          eventNotice: entry.eventNotice,
          notificationSourceId: entry.notificationSourceId,
          notificationChannelId: entry.notificationChannelId,
          notificationScopes: entry.notificationScopes,
          invitation: entry.invitation,
          notificationOrigin: entry.notificationOrigin,
        })),
      }
    } catch {
      return null
    }
  }

  // ── tools ──────────────────────────────────────────────────────────────────
  class ToolTransportError extends Error {}

  async function resolveBoardIdentity(agent, signal) {
    if (hostDisposed) throw new Error('DSH adapter has been disposed')
    if (disposedAgents.has(agent)) throw new Error('DSH Agent session has ended')
    const sessionId = String(agent.id)
    lastAgents.set(sessionId, agent)
    await preparePresenceOwner(signal)
    const previous = boardRegistrations.get(sessionId)
    const parent = previous?.parentId ? lastAgents.get(previous.parentId) : undefined
    const identity = await registerBoardTarget({ sessionId, agent, parent }, signal)
    return {
      ...identity,
      saveName: agentName => renameAgentIdentity({ anchor: sessionId, id: identity.id, agentName }),
    }
  }

  // State needs a resident owner. Do not replay refused writes or fall back to CLI.
  async function invokeRegisteredTool(method, params, signal, cliFallback) {
    if (cliFallback && !(method === 'remember' && resolveDaemon())) {
      const result = await invoke(method, params, cliFallback, signal)
      if (!result.ok) throw new ToolTransportError(result.error)
      return result.data
    }
    try {
      const data = await daemonCall(method, params, signal, true)
      if (data == null) throw new Error('NMG daemon is unavailable for ' + method)
      return data
    } catch (error) {
      throw new ToolTransportError('NMG ' + method + ' request failed: ' + String(error.message || error))
    }
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
  // Poll native endpoints and reconcile their presence before shared delivery.
  // An empty host does not start a daemon or publish an Agent identity.
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

  function registerNativeTool(definition) {
    const release = (handle: unknown) => typeof handle === 'function'
      ? async () => { await handle() }
      : undefined
    const handle = tools.register(definition)
    return handle instanceof Promise ? handle.then(release) : release(handle)
  }

  const capabilityAssembly = assembleAdapterCapabilities(ADAPTER_CAPABILITY_CATALOG.dsh.capabilities, {
    registerTool: tool => registerNativeTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      output: textOutput,
      async execute(args, exec) {
        const sessionId = String(exec?.agent?.id ?? '').trim() ||
          (tool.requiresNativeSession ? '' : hostSessionId)
        if (!sessionId) throw new Error('NMG state requires a native DSH Agent session')
        try {
          const result = await tool.execute(args, {
            sessionId,
            requester: 'agent:dsh',
            daemonAddress: () => {
              const endpoint = resolveDaemon()
              return endpoint && endpoint.host + ':' + endpoint.port
            },
            invoke: (method, params, cliFallback) => invokeRegisteredTool(method, params, exec?.signal, cliFallback),
            memory: {
              projectDir: workspaceRoot,
              retryForeignGraph: true,
              remember: {
                onFeedback: () => {
                  const stagedStack = recallBatch.get(sessionId)
                  if (stagedStack?.[0]) stagedStack[0].fedBack = true
                },
              },
              search: {
                onSearch: ({ query, ranked, disclosed }) => {
                  nativeEvents.note(sessionId, disclosed)
                  recordActivity(sessionId, {
                    kind: 'search',
                    query,
                    candidates: disclosed.results.length,
                    activeGraphId: ranked.activeGraph?.id ?? null,
                  })
                },
              },
              onEvidenceDisclosed: (request, context) => {
                nativeEvents.note(sessionId, context)
                recordActivity(sessionId, {
                  kind: 'get',
                  requested: request.memoryIds.length,
                  candidates: context.results.length,
                  memoryIds: context.results.map(result => result.memory.id).slice(0, 8),
                })
              },
            },
            boardIdentity: () => resolveBoardIdentity(exec.agent, exec.signal),
          })
          return result.text
        } catch (error) {
          if (error instanceof ToolTransportError) return error.message
          throw error
        }
      },
    }),
    'automatic-recall': ({ prepare }) => {
      prepareAutomaticRecallSurface = prepare
      const remove = [
        ctx.on('agent/inbox/inserted', onInboxInserted),
        ctx.on('agent/inbox/claimed', onInboxClaimed),
        ctx.on('agent/request', onRequest),
      ]
      return () => { for (const dispose of remove) if (typeof dispose === 'function') dispose() }
    },
    'state-context': ({ views }) => { contextStateViews = views },
    'answer-attribution': ({ create }) => {
      nativeEvents = new DshNativeEvents(
        async (method, params, signal) => daemonCall(method, params, signal),
        workspaceRoot,
        (agent) => !hostDisposed && !disposedAgents.has(agent) &&
          (!lastAgents.has(String(agent.id)) || lastAgents.get(String(agent.id)) === agent),
        create(32),
      )
      return ctx.on('session/event', (session, event) => nativeEvents.event(session, event))
    },
    'board-delivery': ({ collect, enqueue, activity }) => {
      collectWakeCandidates = collect
      enqueueBoardWakeBatch = enqueue
      reportHarnessActivity = activity
    },
    'tool-observation': ({ observe }) => ctx.on('tools/result', (exec, result) => nativeEvents.observe(exec, result, observe)),
  }, { endpoint: readAdapterEndpoint(), disabled: disabledBoardCapability(coordinationEnabled) })
  const disposers = [
    contextDisposer,
    ctx.on('agent/disposed', onAgentDisposed),
  ]
  if (coordinationEnabled) {
    disposers.push(
      wakeServiceDisposer,
      wakeTimerDisposer,
      initialWakeDisposer,
    )
  }
  if (routeDisposer) disposers.push(routeDisposer)
  if (wakeRouteDisposer) disposers.push(wakeRouteDisposer)

  // Return the cordis dispose-time cleanup for this plugin contribution.
  const dispose = async () => {
    hostDisposed = true
    await capabilityAssembly.dispose()
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
    await Promise.allSettled([...boardRegistrations.entries()]
      .map(([sessionId, record]) => retireBoardRegistration(sessionId, record)))
    await nativeEvents.close()
    recallGenerations.clear()
    sessionTokenTotals.clear()
    recallBatch.clear()
    openSearches.clear()
    maintainedState.clear()
    wakeBatch.clear()
  }
  return Object.assign(dispose, { ready: capabilityAssembly.ready })
}

