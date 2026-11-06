// dsh-nmg browser half: theme-aware tool call cards.
//
// Registered as keyed `tool.call.toolview` entries so each NMG tool's call card
// in the conversation is the compact NMG badge/name/label/result block.
// The card reads the ACTIVE color scheme from the theme service
// (ctx.theme.getTheme().active.colorScheme), subscribes to `theme/change`, and
// picks a full light/dark palette via inline --nmg-* custom properties. It does
// NOT rely on the global --dsw-alias-* theme CSS variables (they do not resolve
// inside plugin-injected contexts) and does NOT hardcode light-only colors.
//
// This is the PERSISTENT client UI route: the bundle built from this file is
// served by the host at /plugins/@nmg/dsh-nmg/client.js and loaded through
// window.__ModuleLoader__ (see the package `dsh.client` manifest + cordis.patch
// bundle). Unlike a dynamic-plugin client it survives page refresh, and unlike
// the dynamic `styles` builtin it injects its own <style> tag (idempotent, and
// removed on dispose).

import React from 'react'

const CSS = `
  .nmg-tool-card {
    display: block;
    margin: 6px 0;
    padding: 8px 12px;
    border: 1px solid var(--nmg-border, rgba(127,127,127,.35));
    border-left: 3px solid var(--nmg-accent, #2563eb);
    border-radius: 8px;
    background: var(--nmg-surface, rgba(0,0,0,.04));
    color: var(--nmg-text, #111827);
    font-size: 12px;
    line-height: 1.5;
    min-width: 0;
    contain: content;
  }
  .nmg-tool-card-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .nmg-tool-badge {
    display: inline-block;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--nmg-accent, #2563eb);
    color: #ffffff;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .5px;
    line-height: 1.4;
  }
  .nmg-tool-name {
    font-weight: 600;
    font-family: monospace;
    color: var(--nmg-text, #111827);
  }
  .nmg-tool-state {
    margin-left: auto;
    font-size: 10px;
    text-transform: uppercase;
    opacity: .75;
    color: var(--nmg-text-dim, #6b7280);
  }
  .nmg-tool-label {
    font-weight: 500;
    color: var(--nmg-text, #111827);
    margin-bottom: 4px;
    word-break: break-word;
  }
  .nmg-tool-result {
    margin: 0;
    padding: 6px 8px;
    border-radius: 6px;
    background: var(--nmg-surface-2, rgba(0,0,0,.05));
    color: var(--nmg-text-2, #374151);
    font-family: monospace;
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 180px;
    overflow: auto;
  }
  .nmg-tool-running {
    font-size: 11px;
    opacity: .6;
    color: var(--nmg-text-dim, #6b7280);
  }
  .nmg-tool-error .nmg-tool-label {
    color: #dc2626;
  }
  /* Right-pane body: one ledger, not a stack of cards. A single spine runs
     down the recall column; each round is a tick on it and each candidate hangs
     off it, so depth is read from weight and indentation rather than boxes. */
  .nmg-recall-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    color: var(--nmg-text, #1f2328);
    font-size: 11.5px;
    line-height: 1.5;
    font-variant-numeric: tabular-nums;
  }
  .nmg-recall-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 10px;
    padding: 10px 12px 8px;
    flex: none;
  }
  .nmg-recall-head-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: .02em;
  }
  .nmg-recall-head-stats {
    font-size: 10.5px;
    color: var(--nmg-text-dim, #8b93a0);
  }
  .nmg-recall-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 0 12px 12px 20px;
  }
  .nmg-round {
    position: relative;
    margin-left: 1px;
    padding: 2px 0 2px 14px;
    border-left: 1px solid var(--nmg-spine, #dcd8d0);
  }
  .nmg-round + .nmg-round {
    margin-top: 14px;
  }
  .nmg-round-dot {
    position: absolute;
    left: -3.5px;
    top: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--nmg-recall, #2f6f8f);
  }
  .nmg-round-head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 4px;
  }
  .nmg-round-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--nmg-text, #1f2328);
  }
  .nmg-round-stat {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: var(--nmg-text-dim, #8b93a0);
  }
  .nmg-item {
    padding: 3px 0 5px;
  }
  .nmg-item + .nmg-item {
    border-top: 1px solid var(--nmg-border, rgba(127,127,127,.16));
  }
  .nmg-item-node {
    font-size: 11.5px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nmg-item-meta {
    display: flex;
    gap: 8px;
    font-size: 10px;
    color: var(--nmg-text-dim, #8b93a0);
  }
  .nmg-item-preview {
    color: var(--nmg-text-2, #3a4149);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .nmg-activity {
    flex: none;
    max-height: 42%;
    overflow: auto;
    padding: 8px 12px 12px 20px;
    border-top: 1px solid var(--nmg-spine, #dcd8d0);
  }
  .nmg-activity-head {
    font-size: 10.5px;
    font-weight: 600;
    color: var(--nmg-text-dim, #8b93a0);
    margin-bottom: 4px;
  }
  .nmg-activity-row {
    display: grid;
    grid-template-columns: 38px 6px 1fr;
    align-items: baseline;
    gap: 8px;
    padding: 2px 0;
  }
  .nmg-activity-time {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    color: var(--nmg-text-dim, #8b93a0);
    text-align: right;
  }
  .nmg-activity-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    align-self: center;
    background: var(--nmg-text-dim, #8b93a0);
  }
  .nmg-activity-dot[data-kind="recall"] { background: var(--nmg-recall, #2f6f8f); }
  .nmg-activity-dot[data-kind="search"] { background: var(--nmg-search, #8a6a3a); }
  .nmg-activity-dot[data-kind="get"] { background: var(--nmg-get, #5c7355); }
  .nmg-activity-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--nmg-text-2, #3a4149);
  }
  .nmg-recall-empty {
    padding: 4px 0;
    color: var(--nmg-text-dim, #8b93a0);
    font-size: 11px;
  }
`

