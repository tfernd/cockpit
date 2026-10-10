// Desktop pills as one SVG: rounded, tinted backgrounds, icons, thin progress bars, light and dark theme.
// Terminal cannot draw this; pills.js falls back to Box blocks there.

// accent -> [base, text in light mode, text in dark mode]
const ACC = {
  blue: ['#3b82f6', '#1d4ed8', '#93c5fd'],
  green: ['#22c55e', '#15803d', '#86efac'],
  amber: ['#f59e0b', '#b45309', '#fcd34d'],
  red: ['#ef4444', '#b91c1c', '#fca5a5'],
  purple: ['#8b5cf6', '#6d28d9', '#c4b5fd'],
  teal: ['#14b8a6', '#0f766e', '#5eead4'],
  orange: ['#f97316', '#c2410c', '#fdba74'],
  gold: ['#eab308', '#854d0e', '#fde047'],
  slate: ['#64748b', '#334155', '#cbd5e1'],
  pink: ['#d946ef', '#a21caf', '#f0abfc'],
}

// 14 x 14 icons drawn with strokes in the pill's text color.
const ICONS = {
  ring: '<circle cx="7" cy="7" r="5.3"/><circle cx="7" cy="7" r="1.7" class="f"/>',
  clock: '<circle cx="7" cy="7" r="5.5"/><path d="M7 4v3.2l2 1.3"/>',
  cal: '<rect x="1.8" y="2.8" width="10.4" height="9.4" rx="2"/><path d="M1.8 6h10.4M4.6 1.6v2.4M9.4 1.6v2.4"/>',
  stack: '<path d="M7 2 12 4.6 7 7.2 2 4.6zM2 7.4 7 10l5-2.6M2 9.8l5 2.6 5-2.6"/>',
  coin: '<circle cx="7" cy="7" r="5.5"/><path d="M7 3.8v6.4M8.8 5.4C8.4 4.7 7.8 4.5 7 4.5c-1 0-1.8.5-1.8 1.3 0 1.9 3.6.9 3.6 2.8 0 .8-.8 1.3-1.8 1.3-.8 0-1.5-.3-1.9-1"/>',
  bolt: '<path d="M8 1.6 3.4 7.8h3.2L6 12.4l4.6-6.2H7.4z"/>',
  agents: '<path d="M7 1.8 12.2 7 7 12.2 1.8 7z"/>',
  check: '<path d="M2.6 7.4l3 3 5.8-6.6"/>',
  turn: '<path d="M2.4 7a4.6 4.6 0 0 1 8-3.1M11.6 7a4.6 4.6 0 0 1-8 3.1M10.6 1.8v2.4H8.2M3.4 12.2V9.8h2.4"/>',
  up: '<path d="M7 11.4V3M3.6 6.4 7 3l3.4 3.4"/>',
  down: '<path d="M7 2.6v8.4M3.6 7.6 7 11l3.4-3.4"/>',
  spark: '<path d="M7 1.6 8.3 5.7 12.4 7 8.3 8.3 7 12.4 5.7 8.3 1.6 7 5.7 5.7z"/>',
}

const H = 26
const GAP = 8
const PAD = 10
const BAR_W = 34
// Stretching: a bar absorbs at most this much extra width (past it a bar is just a long line); padding takes the rest.
const BAR_MAX_GROW = 90
// The last row is left at natural width if filling it would grow its pills by more than this share (a lone short pill across the whole band looks silly).
export const LAST_ROW_MAX_GROW = 0.6
// A pill grows by at most this fraction of its own width (never less than 40px).
const MAX_PILL_GROW = 0.6
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Rough text width at 12.5px: the SVG has no layout engine, so each pill is sized from this estimate.
function textW(s, bold) {
  let w = 0
  for (const ch of String(s)) {
    if ('il.,:;|\'! '.includes(ch)) w += 3.4
    else if ('mwMW%@'.includes(ch)) w += 10.6
    else if (ch >= 'A' && ch <= 'Z') w += 8.8
    else if (ch.charCodeAt(0) > 0x2000) w += 11
    else w += 7.6
  }
  return Math.ceil(w * (bold ? 1.14 : 1)) + 3
}

