// Cockpit views: pure functions that turn state into element trees.
// Box/Text come from $.ui.resolve(e) in the hook and are passed in.
// Bars are real colored Boxes and tables are fixed-width Box cells, so they look the same in the
// terminal and in the Desktop app (whose font is proportional, so padded text would not line up).

import { mean, std, pctl, hitRate, runningAgents, planProgress } from './model.js'

export const TABS = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'tools', label: 'Tools', key: '2' },
  { id: 'files', label: 'Files', key: '3' },
  { id: 'cache', label: 'Cache', key: '4' },
  { id: 'agents', label: 'Agents', key: '5' },
  { id: 'timeline', label: 'Timeline', key: '6' },
  { id: 'debug', label: 'Debug', key: '7' },
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
export const heat = (p) => (p >= 85 ? 'red' : p >= 65 ? 'yellow' : 'green')
export const cacheRemaining = (S, now) => (S.lastMainStepAt ? S.ttlMin * 60000 - (now - S.lastMainStepAt) : null)
export const cacheColor = (rem) => (rem > 60000 ? 'green' : rem > 15000 ? 'yellow' : 'red')
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

// Below this many columns the wide tables drop their least useful columns instead of cutting every cell.
const NARROW = 90

// A horizontal bar made of colored blocks: `pct` filled in `color`, the rest a gray track. Fixed width (pills use it).
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

// Proportional segments that fill their row, for example cache read / wrote / new.
export function fstack(Box, parts, minWidth = 8) {
  const total = parts.reduce((a, p) => a + p.v, 0)
  const kids = parts.filter((p) => p.v > 0).map((p) => Box({ width: 0, flexGrow: Math.max(1, Math.round((p.v / total) * 1000)), height: 1, backgroundColor: p.color }))
  if (!kids.length) kids.push(Box({ width: 0, flexGrow: 1, height: 1, backgroundColor: 'gray' }))
  return Box({ flexDirection: 'row', flexGrow: 1, flexShrink: 1, minWidth, height: 1, children: kids })
}

// One table cell. `w` is its minimum width: a plain cell is as wide as its text but never narrower, so a number is never cut.
// A `flex` cell takes the leftover width (`grow` shares it between several) and is the one that truncates.
function cell(Box, Text, c) {
  const inner = typeof c.node === 'object' && c.node ? c.node : T(Text, c.t ?? '', c)
  const align = { justifyContent: c.right ? 'flex-end' : 'flex-start', children: [inner] }
  return c.flex ? Box({ ...align, overflow: 'hidden', width: 0, flexGrow: c.grow ?? 1, flexShrink: 1, minWidth: c.w ?? 4 }) : Box({ ...align, minWidth: c.w, flexShrink: 0 })
}
function trow(Box, Text, cells, gap = 1) {
  return Box({ flexDirection: 'row', columnGap: gap, children: cells.map((c) => cell(Box, Text, c)) })
}
const head = (label, w, right, flex, grow) => ({ t: label, w, right, flex, grow, dim: true, bold: true })

// A stat tile: tiles share their row evenly, so they read as a grid at any width.
function tile(Box, Text, value, label, color) {
  return Box({
    flexDirection: 'column',
    flexGrow: 1,
    paddingX: 1,
    borderStyle: 'round',
    borderColor: 'gray',
    minWidth: 12,
    children: [T(Text, value, { bold: true, color }), T(Text, label, { dim: true })],
  })
}
const tiles = (Box, list) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: list })

const section = (Text, s) => T(Text, s.toUpperCase(), { dim: true, bold: true })
const note = (Text, s, o = {}) => T(Text, s, { dim: true, wrap: 'wrap', ...o })
// A section in its own rounded card, so the tabs read as a stack of panels.
const card = (Box, Text, title, kids) => Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', paddingX: 1, marginBottom: 1, children: [section(Text, title), ...kids] })

