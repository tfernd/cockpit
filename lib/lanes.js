// The Trace tab as swimlanes: one lane per loop (the main session, then each subagent under the one that spawned it),
// its model calls ("thinking") and tool calls as blocks on a shared time axis. Pure: state in, data or markup out.

import { traceTree, showPath } from './model.js'

export const MAX_LANES = 24
// Lane colours, in order: the main session is grey, subagents take the rest in turn. [svg fill, terminal colour]
const PALETTE = [['#8a8f98', 'white'], ['#5b8def', 'blue'], ['#b04fd1', 'magenta'], ['#e08a1e', 'yellow'], ['#2fae74', 'green'], ['#1fa3b8', 'cyan'], ['#e0559a', 'magenta'], ['#7a6ff0', 'blue']]

export function shortModel(m) {
  return String(m || '').replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')
}
export function fmtDur(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  const s = Math.round(ms / 1000)
  return s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' : Math.floor(s / 60) + 'm ' + (s % 60) + 's'
}
const tok = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n))

// A prompt's text as a title: the engine wraps deliveries and pastes in tags.
export function titleOf(t) {
  const s = String(t || '')
  const plain = s.replace(/<[^>]*>/g, ' ').replace(/\[Subagent hand-back\]/, '').replace(/\s+/g, ' ').trim()
  return /^<agent-message/.test(s) ? 'woken by a subagent: ' + plain : plain
}

// One tool call or model call as a block of its lane, with the words its tooltip shows.
function block(S, sp, now, money, idle, ttl) {
  const t1 = sp.t1 ?? now
  const dur = fmtDur(t1 - sp.t0) + (sp.st === 'run' ? ' so far' : '')
  if (sp.k === 'llm') {
    // The cache: a miss rewrote the whole prompt (nothing read), a write added a lot to it; idle past the lifetime means it had expired.
    const read = sp.cr || 0
    const wrote = sp.cw || 0
    // A lane's first call always starts cold (a new subagent has no cache yet): that is not worth a mark.
    const first = idle === null
    const cache = sp.tok === undefined ? null : read === 0 && wrote > 0 ? (first ? 'cold' : 'miss') : wrote > read * 0.25 && wrote > 2000 && !first ? 'write' : 'hit'
    const expired = idle !== null && idle > ttl
    const words = cache === null ? '' : cache === 'cold' ? 'cold start: wrote ' + tok(wrote) + ' to the cache' : cache === 'miss' ? 'cache miss: wrote ' + tok(wrote) + (expired ? ' (expired after ' + fmtDur(idle) + ' idle)' : '') : cache === 'write' ? 'cache write: ' + tok(wrote) + ', read ' + tok(read) : 'cache hit: read ' + tok(read)
    const tip = ['Thinking', [shortModel(sp.m), sp.ef].filter(Boolean).join(' '), dur, sp.tok ? tok(sp.tok) + ' tokens' : '', money(sp.cost), words].filter(Boolean).join(' · ')
    return { t0: sp.t0, t1, kind: sp.st === 'err' ? 'err' : 'think', tip, cache }
  }
  const d = sp.d && sp.d.startsWith('/') ? showPath(S.cwd, sp.d).t : String(sp.d || '').replace(/\s+/g, ' ')
  const name = String(sp.n).replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '')
  const tip = [name + (d ? ': ' + d.slice(0, 90) : ''), dur, sp.err ? 'failed: ' + sp.err : ''].filter(Boolean).join(' · ')
  return { t0: sp.t0, t1, kind: sp.st === 'err' ? 'err' : 'tool', tip }
}