const STYLE_ID = 'nmg-toolview-css'

function injectCss(): () => void {
  let removed = false
  const tryInject = () => {
    if (removed || typeof document === 'undefined') return
    if (document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']')) return
    const tag = document.createElement('style')
    tag.dataset.plugin = '@nmg/dsh-nmg'
    tag.dataset.pluginCss = STYLE_ID
    tag.textContent = CSS
    document.head.appendChild(tag)
  }
  tryInject()
  return () => {
    if (removed || typeof document === 'undefined') return
    removed = true
    const tag = document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_ID) + ']')
    if (tag && tag.parentNode) tag.parentNode.removeChild(tag)
  }
}

const COLORS: Record<string, string> = {
  nmg_search: '#2563eb',
  nmg_get: '#0ea5e9',
  nmg_remember: '#16a34a',
  nmg_board: '#9333ea',
  nmg_daemon: '#d97706',
}

const LIGHT: Record<string, string> = {
  '--nmg-text': '#1f2328',
  '--nmg-text-2': '#3a4149',
  '--nmg-text-dim': '#8b93a0',
  '--nmg-surface': 'rgba(0, 0, 0, .04)',
  '--nmg-surface-2': 'rgba(0, 0, 0, .06)',
  '--nmg-border': 'rgba(127, 127, 127, .3)',
  '--nmg-spine': '#dcd8d0',
  '--nmg-recall': '#2f6f8f',
  '--nmg-search': '#8a6a3a',
  '--nmg-get': '#5c7355',
}

const DARK: Record<string, string> = {
  '--nmg-text': '#e8e6e1',
  '--nmg-text-2': '#c3c8ce',
  '--nmg-text-dim': '#6a737d',
  '--nmg-surface': 'rgba(255, 255, 255, .06)',
  '--nmg-surface-2': 'rgba(255, 255, 255, .1)',
  '--nmg-border': 'rgba(255, 255, 255, .16)',
  '--nmg-spine': '#323841',
  '--nmg-recall': '#7fb3cd',
  '--nmg-search': '#c9a06a',
  '--nmg-get': '#94ac8b',
}

const KEYS = ['nmg_search', 'nmg_get', 'nmg_remember', 'nmg_board', 'nmg_daemon']

// The recall pill reads the current session's latest recall from the HOST over a
// same-origin webServer route (/nmg/recall?session=) — not by scanning the
// conversation snapshot for a `context` node. That keeps it decoupled from DSH's
// internal `source.sections` field and off the session-snapshot scan path.

