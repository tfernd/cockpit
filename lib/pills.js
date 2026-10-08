// Pill badges for the band above the prompt, and the pane header. Pure functions of state.
// A pill is a Box with a colored background and padding, holding short labels and optional mini bars.

import { paneBody as viewsPaneBody, T, bar as plainBar, fmtMs, fmtTok, mmss, shortModel, heat, cacheRemaining, cacheColor, ctxPercent, limit, agentFleet } from './views.js'
import { hitRate } from './model.js'

const fgFor = (bg) => (bg === 'yellow' || bg === 'cyan' ? 'black' : 'white')

// "2h40m", "1d7h", "12m": time until a limit resets.
export function fmtReset(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60000)
  if (m >= 1440) return Math.floor(m / 1440) + 'd' + Math.floor((m % 1440) / 60) + 'h'
  if (m >= 60) return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm'
  return m + 'm'
}

// parts: { t, bold, dim } text, or { bar: pct, w } a mini bar. Returns { w, node }.
function pill(Box, Text, bg, parts, pri) {
  const fg = fgFor(bg)
  const kids = parts.map((p) => (p.bar !== undefined ? plainBar(Box, p.bar, p.w, fg) : T(Text, p.t, { color: fg, bold: p.bold, dim: p.dim, wrap: 'truncate' })))
  const w = 2 + parts.reduce((a, p) => a + (p.bar !== undefined ? p.w : String(p.t).length), 0) + (parts.length - 1)
  return { pri, w, node: Box({ flexDirection: 'row', columnGap: 1, paddingX: 1, backgroundColor: bg, children: kids }) }
}

// All the pills the current state can show, in display order.
export function buildPills(Box, Text, S, now) {
  const out = []
  const add = (bg, parts, pri) => out.push(pill(Box, Text, bg, parts, pri))

  const p = ctxPercent(S)
  if (p !== null) {
    const parts = [{ t: 'ctx' }, { bar: p, w: 6 }, { t: p + '%', bold: true }]
    if (S.ctx.tokens) parts.push({ t: fmtTok(S.ctx.tokens) + '/' + fmtTok(S.ctx.window), dim: true })
    add(heat(p), parts, 1)
  }

  // Plan windows: subscription accounts report five_hour / seven_day; gateway or enterprise report spend_limit.
  const five = limit(S, 'five_hour')
  const week = limit(S, 'seven_day')
  const spend = limit(S, 'spend_limit')
  if (five) add(heat(five.percentUsed), [{ t: '5h' }, { bar: five.percentUsed, w: 6 }, { t: Math.round(five.percentUsed) + '%', bold: true }, { t: '⟳ ' + fmtReset(five.resetsAt), dim: true }], 2)
  if (week) add(heat(week.percentUsed), [{ t: '7d' }, { bar: week.percentUsed, w: 6 }, { t: Math.round(week.percentUsed) + '%', bold: true }, { t: '⟳ ' + fmtReset(week.resetsAt), dim: true }], 3)
  if (spend) add(heat(spend.percentUsed), [{ t: 'spend limit' }, { bar: Math.min(100, spend.percentUsed), w: 6 }, { t: Math.round(spend.percentUsed) + '%', bold: true }, ...(spend.resetsAt ? [{ t: '⟳ ' + fmtReset(spend.resetsAt), dim: true }] : [])], 2)

  // Money: this session's API-rate cost, and the month so far against an optional budget you set.
  if (S.cost && S.cost.usd > 0) add('gray', [{ t: '$' }, { t: S.cost.usd.toFixed(2), bold: true }, { t: 'session', dim: true }], 4)
  if (S.monthUsd > 0 || S.budgetUsd) {
    const parts = [{ t: 'month' }, { t: '$' + (S.monthUsd || 0).toFixed(0), bold: true }]
    let bg = 'gray'
    if (S.budgetUsd) {
      const pct = ((S.monthUsd || 0) / S.budgetUsd) * 100
      bg = heat(pct)
      parts.push({ bar: Math.min(100, pct), w: 6 }, { t: '/ $' + S.budgetUsd, dim: true }, { t: Math.round(pct) + '%', bold: true })
    }
    add(bg, parts, 4)
  }

  const rem = cacheRemaining(S, now)
  if (rem !== null) {
    const last = S.steps[S.steps.length - 1]
    const col = rem > 0 ? cacheColor(rem) : 'red'
    const parts = [{ t: 'cache' }, { bar: rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0, w: 5 }, { t: rem > 0 ? mmss(rem) : 'cold', bold: true }]
    if (last) parts.push({ t: hitRate(last.read, last.wrote, last.fresh) + '% hit', dim: true })
    add(col, parts, 5)
  }

  const c = S.curTurn
  if (c || S.turns) {
    const tools = c ? S.toolCalls - c.tools0 : S.lastTurn ? S.lastTurn.tools : 0
    const fails = c ? S.fails - c.fails0 : S.lastTurn ? S.lastTurn.fails : 0
    const parts = [{ t: c ? 'turn ' + (S.turns + 1) : 'turn ' + S.turns, bold: true }, { t: tools + ' tools', dim: true }]
    if (fails) parts.push({ t: fails + ' failed', bold: true })
    add(fails ? 'red' : c ? 'blue' : 'gray', parts, 6)
  }

  const f = agentFleet(S)
  if (f.total) {
    const parts = [{ t: '◆ agents' }, { bar: (f.done / f.total) * 100, w: 5 }, { t: f.done + '/' + f.total, bold: true }]
    if (f.running) parts.push({ t: f.running + ' running', dim: true })
    if (f.failed) parts.push({ t: f.failed + ' failed', bold: true })
    add(f.failed ? 'red' : f.running ? 'magenta' : 'green', parts, 3)
  }

  if (S.todos && S.todos.total) {
    const done = S.todos.done === S.todos.total
    add(done ? 'green' : 'blue', [{ t: '✓ tasks' }, { bar: (S.todos.done / S.todos.total) * 100, w: 5 }, { t: S.todos.done + '/' + S.todos.total, bold: true }], 7)
  }
  if (S.model) add('gray', [{ t: shortModel(S.model), bold: true }], 8)
  return out
}