// The lanes of one trace: { T0, T1, lanes: [{ id, name, sub, color, term, depth, t0, t1, from, blocks, live, failed }], hidden }.
export function lanesOf(S, rootId, now) {
  const { all, kids, end } = traceTree(S, rootId, now)
  const root = S.spans[rootId]
  const money = (c) => (c >= 0.001 ? (S.account === 'api' ? '$' : '≈$') + (c >= 0.01 ? c.toFixed(2) : c.toFixed(3)) : '')
  const lanes = []
  // A loop's own work: the spans under it that are not inside a nested subagent (turns of the main loop count as its own).
  const own = (id, out = []) => {
    for (const k of kids[id] || []) {
      if (k.k === 'llm' || k.k === 'tool') out.push(k)
      else if (k.k === 'turn') own(k.id, out)
    }
    return out
  }
  const agentsUnder = (id, out = []) => {
    for (const k of kids[id] || []) {
      if (k.k === 'agent') out.push(k)
      else if (k.k === 'turn') agentsUnder(k.id, out)
    }
    return out
  }
  const mainModel = (own(rootId).find((s) => s.k === 'llm') || {}).m
  const add = (sp, depth, from) => {
    const c = PALETTE[lanes.length % PALETTE.length]
    const isMain = sp.id === rootId
    // Time since the lane's previous model call, against its cache lifetime (main and subagents have their own).
    const ttl = (isMain ? S.ttlMin : S.ttlSubMin) * 60000
    let lastEnd = null
    const blocks = own(sp.id)
      .sort((x, y) => x.t0 - y.t0)
      .map((x) => {
        const idle = x.k === 'llm' && lastEnd !== null ? x.t0 - lastEnd : null
        if (x.k === 'llm') lastEnd = x.t1 ?? now
        return block(S, x, now, money, idle, ttl)
      })
    const a = sp.k === 'agent' ? S.agents[sp.a] : null
    const step = a && a.stepTotal ? 'step ' + a.stepDone + '/' + a.stepTotal : ''
    lanes.push({
      id: sp.id,
      name: isMain ? 'Main session' : sp.n || 'subagent',
      sub: isMain ? shortModel(mainModel) : [shortModel(sp.m), step, sp.d].filter(Boolean).join(' · '),
      color: c[0],
      term: c[1],
      depth,
      t0: sp.t0,
      t1: isMain ? end[rootId] : sp.t1 ?? now,
      from,
      blocks,
      live: sp.st === 'run',
      failed: sp.st === 'err' || sp.st === 'abort',
      tip: sp.res ? 'Handed back: ' + sp.res : '',
    })
    for (const ag of agentsUnder(sp.id)) add(ag, depth + 1, lanes.find((l) => l.id === sp.id))
  }
  add(root, 0, null)
  const hidden = Math.max(0, lanes.length - MAX_LANES)
  return { T0: root.t0, T1: Math.max(end[rootId], root.t0 + 1000), lanes: lanes.slice(0, MAX_LANES), hidden, live: all.some((s) => s.st === 'run') }
}

