// Draws cockpit's element trees (trees.json, from shots.test.ts) as HTML flexbox and screenshots them with headless Chrome.
// This is an approximation of how the Desktop app lays the same tree out (Box -> flex div, 1 column = 8px), not a capture of the real app.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const out = process.argv[2]
const trees = JSON.parse(readFileSync(join(out, 'trees.json'), 'utf8'))
const CELL = 8
const ROW = 19

const COLORS = { red: '#d1342f', green: '#1f9d55', yellow: '#b7791f', blue: '#2b6cb0', magenta: '#a21caf', cyan: '#0e7490', gray: '#8b8f98', white: '#ffffff', black: '#111111' }
const BGS = { ...COLORS, gray: '#d4d7dd', yellow: '#f6c945', cyan: '#5ccfe6' }
const col = (c, bg) => (c ? (bg ? BGS : COLORS)[c] || c : undefined)
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const dim = (v, unit) => (typeof v === 'number' ? v * unit + 'px' : v)

function box(p) {
  const s = ['display:flex', 'box-sizing:border-box', 'min-width:0', 'flex-direction:' + (p.flexDirection || 'row'), 'flex-shrink:' + (p.flexShrink ?? 1), 'flex-grow:' + (p.flexGrow ?? 0)]
  if (p.flexWrap) s.push('flex-wrap:' + p.flexWrap)
  if (p.alignItems) s.push('align-items:' + p.alignItems)
  if (p.justifyContent) s.push('justify-content:' + p.justifyContent)
  const g = p.gap ?? 0
  if (p.columnGap ?? g) s.push('column-gap:' + (p.columnGap ?? g) * CELL + 'px')
  if (p.rowGap ?? g) s.push('row-gap:' + (p.rowGap ?? g) * ROW + 'px')
  if (p.width !== undefined) s.push('width:' + dim(p.width, CELL))
  if (p.minWidth !== undefined) s.push('min-width:' + dim(p.minWidth, CELL))
  if (p.height !== undefined) s.push('height:' + dim(p.height, ROW))
  for (const [k, css] of [['padding', 'padding'], ['paddingTop', 'padding-top'], ['paddingBottom', 'padding-bottom'], ['paddingLeft', 'padding-left'], ['paddingRight', 'padding-right'], ['margin', 'margin'], ['marginTop', 'margin-top'], ['marginBottom', 'margin-bottom'], ['marginLeft', 'margin-left'], ['marginRight', 'margin-right']]) {
    if (p[k] !== undefined) s.push(css + ':' + p[k] * (/Top|Bottom/.test(k) ? ROW : CELL) + 'px')
  }
  if (p.paddingX !== undefined) s.push(`padding-left:${p.paddingX * CELL}px;padding-right:${p.paddingX * CELL}px`)
  if (p.paddingY !== undefined) s.push(`padding-top:${p.paddingY * ROW}px;padding-bottom:${p.paddingY * ROW}px`)
  if (p.marginX !== undefined) s.push(`margin-left:${p.marginX * CELL}px;margin-right:${p.marginX * CELL}px`)
  if (p.marginY !== undefined) s.push(`margin-top:${p.marginY * ROW}px;margin-bottom:${p.marginY * ROW}px`)
  if (p.backgroundColor) s.push('background:' + col(p.backgroundColor, true))
  if (p.borderStyle) s.push(`border:1px solid ${col(p.borderColor) || '#b8bcc4'};border-radius:7px`)
  if (p.overflow === 'hidden') s.push('overflow:hidden')
  if (p.display === 'none') s.push('display:none')
  return s.join(';')
}

function html(el) {
  if (el == null) return ''
  if (typeof el === 'string') return esc(el)
  const { type, props: p = {}, children = [] } = el
  const kids = () => children.map(html).join('')
  if (type === 'Box') return `<div style="${box(p)}">${kids()}</div>`
  if (type === 'Text') {
    const s = ['display:block', 'min-width:0']
    if (p.color) s.push('color:' + col(p.color))
    if (p.backgroundColor) s.push('background:' + col(p.backgroundColor, true))
    if (p.dimColor) s.push('opacity:.55')
    if (p.bold) s.push('font-weight:700')
    if (p.italic) s.push('font-style:italic')
    if (p.underline) s.push('text-decoration:underline')
    const wrap = p.wrap ?? 'wrap'
    if (wrap === 'wrap') s.push('white-space:pre-wrap;overflow-wrap:anywhere')
    else s.push('white-space:pre;overflow:hidden;text-overflow:ellipsis')
    if (wrap === 'truncate-start') s.push('direction:rtl;text-align:left;unicode-bidi:plaintext')
    return `<span style="${s.join(';')}">${kids()}</span>`
  }
  if (type === 'Button') {
    const key = p.hotkey ? `<span class="hk">${esc(p.hotkey)}</span>` : ''
    return `<span class="btn" style="${p.dimColor ? 'opacity:.6' : 'font-weight:600'}">${key}${esc(p.label)}</span>`
  }
  if (type === 'Svg') return `<div style="width:${p.width}px;height:${p.height}px;flex-shrink:0;max-width:100%">${p.source}</div>`
  return `<div>[${esc(type)}]</div>`
}

const CSS = `
*{box-sizing:border-box}
body{margin:0;background:#e9ebef;font:13px/${ROW}px ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d2129}
.card{margin:14px;background:#fff;border:1px solid #cfd3da;border-radius:14px;padding:14px 16px 18px;box-shadow:0 1px 3px #0001}
.title{font-size:15px;color:#555;margin-bottom:12px;display:flex;justify-content:space-between}
.btn{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
.hk{border:1px solid #b8bcc4;border-radius:5px;padding:0 5px;font-size:11px;line-height:16px;color:#666}
`
const FONT_WIDTH = (cols) => cols * CELL + 32 + 28

mkdirSync(join(out, 'html'), { recursive: true })
const chrome = process.env.CHROME || 'google-chrome'
for (const [name, tree] of Object.entries(trees)) {
  const cols = Number(name.split('-').pop())
  const isBand = name.startsWith('band')
  const w = isBand ? cols * CELL + 80 : FONT_WIDTH(cols)
  const page = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><body><div class="card" id="c">${isBand ? '' : '<div class="title"><span>Cockpit</span><span>⤢ &nbsp;✕</span></div>'}${html(tree)}</div><script>document.title=document.getElementById('c').getBoundingClientRect().height+28</script>`
  const file = join(out, 'html', name + '.html')
  writeFileSync(file, page)
  const args = ['--headless=new', '--no-sandbox', '--hide-scrollbars', '--force-device-scale-factor=2']
  const dom = execFileSync(chrome, [...args, '--dump-dom', `--window-size=${w},900`, 'file://' + file], { encoding: 'utf8' })
  const h = Math.ceil(Number(/<title>([\d.]+)<\/title>/.exec(dom)?.[1] || 600))
  execFileSync(chrome, [...args, `--screenshot=${join(out, name + '.png')}`, `--window-size=${w},${h}`, 'file://' + file], { stdio: 'ignore' })
  console.log(name + '.png', w + 'x' + h)
}
