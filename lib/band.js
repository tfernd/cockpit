// The band above the prompt: a strip of stat tiles, each a small label, a big number, one line of detail and a thin bar.
// bandTiles() says what to show (pure data); Desktop draws the tiles as one SVG, the terminal as Boxes.
// No text here changes every second: each change redraws the band, and on Desktop a redraw swaps the whole image.

import { T, bar as plainBar, fmtTok, fmtMs, mmss, cacheRemaining, ctxPercent, limit, agentFleet } from './views.js'
import { hitRate, planProgress } from './model.js'

// Healthy, getting full, about to run out: colour only says something when it needs a look.
const heat = (p) => (p >= 85 ? 'bad' : p >= 65 ? 'warn' : 'ok')
const TONE = { warn: ['#d48a12', 'yellow'], bad: ['#e5534b', 'red'] }

// "2h 40m", "1d 7h", "12m": time until a limit resets.
export function fmtReset(iso) {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60000)
  if (m >= 1440) return Math.floor(m / 1440) + 'd ' + Math.floor((m % 1440) / 60) + 'h'
  if (m >= 60) return Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'
  return m + 'm'
}

// Spent so far this month plus the average daily spend (since the tally began) over the days left.
function projectMonth(S) {
  if (!(S.monthUsd > 0) || !S.monthSince) return 0
  const d = new Date()
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
  const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
  // Only the days cockpit has actually watched count. Under three days it is a guess, so no projection.
  const elapsed = (Date.now() - Math.max(monthStart, S.monthSince)) / 86400000
  if (elapsed < 3) return 0
  return S.monthUsd + (S.monthUsd / elapsed) * Math.max(0, daysInMonth - elapsed)
}

