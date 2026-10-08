// Cockpit views: pure functions that turn state into element trees.
// Box/Text come from $.ui.resolve(e) in the hook and are passed in.
// Bars are real colored Boxes and tables are fixed-width Box cells, so they look the same in the
// terminal and in the Desktop app (whose font is proportional, so padded text would not line up).

import { mean, std, pctl, hitRate, runningAgents } from './model.js'

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

// A horizontal bar made of colored blocks: `pct` filled in `color`, the rest a gray track.
export function bar(Box, pct, w, color, track = 'gray') {
  const f = Math.max(0, Math.min(w, Math.round((Math.max(0, Math.min(100, pct)) / 100) * w)))
  const kids = []
  if (f > 0) kids.push(Box({ width: f, height: 1, backgroundColor: color }))
  if (w - f > 0) kids.push(Box({ width: w - f, height: 1, backgroundColor: track }))
  return Box({ flexDirection: 'row', width: w, height: 1, children: kids })
}

// Proportional segments, for example cache read / wrote / new.
export function stack(Box, parts, w) {
  const total = parts.reduce((a, p) => a + p.v, 0)
  if (!total) return Box({ width: w, height: 1, backgroundColor: 'gray' })
  const kids = []
  let used = 0
  parts.forEach((p, i) => {
    const cells = i === parts.length - 1 ? w - used : Math.round((p.v / total) * w)
    used += cells
    if (cells > 0) kids.push(Box({ width: cells, height: 1, backgroundColor: p.color }))
  })
  return Box({ flexDirection: 'row', width: w, height: 1, children: kids })
}

// One table cell: fixed width, optionally right-aligned.
function cell(Box, Text, c) {
  return Box({
    width: c.w,
    overflow: 'hidden',
    justifyContent: c.right ? 'flex-end' : 'flex-start',
    children: [typeof c.node === 'object' && c.node ? c.node : T(Text, c.t ?? '', c)],
  })
}
function trow(Box, Text, cells, gap = 1) {
  return Box({ flexDirection: 'row', columnGap: gap, children: cells.map((c) => cell(Box, Text, c)) })
}
const head = (label, w, right) => ({ t: label, w, right, dim: true, bold: true })

function tile(Box, Text, value, label, color) {
  return Box({
    flexDirection: 'column',
    paddingX: 1,
    borderStyle: 'round',
    borderColor: 'gray',
    minWidth: 11,
    children: [T(Text, value, { bold: true, color }), T(Text, label, { dim: true })],
  })
}

const section = (Text, s) => T(Text, s.toUpperCase(), { dim: true, bold: true })
const gap = (Text) => T(Text, ' ')