function css() {
  let out = '.ic{fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}.mu{opacity:.72}text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12.5px}@keyframes p{50%{opacity:.35}}.live{animation:p 1.4s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.live{animation:none}}'
  let dark = ''
  for (const [k, [base, light, dk]] of Object.entries(ACC)) {
    out += `.a-${k} .bg{fill:${base};fill-opacity:.14;stroke:${base};stroke-opacity:.38;stroke-width:1}.a-${k} .tx{fill:${light}}.a-${k} .ic{stroke:${light}}.a-${k} .f{fill:${light};stroke:none}.a-${k} .tr{fill:${base};fill-opacity:.24}.a-${k} .fl{fill:${base}}`
    dark += `.a-${k} .tx{fill:${dk}}.a-${k} .ic{stroke:${dk}}.a-${k} .f{fill:${dk}}`
  }
  return out + `@media (prefers-color-scheme:dark){${dark}}`
}

// One pill at (x, y), widened by `extra` px: { w, svg }. Bars absorb the extra first, then the content is centred with more padding.
function pillAt(spec, x, y, extra = 0) {
  const nb = spec.parts.filter((p) => p.bar !== undefined).length
  const barW = BAR_W + (nb ? Math.min(Math.floor(extra / nb), BAR_MAX_GROW) : 0)
  const pad = extra - (barW - BAR_W) * nb
  const padL = Math.floor(pad / 2)
  let cur = PAD + padL
  let g = ''
  if (spec.icon && ICONS[spec.icon]) {
    g += `<g class="ic" transform="translate(${cur},6)">${ICONS[spec.icon]}</g>`
    cur += 14 + 6
  }
  for (const p of spec.parts) {
    if (p.squares) {
      // One small square per subagent, brighter with its context fill, inside the pill.
      const sq = 8
      const gap = 3
      const n = p.squares.length
      g += p.squares.map((it, i) => {
        const x = cur + i * (sq + gap)
        const v = Math.max(0, Math.min(1, it.v ?? 0))
        if (it.s === 'planned') return `<rect x="${x + 0.5}" y="${9.5}" width="${sq - 1}" height="${sq - 1}" rx="2" fill="none" stroke="currentColor" stroke-opacity=".5"/>`
        const color = { running: '#3b82f6', done: '#8a8f96', failed: '#e5534b', killed: '#e0a030' }[it.s] || '#8a8f96'
        const pulse = it.s === 'running' ? ' class="live"' : ''
        return `<rect${pulse} x="${x}" y="9" width="${sq}" height="${sq}" rx="2" fill="${color}" opacity="${(0.35 + 0.65 * v).toFixed(2)}"/>`
      }).join('')
      cur += n * (sq + gap) + 4
      continue
    }
    if (p.bar !== undefined) {
      const fill = Math.max(0, Math.min(100, p.bar)) / 100 * barW
      g += `<rect class="tr" x="${cur}" y="10.5" width="${barW}" height="5" rx="2.5"/>`
      if (fill > 0) g += `<rect class="fl" x="${cur}" y="10.5" width="${Math.max(fill, 4).toFixed(1)}" height="5" rx="2.5"/>`
      cur += barW + 6
    } else {
      g += `<text class="tx${p.dim ? ' mu' : ''}" x="${cur}" y="17.2" font-weight="${p.bold ? 700 : 500}">${esc(p.t)}</text>`
      cur += textW(p.t, p.bold) + 6
    }
  }
  const w = cur - 6 + PAD + (pad - padL)
  return { w, svg: `<g class="a-${spec.accent}" transform="translate(${x},${y})"><rect class="bg" x=".5" y=".5" width="${w - 1}" height="${H - 1}" rx="${H / 2}"/>${g}</g>` }
}

const altOf = (specs) => specs.map((s) => s.parts.filter((p) => p.t !== undefined).map((p) => p.t).join(' ')).join(' | ')

// Spread pills over the fewest rows they need, as evenly as the widths allow (3-3-1 rather than 4-2-1).
// Rows stay in order, and the crew pill (ownRow) always keeps its own row at the end.
function balance(list, maxW, pack) {
  const greedy = pack(list)
  const main = list.filter((it) => !it.s.ownRow)
  const own = list.filter((it) => it.s.ownRow).map((it) => [it])
  const k = pack(main).filter((r) => r.length).length
  if (k <= 1 || main.length <= k) return greedy
  const fits = (g) => g.length && g.reduce((a, it) => a + it.w, 0) + GAP * (g.length - 1) <= maxW
  let best = null
  // Every way to cut the ordered list into k contiguous rows.
  const cut = (start, parts, acc) => {
    if (parts === 1) {
      const last = main.slice(start)
      const rows = [...acc, last]
      if (!rows.every(fits)) return
      const counts = rows.map((r) => r.length)
      const spread = Math.max(...counts) - Math.min(...counts)
      const widths = rows.map((r) => r.reduce((a, it) => a + it.w, 0))
      const wspread = Math.max(...widths) - Math.min(...widths)
      const score = [spread, wspread]
      if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) best = { rows, score }
      return
    }
    for (let end = start + 1; end <= main.length - (parts - 1); end++) cut(end, parts - 1, [...acc, main.slice(start, end)])
  }
  cut(0, k, [])
  return best ? [...best.rows, ...own] : greedy
}

