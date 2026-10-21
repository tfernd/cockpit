// Cockpit views: pure functions that turn state into element trees.
// Box/Text come from $.ui.resolve(e) in the hook and are passed in.
// Bars are real colored Boxes and tables are fixed-width Box cells, so they look the same in the
// terminal and in the Desktop app (whose font is proportional, so padded text would not line up).

import { mean, std, pctl, hitRate, planProgress, showPath, subCache, traceRoots, traceTree } from './model.js'

export const TABS = [
  { id: 'trace', label: 'Trace', key: '1' },
  { id: 'usage', label: 'Usage', key: '2' },
  { id: 'files', label: 'Files', key: '3' },
  { id: 'debug', label: 'Debug', key: '4' },
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

// A stat: big value over a small label, no frame. Stats share their row evenly, so they read as a grid at any width.
function tile(Box, Text, value, label, color) {
  return Box({ flexDirection: 'column', flexGrow: 1, minWidth: 10, paddingRight: 1, children: [T(Text, value, { bold: true, color }), T(Text, label, { dim: true })] })
}
const tiles = (Box, list) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children: list })

const section = (Text, s) => T(Text, s, { bold: true })
const note = (Text, s, o = {}) => T(Text, s, { dim: true, wrap: 'wrap', ...o })
// A section in a card with a dim frame, so the tabs read as a stack of panels.
const card = (Box, Text, title, kids) => Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'gray', borderDimColor: true, paddingX: 1, marginBottom: 1, children: [section(Text, title), ...kids] })

