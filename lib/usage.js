// The Usage tab: what the session spends (context, plan limits, money), how the prompt cache serves it, and the tools.
// Desktop draws it as cards in one SVG, the terminal as rows of Boxes. Pure: state in, markup or elements out.
// Only functions at the top level: views.js imports this module and this one imports views.js.

import { ctxPercent, cacheRemaining, limit, fmtTok, fmtMs, mmss, shortModel, T, fbar } from './views.js'
import { hitRate, pctl, subCache, spendPace, spendPeriod } from './model.js'
import { fmtReset } from './band.js'

const P = 16 // card padding
const G = 12 // gap between cards
const CH = 92 // height of the requests chart
// Series colours as the band uses them; amber and red are kept for what needs a look.
const C = { ctx: '#5b8def', cache: '#1fa3b8', wrote: '#e0a030', fresh: '#5b8def', five: '#2fae74', week: '#7a6ff0', spend: '#e08a1e', bar: '#8a8f98' }
const TONE = { warn: ['#d48a12', 'yellow'], bad: ['#e5534b', 'red'] }
// Plan windows as ring gauges; a spend limit gets the Budget card (its month as a burn-down) instead.
const LIMITS = [['five_hour', '5-hour', C.five, 'green'], ['seven_day', 'Week', C.week, 'magenta']]
const toneOf = (p) => (p >= 85 ? 'bad' : p >= 65 ? 'warn' : null)
const fill = (tone) => (tone ? TONE[tone][0] : null)
const toolName = (n) => String(n).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
// Whole minutes until the last two: the tab only redraws when the words change.
const countdown = (ms) => (ms > 120000 ? Math.ceil(ms / 60000) + 'm' : mmss(ms))
const ago = (ms) => (ms < 60000 ? 'just now' : ms < 3600000 ? Math.floor(ms / 60000) + 'm ago' : Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm ago')
const lost = (sw) => sw.rewrote > 0.5 * (sw.rewrote + (sw.read || 0))

// What the session's money reads as: a bill only on an API account, an estimate at API rates otherwise.
function money(S) {
  const api = S.account === 'api'
  const usd = S.cost && S.cost.usd > 0 ? S.cost.usd : 0
  if (!usd) return { label: api ? 'Cost' : 'Worth', value: '·', sub: 'nothing counted yet' }
  if (api) return { label: 'Cost', value: '$' + usd.toFixed(2), sub: S.monthUsd > 0 ? 'month $' + S.monthUsd.toFixed(0) + (S.budgetUsd ? ' of $' + S.budgetUsd.toFixed(0) : '') : 'this chat' }
  return { label: 'Worth', value: '≈$' + usd.toFixed(2), sub: S.account === 'subscription' ? 'at API rates, not a bill' : 'API-rate estimate' }
}

// ---------- SVG pieces ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const r1 = (v) => Math.round(v * 10) / 10
const SIZE = { lb: 10.5, hv: 28, v: 19, tx: 12.5, sb: 11.5, ax: 10.5 }
// Text width, estimated: the SVG has no layout engine. Labels are capitals with letter spacing.
function textW(s, cls) {
  const size = SIZE[cls] || 12
  let w = 0
  for (const ch of String(s)) w += 'il.,:;|!\' '.includes(ch) ? 0.3 : 'mwMW%@'.includes(ch) ? 0.85 : ch >= 'A' && ch <= 'Z' ? 0.68 : ch.charCodeAt(0) > 0x2000 ? 0.9 : 0.56
  return w * size + (cls === 'lb' ? String(s).length * 0.07 * size : 0)
}
function fit(s, px, cls) {
  let t = String(s)
  if (textW(t, cls) <= px) return t
  while (t.length > 1 && textW(t + '…', cls) > px) t = t.slice(0, -1)
  return px < 12 ? '' : t.trimEnd() + '…'
}
// One text. `w` cuts it to that width; `unit` follows it in a smaller tspan, placed by the renderer, not by an estimate.
function txt(x, y, s, cls, o = {}) {
  const t = o.w === undefined ? String(s) : fit(s, o.w, cls)
  if (!t) return ''
  const anchor = o.end ? ' text-anchor="end"' : o.mid ? ' text-anchor="middle"' : ''
  const style = o.fill ? ` style="fill:${o.fill}"` : ''
  const unit = o.unit ? `<tspan class="u" dx="5">${esc(o.unit)}</tspan>` : ''
  return `<text x="${r1(x)}" y="${r1(y)}" class="${cls}"${anchor}${style}>${esc(t)}${unit}</text>`
}
const label = (x, y, s, w, o = {}) => txt(x, y, s.toUpperCase(), 'lb', { w, ...o })

// A thin rounded bar on a track tinted with its own colour.
function meter(x, y, w, pct, color, h = 6) {
  const f = (Math.max(0, Math.min(100, pct)) / 100) * w
  let s = `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${h}" rx="${h / 2}" fill="${color}" fill-opacity=".18"/>`
  if (f > 0) s += `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(Math.max(f, h))}" height="${h}" rx="${h / 2}" fill="${color}"/>`
  return s
}

// A ring gauge, filled clockwise from the top.
function ring(cx, cy, r, pct, color, sw = 7) {
  const c = 2 * Math.PI * r
  const d = (Math.max(0, Math.min(100, pct)) / 100) * c
  let s = `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" fill="none" stroke="${color}" stroke-opacity=".18" stroke-width="${sw}"/>`
  if (d > 0) s += `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${r1(d)} ${r1(c)}" transform="rotate(-90 ${r1(cx)} ${r1(cy)})"/>`
  return s
}

// Thin columns, the latest at the right, each a stack of parts ({ v, color, op }) scaled to `max`.
// Returns the markup and each column's centre and top, for marks drawn over them.
function columns(x, y, w, h, items, max) {
  const slot = Math.min(28, w / Math.max(1, items.length))
  const bw = Math.max(2, Math.min(10, slot * 0.62))
  let s = ''
  const at = []
  items.forEach((it, i) => {
    const cx = x + w - (items.length - i) * slot + slot / 2
    let top = y + h
    for (const p of it.parts) {
      const ph = max > 0 ? (p.v / max) * h : 0
      if (ph < 0.5) continue
      const gap = top < y + h ? 1 : 0 // a hairline of air between stacked parts
      const hh = Math.max(1, ph - gap)
      top -= ph
      s += `<rect x="${r1(cx - bw / 2)}" y="${r1(top)}" width="${r1(bw)}" height="${r1(hh)}" rx="${r1(Math.min(2, bw / 2))}" fill="${p.color}"${p.op ? ` fill-opacity="${p.op}"` : ''}/>`
    }
    at.push({ cx, top })
  })
  return { svg: s, at }
}

// ---------- cards: { span (1 or 2 columns), make(w) -> { h, draw(x, y, h) } } ----------
function ctxCard(S) {
  const p = ctxPercent(S)
  const win = (S.ctx && S.ctx.window) || 0
  const tok = (S.ctx && S.ctx.tokens) || 0
  const at = p !== null && S.compactAt && win ? Math.round((S.compactAt / win) * 100) : null
  const tone = p === null ? null : toneOf(at ? (p / at) * 100 : p)
  const lines = []
  if (at) lines.push([fmtTok(Math.max(0, S.compactAt - tok)) + ' to go before auto-compact at ' + at + '%'])
  else if (S.autoCompact === false) lines.push(['auto-compact is off'])
  if (S.compactions) lines.push(['compacted ' + S.compactions + '× this chat'])
  return {
    span: 1,
    make: (w) => ({
      h: p === null ? 74 : 96 + lines.length * 18,
      draw(x, y) {
        const x0 = x + P
        const iw = w - 2 * P
        let s = label(x0, y + 24, 'Context', iw)
        if (p === null) return s + txt(x0, y + 50, 'no reading yet: it comes with the first reply', 'sb', { w: iw })
        s += txt(x0, y + 58, p + '%', 'hv', { fill: fill(tone) })
        s += txt(x0 + iw, y + 58, fmtTok(tok) + ' of ' + fmtTok(win) + ' tokens', 'sb', { end: true, w: iw - 90 })
        s += meter(x0, y + 70, iw, p, fill(tone) || C.ctx)
        if (at) {
          // Where auto-compaction runs: a notch over the bar.
          const mx = x0 + (Math.min(100, at) / 100) * iw
          s += `<line x1="${r1(mx)}" y1="${y + 66}" x2="${r1(mx)}" y2="${y + 80}" class="mk"/><path d="M${r1(mx - 4)} ${y + 61} h8 l-4 5 z" class="mkf"/>`
        }
        lines.forEach(([l, c], i) => (s += txt(x0, y + 100 + i * 18, l, 'sb', { w: iw, fill: c })))
        return s
      },
    }),
  }
}

function limitsCard(S, now) {
  const gauges = LIMITS.map(([kind, name, color]) => [limit(S, kind), name, color]).filter(([l]) => l)
  if (!gauges.length) return null
  return {
    span: 1,
    make: (w) => {
      const iw = w - 2 * P
      const cw = iw / gauges.length
      const r = Math.max(20, Math.min(32, cw / 2 - 12))
      return {
        h: 44 + 2 * r + 52,
        draw(x, y) {
          let s = label(x + P, y + 24, 'Plan limits', iw)
          gauges.forEach(([l, name, color], i) => {
            const cx = x + P + cw * i + cw / 2
            const cy = y + 42 + r
            const pct = Math.round(l.percentUsed)
            const tone = toneOf(l.percentUsed)
            s += ring(cx, cy, r, pct, fill(tone) || color)
            s += txt(cx, cy + 6, pct + '%', 'v', { mid: true, fill: fill(tone) })
            s += txt(cx, cy + r + 24, name, 'tx', { mid: true, w: cw - 8 })
            if (l.resetsAt) {
              const when = fmtReset(l.resetsAt, now)
              s += txt(cx, cy + r + 41, textW('resets in ' + when, 'sb') <= cw - 8 ? 'resets in ' + when : when, 'sb', { mid: true, w: cw - 8 })
            }
          })
          return s
        },
      }
    },
  }
}

function cacheCard(S, now) {
  const rem = cacheRemaining(S, now)
  const last = S.steps[S.steps.length - 1]
  const lastHit = last ? hitRate(last.read, last.wrote, last.fresh) : null
  const missed = last && last.read === 0 && last.wrote > 0
  const tone = rem === null ? null : rem <= 0 ? 'bad' : rem < 60000 || missed ? 'warn' : null
  const sc = subCache(S, now)
  const subs = Object.values(S.agents).filter((a) => a.stepAt).sort((a, b) => (a.n ?? 0) - (b.n ?? 0))
  const overall = hitRate(S.cache.read, S.cache.wrote, S.cache.fresh)
  const switches = S.switches.slice(-3).reverse()
  return {
    span: 2,
    make: (w) => {
      const iw = w - 2 * P
      const chart = S.steps.length > 0 // no requests yet: the countdowns say so, no empty chart
      const side = chart && iw >= 560 // room for the chart beside the countdowns
      const lw = side ? Math.min(300, Math.round(iw * 0.34)) : iw
      const per = Math.max(1, Math.floor((lw + 3) / 10)) // subagent dots per row
      const shown = subs.slice(-per * 2)
      const dotRows = Math.ceil(shown.length / per)
      const subTop = 124
      const leftH = subTop + 14 + dotRows * 10 + (dotRows ? 14 : 8)
      const cx0 = side ? lw + 32 : 0 // the chart, relative to the card's inner left
      const cw = iw - cx0
      const cy0 = side ? 0 : leftH + 10
      const legend = [[C.cache, 'cache read'], [C.wrote, 'cache write'], [C.fresh, 'uncached']]
      const marked = S.steps.length && switches.length
      if (marked) legend.push([null, 'switch'])
      const lcols = Math.max(1, Math.min(legend.length, Math.floor(cw / 96)))
      const chartH = chart ? 40 + CH + 32 + Math.ceil(legend.length / lcols) * 18 : 0
      const top = Math.max(leftH, cy0 + chartH)
      const stack = iw < 480 // a switch's result goes under it, not beside it
      const h = top + (switches.length ? 34 + switches.length * (stack ? 36 : 20) - (stack ? 16 : 0) : 0) + 10
      return {
        h,
        draw(x, y) {
          const x0 = x + P
          let s = label(x0, y + 24, 'Cache', lw - 80)
          s += txt(x0 + lw, y + 24, S.ttlMin + ' min window', 'sb', { end: true })
          if (rem === null) s += txt(x0, y + 54, 'no request yet', 'sb')
          else {
            s += txt(x0, y + 58, rem > 0 ? countdown(rem) : 'cold', 'hv', { fill: fill(tone), unit: rem > 0 ? 'left' : 'expired' })
            s += meter(x0, y + 70, lw, rem > 0 ? Math.round((rem / (S.ttlMin * 60000)) * 100) : 0, fill(tone) || C.cache)
            const said = !last ? 'no call yet' : missed ? 'last call missed: wrote ' + fmtTok(last.wrote) : 'last call ' + lastHit + '% from cache'
            s += txt(x0, y + 94, said, 'sb', { w: lw, fill: missed ? TONE.warn[0] : null })
          }
          // Subagents: one dot each, filled while its own cache is warm.
          const sy = y + subTop
          s += label(x0, sy, 'Subagents', lw - 110)
          s += txt(x0 + lw, sy, sc.seen ? sc.warm + ' of ' + sc.seen + ' warm' : 'none yet', 'sb', { end: true })
          shown.forEach((a, i) => {
            const warm = now - a.stepAt < sc.win
            s += `<rect x="${r1(x0 + (i % per) * 10)}" y="${r1(sy + 10 + Math.floor(i / per) * 10)}" width="7" height="7" rx="2" fill="${warm ? C.cache : C.bar}" fill-opacity="${warm ? 1 : 0.35}"/>`
          })
          const ny = sy + 14 + dotRows * 10 + (dotRows ? 10 : 6)
          s += txt(x0, ny, sc.next ? 'next cools in ' + countdown(sc.next) : sc.seen ? 'all cold: the next call of each rewrites its cache' : 'each keeps its own ' + S.ttlSubMin + ' min cache', 'sb', { w: lw })
          if (chart) s += requests(S, now, x0 + cx0, y + cy0, cw, legend, lcols, switches)
          if (switches.length) s += switchRows(switches, now, x0, y + top + 10, iw, stack)
          return s
        },
      }
    },
  }
}

// The main loop's recent requests as stacked columns (read / written / uncached), with the overall hit rate.
function requests(S, now, x, y, w, legend, lcols, switches) {
  let s = label(x, y + 24, 'Recent requests', w - 150)
  s += txt(x + w, y + 24, hitRate(S.cache.read, S.cache.wrote, S.cache.fresh) + '% from cache overall', 'sb', { end: true, w: 150 })
  const ct = y + 40
  const ax = 36 // room for the scale on the left
  const n = Math.min(S.steps.length, Math.floor((w - ax) / 7))
  const steps = S.steps.slice(-n)
  const max = nice(Math.max(...steps.map((st) => st.read + st.wrote + st.fresh), 1))
  s += `<line x1="${r1(x + ax)}" y1="${ct}" x2="${r1(x + w)}" y2="${ct}" class="grid"/><line x1="${r1(x + ax)}" y1="${ct + CH / 2}" x2="${r1(x + w)}" y2="${ct + CH / 2}" class="grid"/>`
  s += txt(x + ax - 6, ct + 4, fmtTok(max), 'ax', { end: true }) + txt(x + ax - 6, ct + CH / 2 + 4, fmtTok(max / 2), 'ax', { end: true })
  const col = columns(x + ax, ct, w - ax, CH, steps.map((st) => ({ parts: [{ v: st.read, color: C.cache }, { v: st.wrote, color: C.wrote }, { v: st.fresh, color: C.fresh }] })), max)
  s += col.svg + `<line x1="${r1(x + ax)}" y1="${ct + CH}" x2="${r1(x + w)}" y2="${ct + CH}" class="base"/>`
  // A switch shows over the request right after it: amber when that request had to rewrite the cache.
  for (const sw of switches) {
    const i = steps.findIndex((st) => st.t === sw.t)
    if (i >= 0) s += diamond(col.at[i].cx, col.at[i].top - 8, lost(sw) ? C.wrote : C.bar)
  }
  // Oldest and latest: each kept to its own half of the axis, so they never meet.
  const mid = x + ax + (w - ax) / 2
  if (mid - col.at[0].cx > 48) s += txt(col.at[0].cx - 4, ct + CH + 15, ago(now - steps[0].t), 'ax', { w: mid - col.at[0].cx - 4 })
  s += txt(x + w, ct + CH + 15, ago(now - steps[steps.length - 1].t), 'ax', { end: true, w: (w - ax) / 2 - 8 })
  const lw = w / lcols
  legend.forEach(([c, name], i) => {
    const lx = x + (i % lcols) * lw
    const ly = ct + CH + 38 + Math.floor(i / lcols) * 18
    s += c ? `<rect x="${r1(lx)}" y="${ly - 8}" width="9" height="9" rx="2" fill="${c}"/>` : diamond(lx + 4.5, ly - 3.5, C.bar)
    s += txt(lx + 15, ly, name, 'sb', { w: lw - 20 })
  })
  return s
}
// A round number at or above v, for the chart's scale.
const nice = (v) => {
  const e = 10 ** Math.floor(Math.log10(v))
  return [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * e).find((m) => m >= v)
}
const diamond = (cx, cy, c) => `<path d="M${r1(cx)} ${r1(cy - 4)} l4 4 l-4 4 l-4 -4 z" fill="${c}"/>`

// Model and effort switches: when, what changed, and what the next request had to write again.
function switchRows(switches, now, x, y, w, stack) {
  let s = label(x, y + 16, 'Model and effort switches', w)
  const rw = Math.min(190, w * 0.42)
  switches.forEach((sw, i) => {
    const ry = y + 38 + i * (stack ? 36 : 20)
    const kept = !lost(sw)
    const said = kept ? 'cache kept, ' + fmtTok(sw.read || 0) + ' read' : 're-cached ' + fmtTok(sw.rewrote) + ' tokens'
    s += txt(x + 62, ry, ago(now - sw.t), 'sb', { end: true })
    s += txt(x + 74, ry, sw.kind + ': ' + (sw.kind === 'model' ? shortModel(sw.from) + ' → ' + shortModel(sw.to) : sw.from + ' → ' + sw.to), 'tx', { w: stack ? w - 74 : w - 74 - rw - 10 })
    s += stack ? txt(x + 74, ry + 16, said, 'sb', { w: w - 74, fill: kept ? null : TONE.warn[0] }) : txt(x + w, ry, said, 'sb', { end: true, w: rw, fill: kept ? null : TONE.warn[0] })
  })
  return s
}

function sessionCard(S) {
  const tm = S.turnMs
  const m = money(S)
  const tiles = [
    ['Turns', String(S.turns), S.toolCalls + ' tool calls'],
    ['Turn time', tm.length ? fmtMs(pctl(tm, 50)) : '·', tm.length ? 'median · p95 ' + fmtMs(pctl(tm, 95)) : 'no turn yet'],
    [m.label, m.value, m.sub],
    ['Tokens in', fmtTok(S.cache.fresh + S.cache.wrote), 'sent or written'],
    ['Tokens out', fmtTok(S.outTok || 0), 'generated'],
    ['Cached', fmtTok(S.cache.read), 'read from cache'],
  ]
  return {
    span: 1,
    make: (w) => {
      const iw = w - 2 * P
      const tc = iw >= 420 ? 3 : 2
      const tw = iw / tc
      const ct = 52 + Math.ceil(tiles.length / tc) * 64 // the turn chart's label
      return {
        h: tm.length ? ct + 22 + 48 + 14 : ct - 6,
        draw(x, y, h) {
          const x0 = x + P
          let s = label(x0, y + 24, 'Session', iw)
          tiles.forEach(([l, v, sub], i) => {
            const tx = x0 + (i % tc) * tw
            const ty = y + 52 + Math.floor(i / tc) * 64
            s += label(tx, ty, l, tw - 12) + txt(tx, ty + 24, v, 'v', { w: tw - 12 }) + txt(tx, ty + 41, sub, 'sb', { w: tw - 12 })
          })
          if (!tm.length) return s
          // Every turn's length, the latest at the right: the chart takes whatever height the row leaves.
          const shown = tm.slice(-Math.floor(iw / 7))
          const max = Math.max(...shown, 1)
          s += label(x0, y + ct, 'Turn times', iw - 140) + txt(x0 + iw, y + ct, 'longest ' + fmtMs(max), 'sb', { end: true, w: 130 })
          const top = y + ct + 12
          const ch = Math.max(36, Math.min(140, y + h - 14 - top))
          s += columns(x0, top, iw, ch, shown.map((v, i) => ({ parts: [{ v, color: i === shown.length - 1 ? C.ctx : C.bar, op: i === shown.length - 1 ? 1 : 0.55 }] })), max).svg
          s += `<line x1="${r1(x0)}" y1="${r1(top + ch)}" x2="${r1(x0 + iw)}" y2="${r1(top + ch)}" class="base"/>`
          return s
        },
      }
    },
  }
}

function toolsCard(S) {
  const rows = Object.entries(S.tools).filter(([n]) => n !== 'Agent').sort((a, b) => b[1].n - a[1].n).slice(0, 10)
  const max = Math.max(1, ...rows.map(([, st]) => st.n))
  return {
    span: 1,
    make: (w) => ({
      h: rows.length ? 52 + (rows.length - 1) * 24 + 18 : 74,
      draw(x, y) {
        const x0 = x + P
        const iw = w - 2 * P
        // Right-aligned number columns; the bar takes what the name leaves.
        const pX = x0 + iw
        const fX = pX - 62
        const cX = fX - 42
        const nw = Math.min(130, Math.round(iw * 0.3))
        const bx = x0 + nw + 8
        const bw = Math.max(20, cX - 44 - bx)
        let s = label(x0, y + 24, 'Tools', nw)
        if (!rows.length) return s + txt(x0, y + 50, 'no tool calls yet', 'sb')
        s += label(cX, y + 24, 'calls', 40, { end: true }) + label(fX, y + 24, 'fail', 36, { end: true }) + label(pX, y + 24, 'p95', 50, { end: true })
        rows.forEach(([name, st], i) => {
          const ry = y + 52 + i * 24
          s += txt(x0, ry, toolName(name), 'tx', { w: nw })
          const len = Math.max(6, (st.n / max) * bw)
          s += `<rect x="${r1(bx)}" y="${ry - 8}" width="${r1(len)}" height="6" rx="3" fill="${C.bar}" fill-opacity=".55"/>`
          // The failed share, at the end of the bar.
          if (st.fail) s += `<rect x="${r1(bx + len - Math.max(6, (st.fail / st.n) * len))}" y="${ry - 8}" width="${r1(Math.max(6, (st.fail / st.n) * len))}" height="6" rx="3" fill="${TONE.bad[0]}"/>`
          s += txt(cX, ry, st.n, 'tx num', { end: true })
          s += txt(fX, ry, st.fail || '·', 'tx num', { end: true, fill: st.fail ? TONE.bad[0] : null })
          s += txt(pX, ry, st.durs.length ? fmtMs(pctl(st.durs, 95)) : '·', 'tx num', { end: true })
        })
        return s
      },
    }),
  }
}

// ---------- budget (gateway and enterprise accounts) ----------
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const day = (t) => { const d = new Date(t); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate() }

// The spend limit in words, shared by the card, the terminal and the alt text. The server's % counts every chat and
// machine; with the amount set (/cockpit budget 250) it reads in dollars. Amber well ahead of an even pace, red past the limit.
function budgetOf(S, now) {
  const l = limit(S, 'spend_limit')
  if (!l) return null
  const b = S.budgetUsd || 0
  const pct = l.percentUsed
  const { frac, proj } = spendPace(l, now)
  const fmt = (p) => (b ? '$' + Math.round((p / 100) * b) : Math.round(p) + '%')
  const tone = pct >= 100 || (proj && proj > 100) ? 'bad' : frac !== null && pct > frac * 100 + 10 ? 'warn' : null
  return {
    l, pct, frac: frac ?? 0, proj, tone, set: !!b, fmt,
    value: fmt(pct),
    of: b ? (pct > 100 ? '(' + Math.round(pct) + '%) of $' + b : 'of $' + b) : 'of the limit',
    pace: proj ? 'on pace for ' + fmt(proj) : '',
    left: l.resetsAt ? fmtReset(l.resetsAt, now) : '',
  }
}

// The month as a burn-down: what was spent (the readings every chat recorded), the even pace, the limit, and where the
// month ends at the pace so far.
function budgetCard(S, now) {
  const bud = budgetOf(S, now)
  if (!bud || !bud.l.resetsAt) return null
  return {
    span: 2,
    make: (w) => ({
      h: w < 560 ? 320 : 178, // narrow: the figures above a full-width chart
      draw(x, y, h) {
        const color = fill(bud.tone) || C.spend
        const stack = w < 560
        const LW = stack ? w - 2 * P : Math.min(230, w * 0.32)
        let s = label(x + P, y + 24, 'Budget this month', LW)
        s += txt(x + P, y + 62, bud.value, 'hv', { fill: fill(bud.tone), unit: bud.of })
        s += txt(x + P, y + 86, bud.pace || 'too early to project', 'tx', { w: LW, fill: fill(bud.tone) })
        s += txt(x + P, y + 106, bud.left ? 'resets in ' + bud.left : '', 'sb', { w: LW })
        s += txt(x + P, y + 124, Math.round(bud.frac * 100) + '% of the month gone', 'sb', { w: LW })
        if (!bud.set) s += txt(x + P, y + 146, '/cockpit budget 250 for dollars', 'sb', { w: LW })
        // the chart: time across the period, spend up to the limit (or past it)
        const { start, end } = spendPeriod(bud.l.resetsAt)
        const x0 = stack ? x + P : x + P + LW + 18
        const x1 = x + w - P - 44
        const y0 = stack ? y + (bud.set ? 150 : 170) : y + 28
        const y1 = y + h - 30
        const top = Math.max(100, bud.proj || 0, bud.pct) * 1.08
        const X = (t) => x0 + ((Math.min(Math.max(t, start), end) - start) / (end - start)) * (x1 - x0)
        const Y = (p) => y1 - (p / top) * (y1 - y0)
        for (const p of [0, 50, 100]) {
          s += `<line x1="${r1(x0)}" y1="${r1(Y(p))}" x2="${r1(x1)}" y2="${r1(Y(p))}" class="${p === 0 ? 'base' : 'grid'}"${p === 100 ? ' stroke-dasharray="4 3"' : ''}/>`
          s += txt(x1 + 6, Y(p) + 4, bud.fmt(p), 'ax')
        }
        // a date a week apart, or two weeks when a week is too narrow for its label
        const wk = (X(start + 7 * 86400000) - X(start)) < 56 ? 14 : 7
        for (let t = start; t <= end; t += wk * 86400000) s += txt(X(t), y1 + 18, day(t), 'ax', { mid: true })
        // even pace: nothing at the start, the whole limit at the reset
        s += `<line x1="${r1(X(start))}" y1="${r1(Y(0))}" x2="${r1(X(end))}" y2="${r1(Y(100))}" stroke="#8b8f98" stroke-opacity=".7" stroke-dasharray="2 4"/>`
        // what was spent, as recorded; the first reading may come mid-month (cockpit records from when it is loaded)
        const pts = ((S.spendHist && S.spendHist.resetsAt === bud.l.resetsAt && S.spendHist.points) || []).filter(([t]) => t <= now)
        const line = [...pts, [now, bud.pct]].map(([t, p]) => r1(X(t)) + ',' + r1(Y(p)))
        if (line.length > 1) s += `<polygon points="${r1(X(pts[0][0]))},${r1(Y(0))} ${line.join(' ')} ${r1(X(now))},${r1(Y(0))}" fill="${color}" fill-opacity=".14"/><polyline points="${line.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>`
        // where the month ends at this pace
        if (bud.proj) s += `<line x1="${r1(X(now))}" y1="${r1(Y(bud.pct))}" x2="${r1(X(end))}" y2="${r1(Y(bud.proj))}" stroke="${color}" stroke-width="1.5" stroke-dasharray="5 4"/>` + `<circle cx="${r1(X(end))}" cy="${r1(Y(bud.proj))}" r="3" fill="${color}"/>`
        s += `<circle cx="${r1(X(now))}" cy="${r1(Y(bud.pct))}" r="4" fill="${color}"/>`
        if (pts.length < 2) s += txt(x0 + 6, y0 + 10, 'the line fills in as you work: every chat records each reading', 'sb', { w: x1 - x0 - 12 })
        return s
      },
    }),
  }
}

const CSS =
  'text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.card{fill:#8b8f98;fill-opacity:.075}' +
  '.lb{font-size:10.5px;letter-spacing:.07em;fill:#7b8089;font-weight:600}.hv{font-size:28px;font-weight:600;fill:#1d2129}.v{font-size:19px;font-weight:600;fill:#1d2129}' +
  '.u{font-size:13px;font-weight:500;fill:#6b7078}.tx{font-size:12.5px;fill:#2b3038}.sb{font-size:11.5px;fill:#6b7078}.ax{font-size:10.5px;fill:#8b8f98}.num{font-variant-numeric:tabular-nums}' +
  '.grid{stroke:#8b8f98;stroke-opacity:.18}.base{stroke:#8b8f98;stroke-opacity:.45}.mk{stroke:#1d2129;stroke-width:1.5}.mkf{fill:#1d2129}' +
  '@media (prefers-color-scheme:dark){.card{fill-opacity:.12}.hv,.v{fill:#e8e9ec}.tx{fill:#d4d6db}.sb,.u{fill:#a2a6ad}.lb{fill:#9a9ea6}.mk{stroke:#e8e9ec}.mkf{fill:#e8e9ec}}'

// The cards in rows: two columns from 640 px, one below. A card on its own in a row takes the whole width.
export function usageSvg(S, now, W) {
  const two = W >= 640
  const cards = [ctxCard(S), limitsCard(S, now), budgetCard(S, now), cacheCard(S, now), sessionCard(S), toolsCard(S)].filter(Boolean)
  const rows = []
  for (let i = 0; i < cards.length; i++) {
    const c = cards[i]
    const next = cards[i + 1]
    if (two && c.span === 1 && next && next.span === 1) {
      rows.push([c, next])
      i++
    } else rows.push([c])
  }
  let s = ''
  let y = 0
  for (const row of rows) {
    const w = row.length === 2 ? (W - G) / 2 : W
    const made = row.map((c) => c.make(w))
    const h = Math.max(...made.map((m) => m.h))
    made.forEach((m, i) => {
      const x = i * (w + G)
      s += `<rect x="${r1(x)}" y="${y}" width="${r1(w)}" height="${h}" rx="12" class="card"/>` + m.draw(x, y, h)
    })
    y += h + G
  }
  const H = Math.max(1, y - G)
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${CSS}</style>${s}</svg>`, h: H }
}

// What the picture says, in words: the Svg's alt text.
function usageAlt(S, now) {
  const out = []
  const p = ctxPercent(S)
  if (p !== null) out.push('Context ' + p + '% (' + fmtTok(S.ctx.tokens || 0) + ' of ' + fmtTok(S.ctx.window) + ')' + (S.compactions ? ', compacted ' + S.compactions + '×' : ''))
  for (const [kind, name] of LIMITS) {
    const l = limit(S, kind)
    if (l) out.push(name + ' ' + Math.round(l.percentUsed) + '%' + (l.resetsAt ? ', resets in ' + fmtReset(l.resetsAt, now) : ''))
  }
  const b = budgetOf(S, now)
  if (b) out.push('Budget ' + b.value + ' ' + b.of + (b.pace ? ', ' + b.pace : '') + (b.left ? ', resets in ' + b.left : ''))
  const rem = cacheRemaining(S, now)
  if (rem !== null) out.push('Cache ' + (rem > 0 ? countdown(rem) + ' left' : 'cold') + ', ' + hitRate(S.cache.read, S.cache.wrote, S.cache.fresh) + '% from cache overall')
  const sc = subCache(S, now)
  if (sc.seen) out.push('subagent caches ' + sc.warm + ' of ' + sc.seen + ' warm')
  const m = money(S)
  out.push(S.turns + ' turns · ' + m.label + ' ' + m.value + ' (' + m.sub + ')')
  const tools = Object.entries(S.tools).filter(([n]) => n !== 'Agent').sort((a, b) => b[1].n - a[1].n).slice(0, 5)
  if (tools.length) out.push('Tools: ' + tools.map(([n, st]) => toolName(n) + ' ' + st.n + (st.fail ? ' (' + st.fail + ' failed)' : '')).join(', '))
  return out.join(' · ')
}

// ---------- terminal ----------
function termTab(Box, Text, S, now, cols) {
  const out = []
  const section = (title, kids) => out.push(Box({ flexDirection: 'column', marginBottom: 1, children: [T(Text, title.toUpperCase(), { dim: true, bold: true }), ...kids] }))
  const note = (s, color) => T(Text, s, { dim: !color, color, wrap: 'wrap' })
  // Gauges share one text column, so their bars line up.
  const gauges = (list) => {
    const tw = Math.max(...list.map((g) => g.text.length))
    return list.map((g) => Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 10, flexShrink: 0, children: [T(Text, g.label, { dim: true })] }), fbar(Box, g.pct, g.color), Box({ minWidth: tw, flexShrink: 0, children: [T(Text, g.text, { color: g.tcolor })] })] }))
  }
  const tcol = (tone) => (tone ? TONE[tone][1] : undefined)

  const p = ctxPercent(S)
  if (p === null) section('Context', [note('no reading yet: it comes with the first reply')])
  else {
    const at = S.compactAt && S.ctx.window ? Math.round((S.compactAt / S.ctx.window) * 100) : null
    const tone = toneOf(at ? (p / at) * 100 : p)
    const kids = gauges([{ label: 'Context', pct: p, color: tcol(tone) || 'blue', text: p + '% · ' + fmtTok(S.ctx.tokens || 0) + ' of ' + fmtTok(S.ctx.window), tcolor: tcol(tone) }])
    if (at) kids.push(note(fmtTok(Math.max(0, S.compactAt - (S.ctx.tokens || 0))) + ' to go before auto-compact at ' + at + '%'))
    if (S.compactions) kids.push(note('compacted ' + S.compactions + '× this chat', 'yellow'))
    section('Context', kids)
  }

  const lims = LIMITS.map(([kind, name, , term]) => [limit(S, kind), name, term]).filter(([l]) => l)
  if (lims.length) section('Plan limits', gauges(lims.map(([l, name, term]) => ({ label: name, pct: l.percentUsed, color: tcol(toneOf(l.percentUsed)) || term, text: Math.round(l.percentUsed) + '%' + (l.resetsAt ? ' · resets in ' + fmtReset(l.resetsAt, now) : ''), tcolor: tcol(toneOf(l.percentUsed)) }))))
  const bud = budgetOf(S, now)
  if (bud) {
    const kids = gauges([{ label: 'Budget', pct: Math.min(100, bud.pct), color: tcol(bud.tone) || 'yellow', text: bud.value + ' ' + bud.of + (bud.left ? ' · resets in ' + bud.left : ''), tcolor: tcol(bud.tone) }])
    kids.push(note((bud.pace ? bud.pace + ' · ' : '') + Math.round(bud.frac * 100) + '% of the month gone' + (bud.set ? '' : ' · /cockpit budget N for dollars'), tcol(bud.tone)))
    section('Budget this month', kids)
  }

  const cache = []
  const rem = cacheRemaining(S, now)
  const sc = subCache(S, now)
  const g = []
  if (rem !== null) {
    const last = S.steps[S.steps.length - 1]
    const tone = rem <= 0 ? 'bad' : rem < 60000 || (last && last.read === 0 && last.wrote > 0) ? 'warn' : null
    g.push({ label: 'Main', pct: rem > 0 ? (rem / (S.ttlMin * 60000)) * 100 : 0, color: tcol(tone) || 'cyan', text: (rem > 0 ? countdown(rem) + ' left' : 'expired') + ' of ' + S.ttlMin + ' min', tcolor: tcol(tone) })
  }
  if (sc.seen) g.push({ label: 'Subagents', pct: sc.next ? (sc.next / sc.win) * 100 : 0, color: sc.warm ? 'cyan' : 'red', text: sc.warm + ' of ' + sc.seen + ' warm' + (sc.next ? ' · next cools ' + countdown(sc.next) : ''), tcolor: sc.warm ? undefined : 'red' })
  if (g.length) cache.push(...gauges(g))
  if (S.steps.length) {
    // One cell per request, its height the tokens it sent: cyan when mostly read from cache, yellow when mostly written.
    const steps = S.steps.slice(-Math.max(8, cols - 13))
    const max = Math.max(...steps.map((st) => st.read + st.wrote + st.fresh), 1)
    const cells = []
    for (const st of steps) {
      const ch = '▁▂▃▄▅▆▇█'[Math.min(7, Math.round(((st.read + st.wrote + st.fresh) / max) * 7))]
      const color = st.read >= st.wrote + st.fresh ? 'cyan' : 'yellow'
      const prev = cells[cells.length - 1]
      if (prev && prev.color === color) prev.s += ch
      else cells.push({ s: ch, color })
    }
    cache.push(Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 10, flexShrink: 0, children: [T(Text, 'Requests', { dim: true })] }), Box({ flexDirection: 'row', flexShrink: 1, overflow: 'hidden', children: cells.map((c) => T(Text, c.s, { color: c.color })) })] }))
    cache.push(note(hitRate(S.cache.read, S.cache.wrote, S.cache.fresh) + '% from cache overall · cyan read from cache, yellow written to it'))
  } else cache.push(note('no request yet'))
  for (const sw of S.switches.slice(-3).reverse()) {
    const kept = !lost(sw)
    const change = sw.kind + ': ' + (sw.kind === 'model' ? shortModel(sw.from) + ' → ' + shortModel(sw.to) : sw.from + ' → ' + sw.to)
    cache.push(Box({ flexDirection: 'row', columnGap: 1, children: [Box({ minWidth: 10, flexShrink: 0, children: [T(Text, ago(now - sw.t), { dim: true })] }), Box({ flexGrow: 1, flexShrink: 1, width: 0, minWidth: 8, overflow: 'hidden', children: [T(Text, change)] }), Box({ flexShrink: 0, children: [T(Text, kept ? 'cache kept' : 're-cached ' + fmtTok(sw.rewrote) + ' tokens', { color: kept ? undefined : 'yellow', dim: kept })] })] }))
  }
  section('Cache', cache)

  const tm = S.turnMs
  const m = money(S)
  const stat = (value, l, color) => Box({ flexDirection: 'column', minWidth: 12, paddingRight: 1, children: [T(Text, value, { bold: true, color }), T(Text, l, { dim: true })] })
  section('Session', [
    Box({
      flexDirection: 'row',
      flexWrap: 'wrap',
      columnGap: 1,
      children: [
        stat(String(S.turns), 'turns'),
        stat(tm.length ? fmtMs(pctl(tm, 50)) + ' / ' + fmtMs(pctl(tm, 95)) : '·', 'turn p50 / p95'),
        stat(fmtTok(S.cache.fresh + S.cache.wrote), 'tokens in'),
        stat(fmtTok(S.outTok || 0), 'out'),
        stat(fmtTok(S.cache.read), 'cached'),
        stat(m.value, m.label.toLowerCase()),
      ],
    }),
    ...(m.value !== '·' ? [note(m.sub)] : []),
  ])

  const rows = Object.entries(S.tools).filter(([n]) => n !== 'Agent').sort((a, b) => b[1].n - a[1].n).slice(0, 10)
  const max = Math.max(1, ...rows.map(([, st]) => st.n))
  const num = (s, w, o = {}) => Box({ width: w, flexShrink: 0, justifyContent: 'flex-end', children: [T(Text, s, o)] })
  const tools = [Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 12, flexShrink: 0, children: [T(Text, 'tool', { dim: true, bold: true })] }), Box({ flexGrow: 1, minWidth: 8 }), num('calls', 5, { dim: true, bold: true }), num('fail', 4, { dim: true, bold: true }), num('p95', 7, { dim: true, bold: true })] })]
  for (const [name, st] of rows) tools.push(Box({ flexDirection: 'row', columnGap: 1, children: [Box({ width: 12, flexShrink: 0, overflow: 'hidden', children: [T(Text, toolName(name))] }), fbar(Box, (st.n / max) * 100, 'blue'), num(st.n, 5), num(st.fail || '·', 4, { color: st.fail ? 'red' : undefined, dim: !st.fail }), num(st.durs.length ? fmtMs(pctl(st.durs, 95)) : '·', 7, { bold: true })] }))
  if (!rows.length) tools.push(note('no tool calls yet'))
  section('Tools', tools)
  return out
}

// Usage: the cards. Desktop gets one SVG drawn as an image (an interactive one reloads its frame and blinks on every redraw).
export function usageTab(Box, Text, S, now, cols, ui = {}) {
  const { surface, Svg } = ui
  if (surface === 'desktop' && Svg) {
    const W = Math.max(320, cols * 8)
    const g = usageSvg(S, now, W)
    return [Svg({ source: g.svg, alt: usageAlt(S, now), width: W, height: g.h, isInteractive: false })]
  }
  return termTab(Box, Text, S, now, cols)
}