const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200].map((s) => s * 1000)
export const tickLabel = (ms) => (ms < 60000 ? ms / 1000 + 's' : Math.floor(ms / 60000) + 'm' + (ms % 60000 ? (ms % 60000) / 1000 + 's' : ''))
export const tickStep = (span, room) => TICKS.find((s) => span / s <= Math.max(2, room)) || TICKS[TICKS.length - 1]

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Desktop: the lanes as one interactive SVG. Hover a block for its tooltip; a lane's dot and connector show the handoff.
export function lanesSvg(m, W, now) {
  const NAME = Math.min(340, Math.max(150, Math.round(W * 0.33)))
  const LANE = 34
  const TOP = 6
  const x0 = NAME + 8
  const x1 = W - 10
  const span = m.T1 - m.T0
  const X = (t) => x0 + ((Math.min(Math.max(t, m.T0), m.T1) - m.T0) / span) * (x1 - x0)
  const legend = legendSvg(14, W - 14)
  const H = TOP + m.lanes.length * LANE + 26 + 10 + legend.h // lanes, axis, legend (wrapped to the width)
  const AX = H - legend.h - 10 // the axis labels' baseline
  let s = ''
  // grid and ticks
  const step = tickStep(span, Math.floor((x1 - x0) / 70))
  for (let at = 0; at <= span; at += step) {
    const x = X(m.T0 + at)
    s += `<line x1="${x}" y1="${TOP}" x2="${x}" y2="${AX - 14}" class="grid"/><text x="${x}" y="${AX}" class="tick" text-anchor="middle">${tickLabel(at)}</text>`
  }
  m.lanes.forEach((l, i) => {
    const y = TOP + i * LANE + LANE / 2
    const ind = l.depth * 10
    // name column: a dot in the lane's colour, the name, the model under it
    s += `<g><title>${esc(l.name + (l.sub ? ' · ' + l.sub : '') + (l.tip ? '\n' + l.tip : ''))}</title><circle cx="${6 + ind}" cy="${y - 6}" r="4" fill="${l.color}"/>`
    s += `<text x="${16 + ind}" y="${y - 2}" class="name">${esc(fit(l.name, NAME - 20 - ind, 7.2))}</text><text x="${16 + ind}" y="${y + 11}" class="sub">${esc(fit(l.sub, NAME - 20 - ind, 6.2))}</text></g>`
    // the lane's life: a hatched track from start to end, so waiting reads as waiting
    const a = X(l.t0)
    const b = Math.max(X(l.t1), a + 3)
    s += `<rect x="${a}" y="${y - 6}" width="${b - a}" height="12" rx="4" class="wait"/>`
    // handoff: a connector from the spawning lane down to this one
    if (l.from) {
      const py = TOP + m.lanes.indexOf(l.from) * LANE + LANE / 2
      s += `<path d="M${a} ${py + 6} V${y - 6}" stroke="${l.color}" class="hand"/><circle cx="${a}" cy="${py + 6}" r="3" fill="${l.color}"/>`
    }
    for (const bk of l.blocks) {
      const bx = X(bk.t0)
      const bw = Math.max(X(bk.t1) - bx, 3)
      const fill = bk.kind === 'err' ? '#e5534b' : l.color
      const op = bk.kind === 'think' ? 0.4 : 1
      s += `<rect x="${bx.toFixed(1)}" y="${y - 7}" width="${bw.toFixed(1)}" height="14" rx="3.5" fill="${fill}" fill-opacity="${op}" class="blk"><title>${esc(bk.tip)}</title></rect>`
      if (bk.cache === 'miss' || bk.cache === 'write') s += tri(bx + bw / 2, y - 9, CACHE[bk.cache], bk.tip)
    }
    if (l.failed) s += `<text x="${b + 6}" y="${y + 4}" class="fail">✕</text>`
  })
  if (m.live) {
    const nx = X(now)
    s += `<line x1="${nx}" y1="${TOP}" x2="${nx}" y2="${AX - 14}" class="now"/><circle cx="${nx}" cy="${AX - 14}" r="3.5" class="nowdot"/>`
  }
  s += `<g transform="translate(0,${AX + 10})">${legend.svg}</g>`
  const css = `.lg{font-size:11.5px;fill:#5b6068}@media (prefers-color-scheme:dark){.lg{fill:#b4b8bf}}text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}.name{font-size:12.5px;fill:#1d2129;font-weight:500}.sub{font-size:11px;fill:#6b7078}.tick{font-size:11px;fill:#8b8f98}.grid{stroke:#8b8f98;stroke-opacity:.18}.wait{fill:none;stroke:#8b8f98;stroke-opacity:.35;stroke-dasharray:3 3}.hand{fill:none;stroke-width:1.2;stroke-opacity:.8}.blk:hover{stroke:#1d2129;stroke-width:1.2}.fail{font-size:12px;fill:#e5534b}.now{stroke:#5b8def;stroke-width:1.2}.nowdot{fill:#5b8def}@media (prefers-color-scheme:dark){.name{fill:#e8e9ec}.sub{fill:#a2a6ad}.blk:hover{stroke:#fff}}`
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${css}</style>${s}</svg>`, h: H }
}

const CACHE = { miss: '#e5534b', write: '#e0a030' }
// A small triangle over a model call that missed or wrote the cache.
const tri = (x, y, c, tip) => `<path d="M${(x - 4).toFixed(1)} ${y - 6} h8 l-4 6 z" fill="${c}"><title>${esc(tip)}</title></path>`

// The legend, drawn with the same marks the lanes use, wrapped into rows that fit the width: { svg, h }.
function legendSvg(x, maxX) {
  const c = '#8a8f98'
  const items = [
    [`<rect x="0" y="-6" width="18" height="12" rx="3" fill="${c}" fill-opacity=".4"/>`, 'thinking (model call)'],
    [`<rect x="0" y="-6" width="18" height="12" rx="3" fill="${c}"/>`, 'tool call'],
    [`<rect x="0" y="-5" width="18" height="10" rx="3" class="wait"/>`, 'waiting'],
    [`<path d="M9 -7 V7" stroke="${c}" class="hand"/><circle cx="9" cy="-7" r="2.5" fill="${c}"/>`, 'handoff to a subagent'],
    [`<rect x="0" y="-6" width="18" height="12" rx="3" fill="#e5534b"/>`, 'failed'],
    [tri(9, 4, CACHE.write, 'cache write'), 'cache write'],
    [tri(9, 4, CACHE.miss, 'cache miss'), 'cache miss'],
  ]
  let s = ''
  let cx = x
  let y = 12
  for (const [mark, label] of items) {
    const w = 30 + label.length * 6.6
    if (cx > x && cx + w > maxX) {
      cx = x
      y += 22
    }
    s += `<g transform="translate(${cx},${y})">${mark}<text x="24" y="4" class="lg">${label}</text></g>`
    cx += w
  }
  return { svg: s, h: y + 10 }
}

// Cut a label to the room it has, by an estimated character width (the SVG has no layout engine).
function fit(s, px, cw) {
  const n = Math.max(3, Math.floor(px / cw))
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

// Terminal: what each cell of a lane shows. Tool beats thinking beats waiting; a failure beats them all.
export function laneCells(l, m, cells) {
  const out = new Array(cells).fill(' ')
  const at = (t) => Math.min(cells - 1, Math.max(0, Math.floor(((t - m.T0) / (m.T1 - m.T0)) * cells)))
  for (let c = at(l.t0); c <= at(l.t1); c++) out[c] = 'wait'
  const rank = { wait: 0, think: 1, write: 2, miss: 3, tool: 4, err: 5 }
  for (const b of l.blocks) {
    const k = b.kind === 'think' && (b.cache === 'miss' || b.cache === 'write') ? b.cache : b.kind
    for (let c = at(b.t0); c <= at(b.t1); c++) if ((rank[k] ?? 0) > (rank[out[c]] ?? -1)) out[c] = k
  }
  return out
}