// ---------- pane bodies ----------
// The pills above the chat show the gauges at a glance; this tab shows the same gauges with the detail a pill has no room for,
// and counters the pills do not carry. Nothing is shown twice.
function overview(Box, Text, S, now) {
  const budget = (label, pct, text, color) =>
    Box({ flexDirection: 'row', columnGap: 1, children: [Box({ minWidth: 9, flexShrink: 0, children: [T(Text, label, { dim: true })] }), fbar(Box, pct, color), Box({ minWidth: 24, flexShrink: 0, children: [T(Text, text, { color })] })] })

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
  const last = S.steps[S.steps.length - 1]
  if (rem !== null) rows.push(budget('Cache', rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0, (rem > 0 ? mmss(rem) + ' left' : 'expired') + (last ? '  hit ' + hitRate(last.read, last.wrote, last.fresh) + '%' : ''), rem > 0 ? cacheColor(rem) : 'red'))
  const sc = subCache(S, now)
  if (sc.seen) rows.push(budget('Subagents', sc.next ? (sc.next / sc.win) * 100 : 0, sc.warm ? sc.warm + ' of ' + sc.seen + ' warm  next cools ' + mmss(sc.next) : 'all cold', sc.warm ? cacheColor(sc.next) : 'red'))
  if (S.todos && S.todos.total) rows.push(budget('Tasks', (S.todos.done / Math.max(1, S.todos.total)) * 100, S.todos.done + ' of ' + S.todos.total + ' done', 'cyan'))
  const pl = planProgress(S)
  if (pl) rows.push(budget('Plan', (pl.done / pl.total) * 100, pl.done + ' of ' + pl.total + ' · ' + pl.title, 'cyan'))
  const f = agentFleet(S)
  if (f.total) rows.push(budget('Agents', (f.done / f.total) * 100, f.done + '/' + f.total + (f.running ? ' · ' + f.running + ' run' : '') + (f.failed ? ' · ' + f.failed + ' failed' : ''), f.failed ? 'yellow' : 'cyan'))
  if (S.account === 'api' && S.budgetUsd > 0 && S.monthUsd > 0) rows.push(budget('Month', (S.monthUsd / S.budgetUsd) * 100, '$' + S.monthUsd.toFixed(0) + ' of $' + S.budgetUsd.toFixed(0), heat((S.monthUsd / S.budgetUsd) * 100)))
  const out = [card(Box, Text, 'Budget', rows)]

  const tm = S.turnMs
  const failRate = S.toolCalls ? Math.round((S.fails / S.toolCalls) * 100) : 0
  const sess = [
    tiles(Box, [
      tile(Box, Text, S.turns, 'turns'),
      tile(Box, Text, S.toolCalls, 'tool calls'),
      tile(Box, Text, S.fails + (S.toolCalls ? ' · ' + failRate + '%' : ''), 'failed', S.fails ? 'yellow' : undefined),
      tile(Box, Text, S.repeatReads, 're-reads', S.repeatReads > 5 ? 'yellow' : undefined),
      tile(Box, Text, S.compactions, 'compactions'),
    ]),
  ]
  // Labels are bold in a fixed column, numbers sit in right-aligned columns under dim headers, like the Tools tab.
  const L = 11
  const stat = (label, heads, vals) => [
    trow(Box, Text, [head('', L), ...heads.map((h) => head(h, 8, true))]),
    trow(Box, Text, [{ t: label, w: L, bold: true }, ...vals.map((v, i) => ({ t: v, w: 8, right: true, bold: heads[i] === 'p95' }))]),
  ]
  const kv = (label, value, o = {}) => trow(Box, Text, [{ t: label, w: L, bold: true }, { t: value, w: 12, flex: true, wrap: 'wrap', ...o }])
  if (tm.length) sess.push(...stat('turn time', ['mean', 'sd', 'p95', 'p99'], [fmtMs(mean(tm)), fmtMs(std(tm)), fmtMs(pctl(tm, 95)), fmtMs(pctl(tm, 99))]))
  if (S.steps.length) sess.push(...stat('tokens', ['in', 'out', 'cached'], [fmtTok(S.cache.fresh + S.cache.wrote), fmtTok(S.outTok || 0), fmtTok(S.cache.read)]))
  if (S.cost && S.cost.usd > 0) {
    if (S.account === 'api') sess.push(kv('cost', 'chat $' + S.cost.usd.toFixed(2) + (S.monthUsd > 0 ? ' · month $' + S.monthUsd.toFixed(0) : '')))
    else if (S.account === 'subscription') {
      sess.push(kv('worth', '≈$' + S.cost.usd.toFixed(2) + ' at API rates this chat' + (S.monthUsd > S.cost.usd ? ' · ≈$' + S.monthUsd.toFixed(0) + ' this month' : '') + (S.planFee ? ' · you pay $' + S.planFee.toFixed(0) : '')))
      sess.push(note(Text, 'an estimate at API rates, not a bill'))
    } else sess.push(kv('cost', '≈$' + S.cost.usd.toFixed(2) + ' at API rates (account type unknown: /cockpit account)'))
  }
  const sw = S.switches[S.switches.length - 1]
  sess.push(kv('model', (S.model || '?') + (sw ? ' · last switch ' + fmtMs(now - sw.t) + ' ago, ' + (sw.rewrote > 0.5 * (sw.rewrote + (sw.read || 0)) ? 're-cached ' + fmtTok(sw.rewrote) : 'cache kept') : '')))
  if (S.cwd) sess.push(kv('workspace', S.cwd, { wrap: 'truncate-start' }))
  out.push(card(Box, Text, 'Session', sess))

  return out
}

// Usage: what the session spends (context, plan limits, money) and how the prompt cache serves it. What runs is in Trace.
const usageTab = (Box, Text, S, now) => [...overview(Box, Text, S, now), ...cacheTab(Box, Text, S, now)]

