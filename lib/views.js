// Cockpit views: pure functions that turn state into element trees.
// Box/Text come from $.ui.resolve(e) in the hook and are passed in.
// Bars are real colored Boxes and tables are fixed-width Box cells, so they look the same in the
// terminal and in the Desktop app (whose font is proportional, so padded text would not line up).

import { mean, std, pctl, hitRate, planProgress, showPath, subCache, traceRoots, traceTree } from './model.js'
import { lanesOf, lanesSvg, laneCells, titleOf, fmtDur, tickLabel, tickStep } from './lanes.js'

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
const usageTab = (Box, Text, S, now, cols) => [...overview(Box, Text, S, now), ...cacheTab(Box, Text, S, now), toolStats(Box, Text, S, cols)]


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

const BODIES = { trace: traceTab, usage: usageTab, files: filesTab, debug: debugTab }

export function paneBody(Box, Text, tab, S, now, cols = 100, ui) {
  const fn = BODIES[tab] || traceTab
  return Box({ flexDirection: 'column', children: fn(Box, Text, S, now, cols, ui) })
}
