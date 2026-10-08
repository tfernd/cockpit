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
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// Rough text width at 12.5px: the SVG has no layout engine, so each pill is sized from this estimate.
function textW(s, bold) {
  let w = 0
  for (const ch of String(s)) {
    if ('il.,:;|\'! '.includes(ch)) w += 3.4
    else if ('mwMW%@'.includes(ch)) w += 10.6
    else if (ch >= 'A' && ch <= 'Z') w += 8.2
    else if (ch.charCodeAt(0) > 0x2000) w += 11
    else w += 7
  }
  return Math.ceil(w * (bold ? 1.07 : 1)) + 2
}

function css() {
  let out = '.ic{fill:none;stroke-width:1.4;stroke-linecap:round;stroke-linejoin:round}.mu{opacity:.72}text{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;font-size:12.5px}'
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

// Lay the pills out in rows no wider than maxW. With maxRows, the lowest-priority pills are dropped until it fits.
export function svgPills(specs, maxW, maxRows = Infinity) {
  let list = specs.map((s) => ({ s, w: pillAt(s, 0, 0).w }))
  const pack = (items) => {
    const rows = [[]]
    let used = 0
    for (const it of items) {
      if (used && used + GAP + it.w > maxW) {
        rows.push([])
        used = 0
      }
      used += (used ? GAP : 0) + it.w
      rows[rows.length - 1].push(it)
    }
    return rows
  }
  let rows = pack(list)
  while (rows.length > maxRows && list.length > 1) {
    const lowest = list.reduce((a, b) => (b.s.pri > a.s.pri ? b : a))
    list = list.filter((it) => it !== lowest)
    rows = pack(list)
  }
  if (!list.length) return null
  // Justify: share each row's leftover width among its pills. The last row stays natural if that would stretch it too much.
  let body = ''
  let width = 0
  let stretched = false
  rows.forEach((r, ri) => {
    const natural = r.reduce((a, it) => a + it.w, 0) + GAP * (r.length - 1)
    const extra = Math.floor(maxW) - natural
    const last = ri === rows.length - 1
    const fill = extra > 0 && !(last && extra / r.reduce((a, it) => a + it.w, 0) > LAST_ROW_MAX_GROW)
    if (fill) stretched = true
    let x = 0
    r.forEach((it, i) => {
      const grow = fill ? Math.floor(extra / r.length) + (i < extra % r.length ? 1 : 0) : 0
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