// ---------- pane bodies ----------
function overview(Box, Text, S, now) {
  const out = []
  const budget = (label, pct, text, color) =>
    Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 10, children: [T(Text, label, { dim: true })] }), bar(Box, pct, 26, color), T(Text, text, { color })] })

  out.push(section(Text, 'Budget'))
  const p = ctxPercent(S)
  if (p !== null) out.push(budget('Context', p, p + '%  ' + fmtTok(S.ctx.tokens || 0) + ' of ' + fmtTok(S.ctx.window), heat(p)))
  else out.push(T(Text, 'Context: no reading yet', { dim: true }))
  for (const l of S.limits) {
    const name = l.kind === 'five_hour' ? '5-hour' : l.kind === 'seven_day' ? 'Weekly' : l.kind
    const reset = l.resetsAt ? '  resets in ' + fmtMs(Math.max(0, Date.parse(l.resetsAt) - Date.now())) : ''
    out.push(budget(name, l.percentUsed, Math.round(l.percentUsed) + '%' + reset, heat(l.percentUsed)))
  }
  const rem = cacheRemaining(S, now)
  if (rem !== null) out.push(budget('Cache', rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0, rem > 0 ? mmss(rem) + ' left' : 'expired', rem > 0 ? cacheColor(rem) : 'red'))
  if (S.todos && S.todos.total) out.push(budget('Progress', (S.todos.done / Math.max(1, S.todos.total)) * 100, S.todos.done + ' of ' + S.todos.total + ' tasks', 'cyan'))
  out.push(gap(Text))

  out.push(section(Text, 'Session'))
  const tm = S.turnMs
  const failRate = S.toolCalls ? Math.round((S.fails / S.toolCalls) * 100) : 0
  out.push(
    Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      children: [
        tile(Box, Text, S.turns, 'turns'),
        tile(Box, Text, S.toolCalls, 'tool calls'),
        tile(Box, Text, S.fails + (S.toolCalls ? ' · ' + failRate + '%' : ''), 'failed', S.fails ? 'yellow' : undefined),
        tile(Box, Text, S.repeatReads, 're-reads', S.repeatReads > 5 ? 'yellow' : undefined),
        tile(Box, Text, runningAgents(S).length + '/' + Object.keys(S.agents).length, 'agents'),
        tile(Box, Text, S.compactions, 'compactions'),
        tile(Box, Text, S.cost ? '$' + S.cost.usd.toFixed(2) : '-', 'cost'),
      ],
    }),
  )
  if (tm.length) out.push(T(Text, 'turn time   mean ' + fmtMs(mean(tm)) + '   sd ' + fmtMs(std(tm)) + '   p95 ' + fmtMs(pctl(tm, 95)) + '   p99 ' + fmtMs(pctl(tm, 99)), { dim: true }))
  out.push(T(Text, 'model       ' + (S.model || '?') + (S.modelLog.length > 1 ? '   · ' + (S.modelLog.length - 1) + ' change' + (S.modelLog.length > 2 ? 's' : '') + ' (see Timeline)' : ''), { dim: true }))
  const run = Object.values(S.running)
  if (run.length) {
    out.push(gap(Text))
    out.push(section(Text, 'Running now'))
    for (const r of run.slice(0, 5)) out.push(T(Text, '▸ ' + r.tool + '  ' + fmtMs(now - r.t) + (r.agentId ? '  (agent)' : ''), { color: 'cyan' }))
  }
  return out
}

function toolsTab(Box, Text, S) {
  const rows = Object.entries(S.tools).sort((a, b) => b[1].n - a[1].n).slice(0, 16)
  const maxP95 = Math.max(1, ...rows.map(([, s]) => pctl(s.durs, 95)))
  const out = [
    trow(Box, Text, [head('tool', 20), head('calls', 6, true), head('fail', 5, true), head('mean', 7, true), head('sd', 7, true), head('p50', 7, true), head('p95', 7, true), head('p99', 7, true), head('p95', 12)]),
  ]
  for (const [name, s] of rows) {
    const d = s.durs
    const p95 = pctl(d, 95)
    out.push(
      trow(Box, Text, [
        { t: name, w: 20 },
        { t: s.n, w: 6, right: true },
        { t: s.fail || '·', w: 5, right: true, color: s.fail ? 'red' : undefined, dim: !s.fail },
        { t: fmtMs(mean(d)), w: 7, right: true },
        { t: fmtMs(std(d)), w: 7, right: true, dim: true },
        { t: fmtMs(pctl(d, 50)), w: 7, right: true },
        { t: fmtMs(p95), w: 7, right: true, bold: true },
        { t: fmtMs(pctl(d, 99)), w: 7, right: true, dim: true },
        { w: 12, node: bar(Box, (p95 / maxP95) * 100, 12, s.fail / Math.max(1, s.n) > 0.1 ? 'yellow' : 'cyan') },
      ]),
    )
  }
  if (!rows.length) out.push(T(Text, 'no tool calls yet', { dim: true }))
  out.push(gap(Text))
  out.push(T(Text, 'Durations include time spent on permission prompts. Last 500 calls per tool.', { dim: true }))
  return out
}