// Tile: { id, label, value, sub, bar (0-100 or null), mark (0-100: a tick on the bar), dots ([state]), tone, color, term }.
export function bandTiles(S, now) {
  const out = []
  const add = (t) => out.push({ bar: null, mark: null, dots: null, tone: 'ok', sub: '', ...t })

  // Context: how full, and where auto-compaction will run (a tick on the bar), or how often it already has.
  const p = ctxPercent(S)
  if (p !== null) {
    const win = S.ctx.window || 0
    const at = S.compactAt && win ? Math.round((S.compactAt / win) * 100) : null
    const how = S.compactions ? 'compacted ' + S.compactions + '×' : at ? 'compacts ' + at + '%' : S.autoCompact === false ? 'no auto-compact' : ''
    add({ id: 'ctx', label: 'Context', value: p + '%', sub: [fmtTok(S.ctx.tokens || 0) + '/' + fmtTok(win), how].filter(Boolean).join(' · '), bar: p, mark: at, tone: heat(at ? (p / at) * 100 : p), color: '#5b8def', term: 'blue' })
  }

  // Cache: how long it stays warm, and whether the last call really read from it.
  const rem = cacheRemaining(S, now)
  if (rem !== null) {
    const last = S.steps[S.steps.length - 1]
    const hit = last ? hitRate(last.read, last.wrote, last.fresh) : null
    const read = !last ? 'no call yet' : last.read === 0 && last.wrote > 0 ? 'last call missed: wrote ' + fmtTok(last.wrote) : hit + '% from cache'
    const tone = rem <= 0 ? 'bad' : rem < 60000 || (hit !== null && hit < 50) ? 'warn' : 'ok'
    const value = rem <= 0 ? 'cold' : rem > 120000 ? Math.ceil(rem / 60000) + 'm' : mmss(rem) // whole minutes until the last two
    add({ id: 'cache', label: 'Cache', value, sub: (rem > 0 ? 'left · ' : 'expired · ') + read, bar: rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0, tone, color: '#1fa3b8', term: 'cyan' })
  }

  // Plan limits: subscriptions report the 5-hour and weekly windows, gateway and enterprise accounts a spend limit.
  const lim = (id, label, l, color, term) => add({ id, label, value: Math.round(l.percentUsed) + '%', sub: l.resetsAt ? 'resets in ' + fmtReset(l.resetsAt) : '', bar: Math.min(100, l.percentUsed), tone: heat(l.percentUsed), color, term })
  const five = limit(S, 'five_hour')
  const week = limit(S, 'seven_day')
  const spend = limit(S, 'spend_limit')
  if (five) lim('5h', '5-hour', five, '#2fae74', 'green')
  if (week) lim('7d', 'Week', week, '#7a6ff0', 'magenta')
  if (spend) lim('spend', 'Spend', spend, '#e08a1e', 'yellow')

  // Money, API accounts only: on a subscription nothing is billed per token.
  if (S.account === 'api' && S.cost && S.cost.usd > 0) {
    const proj = projectMonth(S)
    const month = S.monthUsd > 0 ? '$' + S.monthUsd.toFixed(0) + ' this month' + (proj > S.monthUsd * 1.05 ? ' → ~$' + proj.toFixed(0) : '') + (S.budgetUsd ? ' of $' + S.budgetUsd.toFixed(0) : '') : ''
    const share = S.budgetUsd ? (Math.max(S.monthUsd, proj) / S.budgetUsd) * 100 : null
    add({ id: 'cost', label: 'Cost', value: '$' + S.cost.usd.toFixed(2), sub: month, bar: S.budgetUsd ? Math.min(100, (S.monthUsd / S.budgetUsd) * 100) : null, tone: share ? heat(share) : 'ok', color: '#d4a012', term: 'yellow' })
  }

  // Work: who is busy (subagents, tools in flight), what finished or failed, todo and plan progress.
  const f = agentFleet(S)
  const live = Object.values(S.running).filter((r) => r.tool !== 'Agent').length
  const todo = S.todos && S.todos.total ? S.todos : null
  const pl = planProgress(S)
  if (f.total || live || S.curTurn || S.lastTurn || todo) {
    const value = f.running ? f.running + (f.running === 1 ? ' agent' : ' agents') : S.curTurn || live ? 'working' : 'idle'
    const sub = [
      !f.running && !S.curTurn && !live && S.lastTurn ? 'last turn ' + fmtMs(S.lastTurn.ms) : '',
      f.total ? f.done + ' done' + (f.failed ? ', ' + f.failed + ' failed' : '') : '',
      live ? live + (live === 1 ? ' tool' : ' tools') + ' running' : '',
      todo ? 'todo ' + todo.done + '/' + todo.total : '',
      pl ? 'plan ' + pl.done + '/' + pl.total : '',
    ]
      .filter(Boolean)
      .join(' · ')
    const agents = Object.values(S.agents).sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
    add({ id: 'work', label: 'Work', value, sub, bar: todo ? (todo.done / todo.total) * 100 : null, dots: !todo && agents.length ? agents.slice(-30).map((a) => a.status) : null, tone: f.failed ? 'warn' : 'ok', color: '#b04fd1', term: 'magenta' })
  }
  return out
}

// ---------- Desktop: one SVG ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// Text width at a font size: the SVG has no layout engine, so labels are sized from this estimate.
function textW(s, size) {
  let w = 0
  for (const ch of String(s)) w += 'il.,:;|!\' '.includes(ch) ? 0.3 : 'mwMW%@'.includes(ch) ? 0.85 : ch >= 'A' && ch <= 'Z' ? 0.68 : ch.charCodeAt(0) > 0x2000 ? 0.9 : 0.56
  return w * size
}
const fit = (s, px, size) => {
  let t = String(s)
  if (textW(t, size) <= px) return t
  while (t.length > 1 && textW(t + '…', size) > px) t = t.slice(0, -1)
  return px < size ? '' : t + '…'
}
const DOT = { running: '#5b8def', completed: '#9aa0a6', failed: '#e5534b', killed: '#e0a030' }