function extractText(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .map((block: any) => (block && block.type === 'text' ? block.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseArgs(raw: unknown): Record<string, unknown> {
  try {
    const value = JSON.parse(String(raw || '{}'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

function cardLabel(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case 'nmg_search': return String(args.query || '')
    case 'nmg_get': return (Array.isArray(args.memoryIds) ? args.memoryIds : []).join(', ')
    case 'nmg_remember': return String(args.statement || '') + (args.nodeName ? '  →  ' + String(args.nodeName) : '')
    case 'nmg_board': return String(args.action || '') + (args.taskId ? '  ' + String(args.taskId) : '')
    case 'nmg_daemon': return String(args.action || '')
    default: return ''
  }
}

function truncateResult(text: string): string {
  return text.length <= 420 ? text : text.slice(0, 419) + '…'
}

function CardInner(props: any): any {
  const block = props.block
  const settled = !!(block && block.kind === 'tool-result')
  const toolName = props.toolName || (block && (block.name || (block.call && block.call.name))) || 'nmg'
  const argsRaw = settled
    ? (block.call ? block.call.argsRaw : '')
    : (block ? block.argsRaw : '')
  const args = React.useMemo(() => parseArgs(argsRaw), [argsRaw])
  const resultText = React.useMemo(
    () => (settled ? extractText(block.content) : ''),
    [settled, block],
  )
  const isError = settled ? !!block.isError : false
  const accent = COLORS[toolName] || (props.nmgDark ? '#818cf8' : '#6b7280')
  const label = cardLabel(toolName, args)
  const vars = props.nmgDark ? DARK : LIGHT
  return React.createElement(
    'div',
    {
      className: 'nmg-tool-card' + (isError ? ' nmg-tool-error' : ''),
      style: Object.assign({ '--nmg-accent': accent }, vars),
    },
    React.createElement(
      'div',
      { className: 'nmg-tool-card-head' },
      React.createElement('span', { className: 'nmg-tool-badge' }, 'NMG'),
      React.createElement('span', { className: 'nmg-tool-name' }, toolName),
      React.createElement('span', { className: 'nmg-tool-state' }, settled ? (isError ? 'error' : 'done') : 'running'),
    ),
    label ? React.createElement('div', { className: 'nmg-tool-label' }, label) : null,
    settled
      ? (resultText ? React.createElement('pre', { className: 'nmg-tool-result' }, truncateResult(resultText)) : null)
      : React.createElement('div', { className: 'nmg-tool-running' }, 'running…'),
  )
}

const MemoCard = React.memo(CardInner, (prev: any, next: any) =>
  prev.callId === next.callId &&
  prev.toolName === next.toolName &&
  prev.block === next.block &&
  prev.nmgDark === next.nmgDark,
)

export const inject = ['slots', 'theme']

export function apply(ctx: any): () => void {
  const theme = ctx.theme

  // Theme-mode subscription: mirror the active colorScheme into React state for
  // every mounted card. `listeners` is created here (owning the lifecycle) and
  // each card subscribes in useThemeMode.
  const listeners = new Set<() => void>()
  let themeMode = 'light'
  const refreshMode = () => {
    try {
      const snap = theme.getTheme()
      themeMode = snap && snap.active && snap.active.colorScheme === 'dark' ? 'dark' : 'light'
    } catch {
      themeMode = 'light'
    }
    listeners.forEach((listener) => listener())
  }
  refreshMode()

  function useThemeMode(): string {
    const [mode, setMode] = React.useState(themeMode)
    React.useEffect(() => {
      const listener = () => setMode(themeMode)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }, [])
    return mode
  }

  function NmgToolCard(props: any): any {
    const dark = useThemeMode() === 'dark'
    return React.createElement(MemoCard, Object.assign({}, props, { nmgDark: dark }))
  }

  // Right-pane tab: the same recall ledger the floating pill used to show, now
  // inside the side panel. The host serves /nmg/recall?session=; the panel polls
  // it while mounted and shows the newest recall first.
  function useRecallFeed(current: string | null): any {
    const [recall, setRecall] = React.useState<any>(null)
    React.useEffect(() => {
      if (!current) {
        setRecall(null)
        return
      }
      let alive = true
      const load = () => {
        fetch('/nmg/recall?session=' + encodeURIComponent(current), { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null))
          .then((json) => {
            if (!alive) return
            setRecall(json && json.ok ? json.data || null : null)
          })
          .catch(() => {})
      }
      load()
      const timer = window.setInterval(load, 5000)
      return () => {
        alive = false
        window.clearInterval(timer)
      }
    }, [current])
    return recall
  }

  function activityText(entry: any): string {
    if (!entry) return ''
    if (entry.kind === 'recall') {
      return (entry.candidates || 0) + ' 条 · ~' + (entry.tokens != null ? entry.tokens : '?') + ' token'
    }
    if (entry.kind === 'search') {
      const query = String(entry.query || '')
      return '「' + (query.length > 32 ? query.slice(0, 32) + '…' : query) + '」→ ' + (entry.candidates || 0) + ' 条'
    }
    if (entry.kind === 'get') {
      return (entry.requested || 0) + ' 个 id → ' + (entry.candidates || 0) + ' 条证据'
    }
    return ''
  }

  function NmgRecallPanel(props: any): any {
    const dark = useThemeMode() === 'dark'
    const fromProps = typeof props.sessionId === 'string' ? props.sessionId : ''
    const current = fromProps || (typeof props.useSessions === 'function'
      ? props.useSessions((s: any) => s && s.current)
      : '')
    const recall = useRecallFeed(current)
    const recalls = recall && Array.isArray(recall.recalls) ? recall.recalls : []
    const activity = recall && Array.isArray(recall.activity) ? recall.activity : []
    const totalCandidates = recalls.reduce(
      (sum: number, round: any) => sum + ((round.candidates || []).length),
      0,
    )
    const vars = dark ? DARK : LIGHT
    return React.createElement(
      'div',
      { className: 'nmg-recall-panel', style: vars },
      React.createElement(
        'div',
        { className: 'nmg-recall-head' },
        React.createElement('span', { className: 'nmg-recall-head-title' }, '记忆活动'),
        React.createElement(
          'span',
          { className: 'nmg-recall-head-stats' },
          recalls.length > 0 ? recalls.length + ' 轮 / ' + totalCandidates + ' 条' : '暂无记录',
        ),
      ),
      React.createElement(
        'div',
        { className: 'nmg-recall-scroll' },
        recalls.length > 0
          ? recalls.map((round: any, r: number) =>
              React.createElement(
                'div',
                { key: 'round-' + (round.generation != null ? round.generation : r), className: 'nmg-round' },
                React.createElement('span', { className: 'nmg-round-dot' }),
                React.createElement(
                  'div',
                  { className: 'nmg-round-head' },
                  React.createElement(
                    'span',
                    { className: 'nmg-round-label' },
                    r === 0 ? '最近一轮' : '#' + (round.generation != null ? round.generation : r + 1),
                  ),
                  React.createElement('span', { className: 'nmg-round-stat' }, (round.candidates || []).length + ' 条'),
                  React.createElement('span', { className: 'nmg-round-stat' }, '~' + (round.tokens != null ? round.tokens : '?') + ' tok'),
                ),
                (round.candidates || []).map((c: any, i: number) =>
                  React.createElement(
                    'div',
                    { key: (round.generation || r) + ':' + (c.id || i), className: 'nmg-item' },
                    React.createElement('div', { className: 'nmg-item-node', title: c.node }, c.node),
                    React.createElement(
                      'div',
                      { className: 'nmg-item-meta' },
                      React.createElement('span', null, c.type),
                      React.createElement('span', null, 'L' + c.tier),
                    ),
                    React.createElement('div', { className: 'nmg-item-preview' }, c.preview),
                  ),
                ),
              ),
            )
          : React.createElement('div', { className: 'nmg-recall-empty' }, '还没有召回。下一轮注入后，这里从最近一轮开始往上叠。'),
      ),
      React.createElement(
        'div',
        { className: 'nmg-activity' },
        React.createElement('div', { className: 'nmg-activity-head' }, '活动'),
        activity.length > 0
          ? activity.map((entry: any, i: number) =>
              React.createElement(
                'div',
                { key: String(entry.at || '') + ':' + i, className: 'nmg-activity-row' },
                React.createElement('span', { className: 'nmg-activity-time' }, String(entry.at || '').slice(11, 16)),
                React.createElement('span', { className: 'nmg-activity-dot', 'data-kind': entry.kind }),
                React.createElement('span', { className: 'nmg-activity-text', title: activityText(entry) }, activityText(entry)),
              ),
            )
          : React.createElement('div', { className: 'nmg-recall-empty' }, '本会话还没有活动。'),
      ),
    )
  }

  const disposers: Array<() => void> = [
    injectCss(),
    ctx.on('theme/change', () => refreshMode()),
  ]

  for (const key of KEYS) {
    disposers.push(ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
      { name: 'tool.call.toolview', key },
      (props: any) => React.createElement(NmgToolCard, props),
    )))
  }

  // Right-pane tab entry (sidebarRightTabs) instead of the floating overlay: the
  // recall ledger sits with the other side panels and nothing floats over the
  // conversation any more.
  if (typeof ctx.inject === 'function') disposers.push(ctx.inject(['sidebarRightTabs'], (scope: any) => {
    const tabs = scope.sidebarRightTabs
    if (!tabs || typeof tabs.register !== 'function') return () => {}
    const inner: Array<() => void> = []
    const collect = (value: any) => {
      if (typeof value === 'function') inner.push(value)
    }
    collect(tabs.register({
      id: 'nmg-recall',
      kind: 'nmg-recall',
      title: () => 'NMG 召回',
      guide: [{ order: 40, title: () => 'NMG 召回', description: () => '本会话每轮自动召回的候选记录' }],
    }))
    collect(scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab', key: 'nmg-recall' },
      (props: any) => React.createElement(NmgRecallPanel, props),
    )))
    collect(scope.slots.inject('sidebar.right.pane.tab.title', () => scope.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: 'nmg-recall' },
      () => 'NMG 召回',
    )))
    return () => {
      for (const dispose of inner.reverse()) dispose()
    }
  }))
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
    listeners.clear()
  }
}