// Greedy row packing: pill widths + 1 cell gap. Returns the rows, or null when it needs more than maxRows.
function pack(pills, cols, maxRows) {
  const rows = [[]]
  let used = 0
  for (const p of pills) {
    const w = p.w + 1
    if (used + w > cols && rows[rows.length - 1].length) {
      rows.push([])
      used = 0
    }
    rows[rows.length - 1].push(p)
    used += w
  }
  return rows.length <= maxRows ? rows : null
}

// The band: pills in up to two rows, dropping the lowest-priority ones when the window is narrow.
export function band(Box, Text, S, now, cols = 80) {
  let pills = buildPills(Box, Text, S, now)
  if (!pills.length) return null
  let rows = pack(pills, Math.max(20, cols - 2), 2)
  while (!rows && pills.length > 1) {
    const lowest = pills.reduce((a, b) => (b.pri > a.pri ? b : a))
    pills = pills.filter((p) => p !== lowest)
    rows = pack(pills, Math.max(20, cols - 2), 2)
  }
  if (!rows) return null
  return Box({
    flexDirection: 'column',
    paddingX: 1,
    children: rows.map((r) => Box({ flexDirection: 'row', columnGap: 1, children: r.map((p) => p.node) })),
  })
}

// The pane: all pills on top of the Overview tab, then the tab's own content.
export function paneBody(Box, Text, tab, S, now) {
  const body = viewsPaneBody(Box, Text, tab, S, now)
  if (tab !== 'overview') return body
  const pills = buildPills(Box, Text, S, now)
  const plan = limit(S, 'spend_limit') ? 'gateway / enterprise (spend limit)' : limit(S, 'five_hour') || limit(S, 'seven_day') ? 'subscription (5-hour and weekly windows; cost is an API-rate estimate)' : 'unknown'
  return Box({
    flexDirection: 'column',
    children: [
      Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, rowGap: 1, children: pills.map((p) => p.node) }),
      T(Text, 'plan: ' + plan + (S.budgetUsd ? '' : ' · set a monthly budget with /cockpit budget 200'), { dim: true }),
      T(Text, ' '),
      body,
    ],
  })
}
