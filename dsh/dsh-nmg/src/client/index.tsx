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
  .nmg-recall-pill {
    position: fixed;
    z-index: 9999;
    min-width: 0;
    max-width: 92vw;
    pointer-events: auto; /* shell.overlay is click-through; the pill opts back in */
    border: 1px solid var(--nmg-border, rgba(127,127,127,.35));
    border-left: 3px solid var(--nmg-accent, #2563eb);
    border-radius: 10px;
    background: var(--nmg-surface, rgba(0,0,0,.9));
    color: var(--nmg-text, #111827);
    font-size: 12px;
    line-height: 1.4;
    box-shadow: 0 4px 16px rgba(0,0,0,.28);
    overflow: hidden;
    user-select: none;
    touch-action: none;
  }
  /* collapsed: no fixed layout, sized by inline width:auto → wraps its content */
  .nmg-recall-pill-collapsed {
    width: fit-content;
  }
  /* expanded: a proper window filling its inline width/height; body scrolls */
  .nmg-recall-pill-expanded {
    display: flex;
    flex-direction: column;
  }
  .nmg-recall-pill-expanded .nmg-recall-pill-body {
    flex: 1;
    overflow: auto;
    cursor: text;
    user-select: text;
  }
  .nmg-recall-pill-head {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    cursor: move;
    flex: none;
  }
  .nmg-recall-pill .nmg-tool-badge {
    flex: none;
  }
  .nmg-recall-dock-state {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--nmg-text, #111827);
  }
  .nmg-recall-pill-toggle,
  .nmg-recall-pill-close {
    flex: none;
    border: none;
    background: transparent;
    color: var(--nmg-text-dim, #6b7280);
    font-size: 12px;
    cursor: pointer;
    padding: 0 3px;
    line-height: 1;
  }
  .nmg-recall-pill-toggle:hover,
  .nmg-recall-pill-close:hover {
    color: var(--nmg-text, #111827);
  }
  .nmg-recall-pill-body {
    padding: 6px 10px 8px;
    border-top: 1px solid var(--nmg-border, rgba(127,127,127,.25));
    cursor: text;
    user-select: text;
  }
  .nmg-recall-pill-meta {
    font-family: monospace;
    font-size: 10px;
    color: var(--nmg-text-dim, #6b7280);
    word-break: break-all;
    margin-bottom: 3px;
  }
  .nmg-recall-pill-preview {
    color: var(--nmg-text-2, #374151);
    word-break: break-word;
  }
  .nmg-recall-pill-card {
    padding: 4px 0;
    border-bottom: 1px solid var(--nmg-border, rgba(127,127,127,.18));
  }
  .nmg-recall-pill-card:last-of-type {
    border-bottom: none;
  }
  .nmg-recall-pill-nav {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .nmg-recall-pill-navbtn {
    border: 1px solid var(--nmg-border, rgba(127,127,127,.35));
    background: transparent;
    color: var(--nmg-text, #111827);
    border-radius: 6px;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
  }
  .nmg-recall-pill-navbtn:disabled {
    opacity: .4;
    cursor: default;
  }
  .nmg-recall-pill-navbtn:hover:not(:disabled) {
    background: var(--nmg-surface-2, rgba(0,0,0,.06));
  }
  .nmg-recall-pill-resize {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    opacity: .5;
    background: linear-gradient(135deg, transparent 0 60%, var(--nmg-text-dim, #6b7280) 60% 75%, transparent 75%);
  }
  .nmg-recall-pill-resize:hover {
    opacity: .9;
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
  '--nmg-text': '#111827',
  '--nmg-text-2': '#374151',
  '--nmg-text-dim': '#6b7280',
  '--nmg-surface': 'rgba(0, 0, 0, .04)',
  '--nmg-surface-2': 'rgba(0, 0, 0, .06)',
  '--nmg-border': 'rgba(127, 127, 127, .35)',
}

const DARK: Record<string, string> = {
  '--nmg-text': '#e5e7eb',
  '--nmg-text-2': '#d1d5db',
  '--nmg-text-dim': '#9ca3af',
  '--nmg-surface': 'rgba(255, 255, 255, .07)',
  '--nmg-surface-2': 'rgba(255, 255, 255, .11)',
  '--nmg-border': 'rgba(255, 255, 255, .22)',
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

  // Floating, persistent NMG recall indicator over the frame (shell.overlay).
  // Reads the current session via useSessions, fetches the host's webServer
  // route (`/nmg/recall?session=`), and renders a compact pill that expands to
  // the current session's last recall. Host keeps the daemon token; the browser
  // only sees safe JSON. Refetches on session change plus a light poll so a new
  // recall surfaces while the page stays on one session.
  // Frame-wide floating NMG recall indicator over a persistent, draggable/
  // resizable floating window (shell.overlay). Reads the current session via
  // useSessions, fetches the host's webServer route (/nmg/recall?session=),
  // and persists its position+size across mounts and refreshes.
  // Two independently-memorised window rects: one for the collapsed pill and one
  // for the expanded window. Dragging/resizing one position/size never affects
  // the other, and each is persisted across mounts and refreshes.
  const PILL_RECT_KEY = 'nmg.recall.pill'       // collapsed
  const WIN_RECT_KEY = 'nmg.recall.window'      // expanded
  function pillDefaultRect() {
    return { left: window.innerWidth - 280, top: 80, width: 0, height: 0 } // width 0 → auto
  }
  function windowDefaultRect() {
    return { left: window.innerWidth - 420, top: 96, width: 380, height: 300 }
  }
  function loadRect(key: string, fallback: () => any): any {
    try {
      const raw = window.localStorage.getItem(key)
      if (!raw) return fallback()
      const value = JSON.parse(raw)
      if (!value || typeof value !== 'object') return fallback()
      const f = fallback()
      return {
        left: typeof value.left === 'number' ? value.left : f.left,
        top: typeof value.top === 'number' ? value.top : f.top,
        width: typeof value.width === 'number' ? value.width : f.width,
        height: typeof value.height === 'number' ? value.height : f.height,
      }
    } catch {
      return fallback()
    }
  }
  function saveRect(key: string, rect: any) {
    try {
      window.localStorage.setItem(key, JSON.stringify(rect))
    } catch {}
  }

  function NmgRecallDock(props: any): any {
    const dark = useThemeMode() === 'dark'
    const current = props.useSessions((s: any) => s && s.current)
    const [recall, setRecall] = React.useState<any>(null)
    const [expanded, setExpanded] = React.useState(false)
    const [dismissed, setDismissed] = React.useState(false)
    const [pillRect, setPillRect] = React.useState<any>(() => (typeof window === 'undefined' ? { left: 20, top: 80, width: 0, height: 0 } : loadRect(PILL_RECT_KEY, pillDefaultRect)))
    const [winRect, setWinRect] = React.useState<any>(() => (typeof window === 'undefined' ? { left: 20, top: 96, width: 380, height: 300 } : loadRect(WIN_RECT_KEY, windowDefaultRect)))
    const drag = React.useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; base: any; key: string; set: (fn: any) => void } | null>(null)
    const [windowIndex, setWindowIndex] = React.useState(0)

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
            if (json && json.ok) setRecall(json.data || null)
            else setRecall(null)
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

    // Which rect is live right now (the one being dragged/resized).
    const rect = expanded ? winRect : pillRect
    const setRect = expanded ? setWinRect : setPillRect
    const rectKey = expanded ? WIN_RECT_KEY : PILL_RECT_KEY

    const onPointerDown = React.useCallback((e: any, mode: 'move' | 'resize') => {
      if (e.button !== 0) return
      e.preventDefault()
      const base = mode === 'move' ? { ...rect } : { ...rect }
      drag.current = { mode, startX: e.clientX, startY: e.clientY, base, key: rectKey, set: setRect }
      const onMove = (ev: any) => {
        const d = drag.current
        if (!d) return
        const dx = ev.clientX - d.startX
        const dy = ev.clientY - d.startY
        if (d.mode === 'move') {
          d.set((r: any) => (({ left: Math.max(0, d.base.left + dx), top: Math.max(0, d.base.top + dy), width: r.width, height: r.height })))
        } else {
          d.set((r: any) => (({ left: r.left, top: r.top, width: Math.max(260, d.base.width + dx), height: Math.max(120, d.base.height + dy) })))
        }
      }
      const onUp = (ev: any) => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        const d = drag.current
        if (d) {
          const dx = ev.clientX - d.startX
          const dy = ev.clientY - d.startY
          const finalRect = d.mode === 'move'
            ? { left: Math.max(0, d.base.left + dx), top: Math.max(0, d.base.top + dy), width: d.base.width, height: d.base.height }
            : { left: d.base.left, top: d.base.top, width: Math.max(260, d.base.width + dx), height: Math.max(120, d.base.height + dy) }
          saveRect(d.key, finalRect)
        }
        drag.current = null
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [expanded, rect, rectKey, setRect])

    // Toggle expand/collapse: persist current rect, reset the live rect's height
    // sizing so each state keeps an appropriate shape.
    const toggleExpanded = () => {
      const next = !expanded
      // Persist whichever rect is currently live.
      saveRect(expanded ? WIN_RECT_KEY : PILL_RECT_KEY, expanded ? winRect : pillRect)
      setExpanded(next)
    }

    const recalls = recall && Array.isArray(recall.recalls) ? recall.recalls : []
    const hasRecall = recalls.length > 0
    if (dismissed) return null
    React.useEffect(() => {
      setWindowIndex(0)
    }, [hasRecall])
    const vars = dark ? DARK : LIGHT
    const accent = '#2563eb'
    // Current recall window: start at the newest recall (index 0), page through earlier ones.
    const windowIdx = Math.min(windowIndex, Math.max(0, recalls.length - 1))
    const latest = hasRecall ? recalls[windowIdx] : null
    const stateLine = hasRecall
      ? '召回 ' + (recalls[0].candidates ? recalls[0].candidates.length : 0) + ' 条 · 最近 ~' + (recalls[0].tokens != null ? recalls[0].tokens : '?') + ' token · 共 ' + recalls.length + ' 轮' + (windowIdx > 0 ? ' (#' + (windowIdx + 1) + ')' : '')
      : '当前会话暂无召回'
    const style = Object.assign(
      { '--nmg-accent': accent, left: rect.left, top: rect.top },
      expanded
        ? { width: winRect.width, height: winRect.height }
        : { width: 'auto', minWidth: 120 },
      vars,
    )

    return React.createElement(
      'div',
      {
        className: 'nmg-recall-pill' + (expanded ? ' nmg-recall-pill-expanded' : ' nmg-recall-pill-collapsed'),
        style,
      },
      React.createElement(
        'div',
        { className: 'nmg-recall-pill-head', style: { cursor: 'move' }, onPointerDown: (e: any) => { if (e.button !== 0) return; onPointerDown(e, 'move') } },
        React.createElement('span', { className: 'nmg-tool-badge' }, 'NMG'),
        React.createElement('span', { className: 'nmg-recall-dock-state' }, stateLine),
        React.createElement(
          'button',
          { type: 'button', className: 'nmg-recall-pill-toggle', 'aria-label': expanded ? '收起' : '展开', onPointerDown: (e: any) => e.stopPropagation(), onClick: (e: any) => { e.stopPropagation(); toggleExpanded() } },
          expanded ? '▾' : '▸',
        ),
        React.createElement(
          'button',
          { type: 'button', className: 'nmg-recall-pill-close', 'aria-label': '隐藏', onPointerDown: (e: any) => e.stopPropagation(), onClick: (e: any) => { e.stopPropagation(); setDismissed(true) } },
          '✕',
        ),
      ),
      expanded && latest
        ? React.createElement(
            'div',
            { className: 'nmg-recall-pill-body' },
            (latest.candidates || []).map((c: any, i: number) =>
              React.createElement('div', { key: c.id || i, className: 'nmg-recall-pill-card' },
                React.createElement('div', { className: 'nmg-recall-pill-meta' }, 'node=' + c.node + '  type=' + c.type + '  L' + c.tier),
                React.createElement('div', { className: 'nmg-recall-pill-preview' }, c.preview),
              ),
            ),
            latest.activeGraphId
              ? React.createElement('div', { className: 'nmg-recall-pill-meta' }, 'activeGraphId=' + latest.activeGraphId)
              : null,
            recalls.length > 1
              ? React.createElement(
                  'div',
                  { className: 'nmg-recall-pill-nav' },
                  React.createElement('button', { type: 'button', className: 'nmg-recall-pill-navbtn', disabled: windowIdx <= 0, onPointerDown: (e: any) => e.stopPropagation(), onClick: (e: any) => { e.stopPropagation(); setWindowIndex((v) => Math.max(0, v - 1)) } }, '‹ 更早'),
                  React.createElement('span', { className: 'nmg-recall-pill-meta' }, (windowIdx + 1) + ' / ' + recalls.length),
                  React.createElement('button', { type: 'button', className: 'nmg-recall-pill-navbtn', disabled: windowIdx >= recalls.length - 1, onPointerDown: (e: any) => e.stopPropagation(), onClick: (e: any) => { e.stopPropagation(); setWindowIndex((v) => Math.min(recalls.length - 1, v + 1)) } }, '更新 ›'),
                )
              : null,
          )
        : null,
      expanded
        ? React.createElement(
            'div',
            { className: 'nmg-recall-pill-resize', onPointerDown: (e: any) => { e.stopPropagation(); onPointerDown(e, 'resize') } },
          )
        : null,
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

  // Frame-wide floating NMG recall indicator (shell.overlay, additive).
  disposers.push(ctx.slots.inject('shell.overlay', () => ctx.slots.register(
    { name: 'shell.overlay', id: 'nmg-recall-overlay', order: 50 },
    (props: any) => React.createElement(NmgRecallDock, props),
  )))

  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
    listeners.clear()
  }
}