// ---------- pane bodies ----------
function overview(Box, Text, S, now) {
  const budget = (label, pct, text, color) =>
    Box({ flexDirection: 'row', columnGap: 1, children: [Box({ minWidth: 9, flexShrink: 0, children: [T(Text, label, { dim: true })] }), fbar(Box, pct, color), Box({ minWidth: 22, flexShrink: 0, children: [T(Text, text, { color })] })] })

  const rows = []
  const p = ctxPercent(S)
  if (p !== null) rows.push(budget('Context', p, p + '%  ' + fmtTok(S.ctx.tokens || 0) + ' of ' + fmtTok(S.ctx.window), heat(p)))
  else rows.push(T(Text, 'Context: no reading yet', { dim: true }))
  for (const l of S.limits) {
    const name = l.kind === 'five_hour' ? '5-hour' : l.kind === 'seven_day' ? 'Weekly' : l.kind === 'spend_limit' ? 'Spend' : l.kind
    const reset = l.resetsAt ? '  resets in ' + fmtMs(Math.max(0, Date.parse(l.resetsAt) - Date.now())) : ''
    rows.push(budget(name, l.percentUsed, Math.round(l.percentUsed) + '%' + reset, heat(l.percentUsed)))
  }
  const rem = cacheRemaining(S, now)
  if (rem !== null) rows.push(budget('Cache', rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0, rem > 0 ? mmss(rem) + ' left' : 'expired', rem > 0 ? cacheColor(rem) : 'red'))
  if (S.todos && S.todos.total) rows.push(budget('Progress', (S.todos.done / Math.max(1, S.todos.total)) * 100, S.todos.done + ' of ' + S.todos.total + ' tasks', 'cyan'))
  const out = [card(Box, Text, 'Budget', rows)]

  const tm = S.turnMs
  const failRate = S.toolCalls ? Math.round((S.fails / S.toolCalls) * 100) : 0
  const sess = [
    tiles(Box, [
      tile(Box, Text, S.turns, 'turns'),
      tile(Box, Text, S.toolCalls, 'tool calls'),
      tile(Box, Text, S.fails + (S.toolCalls ? ' · ' + failRate + '%' : ''), 'failed', S.fails ? 'yellow' : undefined),
      tile(Box, Text, S.repeatReads, 're-reads', S.repeatReads > 5 ? 'yellow' : undefined),
      tile(Box, Text, runningAgents(S).length + '/' + Object.keys(S.agents).length, 'agents'),
      tile(Box, Text, S.compactions, 'compactions'),
      tile(Box, Text, S.cost ? '$' + S.cost.usd.toFixed(2) : '-', S.account === 'api' ? 'cost' : 'cost (API rate)'),
    ]),
  ]
  if (tm.length) sess.push(note(Text, 'turn time   mean ' + fmtMs(mean(tm)) + '   sd ' + fmtMs(std(tm)) + '   p95 ' + fmtMs(pctl(tm, 95)) + '   p99 ' + fmtMs(pctl(tm, 99))))
  sess.push(note(Text, 'model   ' + (S.model || '?') + (S.modelLog.length > 1 ? '   · ' + (S.modelLog.length - 1) + ' change' + (S.modelLog.length > 2 ? 's' : '') + ' (see Timeline)' : '')))
  out.push(card(Box, Text, 'Session', sess))

  const run = Object.values(S.running)
  if (run.length) out.push(card(Box, Text, 'Running now', run.slice(0, 5).map((r) => T(Text, '▸ ' + r.tool + '  ' + fmtMs(now - r.t) + (r.agentId ? '  (agent)' : ''), { color: 'cyan', wrap: 'wrap' }))))
  return out
}

function toolsTab(Box, Text, S, now, cols) {
  const wide = cols >= NARROW
  const rows = Object.entries(S.tools).sort((a, b) => b[1].n - a[1].n).slice(0, 16)
  const maxP95 = Math.max(1, ...rows.map(([, s]) => pctl(s.durs, 95)))
  const D = 8
  const line = (name, s, header) => {
    const d = s ? s.durs : []
    const v = (f) => (header ? undefined : f)
    const cells = [
      header ? head('tool', 10, false, true, 2) : { t: name, w: 10, flex: true, grow: 2 },
      header ? head('calls', 6, true) : { t: s.n, w: 6, right: true },
      header ? head('fail', 5, true) : { t: s.fail || '·', w: 5, right: true, color: s.fail ? 'red' : undefined, dim: !s.fail },
      header ? head('mean', D, true) : { t: fmtMs(mean(d)), w: D, right: true },
    ]
    if (wide) cells.push(header ? head('sd', D, true) : { t: fmtMs(std(d)), w: D, right: true, dim: true }, header ? head('p50', D, true) : { t: fmtMs(pctl(d, 50)), w: D, right: true })
    cells.push(header ? head('p95', D, true) : { t: fmtMs(pctl(d, 95)), w: D, right: true, bold: true })
    if (wide) cells.push(header ? head('p99', D, true) : { t: fmtMs(pctl(d, 99)), w: D, right: true, dim: true })
    cells.push(header ? head('', 8, false, true, 1) : { w: 8, flex: true, grow: 1, node: fbar(Box, (pctl(d, 95) / maxP95) * 100, s.fail / Math.max(1, s.n) > 0.1 ? 'yellow' : 'cyan', 'gray', 6) })
    return trow(Box, Text, cells)
  }
  const body = [line('', null, true), ...rows.map(([name, s]) => line(name, s, false))]
  if (!rows.length) body.push(T(Text, 'no tool calls yet', { dim: true }))
  return [card(Box, Text, 'Tool calls', body), note(Text, 'Durations include time spent on permission prompts, and an Agent call lasts as long as the whole subagent. Last 500 calls per tool.')]
}

