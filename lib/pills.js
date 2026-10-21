// Pill badges for the band above the prompt and the pane header.
// pillSpecs() says WHAT to show (pure data); Desktop draws it as an SVG (svgband.js), the terminal as colored Boxes.

import { paneBody as viewsPaneBody, T, bar as plainBar, fmtTok, fmtMs, mmss, cacheRemaining, ctxPercent, limit, agentFleet } from './views.js'
import { planProgress } from './model.js'
import { svgPills, LAST_ROW_MAX_GROW } from './svgband.js'

// Estimated width in px of the band's slot on Desktop (about 8px per terminal column, never under 240). Tune here.
const normTitle = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
export const slotPx = (cols) => Math.max(240, cols * 8)

// Shortens a label to n characters with an ellipsis, so one long task name does not push the pill off the row.
const fitLabel = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s))

// Turns a percentage into an accent: the metric's own hue while healthy, amber then red as it fills.
const heatAccent = (base, pct) => (pct >= 85 ? 'red' : pct >= 65 ? 'amber' : base)
const cacheAccent = (rem) => (rem > 60000 ? 'teal' : rem > 15000 ? 'amber' : 'red')

// "2h40m", "1d7h", "12m": time until a limit resets.
export function fmtReset(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60000)
  if (m >= 1440) return Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h'
  if (m >= 60) return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
  return m + 'm'
}

// Spent so far this month plus the average daily spend (since the tally began, at least one day) over the days left.
function projectMonth(S) {
  if (!(S.monthUsd > 0) || !S.monthSince) return 0
  const d = new Date()
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  // Only the days cockpit has actually watched count. Under three days it is a guess, so no projection.
  const elapsed = (Date.now() - Math.max(monthStart, S.monthSince)) / 86400000
  if (elapsed < 3) return 0
  const daysLeft = Math.max(0, daysInMonth - elapsed)
  return S.monthUsd + (S.monthUsd / elapsed) * daysLeft
}

// Spec: { id, accent, icon, pri, parts: [{ t, bold, dim } | { bar: pct }] }, in display order.
export function pillSpecs(S, now) {
  const out = []
  const add = (id, accent, icon, pri, parts) => out.push({ id, accent, icon, pri, parts })

  const p = ctxPercent(S)
  if (p !== null) {
    // The bar and the percentage say how full it is; the window size is the one thing they do not say.
    const parts = [{ t: 'context', dim: true }, { bar: p }, { t: p + '%', bold: true }]
    if (S.ctx.window) parts.push({ t: 'of ' + fmtTok(S.ctx.window), dim: true })
    add('ctx', heatAccent('blue', p), 'ring', 1, parts)
  }

  // Plan windows: subscription accounts report five_hour / seven_day; gateway and enterprise report spend_limit.
  const five = limit(S, 'five_hour')
  const week = limit(S, 'seven_day')
  const spend = limit(S, 'spend_limit')
  const win = (id, base, icon, pri, name, l) => {
    const parts = [{ t: name, dim: true }, { bar: Math.min(100, l.percentUsed) }, { t: Math.round(l.percentUsed) + '%', bold: true }]
    if (l.resetsAt) parts.push({ t: '⟳' + fmtReset(l.resetsAt), dim: true })
    add(id, heatAccent(base, l.percentUsed), icon, pri, parts)
  }
  if (five) win('5h', 'green', 'clock', 2, '5h', five)
  if (week && (week.percentUsed >= 50 || !five)) win('7d', 'purple', 'cal', 3, '7d', week) // the week matters once it is half used
  if (spend) win('spend', 'orange', 'coin', 2, 'spend', spend)

  // Money, API / enterprise accounts only: on a subscription (5h / 7d windows) there is no per-token bill.
  // Two pills: what this chat cost, and the month (spent -> projected, against what is allowed).
  if (S.account === 'api') {
    if (S.cost && S.cost.usd > 0) add('cost', 'gold', 'coin', 3, [{ t: 'chat', dim: true }, { t: '$' + S.cost.usd.toFixed(2), bold: true }])
    if (S.monthUsd > 0) {
      const proj = projectMonth(S)
      // Only a budget the user set counts as the limit: the account reports a percentage, not dollars, and a
      // dollar figure backed out of it is wrong whenever cockpit missed some of the month's sessions.
      const allowed = S.budgetUsd || 0
      const parts = [{ t: 'month', dim: true }, { t: '$' + S.monthUsd.toFixed(0), bold: true }]
      if (proj > S.monthUsd * 1.05) parts.push({ t: '→ ~$' + proj.toFixed(0), dim: true })
      let accent = 'gold'
      if (allowed) {
        accent = heatAccent('gold', (Math.max(S.monthUsd, proj) / allowed) * 100) // warn on where the month is heading
        parts.push({ bar: Math.min(100, (S.monthUsd / allowed) * 100) }, { t: '/$' + allowed.toFixed(0), dim: true })
      }
      add('month', accent, 'cal', 4, parts)
    }
  }

  const rem = cacheRemaining(S, now)
  if (rem !== null) {
    // Whole minutes until the last two, so the pill does not change every second.
    const left = rem <= 0 ? 'cold' : rem > 120000 ? Math.ceil(rem / 60000) + 'm' : mmss(rem)
    add('cache', rem > 0 ? cacheAccent(rem) : 'red', 'stack', 5, [{ t: 'cache', dim: true }, { bar: rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0 }, { t: left, bold: true }])
  }

  // What is happening now: the newest tool in flight (and whose it is), else the turn thinking, else the last turn.
  const live = Object.values(S.running).filter((r) => r.tool !== 'Agent').sort((a, b) => a.t - b.t)
  const f = agentFleet(S)
  const secs = (ms) => (ms < 60000 ? Math.round(ms / 1000) + 's' : mmss(ms))
  if (live.length || S.curTurn || f.running) {
    const r = live[live.length - 1]
    const who = r && r.agentId && S.agents[r.agentId] ? fitLabel(S.agents[r.agentId].desc, 18) + ' · ' : ''
    const parts = [{ t: 'now', dim: true }]
    if (r) parts.push({ t: who + r.tool, bold: true }, { t: secs(now - r.t), dim: true })
    else parts.push({ t: S.curTurn ? 'thinking' : 'agents working', bold: true })
    if (!r && S.curTurn) parts.push({ t: secs(now - S.curTurn.t0), dim: true })
    if (live.length > 1) parts.push({ t: '+' + (live.length - 1) + ' tools', dim: true })
    if (f.running) parts.push({ t: f.running + (f.running === 1 ? ' agent' : ' agents'), dim: true })
    add('now', 'blue', 'bolt', 2, parts)
  } else if (S.lastTurn) {
    const parts = [{ t: 'last turn', dim: true }, { t: fmtMs(S.lastTurn.ms), bold: true }, { t: S.lastTurn.tools + ' tools', dim: true }]
    if (S.lastTurn.fails) parts.push({ t: S.lastTurn.fails + ' failed', bold: true })
    add('now', S.lastTurn.fails ? 'red' : 'slate', 'turn', 6, parts)
  }
  return arrange(out)
}

