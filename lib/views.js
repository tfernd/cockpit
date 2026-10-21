// Cockpit views: pure functions that turn state into element trees.
// Box/Text come from $.ui.resolve(e) in the hook and are passed in.
// Bars are real colored Boxes and tables are fixed-width Box cells, so they look the same in the
// terminal and in the Desktop app (whose font is proportional, so padded text would not line up).

import { traceRoots, traceTree } from './model.js'
import { lanesOf, lanesSvg, laneCells, titleOf, fmtDur, tickLabel, tickStep } from './lanes.js'
import { usageTab } from './usage.js'

export const TABS = [
  { id: 'trace', label: 'Trace', key: '1' },
  { id: 'usage', label: 'Usage', key: '2' },
]

// ---------- formatting ----------
export function fmtMs(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  const total = Math.round(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  if (h) return h + 'h' + String(m).padStart(2, '0') + 'm'
  return m + 'm' + String(total % 60).padStart(2, '0') + 's'
}
export function fmtTok(n) {
  if (n >= 1e6) return +(n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return +(n / 1e3).toFixed(1) + 'k'
  return String(Math.round(n))
}
export function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000))
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}
export function shortModel(m) {
  if (!m) return '?'
  return String(m)
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d+)-(\d+)$/, ' $1.$2')
    .replace(/-(\d+)$/, ' $1')
}
export const cacheRemaining = (S, now) => (S.lastMainStepAt ? S.ttlMin * 60000 - (now - S.lastMainStepAt) : null)
export const ctxPercent = (S) => (S.ctx && S.ctx.window ? S.ctx.percent ?? Math.round(((S.ctx.tokens || 0) / S.ctx.window) * 100) : null)
export const agentFleet = (S) => {
  const all = Object.values(S.agents)
  const running = all.filter((a) => a.status === 'running').length
  const done = all.filter((a) => a.status === 'completed').length
  return { total: all.length, running, done, failed: all.length - running - done }
}
export const limit = (S, kind) => S.limits.find((l) => l.kind === kind)

// ---------- building blocks ----------
export const T = (Text, s, o = {}) => Text({ color: o.color, dimColor: o.dim, bold: o.bold, italic: o.italic, wrap: o.wrap || 'truncate', children: [String(s === '' ? ' ' : s)] })

// A horizontal bar made of colored blocks: `pct` filled in `color`, the rest a gray track. Fixed width (the band's tiles use it).
export function bar(Box, pct, w, color, track = 'gray') {
  const f = Math.max(0, Math.min(w, Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)))
  const kids = []
  if (f > 0) kids.push(Box({ width: f, height: 1, backgroundColor: color }))
  if (w - f > 0) kids.push(Box({ width: w - f, height: 1, backgroundColor: track }))
  return Box({ flexDirection: 'row', width: w, height: 1, children: kids })
}

// The same bar, but it takes whatever width its row leaves: the fill and the track share it by their grow factors.
export function fbar(Box, pct, color, track = 'gray', minWidth = 8) {
  const p = Math.max(0, Math.min(100, pct))
  const kids = []
  if (p > 0) kids.push(Box({ width: 0, flexGrow: p, height: 1, backgroundColor: color }))
  if (p < 100) kids.push(Box({ width: 0, flexGrow: 100 - p, height: 1, backgroundColor: track }))
  return Box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, minWidth, height: 1, children: kids })
}

const note = (Text, s, o = {}) => T(Text, s, { dim: true, wrap: 'wrap', ...o })
// ---------- trace: swimlanes ----------
// One lane per loop (main session, then each subagent under the one that spawned it), its thinking and tool calls as
// blocks on one time axis. Desktop draws it as one interactive SVG (hover a block for its detail); the terminal as one
// coloured row per lane.
function traceTab(Box, Text, S, now, cols, ui = {}) {
  const { Button, ctl = {}, surface, Svg } = ui
  const roots = traceRoots(S)
  if (!roots.length) return [note(Text, 'No trace yet. Each prompt you send starts one: the main session and every subagent as a lane, their thinking and tool calls on one time axis.')]
  const root = (ctl.root && S.spans[ctl.root]) || roots[roots.length - 1]
  const idx = roots.indexOf(root)
  now = Math.floor(now / 5000) * 5000 // the lanes move in 5 s steps, so redraws in between draw the same markup
  // The latest prompt is shown with the one before it as context; a prompt picked with ◀ ▶ is shown alone.
  const shown = !ctl.root && idx > 0 ? [roots[idx - 1].id, root.id] : [root.id]
  const m = lanesOf(S, shown, now)
  const all = shown.flatMap((id) => traceTree(S, id, now).all)
  const llm = all.filter((s) => s.k === 'llm')
  const cost = llm.reduce((a, s) => a + (s.cost || 0), 0)
  const errs = all.filter((s) => s.st === 'err').length
  const nav = []
  if (Button && idx > 0) nav.push(Button({ key: 'trace-prev', label: '◀', plain: true, onPress: () => ctl.show(roots[idx - 1].id) }))
  nav.push(T(Text, idx + 1 + ' of ' + roots.length, { dim: true }))
  if (Button && idx < roots.length - 1) nav.push(Button({ key: 'trace-next', label: '▶', plain: true, onPress: () => ctl.show(roots[idx + 1].id) }))
  const head = Box({ flexDirection: 'row', columnGap: 1, children: [Box({ flexGrow: 1, width: 0, overflow: 'hidden', children: [T(Text, titleOf(root.n) || 'continued', { bold: true })] }), ...nav] })
  const money = cost >= 0.01 ? (S.account === 'api' ? '$' : '≈$') + cost.toFixed(2) : ''
  const facts = [m.live ? 'Running' : errs ? 'Done, ' + errs + ' failed' : 'Done', fmtDur(m.T1 - m.T0), fmtTok(llm.reduce((a, s) => a + (s.tok || 0), 0)) + ' tokens', money].filter(Boolean).join(' · ')
  const out = [head, T(Text, facts, { color: m.live ? 'cyan' : errs ? 'red' : undefined, dim: !m.live && !errs }), T(Text, ' ')]
  if (surface === 'desktop' && Svg) {
    const W = Math.max(320, cols * 8)
    const g = lanesSvg(m, W, now)
    // A live trace is a plain image: an interactive SVG sits in a frame that reloads (blinks) on every update.
    // Once the trace is done it stops changing, and becomes interactive for its tooltips.
    out.push(Svg({ source: g.svg, alt: m.lanes.map((l) => l.name + ' (' + l.sub + ')').join(', '), width: W, height: g.h, isInteractive: !m.live }))
  } else out.push(...termLanes(Box, Text, m, cols))
  if (m.hidden) out.push(note(Text, '+ ' + m.hidden + ' more subagents not drawn'))
  if (surface === 'desktop' && Svg) out.push(note(Text, m.live ? 'Hover works once the trace is done (a live one is drawn as an image, so it does not blink).' : 'Hover a block for its detail; hover a name for what the subagent handed back.'))
  else out.push(termLegend(Box, Text))
  return out
}