// Per tool over the whole session: calls, failures and how long they take. Durations include permission prompts.
function toolStats(Box, Text, S, cols) {
  const wide = cols >= NARROW
  const rows = Object.entries(S.tools).filter(([n]) => n !== 'Agent').sort((a, b) => b[1].n - a[1].n).slice(0, 12)
  const D = 8
  const body = [trow(Box, Text, [head('tool', 10, false, true), head('calls', 6, true), head('fail', 5, true), ...(wide ? [head('mean', D, true)] : []), head('p50', D, true), head('p95', D, true)])]
  for (const [name, st] of rows) {
    const d = st.durs
    body.push(trow(Box, Text, [{ t: name.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ''), w: 10, flex: true }, { t: st.n, w: 6, right: true }, { t: st.fail || '·', w: 5, right: true, color: st.fail ? 'red' : undefined, dim: !st.fail }, ...(wide ? [{ t: fmtMs(mean(d)), w: D, right: true, dim: true }] : []), { t: fmtMs(pctl(d, 50)), w: D, right: true }, { t: fmtMs(pctl(d, 95)), w: D, right: true, bold: true }]))
  }
  if (!rows.length) body.push(note(Text, 'no tool calls yet'))
  return card(Box, Text, 'Tools this session', body)
}

function filesTab(Box, Text, S) {
  const rows = Object.entries(S.files).sort((a, b) => b[1].repeat - a[1].repeat || b[1].reads - a[1].reads).slice(0, 16)
  const body = [trow(Box, Text, [head('file', 12, false, true), head('reads', 6, true), head('edits', 6, true), head('repeat', 7, true)])]
  let outside = 0
  for (const [path, f] of rows) {
    const sp = showPath(S.cwd, path)
    if (sp.outside) outside++
    body.push(trow(Box, Text, [{ t: sp.outside ? '↗ ' + sp.t : sp.t, w: 12, flex: true, wrap: 'truncate-start', color: sp.outside ? 'yellow' : undefined }, { t: f.reads, w: 6, right: true }, { t: f.edits || '·', w: 6, right: true, dim: !f.edits }, { t: f.repeat || '·', w: 7, right: true, color: f.repeat >= 3 ? 'yellow' : undefined, dim: !f.repeat }]))
  }
  if (!rows.length) body.push(T(Text, 'no file reads or edits yet', { dim: true }))
  body.push(note(Text, S.cwd ? 'Paths are relative to ' + S.cwd + (outside ? '. ↗ marks files outside it, shown in full.' : '.') : 'Workspace folder unknown: full paths.'))
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
  const src = { env: 'an environment variable', setting: 'the promptCacheTtl setting', manual: '/cockpit ttl', auto: 'automatic for your account type', default: 'the default' }[S.ttlSource]
  win.push(note(Text, 'Token counts are what the API reported for each request. The ' + S.ttlMin + ' min window comes from ' + src + '; the API does not report it. /cockpit ttl 5|60|auto.'))
  out.push(card(Box, Text, 'Main window (' + S.ttlMin + ' min)', win))

  const sc = subCache(S, now)
  const sub = []
  if (!sc.seen) sub.push(note(Text, 'no subagent request yet'))
  else {
    sub.push(tiles(Box, [tile(Box, Text, sc.warm + ' of ' + sc.seen, 'warm', sc.warm ? 'green' : 'red'), tile(Box, Text, sc.next ? mmss(sc.next) : '·', 'next cools', sc.next ? cacheColor(sc.next) : undefined), tile(Box, Text, S.ttlSubMin + ' min', 'window')]))
  }
  sub.push(note(Text, 'Each subagent keeps its own cache, counted from the end of its last request. The window comes from subagentPromptCacheTtl or CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, else 5 minutes.'))
  out.push(card(Box, Text, 'Subagents (' + S.ttlSubMin + ' min)', sub))

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
  reqs.push(note(Text, 'green = served from cache · yellow = written to cache · cyan = sent uncached. Main loop only.'))
  out.push(card(Box, Text, 'Recent requests', reqs))
  return out
}