function filesTab(Box, Text, S) {
  const rows = Object.entries(S.files).sort((a, b) => b[1].repeat - a[1].repeat || b[1].reads - a[1].reads).slice(0, 16)
  const out = [trow(Box, Text, [head('file', 46), head('reads', 6, true), head('edits', 6, true), head('repeat', 7, true)])]
  for (const [path, f] of rows) {
    const short = path.length > 45 ? '…' + path.slice(-44) : path
    out.push(trow(Box, Text, [{ t: short, w: 46 }, { t: f.reads, w: 6, right: true }, { t: f.edits || '·', w: 6, right: true, dim: !f.edits }, { t: f.repeat || '·', w: 7, right: true, color: f.repeat >= 3 ? 'yellow' : undefined, dim: !f.repeat }]))
  }
  if (!rows.length) out.push(T(Text, 'no file reads or edits yet', { dim: true }))
  out.push(gap(Text))
  out.push(T(Text, 'repeat = read again with no edit in between, usually wasted context. Total: ' + S.repeatReads + '.', { dim: true }))
  return out
}

function cacheTab(Box, Text, S, now) {
  const out = []
  const rem = cacheRemaining(S, now)
  out.push(section(Text, 'Window (' + S.ttlMin + ' min)'))
  if (rem === null) out.push(T(Text, 'no request yet', { dim: true }))
  else if (rem > 0) out.push(Box({ flexDirection: 'row', columnGap: 1, children: [bar(Box, (rem / (S.ttlMin * 60000)) * 100, 30, cacheColor(rem)), T(Text, mmss(rem) + ' left · send a message to refresh', { color: cacheColor(rem) })] }))
  else out.push(T(Text, 'expired ' + mmss(-rem) + ' ago: the next request rewrites the cache', { color: 'red' }))
  const t = S.cache
  out.push(gap(Text))
  out.push(
    Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      children: [tile(Box, Text, fmtTok(t.read), 'read', 'green'), tile(Box, Text, fmtTok(t.wrote), 'wrote', 'yellow'), tile(Box, Text, fmtTok(t.fresh), 'new', 'cyan'), tile(Box, Text, hitRate(t.read, t.wrote, t.fresh) + '%', 'hit rate')],
    }),
  )
  out.push(gap(Text))
  out.push(section(Text, 'Recent requests'))
  out.push(trow(Box, Text, [head('ago', 7, true), head('read / wrote / new', 32), head('hit', 5, true), head('model', 14)]))
  for (const s of S.steps.slice(-12).reverse()) {
    const h = hitRate(s.read, s.wrote, s.fresh)
    out.push(trow(Box, Text, [{ t: fmtMs(now - s.t), w: 7, right: true, dim: true }, { w: 32, node: stack(Box, [{ v: s.read, color: 'green' }, { v: s.wrote, color: 'yellow' }, { v: s.fresh, color: 'cyan' }], 32) }, { t: h + '%', w: 5, right: true, color: h < 50 ? 'yellow' : undefined }, { t: shortModel(s.model), w: 14, dim: true }]))
  }
  if (!S.steps.length) out.push(T(Text, 'no requests recorded yet', { dim: true }))
  out.push(gap(Text))
  out.push(T(Text, 'green = served from cache · yellow = written to cache · cyan = sent uncached. Set lifetime: /cockpit ttl 5 or 60.', { dim: true }))
  return out
}

