// Pill badges for the band above the prompt and the pane header.
// pillSpecs() says WHAT to show (pure data); Desktop draws it as an SVG (svgband.js), the terminal as colored Boxes.

import { paneBody as viewsPaneBody, T, bar as plainBar, fmtTok, fmtMs, mmss, shortModel, cacheRemaining, ctxPercent, limit, agentFleet } from './views.js'
import { hitRate, planProgress } from './model.js'
import { svgPills, LAST_ROW_MAX_GROW } from './svgband.js'

// Estimated width in px of the band's slot on Desktop (about 8px per terminal column, never under 240). Tune here.
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
  const daysLeft = Math.max(0, daysInMonth - (d.getDate() - 1) - d.getHours() / 24)
  const elapsed = Math.max(1, (Date.now() - S.monthSince) / 86400000)
  return S.monthUsd + (S.monthUsd / elapsed) * daysLeft
}

// Spec: { id, accent, icon, pri, parts: [{ t, bold, dim } | { bar: pct }] }, in display order.
export function pillSpecs(S, now) {
  const out = []
  const add = (id, accent, icon, pri, parts) => out.push({ id, accent, icon, pri, parts })

  const p = ctxPercent(S)
  if (p !== null) {
    const parts = [{ t: 'ctx', dim: true }, { bar: p }, { t: p + '%', bold: true }]
    if (S.ctx.tokens) parts.push({ t: fmtTok(S.ctx.tokens) + '/' + fmtTok(S.ctx.window), dim: true })
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
  if (week) win('7d', 'purple', 'cal', 3, '7d', week)
  if (spend) win('spend', 'orange', 'coin', 2, 'spend', spend)

  // Money, API / enterprise accounts only: on a subscription (5h / 7d windows) there is no per-token bill.
  // Two pills: what this chat cost, and the month (spent -> projected, against what is allowed).
  if (!(five || week)) {
    if (S.cost && S.cost.usd > 0) add('cost', 'gold', 'coin', 3, [{ t: 'chat', dim: true }, { t: '$' + S.cost.usd.toFixed(2), bold: true }])
    if (S.monthUsd > 0) {
      const proj = projectMonth(S)
      let allowed = S.budgetUsd || 0
      let inferred = false
      if (!allowed && spend && spend.percentUsed > 0) {
        allowed = S.monthUsd / (spend.percentUsed / 100) // the account reports a percentage, so back out the dollar limit
        inferred = true
      }
      const parts = [{ t: 'month', dim: true }, { t: '$' + S.monthUsd.toFixed(0), bold: true }]
      if (proj > S.monthUsd * 1.05) parts.push({ t: '→ ~$' + proj.toFixed(0), dim: true })
      let accent = 'gold'
      if (allowed) {
        accent = heatAccent('gold', (Math.max(S.monthUsd, proj) / allowed) * 100) // warn on where the month is heading
        parts.push({ bar: Math.min(100, (S.monthUsd / allowed) * 100) }, { t: (inferred ? '≈$' : '/$') + allowed.toFixed(0), dim: true })
      }
      add('month', accent, 'cal', 4, parts)
    }
  }

  const rem = cacheRemaining(S, now)
  if (rem !== null) {
    const last = S.steps[S.steps.length - 1]
    const parts = [{ t: 'cache', dim: true }, { bar: rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0 }, { t: rem > 0 ? mmss(rem) : 'cold', bold: true }]
    if (last) parts.push({ t: hitRate(last.read, last.wrote, last.fresh) + '%', dim: true })
    add('cache', rem > 0 ? cacheAccent(rem) : 'red', 'stack', 5, parts)
  }

  // Tokens this session: what was sent new (uncached input + cache writes), what came back, what the cache served.
  if (S.steps.length) {
    add('tokens', 'blue', 'up', 6, [{ t: 'in', dim: true }, { t: fmtTok(S.cache.fresh + S.cache.wrote), bold: true }, { t: 'out', dim: true }, { t: fmtTok(S.outTok || 0), bold: true }, { t: 'cached', dim: true }, { t: fmtTok(S.cache.read), bold: true }])
  }

  // A model or effort change shows for ten minutes, with what it cost the cache.
  const sw = S.switches[S.switches.length - 1]
  if (sw && now - sw.t < 600000) {
    const lost = sw.rewrote > 0.5 * (sw.rewrote + (sw.read || 0))
    add('switch', 'amber', 'turn', 4, [{ t: sw.kind === 'model' ? 'model →' : 'effort →', dim: true }, { t: sw.kind === 'model' ? shortModel(sw.to) : String(sw.to), bold: true }, { t: lost ? 're-cached ' + fmtTok(sw.rewrote) : 'cache kept', dim: true }])
  }

  const c = S.curTurn
  if (c || S.turns) {
    const tools = c ? S.toolCalls - c.tools0 : S.lastTurn ? S.lastTurn.tools : 0
    const fails = c ? S.fails - c.fails0 : S.lastTurn ? S.lastTurn.fails : 0
    const parts = [{ t: 'turn ' + (c ? S.turns + 1 : S.turns), bold: true }, { t: tools + ' tools', dim: true }]
    if (fails) parts.push({ t: fails + ' failed', bold: true })
    add('turn', fails ? 'red' : c ? 'blue' : 'slate', 'turn', 6, parts)
  }

  const f = agentFleet(S)
  if (f.total) {
    const parts = [{ t: 'agents', dim: true }, { bar: (f.done / f.total) * 100 }, { t: f.done + '/' + f.total, bold: true }]
    if (f.failed) parts.push({ t: f.failed + ' failed', bold: true })
    // The fleet summary only lives while work is in progress; the totals stay in the Agents tab.
    if (f.running) add('agents', f.failed ? 'red' : 'pink', 'agents', 3, parts)
    // One pill for each running agent (up to three): what it is, what it is doing, how long, how much context.
    const running = Object.values(S.agents).filter((a) => a.status === 'running').sort((a, b) => a.startedAt - b.startedAt)
    for (const a of running.slice(0, 3)) {
      const idle = a.current ? 0 : now - a.lastAt
      const stalled = idle > 120000
      // The task is what the user needs to see; generic type names like 'workflow-subagent' say nothing.
      const parts = [{ t: fitLabel(a.desc || a.type, 28), bold: true }, { t: a.current ? '▸ ' + a.current : stalled ? 'silent ' + fmtMs(idle) : 'thinking', dim: true }, { t: fmtMs(now - a.startedAt), dim: true }]
      if (a.ctx > 0) parts.push({ t: fmtTok(a.ctx) + ' ctx', dim: true })
      add('agent-' + a.id, stalled ? 'red' : 'pink', 'agents', 5, parts)
    }
    if (running.length > 3) add('agents-more', 'pink', 'agents', 6, [{ t: '+' + (running.length - 3) + ' more running', dim: true }])
  }

  const pl = planProgress(S)
  if (pl && pl.done < pl.total) add('plan', 'blue', 'check', 4, [{ t: 'plan', dim: true }, { bar: (pl.done / pl.total) * 100 }, { t: pl.done + '/' + pl.total, bold: true }, { t: pl.title, dim: true }])
  if (S.todos && S.todos.total) {
    const done = S.todos.done === S.todos.total
    add('tasks', done ? 'green' : 'blue', 'check', 7, [{ t: 'tasks', dim: true }, { bar: (S.todos.done / S.todos.total) * 100 }, { t: S.todos.done + '/' + S.todos.total, bold: true }])
  }
  return out
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

// The pane: all pills on top of the Overview tab, then the tab's own content.
export function paneBody(Box, Text, tab, S, now, cols = 100, surface, Svg) {
  const body = viewsPaneBody(Box, Text, tab, S, now)
  if (tab !== 'overview') return body
  const specs = pillSpecs(S, now)
  let pills
  const r = surface === 'desktop' && Svg ? svgPills(specs, slotPx(cols)) : null
  if (r) pills = Svg({ source: r.svg, alt: r.alt, width: r.w, height: r.h })
  else pills = boxRows(Box, packRows(specs.map((s) => boxPill(Box, Text, s)), Math.max(20, cols), Infinity), Math.max(20, cols), { rowGap: 1 })
  const plan = limit(S, 'spend_limit') ? 'gateway / enterprise (spend limit)' : limit(S, 'five_hour') || limit(S, 'seven_day') ? 'subscription (5-hour and weekly windows; cost is an API-rate estimate)' : 'unknown'
  return Box({ flexDirection: 'column', children: [pills, T(Text, 'plan: ' + plan + (S.budgetUsd ? '' : ' · set a monthly budget with /cockpit budget 200'), { dim: true }), T(Text, ' '), body] })
}