// What the recorder has actually seen: first place to look when a panel is empty.
function debugTab(Box, Text, S, now) {
  const ev = [trow(Box, Text, [head('event', 16, false, true), head('count', 7, true), head('last', 12, true)])]
  const rows = Object.entries(S.dbg || {}).sort((a, b) => b[1].last - a[1].last)
  for (const [name, r] of rows) ev.push(trow(Box, Text, [{ t: name, w: 16, flex: true }, { t: r.n, w: 7, right: true }, { t: fmtMs(now - r.last) + ' ago', w: 12, right: true, dim: true }]))
  if (!rows.length) ev.push(T(Text, 'no events yet: send a message. If this stays empty, hooks are not firing in this app.', { color: 'yellow', wrap: 'wrap' }))
  const st = [
    note(Text, 'context ' + JSON.stringify(S.ctx) + ' · limits ' + S.limits.length + ' · cost ' + (S.cost ? '$' + S.cost.usd : 'none')),
    note(Text, 'workspace ' + (S.cwd || 'unknown') + ' · account ' + (S.account || 'unknown')),
    note(Text, 'steps ' + S.steps.length + ' · tools ' + Object.keys(S.tools).length + ' · files ' + Object.keys(S.files).length + ' · agents ' + Object.keys(S.agents).length + ' · cache ttl ' + S.ttlMin + 'm main / ' + S.ttlSubMin + 'm sub (' + S.ttlSource + ')'),
  ]
  return [card(Box, Text, 'Events seen by the recorder', ev), card(Box, Text, 'State', st)]
}

// ---------- trace: the waterfall ----------
// One row per span: a label column (a Button: press to select, press a parent to open or close it) and a track where
// the bar is three flex boxes (the gap before it, the bar, the rest) sized in permille of the trace's length. No widths
// are estimated, so the same tree lines up on the terminal and on Desktop.
const GLYPH = { turn: '◆', agent: '◇', llm: '✦', tool: '▸' }
const BAR = { turn: 'gray', agent: 'gray', llm: 'magenta', tool: 'cyan' }
const KIND = { turn: 'prompt', agent: 'subagent', llm: 'model call', tool: 'tool call' }
const STATE = { run: 'running', ok: 'done', err: 'failed', abort: 'stopped' }
const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000)
const MAX_ROWS = 80
const money = (S, c) => (c >= 0.001 ? (S.account === 'api' ? '$' : '≈$') + (c >= 0.01 ? c.toFixed(2) : c.toFixed(3)) : '')
const tickLabel = (ms) => (ms < 60000 ? ms / 1000 + 's' : Math.floor(ms / 60000) + 'm' + (ms % 60000 ? (ms % 60000) / 1000 + 's' : ''))
const cut = (s, n) => (n <= 0 ? '' : s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s)

function spanName(S, sp) {
  if (sp.k === 'turn') return [sp.n || (sp.p ? 'woken by its subagents' : 'continued'), '']
  if (sp.k === 'agent') {
    const a = S.agents[sp.a]
    const step = a && a.stepTotal ? 'step ' + a.stepDone + '/' + a.stepTotal : ''
    return [sp.n || 'subagent', [step, sp.d, sp.m && shortModel(sp.m)].filter(Boolean).join(' · ')]
  }
  if (sp.k === 'llm') return ['model call', sp.m ? shortModel(sp.m) : '']
  const d = sp.d && sp.d.startsWith('/') ? showPath(S.cwd, sp.d).t : sp.d || ''
  return [String(sp.n).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, ''), d.replace(/\s+/g, ' ')]
}