// Tiles in rows that fit the width (at least 150 px each), split by hairlines.
export function bandSvg(tiles, W) {
  const per = Math.max(1, Math.min(tiles.length, Math.floor(W / 150)))
  const TW = W / per
  const TH = 70
  const H = Math.ceil(tiles.length / per) * TH
  let s = ''
  tiles.forEach((t, i) => {
    const x = (i % per) * TW
    const y = Math.floor(i / per) * TH
    const tone = TONE[t.tone] ? TONE[t.tone][0] : null
    const px = x + 14
    const inner = TW - 28
    if (i % per) s += `<line x1="${x.toFixed(1)}" y1="${y + 10}" x2="${x.toFixed(1)}" y2="${y + TH - 10}" class="sep"/>`
    s += `<text x="${px.toFixed(1)}" y="${y + 16}" class="lb">${esc(t.label.toUpperCase())}</text>`
    s += `<text x="${px.toFixed(1)}" y="${y + 36}" class="v"${tone ? ` style="fill:${tone}"` : ''}>${esc(t.value)}</text>`
    // The detail sits on its own line under the bar: no width estimate decides where it starts.
    if (t.sub) s += `<text x="${px.toFixed(1)}" y="${y + 63}" class="sb">${esc(fit(t.sub, inner, 11.5))}</text>`
    const by = y + 44
    if (t.bar !== null) {
      const c = tone || t.color
      const fw = Math.max(0, Math.min(100, t.bar)) / 100 * inner
      s += `<rect x="${px.toFixed(1)}" y="${by}" width="${inner.toFixed(1)}" height="4" rx="2" fill="${c}" fill-opacity=".18"/>`
      if (fw > 0) s += `<rect x="${px.toFixed(1)}" y="${by}" width="${Math.max(fw, 4).toFixed(1)}" height="4" rx="2" fill="${c}"/>`
      if (t.mark) {
        const mx = px + (Math.min(100, t.mark) / 100) * inner
        s += `<line x1="${mx.toFixed(1)}" y1="${by - 3}" x2="${mx.toFixed(1)}" y2="${by + 7}" class="mk"/>`
      }
    } else if (t.dots) {
      t.dots.forEach((st, k) => {
        const dx = px + k * 9
        if (dx + 6 <= px + inner) s += `<rect x="${dx.toFixed(1)}" y="${by - 1}" width="6" height="6" rx="1.5" fill="${DOT[st] || DOT.completed}"/>`
      })
    }
  })
  const css = 'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.lb{font-size:10.5px;letter-spacing:.07em;fill:#7b8089;font-weight:600}.v{font-size:17px;font-weight:600;fill:#1d2129}.sb{font-size:11.5px;fill:#6b7078}.sep{stroke:#8b8f98;stroke-opacity:.25}.mk{stroke:#1d2129;stroke-width:1.5}@media (prefers-color-scheme:dark){.v{fill:#e8e9ec}.sb{fill:#a2a6ad}.lb{fill:#9a9ea6}.mk{stroke:#e8e9ec}}'
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${css}</style>${s}</svg>`, h: H }
}

// ---------- terminal: Boxes ----------
// The same tiles side by side (as many as fit at 22 columns each): label, value with its detail, a bar.
function termTiles(Box, Text, tiles, cols) {
  const per = Math.max(1, Math.min(tiles.length, Math.floor(cols / 22)))
  const tw = Math.floor((cols - (per - 1) * 2) / per)
  const rows = []
  for (let i = 0; i < tiles.length; i += per) {
    rows.push(
      Box({
        flexDirection: 'row',
        columnGap: 2,
        children: tiles.slice(i, i + per).map((t) => {
          const c = TONE[t.tone] ? TONE[t.tone][1] : t.term
          const kids = [T(Text, t.label.toUpperCase(), { dim: true, bold: true }), Box({ flexDirection: 'row', overflow: 'hidden', children: [T(Text, t.value, { bold: true, color: TONE[t.tone] ? c : undefined }), T(Text, t.sub ? ' ' + t.sub : '', { dim: true })] })]
          if (t.bar !== null) kids.push(plainBar(Box, t.bar, tw, c, 'gray'))
          return Box({ flexDirection: 'column', width: tw, flexShrink: 0, overflow: 'hidden', children: kids })
        }),
      }),
    )
  }
  return Box({ flexDirection: 'column', paddingX: 1, children: rows })
}

export function band(Box, Text, S, now, cols = 80, surface, Svg) {
  const tiles = bandTiles(S, now)
  if (!tiles.length) return null
  if (surface === 'desktop' && Svg) {
    const W = Math.max(300, (cols - 2) * 8)
    const g = bandSvg(tiles, W)
    const alt = tiles.map((t) => t.label + ' ' + t.value + (t.sub ? ' ' + t.sub : '')).join(' | ')
    return Box({ paddingX: 1, children: [Svg({ source: g.svg, alt, width: W, height: g.h })] })
  }
  return termTiles(Box, Text, tiles, Math.max(20, cols - 2))
}