// Terminal colours for what a cell shows; a tool call takes its lane's own colour.
const TERM_KIND = { think: 'gray', write: 'yellow', miss: 'red', err: 'red' }

// The terminal legend: each swatch drawn as the lanes draw it.
function termLegend(Box, Text) {
  const sw = (bg, label) => Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 2, height: 1, backgroundColor: bg }), T(Text, label, { dim: true })] })
  const items = [sw('gray', 'thinking'), sw('blue', 'tool call (lane colour)'), Box({ flexDirection: 'row', columnGap: 1, children: [T(Text, '──', { dim: true }), T(Text, 'waiting', { dim: true })] }), Box({ flexDirection: 'row', columnGap: 1, children: [T(Text, '··', { dim: true }), T(Text, 'idle (your turn)', { dim: true })] }), sw('yellow', 'cache write'), sw('red', 'cache miss or failed')]
  return Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: items })
}

// Terminal lanes: a name column (dot in the lane's colour, the name, the model) and one cell per slice of time.
function termLanes(Box, Text, m, cols) {
  const L = Math.max(18, Math.min(40, Math.round(cols * 0.3)))
  const cells = Math.max(10, cols - L - 1)
  const rows = []
  for (const l of m.lanes) {
    const st = laneCells(l, m, cells)
    const runs = []
    for (let i = 0; i < st.length; ) {
      let j = i
      while (j < st.length && st[j] === st[i]) j++
      const n = j - i
      const k = st[i]
      if (k === 'wait') runs.push(T(Text, '─'.repeat(n), { dim: true }))
      else if (k === 'idle') runs.push(T(Text, '·'.repeat(n), { dim: true }))
      else if (k === ' ') runs.push(T(Text, ' '.repeat(n)))
      else runs.push(Box({ width: n, flexShrink: 0, height: 1, backgroundColor: TERM_KIND[k] || l.term }))
      i = j
    }
    const name = '  '.repeat(l.depth) + l.name
    rows.push(
      Box({
        flexDirection: 'row',
        children: [
          Box({ width: L, flexShrink: 0, overflow: 'hidden', flexDirection: 'row', children: [T(Text, '● ', { color: l.term }), T(Text, name, { bold: true }), T(Text, l.sub ? ' ' + l.sub : '', { dim: true })] }),
          Box({ flexDirection: 'row', width: cells, flexShrink: 0, overflow: 'hidden', children: runs }),
        ],
      }),
    )
  }
  const step = tickStep(m.T1 - m.T0, Math.floor(cells / 8))
  const axis = []
  for (let at = 0; at < m.T1 - m.T0; at += step) axis.push(Box({ width: 0, flexGrow: Math.max(1, Math.round((Math.min(step, m.T1 - m.T0 - at) / (m.T1 - m.T0)) * 1000)), overflow: 'hidden', children: [T(Text, tickLabel(at), { dim: true })] }))
  rows.push(Box({ flexDirection: 'row', children: [Box({ width: L, flexShrink: 0 }), Box({ flexDirection: 'row', width: cells, flexShrink: 0, children: axis })] }))
  return rows
}

const BODIES = { trace: traceTab, usage: usageTab }

export function paneBody(Box, Text, tab, S, now, cols = 100, ui) {
  const fn = BODIES[tab] || traceTab
  return Box({ flexDirection: 'column', children: fn(Box, Text, S, now, cols, ui) })
}