function traceTab(Box, Text, S, now, cols, Button, ctl = { open: {} }) {
  const roots = traceRoots(S)
  if (!roots.length) return [note(Text, 'No trace yet. Each prompt you send starts one: its model calls, tool calls and subagents, on one time axis.')]
  const latest = roots[roots.length - 1]
  const root = (ctl.root && S.spans[ctl.root]) || latest
  const idx = roots.indexOf(root)
  const { all, kids, end } = traceTree(S, root.id, now)
  const T0 = root.t0
  const span = Math.max(1000, end[root.id] - T0)
  const pm = (ms) => Math.max(0, Math.min(1000, Math.round((ms / span) * 1000)))
  const leaves = all.filter((s) => (s.k === 'llm' || s.k === 'tool') && s.t1 !== null)
  const slowest = leaves.length >= 3 ? leaves.reduce((a, b) => (b.t1 - b.t0 > a.t1 - a.t0 ? b : a)) : null
  const agents = all.filter((s) => s.k === 'agent').length
  const isOpen = (s) => ctl.open[s.id] ?? (s.k === 'turn' || (s.k === 'agent' && agents <= 4 && (kids[s.id] || []).length <= 12))
  const live = all.some((s) => s.st === 'run')
  const errs = all.filter((s) => s.st === 'err').length
  const L = cols >= 90 ? 40 : 22 // the label column

  // Header: what the trace was, where it stands, paging between traces.
  const status = live ? ['● live', 'cyan'] : root.st === 'abort' ? ['stopped', 'yellow'] : errs ? ['done, ' + errs + ' failed', 'red'] : ['done', 'green']
  const nav = []
  if (Button && idx > 0) nav.push(Button({ key: 'trace-prev', label: '◀', plain: true, onPress: () => ctl.show(roots[idx - 1].id) }))
  nav.push(T(Text, 'trace ' + (idx + 1) + ' of ' + roots.length, { dim: true }))
  if (Button && idx < roots.length - 1) nav.push(Button({ key: 'trace-next', label: '▶', plain: true, onPress: () => ctl.show(roots[idx + 1].id) }), Button({ key: 'trace-latest', label: 'latest', plain: true, onPress: () => ctl.show(null) }))
  // Filter: running or failed spans only, each with the parents that lead to it.
  const want = { running: 'run', failed: 'err' }[ctl.filter]
  const keep = {}
  const mark = (sp) => (keep[sp.id] = (kids[sp.id] || []).map(mark).some(Boolean) || sp.st === want)
  if (want) mark(root)
  const filters = Button
    ? ['all', 'running', 'failed'].map((f) => Button({ key: 'filter-' + f, label: f, plain: true, dimColor: (ctl.filter || 'all') !== f, onPress: () => ctl.setFilter(f) }))
    : []
  const head = Box({
    flexDirection: 'row',
    columnGap: 1,
    children: [T(Text, 'Trace', { bold: true }), Box({ flexGrow: 1, width: 0, overflow: 'hidden', children: [T(Text, root.n || 'continued', { dim: true })] }), T(Text, status[0], { color: status[1] }), ...nav],
  })
  const llm = all.filter((s) => s.k === 'llm')
  const cost = llm.reduce((a, s) => a + (s.cost || 0), 0)
  const kpi = tiles(Box, [
    tile(Box, Text, fmtMs(span), 'duration'),
    tile(Box, Text, money(S, cost) || '·', S.account === 'api' ? 'cost' : 'worth'),
    tile(Box, Text, fmtTok(llm.reduce((a, s) => a + (s.tok || 0), 0)), 'tokens'),
    tile(Box, Text, llm.length, 'model calls'),
    tile(Box, Text, all.filter((s) => s.k === 'tool').length, 'tool calls'),
    tile(Box, Text, errs, 'errors', errs ? 'red' : undefined),
  ])

  // The time axis: a label at each round step.
  const step = TICKS.find((s) => span / s <= Math.max(2, Math.floor((cols - L) / 9))) || TICKS[TICKS.length - 1]
  const ticks = []
  for (let at = 0; at < span; at += step) ticks.push(Box({ width: 0, flexGrow: Math.max(1, pm(Math.min(step, span - at))), overflow: 'hidden', children: [T(Text, tickLabel(at), { dim: true })] }))
  const axis = Box({ flexDirection: 'row', children: [Box({ width: L, flexShrink: 0, children: [T(Text, 'span', { dim: true, bold: true })] }), Box({ flexDirection: 'row', flexGrow: 1, width: 0, minWidth: 10, children: ticks })] })

  const rows = []
  let hidden = 0
  const row = (sp, depth) => {
    if (rows.length >= MAX_ROWS) {
      hidden++
      return
    }
    if (want && !keep[sp.id] && sp !== root) return
    const ch = (kids[sp.id] || []).filter((k) => !want || keep[k.id])
    const open = ch.length > 0 && isOpen(sp)
    const [name, detail] = spanName(S, sp)
    const lead = ch.length ? (open ? '▾ ' : '▸ ') : '  '
    const room = L - 1 - 2 * depth - lead.length - 2
    const n = cut(name, room)
    const d = cut(detail, room - n.length - 1)
    const sel = ctl.sel === sp.id
    const label = [T(Text, lead, { dim: true }), T(Text, GLYPH[sp.k] + ' ', { color: sp.st === 'err' ? 'red' : BAR[sp.k] === 'gray' ? undefined : BAR[sp.k] }), T(Text, n, { bold: sp.k === 'turn' || sp.k === 'agent' || sel, color: sel ? 'blue' : undefined })]
    if (d) label.push(T(Text, ' ' + d, { dim: true }))
    const press = () => ctl.press(sp.id, open, ch.length > 0)
    const cell = Box({ width: L, flexShrink: 0, overflow: 'hidden', paddingLeft: 2 * depth, children: [Button ? Button({ key: 'sp-' + sp.id, plain: true, onPress: press, children: label }) : Box({ flexDirection: 'row', children: label })] })

    const t1 = sp.k === 'llm' || sp.k === 'tool' ? sp.t1 ?? now : end[sp.id]
    const dur = t1 - sp.t0
    const color = sp.st === 'err' ? 'red' : BAR[sp.k]
    const c = sp.k === 'llm' ? sp.cost || 0 : sp.k === 'agent' || sp.k === 'turn' ? all.filter((x) => x.k === 'llm' && x.t0 >= sp.t0 && isUnder(x, sp.id)).reduce((a, x) => a + (x.cost || 0), 0) : 0
    const text = fmtMs(dur) + (sp.st === 'run' ? '…' : '') + (money(S, c) ? ' · ' + money(S, c) : '')
    const tag = [T(Text, text, { dim: sp.st !== 'err', color: sp.st === 'err' ? 'red' : undefined })]
    if (sp === slowest) tag.push(T(Text, ' slowest', { color: 'yellow', bold: true }))
    const a = pm(sp.t0 - T0)
    const w = Math.max(1, pm(dur))
    const left = a + w > 700 // past 70% of the axis the label goes before the bar
    const gap = Box({ width: 0, flexGrow: a, overflow: 'hidden', flexDirection: 'row', justifyContent: 'flex-end', children: left ? [...tag, T(Text, ' ')] : [] })
    const barBox = Box({ width: 0, flexGrow: w, minWidth: 1, height: 1, backgroundColor: color })
    const rest = Box({ width: 0, flexGrow: Math.max(0, 1000 - a - w), overflow: 'hidden', flexDirection: 'row', children: left ? [] : [T(Text, ' '), ...tag] })
    rows.push(Box({ flexDirection: 'row', height: 1, children: [cell, Box({ flexDirection: 'row', flexGrow: 1, width: 0, minWidth: 10, height: 1, children: [gap, barBox, rest] })] }))
    if (open) for (const k of ch) row(k, depth + 1)
  }
  const parentOf = Object.fromEntries(all.map((s) => [s.id, s.p]))
  const isUnder = (x, id) => {
    for (let p = parentOf[x.id]; p; p = parentOf[p]) if (p === id) return true
    return false
  }
  row(root, 0)
  if (want && !keep[root.id]) rows.push(note(Text, 'nothing ' + ctl.filter + ' in this trace'))
  if (hidden) rows.push(note(Text, '+ ' + hidden + ' more rows: close a subagent to see the rest'))

  // The crew of this trace, and the plan the orchestrator posted (its tasks tick off as subagents of that name finish).
  const crew = all.filter((s) => s.k === 'agent')
  const extra = []
  if (crew.length) {
    const n = (st) => crew.filter((s) => s.st === st).length
    const parts = [crew.length + ' subagents', n('ok') + ' done', n('run') + ' running']
    if (n('err') + n('abort')) parts.push(n('err') + n('abort') + ' failed')
    extra.push(T(Text, parts.join(' · ') + ' · most at once ' + (S.peakRunning || 0), { color: n('err') ? 'yellow' : undefined, wrap: 'wrap' }))
  }
  const pl = planProgress(S)
  if (pl) {
    const done = new Set(Object.values(S.agents).filter((a) => a.status === 'completed').map((a) => a.desc.toLowerCase()))
    const tasks = S.plan.tasks.map((t) => (done.has(t.title.toLowerCase()) ? '✓ ' : '◦ ') + t.title).join('  ')
    extra.push(T(Text, 'plan ' + pl.title + ' ' + pl.done + '/' + pl.total + ':  ' + tasks, { color: pl.done === pl.total ? 'green' : 'cyan', wrap: 'wrap' }))
  }
  const out = [head, kpi, ...extra, Box({ flexDirection: 'row', columnGap: 2, children: [T(Text, 'show', { dim: true }), ...filters] }), axis, ...rows, T(Text, ' ')]
  const sel = ctl.sel && S.spans[ctl.sel] && S.spans[ctl.sel].r === root.id ? S.spans[ctl.sel] : null
  if (sel) out.push(spanCard(Box, Text, S, sel, root, end, kids, now))
  out.push(toolStats(Box, Text, S, cols))
  out.push(note(Text, '✦ model call · ▸ tool · ◇ subagent. Press a row to see it; press it again to open or close it.'))
  return out
}