function filesTab(Box, Text, S) {
  const rows = Object.entries(S.files).sort((a, b) => b[1].repeat - a[1].repeat || b[1].reads - a[1].reads).slice(0, 16)
  const body = [trow(Box, Text, [head('file', 12, false, true), head('reads', 7, true), head('edits', 7, true), head('repeat', 8, true)])]
  for (const [path, f] of rows) {
    body.push(trow(Box, Text, [{ t: path, w: 12, flex: true, wrap: 'truncate-start' }, { t: f.reads, w: 7, right: true }, { t: f.edits || '·', w: 7, right: true, dim: !f.edits }, { t: f.repeat || '·', w: 8, right: true, color: f.repeat >= 3 ? 'yellow' : undefined, dim: !f.repeat }]))
  }
  if (!rows.length) body.push(T(Text, 'no file reads or edits yet', { dim: true }))
  return [card(Box, Text, 'Files', body), note(Text, 'repeat = read again with no edit in between, usually wasted context. Total: ' + S.repeatReads + '.')]
}

function cacheTab(Box, Text, S, now) {
  const out = []
  const rem = cacheRemaining(S, now)
  const win = []
  if (rem === null) win.push(T(Text, 'no request yet', { dim: true }))
  else if (rem > 0) win.push(fbar(Box, (rem / (S.ttlMin * 60000)) * 100, cacheColor(rem), 'gray', 12), T(Text, mmss(rem) + ' left · send a message to refresh', { color: cacheColor(rem), wrap: 'wrap' }))
  else win.push(T(Text, 'expired ' + mmss(-rem) + ' ago: the next request rewrites the cache', { color: 'red', wrap: 'wrap' }))
  const t = S.cache
  win.push(tiles(Box, [tile(Box, Text, fmtTok(t.read), 'read', 'green'), tile(Box, Text, fmtTok(t.wrote), 'wrote', 'yellow'), tile(Box, Text, fmtTok(t.fresh), 'new', 'cyan'), tile(Box, Text, hitRate(t.read, t.wrote, t.fresh) + '%', 'hit rate'), tile(Box, Text, fmtTok(S.outTok || 0), 'output')]))
  win.push(note(Text, 'Token counts are what the API reported for each request. The window length is your setting (/cockpit ttl 5 or 60); the API does not report it.'))
  out.push(card(Box, Text, 'Window (' + S.ttlMin + ' min)', win))

  const sws = []
  if (!S.switches.length) sws.push(note(Text, 'none yet. A switch usually drops the prompt cache, so the next request re-writes the whole context.'))
  for (const sw of S.switches.slice(-6).reverse()) {
    const lost = sw.rewrote > 0.5 * (sw.rewrote + (sw.read || 0))
    sws.push(
      Box({
        flexDirection: 'row',
        flexWrap: 'wrap',
        columnGap: 1,
        children: [
          Box({ minWidth: 11, flexShrink: 0, justifyContent: 'flex-end', children: [T(Text, fmtMs(now - sw.t) + ' ago', { dim: true })] }),
          Box({ minWidth: 6, flexShrink: 0, children: [T(Text, sw.kind, { dim: true })] }),
          Box({ flexShrink: 0, children: [T(Text, shortModel(String(sw.from)) + ' → ' + shortModel(String(sw.to)))] }),
          Box({ flexShrink: 0, children: [T(Text, lost ? 're-cached ' + fmtTok(sw.rewrote) + ' tokens' : 'cache kept (' + fmtTok(sw.read || 0) + ' read)', { color: lost ? 'yellow' : 'green' })] }),
        ],
      }),
    )
  }
  if (S.switchTokens) sws.push(note(Text, 'total re-cached after switches: ' + fmtTok(S.switchTokens) + ' tokens'))
  out.push(card(Box, Text, 'Model and effort switches', sws))

  const reqs = [trow(Box, Text, [head('ago', 8, true), head('read / wrote / new', 12, false, true), head('hit', 5, true), head('model', 12)])]
  for (const s of S.steps.slice(-12).reverse()) {
    const h = hitRate(s.read, s.wrote, s.fresh)
    reqs.push(trow(Box, Text, [{ t: fmtMs(now - s.t), w: 8, right: true, dim: true }, { w: 12, flex: true, node: fstack(Box, [{ v: s.read, color: 'green' }, { v: s.wrote, color: 'yellow' }, { v: s.fresh, color: 'cyan' }], 12) }, { t: h + '%', w: 5, right: true, color: h < 50 ? 'yellow' : undefined }, { t: shortModel(s.model), w: 12, dim: true }]))
  }
  if (!S.steps.length) reqs.push(T(Text, 'no requests recorded yet', { dim: true }))
  reqs.push(note(Text, 'green = served from cache · yellow = written to cache · cyan = sent uncached. Main loop only: subagents keep their own caches, which are not tracked.'))
  out.push(card(Box, Text, 'Recent requests', reqs))
  return out
}