// A fixed order, so a pill never moves when another comes or goes: gauges, then now, then money.
const ORDER = ['ctx', 'cache', '5h', '7d', 'spend', 'now', 'cost', 'month']
function arrange(specs) {
  return specs.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id))
}

// ---------- terminal renderer: colored Box blocks ----------
const TERM_BG = { blue: 'blue', green: 'green', amber: 'yellow', red: 'red', purple: 'magenta', teal: 'cyan', orange: 'yellow', gold: 'yellow', slate: 'gray', pink: 'magenta' }

// `make(grow)` builds the Box; grow lets it stretch to fill its row (content centred, bars keep their size).
function boxPill(Box, Text, spec) {
  const bg = TERM_BG[spec.accent] || 'gray'
  const fg = bg === 'yellow' || bg === 'cyan' ? 'black' : 'white'
  const track = bg === 'gray' ? 'black' : 'gray'
  const kids = () => spec.parts.map((p) => (p.bar !== undefined ? plainBar(Box, p.bar, 6, fg, track) : T(Text, p.t, { color: fg, bold: p.bold, dim: p.dim })))
  const w = 2 + spec.parts.reduce((a, p) => a + (p.bar !== undefined ? 6 : String(p.t).length), 0) + (spec.parts.length - 1)
  const make = (grow) => Box({ flexDirection: 'row', columnGap: 1, paddingX: 1, backgroundColor: bg, flexGrow: grow ? 1 : 0, justifyContent: 'center', children: kids() })
  return { w, pri: spec.pri, make }
}

function packRows(items, cols, maxRows) {
  const rows = [[]]
  let used = 0
  for (const it of items) {
    const w = it.w + 1
    if (used + w > cols && rows[rows.length - 1].length) {
      rows.push([])
      used = 0
    }
    rows[rows.length - 1].push(it)
    used += w
  }
  return rows.length <= maxRows ? rows : null
}

// Rows of pills that stretch to the full width (`cols` is what packRows packed to); the last row stays natural when stretching would grow it too much (same rule as the SVG).
function boxRows(Box, rows, cols, extra = {}) {
  return Box({
    flexDirection: 'column',
    ...extra,
    children: rows.map((r, ri) => {
      const natural = r.reduce((a, i) => a + i.w, 0)
      const grow = !(ri === rows.length - 1 && (cols - 1 - (r.length - 1) - natural) / natural > LAST_ROW_MAX_GROW)
      return Box({ flexDirection: 'row', columnGap: 1, children: r.map((i) => i.make(grow)) })
    }),
  })
}

// The band: Desktop gets an SVG of rounded pills, the terminal Box blocks in up to two rows.
export function band(Box, Text, S, now, cols = 80, surface, Svg) {
  const specs = pillSpecs(S, now)
  if (!specs.length) return null
  if (surface === 'desktop' && Svg) {
    const r = svgPills(specs, slotPx(cols), 3)
    if (r) return Box({ paddingX: 1, children: [Svg({ source: r.svg, alt: r.alt, width: r.w, height: r.h })] })
  }
  let items = specs.map((s) => boxPill(Box, Text, s))
  let rows = packRows(items, Math.max(20, cols - 2), 2)
  while (!rows && items.length > 1) {
    const lowest = items.reduce((a, b) => (b.pri > a.pri ? b : a))
    items = items.filter((i) => i !== lowest)
    rows = packRows(items, Math.max(20, cols - 2), 2)
  }
  if (!rows) return null
  return boxRows(Box, rows, Math.max(20, cols - 2), { paddingX: 1 })
}

export function paneBody(Box, Text, tab, S, now, cols = 100, surface, Svg, Button, ctl) {
  return viewsPaneBody(Box, Text, tab, S, now, cols, { Button, ctl, surface, Svg })
}