// The selected span in full: what it was, how long, what it cost, its input, and its error or answer.
function spanCard(Box, Text, S, sp, root, end, kids, now) {
  const kv = (label, value, o = {}) => trow(Box, Text, [{ t: label, w: 9, dim: true }, { t: value, w: 12, flex: true, wrap: 'wrap', ...o }])
  const [name, detail] = spanName(S, sp)
  const t1 = sp.k === 'llm' || sp.k === 'tool' ? sp.t1 ?? now : end[sp.id]
  const rows = [kv('what', KIND[sp.k] + ' · ' + STATE[sp.st], { color: sp.st === 'err' ? 'red' : sp.st === 'run' ? 'cyan' : undefined }), kv('duration', fmtMs(t1 - sp.t0)), kv('started', '+' + fmtMs(sp.t0 - root.t0))]
  if (sp.m) rows.push(kv('model', shortModel(sp.m)))
  if (sp.tok) rows.push(kv('tokens', fmtTok(sp.tok) + (sp.cost ? ' · ' + money(S, sp.cost) : '')))
  if (sp.k === 'agent' || sp.k === 'turn') rows.push(kv('spans', String((kids[sp.id] || []).length)))
  if (sp.d || detail) rows.push(kv('input', sp.d || detail))
  if (sp.err) rows.push(kv('error', sp.err, { color: 'red' }))
  const a = sp.k === 'agent' && S.agents[sp.a]
  if (a && a.stepTotal) rows.push(kv('progress', 'step ' + a.stepDone + '/' + a.stepTotal + (a.stepNote ? ' · ' + a.stepNote : '')))
  if (sp.res) rows.push(kv('answer', sp.res))
  return card(Box, Text, name, rows)
}

const BODIES = { trace: traceTab, usage: usageTab, files: filesTab, debug: debugTab }

export function paneBody(Box, Text, tab, S, now, cols = 100, Button, ctl) {
  const fn = BODIES[tab] || traceTab
  return Box({ flexDirection: 'column', children: fn(Box, Text, S, now, cols, Button, ctl) })
}