function agentsTab(Box, Text, S, now, cols) {
  const all = Object.values(S.agents)
  if (!all.length) return [note(Text, 'no subagents spawned this session')]
  const wide = cols >= NARROW
  const f = agentFleet(S)
  const fleet = [
    fbar(Box, (f.done / f.total) * 100, f.failed ? 'yellow' : 'green', 'gray', 12),
    T(Text, f.total + ' launched · ' + f.done + ' finished · ' + f.running + ' running' + (f.failed ? ' · ' + f.failed + ' failed' : ''), { bold: true, wrap: 'wrap' }),
  ]
  const pl = planProgress(S)
  if (pl) fleet.push(T(Text, 'plan "' + pl.title + '": ' + pl.done + '/' + pl.total + ' tasks done', { color: pl.done === pl.total ? 'green' : 'cyan', wrap: 'wrap' }))
  const out = [card(Box, Text, 'Subagents', fleet)]

  // By type: how much each kind of agent has cost and how long it takes.
  const byType = {}
  for (const a of all) {
    const k = a.type || 'agent'
    const r = (byType[k] ??= { n: 0, done: 0, failed: 0, tokens: 0, cost: 0, ms: 0 })
    r.n++
    if (a.status === 'completed') r.done++
    if (a.status === 'failed' || a.status === 'killed') r.failed++
    r.tokens += a.tokens || 0
    r.cost += a.cost || 0
    r.ms += (a.endedAt || now) - a.startedAt
  }
  const types = [trow(Box, Text, [head('type', 12, false, true), head('runs', 5, true), head('done', 5, true), head('failed', 7, true), head('tokens', 8, true), head('≈cost', 8, true), ...(wide ? [head('avg time', 9, true)] : [])])]
  for (const [k, r] of Object.entries(byType).sort((x, y) => y[1].n - x[1].n)) {
    types.push(trow(Box, Text, [{ t: k, w: 12, flex: true, bold: true }, { t: r.n, w: 5, right: true }, { t: r.done, w: 5, right: true, color: 'green' }, { t: r.failed || '·', w: 7, right: true, color: r.failed ? 'red' : undefined, dim: !r.failed }, { t: fmtTok(r.tokens), w: 8, right: true }, { t: '$' + r.cost.toFixed(2), w: 8, right: true }, ...(wide ? [{ t: fmtMs(r.ms / r.n), w: 9, right: true, dim: true }] : [])]))
  }
  const sub = limit(S, 'five_hour') || limit(S, 'seven_day')
  types.push(note(Text, sub ? 'Cost is an estimate at API list rates, not a bill.' : 'Cost is an estimate at API list rates; your gateway or contract may price it differently.'))
  out.push(card(Box, Text, 'By type', types))

  // Every subagent, nested under the loop that spawned it. Nothing is cut off: long text wraps.
  const ids = new Set(Object.keys(S.agents))
  const kids = {}
  const roots = []
  for (const a of all) {
    if (a.parent && ids.has(a.parent)) (kids[a.parent] ??= []).push(a)
    else roots.push(a)
  }
  const byStart = (x, y) => x.startedAt - y.startedAt
  const tree = []
  const draw = (a, prefix, last) => {
    const running = a.status === 'running'
    const idle = running && !a.current ? now - a.lastAt : 0
    const stalled = idle > 120000
    const color = stalled ? 'red' : running ? 'cyan' : a.status === 'completed' ? 'green' : 'red'
    const icon = running ? (stalled ? '⚠' : '◆') : a.status === 'completed' ? '✓' : '✗'
    const branch = prefix + (last ? '└─ ' : '├─ ')
    const pad = prefix + (last ? '   ' : '│  ')
    const state = (running ? (a.current ? '▸ ' + a.current : stalled ? 'silent ' + fmtMs(idle) : 'thinking') : a.status) + ' · ' + fmtMs((a.endedAt || now) - a.startedAt)
    tree.push(
      Box({
        flexDirection: 'row',
        columnGap: 1,
        children: [
          Box({ flexShrink: 0, children: [T(Text, branch + icon, { color })] }),
          Box({ flexShrink: 0, children: [T(Text, a.type, { bold: true })] }),
          Box({ flexGrow: 1, flexShrink: 1, minWidth: 8, children: [T(Text, a.desc, { wrap: 'wrap' })] }),
          Box({ flexShrink: 0, children: [T(Text, state, { color, dim: !running })] }),
        ],
      }),
    )
    const prog = a.stepTotal ? '  step ' + a.stepDone + '/' + a.stepTotal + (a.stepNote ? ' · ' + a.stepNote : '') : ''
    tree.push(note(Text, pad + shortModel(a.model) + ' · ' + a.steps + ' req · ' + a.tools + ' tools' + (a.fails ? ' · ' + a.fails + ' failed' : '') + ' · ctx ' + fmtTok(a.ctx) + ' · ' + fmtTok(a.tokens || 0) + ' tok · ≈$' + (a.cost || 0).toFixed(2) + prog))
    if (a.result) tree.push(T(Text, pad + '↩ ' + a.result, { color: 'green', wrap: 'wrap' }))
    const children = (kids[a.id] || []).sort(byStart)
    children.forEach((c, i) => draw(c, pad, i === children.length - 1))
  }
  const top = roots.sort(byStart)
  top.forEach((a, i) => draw(a, '', i === top.length - 1))
  out.push(card(Box, Text, 'All subagents', tree))
  return out
}

