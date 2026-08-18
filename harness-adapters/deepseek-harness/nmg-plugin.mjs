// NMG adapter for DeepSeek Harness — composition plugin form.
//
// This is a real Cordis plugin module (loaded as a preset row via
// `name: './nmg-plugin.mjs'`), NOT the dynamic-plugin sandbox body. It registers
// five model-visible tools (nmg_search / nmg_get / nmg_remember / nmg_board /
// nmg_daemon) into the host `tools` registry, each backed by the agent-neutral
// `nmg` CLI (`node bin/nmg.mjs`) through the host `subprocess` service.
//
// It also implements AUTOMATIC RECALL on the `agent/pre-step` hook: on the first
// step of a new user turn it runs a small-budget `nmg search` and injects the
// Active-Graph HEADER projection (compact headers + activeGraphId) as a recall
// context message, so the model knows relevant memory exists before it answers.
// Exact evidence stays behind nmg_get; passing the activeGraphId there records
// actual use. Injection never blocks a step: any failure falls back to next().
//
// It publishes no service, so it needs no isolate realm (like tool-bash /
// tool-pwsh / tool-fs in the shipped presets). It only consumes host services.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export default {
  name: 'nmg',
  apply(ctx) {
    const tools = ctx.get('tools')
    const subprocess = ctx.get('subprocess')
    if (!tools || !subprocess) return

    const sandboxPolicy = ctx.get('sandboxPolicy')
    const workspaceRoot =
      sandboxPolicy && typeof sandboxPolicy.workspaceRoot === 'string' && sandboxPolicy.workspaceRoot
        ? sandboxPolicy.workspaceRoot
        : 'C:\\Documents\\GitHub\\NodeMemoryGraph'
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

    const textOutput = {
      schema: { type: 'string' },
      render: (args, value) => [{ type: 'text', text: String(value) }],
    }

    // ── automatic recall (agent/pre-step) ────────────────────────────────────

    // Per-session recall window: the last turn we injected for, and the turn each
    // memory id was last injected on. Mirrors the Pi adapter's in-memory window
    // (recent 12 turns, bounded ~128 ids) so repeated unchanged content is folded
    // instead of re-injected, while stale memories may resurface later.
    const recallWindows = new Map() // sessionId -> { lastTurn, injected: Map<id, turn> }
    // Cumulative estimated recall tokens per session, so the cue surfaces the
    // cost of the memory introduced this session ("prompt growth" visibility).
    const sessionTokenTotals = new Map() // sessionId -> total estimated recall tokens

    // CJK-aware token estimate, used only as a fallback when the daemon is down
    // and NMG's own estimatedTokens is unavailable.
    function estimateTokens(text) {
      let cjk = 0
      let latin = 0
      for (const ch of String(text || '')) {
        if (ch.codePointAt(0) > 0x2fff) cjk += 1
        else if (!/\s/.test(ch)) latin += 1
      }
      return Math.ceil(cjk + latin / 4)
    }

    function beginRecallTurn(sessionId, turn) {
      let window = recallWindows.get(sessionId)
      if (!window) {
        window = { lastTurn: -1, injected: new Map() }
        recallWindows.set(sessionId, window)
      }
      const isNewTurn = turn !== window.lastTurn
      window.lastTurn = turn
      return { isNewTurn, window }
    }

    function filterRecallCandidates(window, turn, candidates) {
      const fresh = []
      for (const candidate of candidates || []) {
        const previousTurn = window.injected.get(candidate.id)
        if (previousTurn != null && turn - previousTurn <= 12) continue
        fresh.push(candidate)
      }
      for (const [id, injectedTurn] of window.injected) {
        if (turn - injectedTurn > 12) window.injected.delete(id)
      }
      return fresh
    }

    function extractUserPrompt(messages) {
      const parts = []
      for (const message of messages || []) {
        if (!message || message.role !== 'user') continue
        if (message.source && message.source.kind !== 'user') continue
        for (const block of message.content || []) {
          if (block.type === 'text' && block.text) parts.push(block.text)
        }
      }
      const joined = parts.join(' ').replace(/\s+/g, ' ').trim()
      return joined.length > 500 ? joined.slice(0, 500) : joined
    }

    function formatRecall(candidates, activeGraphId, tokens, sessionTotal) {
      const lines = candidates.map(
        (c) => 'mid=' + c.id + '\tnode=' + c.node + '\ttype=' + c.type + '\tL' + c.tier + '\t' + truncate(c.preview, 160),
      )
      if (activeGraphId) lines.push('activeGraphId=' + activeGraphId)
      if (tokens != null) {
        lines.push('recall tokens ~' + tokens + (sessionTotal != null ? ' · session ~' + sessionTotal : ''))
      }
      lines.push('Load exact records with nmg_get (mids + activeGraphId).')
      return 'NMG memory (automatic recall):\n' + lines.join('\n')
    }

    // ── daemon JSON-RPC (fast path) ────────────────────────────────────────────
    // A per-turn CLI spawn costs ~180 ms (Node boot + module load); the running
    // daemon answers the same search over HTTP JSON-RPC in single-digit ms. Use
    // it first for the automatic-recall hot path, fall back to the one-shot CLI
    // only when no live daemon exists, and never let either block a turn beyond
    // the 1.5 s recall budget.

    let daemon = null

    function isProcessAlive(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return false
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return error.code !== 'ESRCH'
      }
    }

    function resolveDaemon() {
      if (daemon) return daemon
      try {
        const home = process.env.USERPROFILE || process.env.HOME || ''
        const dataDir = (process.env.NMG_DATA_DIR || join(home, '.nmg')).replace(/[\\/]+$/, '')
        const state = JSON.parse(readFileSync(join(dataDir, 'nmg.sqlite.server.json'), 'utf8'))
        // No protocol-version check on purpose: the JSON-RPC envelope has been
        // stable across v2→v3, this path is only a fast path, and an
        // incompatible call fails and falls back to the CLI — which performs the
        // authoritative protocol check. Hard-coding a version would silently
        // disable the fast path on every bump.
        if (state.transport === 'http' && state.host && state.port && state.token && isProcessAlive(state.pid)) {
          daemon = { host: state.host, port: state.port, token: state.token, pid: state.pid }
        }
      } catch {
        daemon = null
      }
      return daemon
    }

    async function daemonCall(method, params, signal) {
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
        daemon = null // stale or dead daemon — rediscover on the next call
        return null
      }
    }

    function searchPreviewOf(memory) {
      const normalized = String((memory && memory.statement) || '').replace(/\s+/g, ' ').trim()
      return normalized.length <= 320 ? normalized : normalized.slice(0, 319) + '…'
    }

    function projectCompact(context) {
      return {
        candidates: (Array.isArray(context.results) ? context.results : []).map((r) => ({
          id: r.memory.id,
          node: (r.node && r.node.canonicalName) || '',
          type: r.memory.memoryType,
          tier: r.memory.tier,
          preview: searchPreviewOf(r.memory),
        })),
        activeGraphId: context.activeGraph ? context.activeGraph.id : null,
        deferredMemoryIds:
          (context.progressiveDisclosure && context.progressiveDisclosure.deferredMemoryIds) || [],
        tokens:
          (context.activeGraph && context.activeGraph.usage && context.activeGraph.usage.estimatedTokens) ||
          null,
      }
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

    // Shared tool dispatch: daemon JSON-RPC first (single-digit-ms), one-shot
    // CLI as fallback only when no live daemon or an RPC-level failure.
    async function invoke(method, params, cliArgs, signal, project) {
      try {
        const raw = await daemonCall(method, params, signal)
        if (raw != null) return { ok: true, data: project ? project(raw) : raw }
      } catch {
        return { ok: false, error: 'NMG call aborted' }
      }
      return nmgJson(cliArgs, signal)
    }

    function recallBudget(signal) {
      try {
        return AbortSignal.any([signal, AbortSignal.timeout(1500)])
      } catch {
        return signal
      }
    }

    async function autoRecall(query, signal) {
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
        }, budget)
        if (context) return projectCompact(context)
      } catch {
        return null // aborted or daemon-level failure — never block the turn
      }
      const argv = [
        'search', query,
        '--limit', String(limit),
        '--max-tier', String(tier),
        '--graph-hops', '1',
        '--tiered-disclosure',
        '--project-dir', workspaceRoot,
        '--compact-json',
      ]
      const result = await nmgJson(argv, budget)
      return result.ok ? result.data : null
    }

    async function onPreStep(payload, next) {
      try {
        const { agent, turn, messages, signal } = payload
        const sessionId = String(agent.id)
        const { isNewTurn, window } = beginRecallTurn(sessionId, turn)
        if (!isNewTurn) return next()
        const promptText = extractUserPrompt(messages)
        if (!promptText) return next()
        const recall = await autoRecall(promptText, signal)
        if (!recall || !Array.isArray(recall.candidates) || recall.candidates.length === 0) return next()
        const fresh = filterRecallCandidates(window, turn, recall.candidates)
        if (fresh.length === 0) return next()
        const thisTokens =
          recall.tokens != null
            ? recall.tokens
            : estimateTokens(fresh.map((c) => c.preview).join(' '))
        const sessionTotal = (sessionTokenTotals.get(sessionId) || 0) + thisTokens
        sessionTokenTotals.set(sessionId, sessionTotal)
        // Manual construction — no bare package import. `createUserMessage`
        // lives in @deepseek-ai/dsh-llm, which a local preset module cannot
        // reliably resolve across installs (bare imports broke the mount after a
        // host reinstall). MessageId is a branded string; any unique id works.
        const cue = {
          id: 'nmg-recall:' + sessionId + ':' + turn,
          role: 'user',
          content: [
            { type: 'text', text: formatRecall(fresh, recall.activeGraphId, thisTokens, sessionTotal) },
          ],
          source: { kind: 'plugin', plugin: 'nmg', form: 'recall' },
        }
        for (const candidate of fresh) window.injected.set(candidate.id, turn)
        const decision = await next()
        if (decision.kind !== 'enter') return decision
        return { kind: 'enter', messages: [...decision.messages, cue] }
      } catch {
        return next()
      }
    }

    function onAgentDisposed(payload) {
      try {
        if (payload && payload.agent) {
          const id = String(payload.agent.id)
          recallWindows.delete(id)
          sessionTokenTotals.delete(id)
        }
      } catch {
        // cleanup is best-effort
      }
    }

    // ── tools ─────────────────────────────────────────────────────────────────

    const searchTool = {
      name: 'nmg_search',
      description: 'Search NMG durable memory and return compact headers (mid/node/type/tier/preview) plus an activeGraphId. Load exact statements with nmg_get. Treat results as candidates, not proof of completeness.',
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
        const params = { query: args.query, projectDir: workspaceRoot }
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
        argv.push('--project-dir', workspaceRoot, '--compact-json')
        const r = await invoke('search', params, argv, exec.signal, projectCompact)
        if (!r.ok) return r.error
        const data = r.data
        const candidates = Array.isArray(data.candidates) ? data.candidates : []
        const lines = candidates.length
          ? candidates.map((c) => 'mid=' + c.id + '\tnode=' + c.node + '\ttype=' + c.type + '\tL' + c.tier + '\t' + truncate(c.preview, 160))
          : ['No NMG match.']
        if (data.activeGraphId) lines.push('activeGraphId=' + data.activeGraphId)
        if (Array.isArray(data.deferredMemoryIds) && data.deferredMemoryIds.length) lines.push('deferred: ' + data.deferredMemoryIds.join(','))
        if (data.tokens != null) lines.push('recall tokens ~' + data.tokens)
        else if (candidates.length) lines.push('recall tokens ~' + estimateTokens(lines.join('\n')))
        lines.push('Select exact records with nmg_get (mids + activeGraphId).')
        return lines.join('\n')
      },
    }

    const getTool = {
      name: 'nmg_get',
      description: 'Expand selected memory IDs into exact statements and bounded source evidence. Pass the activeGraphId returned by nmg_search to record actual use.',
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
        const params = { memoryIds: ids, projectDir: workspaceRoot }
        if (args.activeGraphId) params.activeGraphId = args.activeGraphId
        if (args.graphHops != null) params.graphHops = args.graphHops
        const argv = ['get'].concat(ids)
        if (args.activeGraphId) argv.push('--active-graph-id', args.activeGraphId)
        if (args.graphHops != null) argv.push('--graph-hops', String(args.graphHops))
        argv.push('--project-dir', workspaceRoot, '--json')
        const r = await invoke('get', params, argv, exec.signal, null)
        if (!r.ok) return r.error
        const data = r.data
        const results = Array.isArray(data.results) ? data.results : []
        const lines = []
        for (const item of results) {
          const m = item.memory || {}
          const n = item.node || {}
          lines.push('- ' + m.statement)
          lines.push('  mid=' + m.id + ' node=' + (n.canonicalName || '') + ' type=' + m.memoryType + ' truth=' + m.truthStatus)
          const ev = item.evidence && item.evidence.content
          if (ev && String(ev).trim() !== String(m.statement || '').trim()) lines.push('  SRC: ' + truncate(ev, 280))
        }
        if (Array.isArray(data.missingMemoryIds) && data.missingMemoryIds.length) lines.push('MISSING: ' + data.missingMemoryIds.join(', '))
        return lines.length ? lines.join('\n') : 'No active memory found.'
      },
    }

    const rememberTool = {
      name: 'nmg_remember',
      description: 'Save a durable typed memory (fact/preference/constraint/state/event/strategy). Requires a stable nodeName and self-contained statement. Never save secrets, chatter, unverified model claims, or transient failures.',
      parameters: {
        type: 'object',
        properties: {
          statement: { type: 'string', description: 'Self-contained semantic statement.' },
          nodeName: { type: 'string', description: 'Stable node grouping related memories.' },
          memoryType: { type: 'string', enum: ['fact', 'state', 'event', 'preference', 'constraint', 'strategy'], description: 'Memory type.' },
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
        required: ['statement', 'nodeName'],
      },
      output: textOutput,
      async execute(args, exec) {
        const params = { statement: args.statement, nodeName: args.nodeName, projectDir: workspaceRoot }
        if (args.memoryType) params.memoryType = args.memoryType
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
        const m = r.data.memory || {}
        const n = r.data.node || {}
        return 'Saved ' + m.id + ' under "' + (n.canonicalName || '') + '" (type=' + (m.memoryType || '?') + ').'
      },
    }

    const boardTool = {
      name: 'nmg_board',
      description: 'Temporary, task-scoped cross-agent coordination (not durable memory). Entries expire. Use a stable taskId; default agent identity is "dsh". Promote durable conclusions only through a separate nmg_remember.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['put', 'read', 'resolve', 'claim', 'release', 'discover'], description: 'Board action.' },
          taskId: { type: 'string', description: 'Task channel; omit for the shared world channel.' },
          content: { type: 'string', description: 'Entry text (put).' },
          kind: { type: 'string', enum: ['goal', 'note', 'question', 'result', 'handoff', 'decision', 'blocker'], description: 'Entry kind (put).' },
          agentId: { type: 'string', description: 'Writer/reader identity (default "dsh").' },
          entryId: { type: 'string', description: 'Entry to resolve/claim/release.' },
          resolution: { type: 'string', description: 'Resolution note (resolve).' },
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
        const agent = args.agentId || 'dsh'
        if (args.action === 'put' && !args.taskId) return 'nmg_board put requires taskId.'
        if (args.action === 'read' && !args.taskId) return 'nmg_board read requires taskId.'
        if ((args.action === 'resolve' || args.action === 'claim' || args.action === 'release') && (!args.taskId || !args.entryId)) {
          return 'nmg_board ' + args.action + ' requires taskId and entryId.'
        }
        if (!['put', 'read', 'resolve', 'claim', 'release', 'discover'].includes(args.action)) {
          return 'Unsupported board action: ' + args.action
        }
        const params = { action: args.action, agentId: agent }
        const argv = ['board', args.action]
        if (args.action === 'discover') {
          params.taskId = 'default'
          if (args.capabilities) params.capabilities = args.capabilities
          argv.push('--agent', agent)
          if (args.capabilities) argv.push('--capabilities', args.capabilities)
        } else if (args.action === 'put') {
          params.taskId = args.taskId
          params.content = args.content || ''
          if (args.kind) params.kind = args.kind
          if (args.to) params.to = args.to
          if (args.ttlSeconds != null) params.ttlSeconds = args.ttlSeconds
          argv.push(args.taskId, args.content || '')
          argv.push('--agent', agent)
          if (args.kind) argv.push('--kind', args.kind)
          if (args.to) argv.push('--to', args.to)
          if (args.ttlSeconds != null) argv.push('--ttl-seconds', String(args.ttlSeconds))
        } else if (args.action === 'read') {
          params.taskId = args.taskId
          if (args.afterCursor != null) params.afterCursor = args.afterCursor
          if (args.limit != null) params.limit = args.limit
          if (args.includeResolved) params.includeResolved = true
          argv.push(args.taskId, '--agent', agent)
          if (args.afterCursor != null) argv.push('--after-cursor', String(args.afterCursor))
          if (args.limit != null) argv.push('--limit', String(args.limit))
          if (args.includeResolved) argv.push('--include-resolved')
        } else {
          params.taskId = args.taskId
          params.entryId = args.entryId
          if (args.action === 'resolve' && args.resolution) params.resolution = args.resolution
          if (args.action === 'claim' && args.leaseSeconds != null) params.leaseSeconds = args.leaseSeconds
          argv.push(args.taskId, args.entryId, '--agent', agent)
          if (args.action === 'resolve' && args.resolution) argv.push('--resolution', args.resolution)
          if (args.action === 'claim' && args.leaseSeconds != null) argv.push('--lease-seconds', String(args.leaseSeconds))
        }
        argv.push('--json')
        const r = await invoke('taskBoard', params, argv, exec.signal, null)
        if (!r.ok) return r.error
        const data = r.data
        if (data.action === 'discover') {
          const agents = Array.isArray(data.agents) ? data.agents : []
          if (!agents.length) return 'No online NMG agents match.'
          return 'Online NMG agents:\n' + agents.map((a) => '- ' + a.agentName + (a.capabilities ? ' capabilities=' + a.capabilities : '') + ' lastSeen=' + a.lastSeenAt).join('\n')
        }
        const entries = Array.isArray(data.entries) ? data.entries : (data.entry ? [data.entry] : [])
        const lines = entries.map((e) => '- #' + e.sequence + ' ' + e.id + ' [' + e.kind + '/' + e.status + '] ' + e.agentId + ': ' + truncate(e.content, 400))
        if (data.action === 'read' && data.nextCursor != null) lines.push('nextCursor=' + data.nextCursor)
        return lines.length ? lines.join('\n') : 'No matching board entries.'
      },
    }

    const daemonTool = {
      name: 'nmg_daemon',
      description: 'Read-only NMG daemon health check. The adapter uses one-shot CLI calls and never owns a daemon, so start/stop is intentionally out of scope.',
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

    const disposers = [
      tools.register(searchTool),
      tools.register(getTool),
      tools.register(rememberTool),
      tools.register(boardTool),
      tools.register(daemonTool),
      ctx.on('agent/pre-step', onPreStep),
      ctx.on('agent/disposed', onAgentDisposed),
    ]
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose()
    })
  },
}
