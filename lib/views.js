// Cockpit views: pure functions that turn state into element trees.
// Box/Text come from $.ui.resolve(e) in the hook and are passed in. Text only, so it draws in terminal and Desktop.

import { mean, std, pctl, hitRate, runningAgents } from './model.js'

export const TABS = [
  { id: 'overview', label: 'Overview', key: '1' },
  { id: 'tools', label: 'Tools', key: '2' },
  { id: 'files', label: 'Files', key: '3' },
  { id: 'cache', label: 'Cache', key: '4' },
  { id: 'agents', label: 'Agents', key: '5' },
  { id: 'timeline', label: 'Timeline', key: '6' },
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
export function bar(p, w = 10) {
  const f = Math.max(0, Math.min(w, Math.round((Math.max(0, Math.min(100, p)) / 100) * w)))
  return '█'.repeat(f) + '░'.repeat(w - f)
}
const padR = (s, n) => String(s).padEnd(n).slice(0, Math.max(n, 0))
const padL = (s, n) => String(s).padStart(n)
const heat = (p) => (p >= 85 ? 'red' : p >= 65 ? 'yellow' : 'green')
const cacheRemaining = (S, now) => (S.lastMainStepAt ? S.ttlMin * 60000 - (now - S.lastMainStepAt) : null)
const cacheColor = (rem) => (rem > 60000 ? 'green' : rem > 15000 ? 'yellow' : 'red')

// ---------- band (one line above the prompt) ----------
export function band(Box, Text, S, now, cols = 80) {
  if (!S.ctx && !S.toolCalls && !S.turns) return null
  const parts = []
  if (S.ctx && S.ctx.window) {
    const p = S.ctx.percent ?? Math.round(((S.ctx.tokens || 0) / S.ctx.window) * 100)
    parts.push({ t: 'ctx ' + bar(p, 8) + ' ' + p + '%', c: heat(p) })
  }
  const rem = cacheRemaining(S, now)
  if (rem !== null) {
    const last = S.steps[S.steps.length - 1]
    const hit = last ? ' ' + hitRate(last.read, last.wrote, last.fresh) + '%' : ''
    parts.push(rem > 0 ? { t: 'cache ' + mmss(rem) + hit, c: cacheColor(rem) } : { t: 'cache cold', c: 'red' })
  }
  const c = S.curTurn
  if (c) {
    const tools = S.toolCalls - c.tools0
    const fails = S.fails - c.fails0
    parts.push({ t: 'turn ' + (S.turns + 1) + ' · ' + tools + ' tools' + (fails ? ' · ' + fails + '✗' : ''), c: fails ? 'yellow' : undefined })
  } else if (S.turns) {
    parts.push({ t: 'turns ' + S.turns, dim: true })
  }
  const ag = runningAgents(S).length
  if (ag) parts.push({ t: 'agents ' + ag + ' running', c: 'cyan' })
  if (S.todos && S.todos.total) parts.push({ t: '✓ ' + S.todos.done + '/' + S.todos.total })
  const five = S.limits.find((l) => l.kind === 'five_hour')
  if (five) parts.push({ t: '5h ' + Math.round(five.percentUsed) + '%', c: heat(five.percentUsed) })

  const kids = []
  let used = 2
  for (const p of parts) {
    const w = p.t.length + 3
    if (used + w > cols) break
    used += w
    if (kids.length) kids.push(Text({ dimColor: true, children: ' · ' }))
    kids.push(Text({ color: p.c, dimColor: p.dim, children: p.t }))
  }
  if (!kids.length) return null
  return Box({ flexDirection: 'row', paddingX: 1, children: kids })
}

// ---------- pane bodies ----------
const L = (Text, s, color, dim, bold) => Text({ color, dimColor: dim, bold, wrap: 'truncate', children: [s === '' ? ' ' : s] })

function overview(Text, S, now) {
  const out = []
  if (S.ctx && S.ctx.window) {
    const p = S.ctx.percent ?? Math.round(((S.ctx.tokens || 0) / S.ctx.window) * 100)
    out.push(L(Text, 'Context   ' + bar(p, 20) + ' ' + p + '%  ' + fmtTok(S.ctx.tokens || 0) + ' / ' + fmtTok(S.ctx.window), heat(p)))
  } else out.push(L(Text, 'Context   (no reading yet)', undefined, true))
  for (const l of S.limits) {
    const reset = l.resetsAt ? '  resets in ' + fmtMs(Math.max(0, Date.parse(l.resetsAt) - Date.now())) : ''
    out.push(L(Text, padR(l.kind === 'five_hour' ? '5-hour' : l.kind === 'seven_day' ? 'Weekly' : l.kind, 10) + bar(l.percentUsed, 20) + ' ' + Math.round(l.percentUsed) + '%' + reset, heat(l.percentUsed)))
  }
  if (S.cost) out.push(L(Text, 'Cost      $' + S.cost.usd.toFixed(2)))
  out.push(L(Text, ''))
  const tm = S.turnMs
  out.push(L(Text, 'Turns     ' + S.turns + (tm.length ? '   mean ' + fmtMs(mean(tm)) + '   p95 ' + fmtMs(pctl(tm, 95)) : '')))
  const rate = S.toolCalls ? ((S.fails / S.toolCalls) * 100).toFixed(1) : '0.0'
  out.push(L(Text, 'Tools     ' + S.toolCalls + ' calls   ' + S.fails + ' failed (' + rate + '%)', S.fails ? 'yellow' : undefined))
  out.push(L(Text, 'Re-reads  ' + S.repeatReads + ' repeated reads of unchanged-since-read files', S.repeatReads > 5 ? 'yellow' : undefined))
  if (S.todos) out.push(L(Text, 'Progress  ' + bar((S.todos.done / Math.max(1, S.todos.total)) * 100, 20) + ' ' + S.todos.done + '/' + S.todos.total))
  out.push(L(Text, 'Compacts  ' + S.compactions))
  out.push(L(Text, ''))
  out.push(L(Text, 'Model     ' + (S.model || '?') + (S.modelLog.length > 1 ? '   (' + (S.modelLog.length - 1) + ' change' + (S.modelLog.length > 2 ? 's' : '') + ', see Timeline)' : '')))
  const run = Object.values(S.running)
  if (run.length) out.push(L(Text, 'Running   ' + run.map((r) => r.tool + ' ' + fmtMs(now - r.t)).slice(0, 4).join(', '), 'cyan'))
  return out
}

function toolsTab(Text, S) {
  const rows = Object.entries(S.tools).sort((a, b) => b[1].n - a[1].n).slice(0, 18)
  const out = [L(Text, padR('tool', 22) + padL('n', 5) + padL('fail', 6) + padL('mean', 8) + padL('sd', 8) + padL('p50', 8) + padL('p95', 8) + padL('p99', 8), undefined, true, true)]
  for (const [name, s] of rows) {
    const d = s.durs
    out.push(
      L(
        Text,
        padR(name, 22) + padL(s.n, 5) + padL(s.fail, 6) + padL(fmtMs(mean(d)), 8) + padL(fmtMs(std(d)), 8) + padL(fmtMs(pctl(d, 50)), 8) + padL(fmtMs(pctl(d, 95)), 8) + padL(fmtMs(pctl(d, 99)), 8),
        s.fail ? 'yellow' : undefined,
      ),
    )
  }
  if (!rows.length) out.push(L(Text, 'no tool calls yet', undefined, true))
  out.push(L(Text, ''))
  out.push(L(Text, 'Durations include time spent waiting on permission prompts. Last 500 calls per tool.', undefined, true))
  return out
}

function filesTab(Text, S) {
  const rows = Object.entries(S.files).sort((a, b) => b[1].repeat - a[1].repeat || b[1].reads - a[1].reads).slice(0, 18)
  const out = [L(Text, padR('file', 46) + padL('reads', 7) + padL('edits', 7) + padL('repeat', 8), undefined, true, true)]
  for (const [path, f] of rows) {
    const short = path.length > 45 ? '…' + path.slice(-44) : path
    out.push(L(Text, padR(short, 46) + padL(f.reads, 7) + padL(f.edits, 7) + padL(f.repeat, 8), f.repeat >= 3 ? 'yellow' : undefined))
  }
  if (!rows.length) out.push(L(Text, 'no file reads or edits yet', undefined, true))
  out.push(L(Text, ''))
  out.push(L(Text, 'repeat = read again with no edit in between (usually wasted context).', undefined, true))
  return out
}

function cacheTab(Text, S, now) {
  const out = []
  const rem = cacheRemaining(S, now)
  if (rem === null) out.push(L(Text, 'Cache window: no request yet', undefined, true))
  else if (rem > 0) {
    const pct = (rem / (S.ttlMin * 60000)) * 100
    out.push(L(Text, 'Cache window  ' + bar(pct, 20) + ' ' + mmss(rem) + ' left of ' + S.ttlMin + 'm  (send a message to refresh)', cacheColor(rem)))
  } else out.push(L(Text, 'Cache window  expired ' + mmss(-rem) + ' ago: next request rewrites the cache', 'red'))
  const t = S.cache
  out.push(L(Text, 'Session       read ' + fmtTok(t.read) + '   wrote ' + fmtTok(t.wrote) + '   new ' + fmtTok(t.fresh) + '   hit ' + hitRate(t.read, t.wrote, t.fresh) + '%'))
  out.push(L(Text, ''))
  out.push(L(Text, padL('ago', 7) + padL('read', 9) + padL('wrote', 9) + padL('new', 9) + padL('hit', 6) + '  model', undefined, true, true))
  for (const s of S.steps.slice(-12).reverse()) {
    const h = hitRate(s.read, s.wrote, s.fresh)
    out.push(L(Text, padL(fmtMs(now - s.t), 7) + padL(fmtTok(s.read), 9) + padL(fmtTok(s.wrote), 9) + padL(fmtTok(s.fresh), 9) + padL(h + '%', 6) + '  ' + (s.model || ''), h < 50 ? 'yellow' : undefined))
  }
  out.push(L(Text, ''))
  out.push(L(Text, 'Lifetime is ' + S.ttlMin + 'm. Change with /cockpit ttl 5  or  /cockpit ttl 60.', undefined, true))
  return out
}

function agentsTab(Text, S, now) {
  const list = Object.values(S.agents).sort((a, b) => b.startedAt - a.startedAt).slice(0, 14)
  const out = []
  if (!list.length) return [L(Text, 'no subagents spawned this session', undefined, true)]
  for (const a of list) {
    const icon = a.status === 'running' ? '◆' : a.status === 'completed' ? '✓' : '✗'
    const color = a.status === 'running' ? 'cyan' : a.status === 'completed' ? 'green' : 'red'
    const end = a.endedAt || now
    out.push(L(Text, icon + ' ' + padR(a.type, 16) + padR(a.desc, 34) + ' ' + fmtMs(end - a.startedAt), color))
    const idle = a.status === 'running' && !a.current ? '   idle ' + fmtMs(now - a.lastAt) : ''
    out.push(L(Text, '    ' + (a.model || '?') + ' · ' + a.steps + ' req · ' + a.tools + ' tools' + (a.fails ? ' · ' + a.fails + ' failed' : '') + ' · ctx ' + fmtTok(a.ctx) + ' · out ' + fmtTok(a.out) + (a.current ? '   now: ' + a.current : idle), undefined, true))
  }
  return out
}

function timelineTab(Text, S, now) {
  const out = []
  const icon = { spawn: '▶', result: '◀', send: '→', recv: '←', model: '⇄', compact: '⊟' }
  for (const m of S.msgs.slice(-22).reverse()) out.push(L(Text, padL(fmtMs(now - m.t), 7) + ' ago  ' + (icon[m.kind] || '·') + ' ' + m.text))
  if (!out.length) out.push(L(Text, 'nothing yet: spawns, subagent results, messages, model changes and compactions appear here', undefined, true))
  return out
}

const BODIES = { overview, tools: toolsTab, files: filesTab, cache: cacheTab, agents: agentsTab, timeline: timelineTab }

export function paneBody(Box, Text, tab, S, now) {
  const fn = BODIES[tab] || overview
  return Box({ flexDirection: 'column', children: fn(Text, S, now) })
}
