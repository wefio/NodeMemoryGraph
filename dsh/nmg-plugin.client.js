// NMG tool cards — Client half (canonical source, theme-aware version).
//
// Custom conversation cards for the five NMG tools, registered as keyed
// `tool.call.toolview` entries. This is the exact `code.client` body used by
// the dynamic plugin `toolv-2`; keep this file and that package in sync.
//
// Loading it back is one dynamic-plugin step (this process only):
//   cordis_define kind:"new" idPrefix:"toolv" code.client := this body
//   cordis_run  → approve in the browser.
//
// THEME-AWARE: the card reads the ACTUAL active color scheme from the theme
// service (ctx.theme.getTheme().active.colorScheme), subscribes to
// `theme/change`, and picks a full light/dark palette per card via inline
// --nmg-* custom properties. Do NOT rely on the global --dsw-alias-* theme CSS
// variables — they do not resolve inside the dynamic injected context (a badge
// background of var(...) rendered white), and do NOT hardcode light-only colors.
//
// PERSISTENT client UI is a different mechanism in DSH: client modules are
// HOST-composition packages declaring `dsh.client` in package.json with
// `exports["./client"]` pointing at a BUILT bundle (the `__ModuleLoader__.load`
// handoff), scanned from host Loader entries — presets cannot carry client UI,
// dynamic client plugins do not survive a page refresh, and package-set changes
// take effect only after a host restart. See README.md.

return {
  name: 'nmg-toolview',
  apply(ctx) {
    const slots = ctx.get('slots')
    const theme = ctx.get('theme')
    if (slots === undefined) return

    let themeMode = 'light'
    const listeners = new Set()
    function applyMode(mode) {
      themeMode = mode === 'dark' ? 'dark' : 'light'
      for (const listener of listeners) listener()
    }
    function refreshMode() {
      try {
        const snap = theme && theme.getTheme()
        applyMode(snap && snap.active ? snap.active.colorScheme : 'light')
      } catch {
        applyMode('light')
      }
    }
    refreshMode()

    styles.insert(`
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
    `)

    const COLORS = {
      nmg_search: '#2563eb',
      nmg_get: '#0ea5e9',
      nmg_remember: '#16a34a',
      nmg_board: '#9333ea',
      nmg_daemon: '#d97706',
    }

    const LIGHT = {
      '--nmg-text': '#111827',
      '--nmg-text-2': '#374151',
      '--nmg-text-dim': '#6b7280',
      '--nmg-surface': 'rgba(0, 0, 0, .04)',
      '--nmg-surface-2': 'rgba(0, 0, 0, .06)',
      '--nmg-border': 'rgba(127, 127, 127, .35)',
    }
    const DARK = {
      '--nmg-text': '#e5e7eb',
      '--nmg-text-2': '#d1d5db',
      '--nmg-text-dim': '#9ca3af',
      '--nmg-surface': 'rgba(255, 255, 255, .07)',
      '--nmg-surface-2': 'rgba(255, 255, 255, .11)',
      '--nmg-border': 'rgba(255, 255, 255, .22)',
    }

    function useThemeMode() {
      const [mode, setMode] = React.useState(themeMode)
      React.useEffect(() => {
        const listener = () => setMode(themeMode)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return mode
    }

    function extractText(content) {
      return (Array.isArray(content) ? content : [])
        .map((block) => (block && block.type === 'text' ? block.text : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim()
    }

    function parseArgs(raw) {
      try {
        return JSON.parse(raw || '{}')
      } catch {
        return {}
      }
    }

    function cardLabel(toolName, args) {
      switch (toolName) {
        case 'nmg_search': return String(args.query || '')
        case 'nmg_get': return (Array.isArray(args.memoryIds) ? args.memoryIds : []).join(', ')
        case 'nmg_remember': return String(args.statement || '') + (args.nodeName ? '  →  ' + String(args.nodeName) : '')
        case 'nmg_board': return String(args.action || '') + (args.taskId ? '  ' + String(args.taskId) : '')
        case 'nmg_daemon': return String(args.action || '')
        default: return ''
      }
    }

    function truncateResult(text) {
      return text.length <= 420 ? text : text.slice(0, 419) + '…'
    }

    function CardInner(props) {
      const block = props.block
      const settled = block && block.kind === 'tool-result'
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

    function NmgToolCard(props) {
      const dark = useThemeMode() === 'dark'
      return React.createElement(CardInner, Object.assign({}, props, { nmgDark: dark }))
    }

    const MemoCard = React.memo(CardInner, (prev, next) =>
      prev.callId === next.callId &&
      prev.toolName === next.toolName &&
      prev.block === next.block &&
      prev.nmgDark === next.nmgDark,
    )

    const disposers = [
      ctx.on('theme/change', (snapshot) => {
        applyMode(snapshot && snapshot.active ? snapshot.active.colorScheme : 'light')
      }),
    ]
    const keys = ['nmg_search', 'nmg_get', 'nmg_remember', 'nmg_board', 'nmg_daemon']
    for (const key of keys) {
      slots.inject('tool.call.toolview', () => slots.register(
        { name: 'tool.call.toolview', key },
        (props) => React.createElement(NmgToolCard, props),
      ))
    }
    ctx.on('dispose', () => {
      for (const dispose of disposers) dispose()
    })
  },
}