function timelineTab(Box, Text, S, now) {
  const icon = { spawn: '▶', result: '◀', send: '→', recv: '←', model: '⇄', compact: '⊟' }
  const color = { spawn: 'cyan', result: 'green', send: 'magenta', recv: 'magenta', model: 'yellow', compact: 'yellow' }
  // The message takes the rest of the row and wraps, so a narrow pane never cuts it off.
  const rows = S.msgs.slice(-22).reverse().map((m) =>
    Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        Box({ minWidth: 11, flexShrink: 0, justifyContent: 'flex-end', children: [T(Text, fmtMs(now - m.t) + ' ago', { dim: true })] }),
        Box({ minWidth: 2, flexShrink: 0, children: [T(Text, icon[m.kind] || '·', { color: color[m.kind] })] }),
        Box({ flexGrow: 1, flexShrink: 1, children: [T(Text, m.text, { wrap: 'wrap' })] }),
      ],
    }),
  )
  if (!rows.length) rows.push(note(Text, 'nothing yet: spawns, subagent results, session messages, model changes and compactions appear here'))
  return [card(Box, Text, 'Timeline', rows)]
}

// What the recorder has actually seen: first place to look when a panel is empty.
function debugTab(Box, Text, S, now) {
  const ev = [trow(Box, Text, [head('event', 16, false, true), head('count', 7, true), head('last', 12, true)])]
  const rows = Object.entries(S.dbg || {}).sort((a, b) => b[1].last - a[1].last)
  for (const [name, r] of rows) ev.push(trow(Box, Text, [{ t: name, w: 16, flex: true }, { t: r.n, w: 7, right: true }, { t: fmtMs(now - r.last) + ' ago', w: 12, right: true, dim: true }]))
  if (!rows.length) ev.push(T(Text, 'no events yet: send a message. If this stays empty, hooks are not firing in this app.', { color: 'yellow', wrap: 'wrap' }))
  const st = [
    note(Text, 'context ' + JSON.stringify(S.ctx) + ' · limits ' + S.limits.length + ' · cost ' + (S.cost ? '$' + S.cost.usd : 'none')),
    note(Text, 'steps ' + S.steps.length + ' · tools ' + Object.keys(S.tools).length + ' · files ' + Object.keys(S.files).length + ' · agents ' + Object.keys(S.agents).length + ' · cache ttl ' + S.ttlMin + 'm'),
  ]
  return [card(Box, Text, 'Events seen by the recorder', ev), card(Box, Text, 'State', st)]
}

const BODIES = { overview, tools: toolsTab, files: filesTab, cache: cacheTab, agents: agentsTab, timeline: timelineTab, debug: debugTab }

export function paneBody(Box, Text, tab, S, now, cols = 100) {
  const fn = BODIES[tab] || overview
  return Box({ flexDirection: 'column', children: fn(Box, Text, S, now, cols) })
}