function agentsTab(Box, Text, S, now) {
  const list = Object.values(S.agents).sort((a, b) => b.startedAt - a.startedAt).slice(0, 10)
  if (!list.length) return [T(Text, 'no subagents spawned this session', { dim: true })]
  const f = agentFleet(S)
  const out = [
    section(Text, 'Subagents'),
    Box({
      flexDirection: 'row',
      columnGap: 1,
      children: [
        bar(Box, (f.done / f.total) * 100, 26, f.failed ? 'yellow' : 'green'),
        T(Text, f.total + ' launched · ' + f.done + ' finished · ' + f.running + ' running' + (f.failed ? ' · ' + f.failed + ' failed' : ''), { bold: true }),
      ],
    }),
    gap(Text),
    T(Text, '● main', { bold: true }),
  ]
  for (const a of list) {
    const running = a.status === 'running'
    const idle = running && !a.current ? now - a.lastAt : 0
    const stalled = idle > 120000
    const color = stalled ? 'red' : running ? 'cyan' : a.status === 'completed' ? 'green' : 'red'
    const icon = running ? (stalled ? '⚠' : '◆') : a.status === 'completed' ? '✓' : '✗'
    out.push(
      trow(Box, Text, [
        { t: '├─ ' + icon, w: 5, color },
        { t: a.type, w: 14, bold: true },
        { t: a.desc, w: 34 },
        { t: fmtMs((a.endedAt || now) - a.startedAt), w: 8, right: true, dim: true },
        { t: running ? (a.current ? '▸ ' + a.current : stalled ? 'silent ' + fmtMs(idle) : 'thinking') : a.status, w: 18, color, dim: !running },
      ]),
    )
    out.push(T(Text, '│    ' + shortModel(a.model) + ' · ' + a.steps + ' req · ' + a.tools + ' tools' + (a.fails ? ' · ' + a.fails + ' failed' : '') + ' · ctx ' + fmtTok(a.ctx) + ' · out ' + fmtTok(a.out), { dim: true }))
    if (a.result) out.push(T(Text, '│    ↩ ' + a.result, { color: 'green' }))
  }
  return out
}

function timelineTab(Box, Text, S, now) {
  const icon = { spawn: '▶', result: '◀', send: '→', recv: '←', model: '⇄', compact: '⊟' }
  const color = { spawn: 'cyan', result: 'green', send: 'magenta', recv: 'magenta', model: 'yellow', compact: 'yellow' }
  const out = []
  for (const m of S.msgs.slice(-22).reverse()) out.push(trow(Box, Text, [{ t: fmtMs(now - m.t) + ' ago', w: 11, right: true, dim: true }, { t: icon[m.kind] || '·', w: 2, color: color[m.kind] }, { t: m.text, w: 90 }]))
  if (!out.length) out.push(T(Text, 'nothing yet: spawns, subagent results, session messages, model changes and compactions appear here', { dim: true }))
  return out
}

// What the recorder has actually seen: first place to look when a panel is empty.
function debugTab(Box, Text, S, now) {
  const out = [section(Text, 'Events seen by the recorder')]
  out.push(trow(Box, Text, [head('event', 22), head('count', 7, true), head('last', 12, true)]))
  const rows = Object.entries(S.dbg || {}).sort((a, b) => b[1].last - a[1].last)
  for (const [name, r] of rows) out.push(trow(Box, Text, [{ t: name, w: 22 }, { t: r.n, w: 7, right: true }, { t: fmtMs(now - r.last) + ' ago', w: 12, right: true, dim: true }]))
  if (!rows.length) out.push(T(Text, 'no events yet: send a message. If this stays empty, hooks are not firing in this app.', { color: 'yellow' }))
  out.push(gap(Text))
  out.push(section(Text, 'State'))
  out.push(T(Text, 'context ' + JSON.stringify(S.ctx) + ' · limits ' + S.limits.length + ' · cost ' + (S.cost ? '$' + S.cost.usd : 'none'), { dim: true }))
  out.push(T(Text, 'steps ' + S.steps.length + ' · tools ' + Object.keys(S.tools).length + ' · files ' + Object.keys(S.files).length + ' · agents ' + Object.keys(S.agents).length + ' · cache ttl ' + S.ttlMin + 'm', { dim: true }))
  return out
}

const BODIES = { overview, tools: toolsTab, files: filesTab, cache: cacheTab, agents: agentsTab, timeline: timelineTab, debug: debugTab }

export function paneBody(Box, Text, tab, S, now) {
  const fn = BODIES[tab] || overview
  return Box({ flexDirection: 'column', children: fn(Box, Text, S, now) })
}