// Lay the pills out in rows no wider than maxW. With maxRows, the lowest-priority pills are dropped until it fits.
export function svgPills(specs, maxW, maxRows = Infinity) {
  let list = specs.map((s) => ({ s, w: pillAt(s, 0, 0).w }))
  // A pill marked ownRow (the crew) sits alone on its row, so the band reads as rows of pills, then the crew.
  const pack = (items) => {
    const rows = [[]]
    let used = 0
    for (const it of items) {
      if (it.s.ownRow && rows[rows.length - 1].length) {
        rows.push([])
        used = 0
      }
      if (used && (used + GAP + it.w > maxW || it.s.ownRow)) {
        rows.push([])
        used = 0
      }
      used += (used ? GAP : 0) + it.w
      rows[rows.length - 1].push(it)
      if (it.s.ownRow) {
        rows.push([])
        used = 0
      }
    }
    return rows.filter((r) => r.length)
  }
  let rows = balance(list, maxW, pack)
  while (rows.length > maxRows && list.length > 1) {
    const lowest = list.reduce((a, b) => (b.s.pri > a.s.pri ? b : a))
    list = list.filter((it) => it !== lowest)
    rows = balance(list, maxW, pack)
  }
  if (!list.length) return null
  // Justify: share each row's leftover width among its pills. The last row stays natural if that would stretch it too much.
  let body = ''
  let width = 0
  let stretched = false
  rows.forEach((r, ri) => {
    const natural = r.reduce((a, it) => a + it.w, 0) + GAP * (r.length - 1)
    const extra = Math.floor(maxW) - natural
    // Every row is justified to the full width, the last one too: the band reads as a grid, not ragged rows.
    const fill = extra > 0
    if (fill) stretched = true
    let x = 0
    r.forEach((it, i) => {
      // A short pill may grow only so far; past that its text would float in empty space.
      const share = fill ? Math.floor(extra / r.length) + (i < extra % r.length ? 1 : 0) : 0
      const grow = share
      const p = pillAt(it.s, x, ri * (H + GAP) + 2, grow)
      body += p.svg
      x += p.w + GAP
    })
    width = Math.max(width, x - GAP)
  })
  const h = rows.length * H + (rows.length - 1) * GAP + 4
  // A stretched band reaches the edge of its slot; otherwise keep the old 2px of slack.
  const w = stretched ? Math.ceil(width) : Math.ceil(width) + 2
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><style>${css()}</style>${body}</svg>`
  return { svg: source, w, h, alt: altOf(list.map((it) => it.s)) }
}

// One square per agent, in spawn order, wrapped to the width. Colour is the state:
// blue running, grey finished, red failed, amber stopped, hollow for a planned task not started.
// v (0..1) is how full the agent's context is; a fuller square is brighter, so busy agents stand out.
const DOT = { running: '#3b82f6', done: '#9aa0a6', failed: '#e5534b', killed: '#e0a030' }
export function dotGridSvg(items, W, cell = 14) {
  const size = cell - 4
  const cols = Math.max(1, Math.floor(W / cell))
  const rows = Math.max(1, Math.ceil(items.length / cols))
  const H = rows * cell + 2
  const body = items
    .map((it, i) => {
      const x = (i % cols) * cell + 1
      const y = Math.floor(i / cols) * cell + 1
      if (it.s === 'planned') return `<rect x="${x + 0.5}" y="${y + 0.5}" width="${size - 1}" height="${size - 1}" rx="2" fill="none" stroke="#9a9a96" stroke-width="1"/>`
      const v = Math.max(0, Math.min(1, it.v ?? 0))
      const opacity = (0.3 + 0.7 * v).toFixed(2)
      const pulse = it.s === 'running' ? ' class="live"' : ''
      return `<rect${pulse} x="${x}" y="${y}" width="${size}" height="${size}" rx="2" fill="${DOT[it.s] || DOT.done}" opacity="${opacity}"/>`
    })
    .join('')
  const css = '@keyframes p{50%{opacity:.35}}.live{animation:p 1.4s ease-in-out infinite}@media (prefers-reduced-motion: reduce){.live{animation:none}}'
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><style>${css}</style>${body}</svg>`
}
