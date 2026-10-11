// Cockpit recorder: plain state + pure mutators. No `$` in here, so it is unit-testable.

export const MAX_DURS = 500
export const MAX_STEPS = 200
export const MAX_MSGS = 200
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function newState(ttlMin = 5) {
  return {
    v: 1,
    ttlMin, // prompt-cache lifetime of the main conversation, minutes (5 or 60): from settings / env, else automatic, else /cockpit ttl
    ttlSubMin: 5, // the same for subagents and background requests (their own setting)
    ttlManual: null, // 5 or 60 when the user ran /cockpit ttl; used only when no Claude Code setting decides
    ttlSource: 'default', // where ttlMin came from: 'env' | 'setting' | 'manual' | 'auto' | 'default'
    startedAt: 0,
    account: null, // 'subscription' | 'api' | null (not known yet)
    lastCost: null, // last session cost seen, to add only the growth to the monthly total
    outTok: 0, // output tokens across the session (main loop)
    effort: null, // thinking effort of the latest main request
    effortSeen: false,
    switches: [], // model / effort changes: { t, kind, from, to, rewrote (tokens re-cached), read }
    switchTokens: 0, // total tokens re-cached right after switches
    monthSince: 0, // when the monthly total started counting (ms)
    monthUsd: 0, // API-rate cost of every session this month that ran with cockpit loaded
    budgetUsd: 0, // monthly budget the user set with /cockpit budget; 0 = none
    seq: 0,
    turns: 0,
    turnMs: [],
    curTurn: null, // { id, t0, tools0, fails0 }
    lastTurn: null,
    toolCalls: 0,
    fails: 0,
    tools: {}, // name -> { n, fail, durs[] }
    files: {}, // path -> { reads, edits, repeat, sinceEdit }
    repeatReads: 0,
    running: {}, // key -> { tool, t, agentId }
    steps: [], // main-loop model requests: { t, model, read, wrote, fresh, out }
    cache: { read: 0, wrote: 0, fresh: 0 },
    lastMainStepAt: 0,
    model: null,
    modelLog: [], // { t, model }
    agents: {}, // id -> agent record
    msgs: [], // timeline
    compactions: 0,
    ctx: null, // { tokens, window, percent }
    limits: [], // [{ kind, percentUsed, resetsAt }]
    cost: null,
    todos: null, // { done, total }
    alerted: {},
    dbg: {}, // event name -> { n, last }: what the recorder has actually seen
    cwd: null, // the workspace folder, to show paths relative to it
    peakRunning: 0, // most subagents running at once
    listAll: false, // /cockpit all: list every subagent instead of the busy and recent ones
  }
}

// Count one event, for the Debug tab.
export function count(S, name, t) {
  const d = (S.dbg ??= {})
  const r = (d[name] ??= { n: 0, last: 0 })
  r.n++
  r.last = t
}

// ---------- maths ----------
export function mean(a) {
  return a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
}
export function std(a) {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1))
}
export function pctl(a, p) {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1))]
}

function cap(a, n) {
  if (a.length > n) a.splice(0, a.length - n)
}
function snip(s, n = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
export function pushMsg(S, t, kind, text) {
  S.msgs.push({ t, kind, text: snip(text, 120) })
  cap(S.msgs, MAX_MSGS)
}

// ---------- tools & files ----------
export function onToolStart(S, id, tool, agentId, t, e) {
  const key = id ?? 'n' + S.seq++
  S.toolCalls++
  S.tools[tool] ??= { n: 0, fail: 0, durs: [] }
  S.tools[tool].n++
  S.running[key] = { tool, t, agentId }
  const a = agentId ? ensureAgent(S, agentId, t) : null
  if (a) {
    a.tools++
    a.current = tool
    a.lastAt = t
  }
  const path = e && (e.file_path ?? e.notebook_path)
  if (typeof path === 'string') {
    S.files[path] ??= { reads: 0, edits: 0, repeat: 0, sinceEdit: 0 }
    const f = S.files[path]
    if (tool === 'Read') {
      if (f.sinceEdit > 0) {
        f.repeat++
        S.repeatReads++
      }
      f.reads++
      f.sinceEdit++
    } else if (EDIT_TOOLS.has(tool)) {
      f.edits++
      f.sinceEdit = 0
    }
  }
  if (tool === 'TodoWrite' && e && Array.isArray(e.todos)) {
    S.todos = { done: e.todos.filter((x) => x && x.status === 'completed').length, total: e.todos.length }
  }
  return key
}

export function onToolEnd(S, key, failed, t) {
  const r = S.running[key]
  if (!r) return
  delete S.running[key]
  const s = S.tools[r.tool]
  s.durs.push(t - r.t)
  cap(s.durs, MAX_DURS)
  if (failed) {
    s.fail++
    S.fails++
  }
  const a = r.agentId ? S.agents[r.agentId] : null
  if (a) {
    a.current = null
    a.lastAt = t
    if (failed) a.fails++
  }
}

// ---------- model requests (cache, models) ----------
export function onStepEnd(S, e, result, t) {
  const u = result && result.usage
  const model = (u && u.model) || e.model
  const effort = e.effort === undefined ? null : e.effort
  let sw = null // a model or effort change seen on THIS request: its cache write is the price of switching
  if (!e.agentId) {
    S.lastMainStepAt = t
    if (model && model !== S.model) {
      if (S.model) {
        pushMsg(S, t, 'model', S.model + ' → ' + model)
        sw = { t, kind: 'model', from: S.model, to: model, rewrote: 0 }
      }
      S.model = model
      S.modelLog.push({ t, model })
      cap(S.modelLog, 50)
    }
    if (S.effortSeen && effort !== S.effort) {
      pushMsg(S, t, 'model', 'effort ' + (S.effort ?? 'default') + ' → ' + (effort ?? 'default'))
      sw ??= { t, kind: 'effort', from: S.effort ?? 'default', to: effort ?? 'default', rewrote: 0 }
    }
    S.effort = effort
    S.effortSeen = true
  }
  if (!u) {
    if (sw) S.switches.push(sw)
    return
  }
  const read = u.cache_read_input_tokens || 0
  const wrote = u.cache_creation_input_tokens || 0
  const fresh = u.input_tokens || 0
  const out = u.output_tokens || 0
  if (e.agentId) {
    const a = ensureAgent(S, e.agentId, t, model)
    if (a) {
      if (model) a.model = model // what the request really ran on, not what was asked for
      a.steps++
      a.out += out
      a.tokens += read + wrote + fresh + out
      a.cost += costOf(model, u)
      a.ctx = read + wrote + fresh
      a.lastAt = t
      a.stepAt = t // end of its last request: its cache window counts from here
    }
    return
  }
  if (sw) {
    // The first request after a switch has to write the whole prefix again if the cache could not be reused.
    sw.rewrote = wrote
    sw.read = read
    S.switches.push(sw)
    cap(S.switches, 30)
    S.switchTokens += wrote
  }
  S.steps.push({ t, model, read, wrote, fresh, out })
  cap(S.steps, MAX_STEPS)
  S.cache.read += read
  S.cache.wrote += wrote
  S.cache.fresh += fresh
  S.outTok += out
}

// "5m" / "1h" (what Claude Code accepts) to minutes; anything else is not a setting.
export function parseTtl(v) {
  if (v === 5 || v === 60) return v
  const m = /^\s*(\d+)\s*([mh])\s*$/i.exec(String(v ?? ''))
  if (!m) return null
  const min = Number(m[1]) * (m[2].toLowerCase() === 'h' ? 60 : 1)
  return min === 5 || min === 60 ? min : null
}

// The cache lifetimes Claude Code is using, from what it is configured with. Mirrors its own precedence: the env var beats
// the setting, FORCE_5M / ENABLE_1H cover both buckets, and with nothing set a subscription gets 1 hour for the main
// conversation and an API key 5 minutes; subagents get 5 minutes unless 1 hour is enabled. `manual` is /cockpit ttl.
export function resolveTtl(c) {
  const env = parseTtl(c.envMain)
  const set = parseTtl(c.setMain)
  const sub = parseTtl(c.envSub) ?? parseTtl(c.setSub)
  let main, src
  if (env) [main, src] = [env, 'env']
  else if (set) [main, src] = [set, 'setting']
  else if (c.force5m) [main, src] = [5, 'env']
  else if (c.enable1h) [main, src] = [60, 'env']
  else if (c.manual) [main, src] = [c.manual, 'manual']
  else if (c.account === 'subscription') [main, src] = [60, 'auto']
  else if (c.account === 'api') [main, src] = [5, 'auto']
  else [main, src] = [5, 'default']
  return { main, sub: sub ?? (c.force5m ? 5 : c.enable1h ? 60 : 5), src }
}

// Subagent cache windows: each agent's cache counts from the end of its last request. Warm = still inside the window.
export function subCache(S, now) {
  const win = S.ttlSubMin * 60000
  let seen = 0
  let warm = 0
  let next = Infinity
  for (const a of Object.values(S.agents)) {
    if (!a.stepAt) continue
    seen++
    const rem = win - (now - a.stepAt)
    if (rem > 0) {
      warm++
      next = Math.min(next, rem)
    }
  }
  return { seen, warm, next: warm ? next : null, win }
}

export function hitRate(read, wrote, fresh) {
  const tot = read + wrote + fresh
  return tot ? Math.round((read / tot) * 100) : 0
}

// ---------- turns & agents ----------
export function onTurnStart(S, e, t) {
  S.curTurn = { id: e.turnId, t0: t, tools0: S.toolCalls, fails0: S.fails }
}

export function onTurnComplete(S, e, t) {
  if (e.agentId) {
    const a = ensureAgent(S, e.agentId, t)
    if (a) {
      a.lastAt = t
      a.endedAt = t
      a.current = null
      a.status = e.isAborted ? 'killed' : e.reason === 'error' ? 'failed' : 'completed'
      a.result = snip(e.answer, 160)
      a.resultAt = t
      if (!a.unlisted) pushMsg(S, t, 'result', a.desc + ' → ' + snip(e.answer, 90))
    }
    return
  }
  S.turns++
  S.turnMs.push(e.durationMs || 0)
  cap(S.turnMs, MAX_STEPS)
  const c = S.curTurn
  S.lastTurn = {
    ms: e.durationMs || 0,
    tools: c ? S.toolCalls - c.tools0 : 0,
    fails: c ? S.fails - c.fails0 : 0,
    reason: e.reason,
  }
  S.curTurn = null
}

// USD per million tokens (input, output, cache read, cache write). API-rate equivalent: on a subscription
// nothing is billed per token, so the cost is shown as a comparison, not a bill.
const PRICES = [
  [/fable|mythos/, [10, 50, 0.25, 12.5]],
  [/opus-5-5/, [4, 20, 0.2, 5]],
  [/opus/, [5, 25, 0.5, 6.25]],
  [/sonnet/, [2, 10, 0.2, 2.5]],
  [/haiku/, [1, 5, 0.1, 1.25]],
]
export function costOf(model, u) {
  const p = (PRICES.find(([re]) => re.test(String(model).toLowerCase())) || [, [4, 20, 0.2, 5]])[1]
  return ((u.input_tokens || 0) * p[0] + (u.output_tokens || 0) * p[1] + (u.cache_read_input_tokens || 0) * p[2] + (u.cache_creation_input_tokens || 0) * p[3]) / 1e6
}

function blankAgent(id, n, t) {
  return { id, n, desc: '', type: '', model: '', bg: false, startedAt: t, lastAt: t, tools: 0, fails: 0, steps: 0, parent: null, stepDone: 0, stepTotal: 0, stepNote: '', out: 0, tokens: 0, cost: 0, ctx: 0, status: 'running', current: null }
}

// A loop that sends events but was never announced by agent.spawn: a workflow's agents and the engine's own forks.
// The engine lists neither, so this is the only way they show up. A later agent.spawn for the same id fills in the rest.
export function ensureAgent(S, id, t, model) {
  if (!id) return null
  let a = S.agents[id]
  if (a) return a
  S.agentN = (S.agentN || 0) + 1
  a = S.agents[id] = { ...blankAgent(id, S.agentN, t), desc: 'loop ' + S.agentN, type: 'unlisted', model: model || '', unlisted: true }
  return a
}

export function onSpawn(S, id, e, model, t) {
  const prev = S.agents[id] && S.agents[id].unlisted ? S.agents[id] : null // its events can beat this hook
  if (!prev) S.agentN = (S.agentN || 0) + 1 // spawn order, so unnamed agents can still be told apart
  const base = blankAgent(id, prev ? prev.n : S.agentN, prev ? prev.startedAt : t)
  S.agents[id] = {
    ...base,
    ...(prev ? { tools: prev.tools, fails: prev.fails, steps: prev.steps, out: prev.out, tokens: prev.tokens, cost: prev.cost, ctx: prev.ctx, lastAt: prev.lastAt, current: prev.current } : {}),
    desc: snip(e.description, 60),
    type: e.subagentType,
    model: model || e.model || (prev && prev.model) || '',
    bg: !!e.background,
    parent: e.parentAgentId || null, // the loop that spawned it; null = main
  }
  pushMsg(S, t, 'spawn', e.subagentType + ': ' + snip(e.description, 80))
  trackPeak(S)
}

export function trackPeak(S) {
  const n = runningAgents(S).length
  if (n > S.peakRunning) S.peakRunning = n
}

// An unlisted loop that stops sending events and never completes is closed after ten quiet minutes (the engine will not say).
export function closeStale(S, now) {
  for (const a of Object.values(S.agents)) {
    if (a.unlisted && a.status === 'running' && now - a.lastAt > 600000) {
      a.status = 'killed'
      a.endedAt = a.lastAt
      a.result = 'no events for 10 minutes'
    }
  }
}

// A worker's own progress, from its `step` tool. Returns false for an unknown agent.
export function onStep(S, agentId, input, t) {
  const a = S.agents[agentId]
  if (!a) return false
  const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
  const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
  a.stepTotal = total
  a.stepDone = total ? Math.min(total, done) : done
  if (input.note !== undefined) a.stepNote = snip(input.note, 60)
  a.lastAt = t
  return true
}

// The orchestrator's plan: the list of tasks it intends to delegate, in order.
export function onPlan(S, input) {
  const tasks = (input.tasks || []).filter((x) => x && String(x.title || '').trim()).map((x) => ({ title: snip(x.title, 60), tier: String(x.tier || ''), after: (x.after || []).filter(Number.isInteger) }))
  S.plan = { title: snip(input.title || (S.plan && S.plan.title) || 'plan', 40), tasks }
}

const normTitle = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

// Planned tasks that a completed subagent has matched by description.
export function planProgress(S) {
  if (!S.plan || !S.plan.tasks.length) return null
  const finished = new Set(Object.values(S.agents).filter((a) => a.status === 'completed').map((a) => normTitle(a.desc)))
  const done = S.plan.tasks.filter((t) => finished.has(normTitle(t.title))).length
  return { done, total: S.plan.tasks.length, title: S.plan.title }
}

export function syncAgents(S, list) {
  for (const info of list || []) {
    const a = S.agents[info.id]
    if (a && info.status && a.status !== 'completed') a.status = info.status
  }
}

export function runningAgents(S) {
  return Object.values(S.agents).filter((a) => a.status === 'running')
}

// Statistics over the subagents that have finished, plus a row per model and the busiest moment.
export function agentStats(S, now) {
  const all = Object.values(S.agents)
  const fin = all.filter((a) => a.endedAt)
  const byModel = {}
  for (const a of all) {
    const k = a.model || '?'
    const r = (byModel[k] ??= { n: 0, fin: 0, ms: 0, steps: 0, tokens: 0, cost: 0 })
    r.n++
    r.steps += a.steps
    r.tokens += a.tokens || 0
    r.cost += a.cost || 0
    if (a.endedAt) {
      r.fin++
      r.ms += a.endedAt - a.startedAt
    }
  }
  return {
    total: all.length,
    finished: fin.length,
    time: fin.map((a) => a.endedAt - a.startedAt),
    turns: fin.map((a) => a.steps),
    tools: fin.map((a) => a.tools),
    tokens: fin.map((a) => a.tokens || 0),
    cost: fin.map((a) => a.cost || 0),
    byModel,
    peak: S.peakRunning || 0,
    unlisted: all.filter((a) => a.unlisted).length,
  }
}

// Path as shown: relative to the workspace when inside it, the full path (flagged) when outside.
export function showPath(cwd, p) {
  const base = cwd ? cwd.replace(/\/+$/, '') : ''
  if (base && p === base) return { t: '.', outside: false }
  if (base && p.startsWith(base + '/')) return { t: p.slice(base.length + 1), outside: false }
  return { t: p, outside: !!base }
}

// ---------- alerts (pure; caller shows them) ----------
export function alerts(S, now) {
  const out = []
  const once = (key, text) => {
    if (S.alerted[key]) return
    S.alerted[key] = 1
    out.push(text)
  }
  if (S.lastMainStepAt) {
    const rem = S.ttlMin * 60000 - (now - S.lastMainStepAt)
    if (rem > 0 && rem <= 30000) once('cache' + S.lastMainStepAt, 'cache expires in ' + Math.ceil(rem / 1000) + 's: any message refreshes it')
  }
  const p = S.ctx && S.ctx.percent
  if (p >= 90) once('ctx90', 'context ' + p + '% full')
  else if (p >= 80) once('ctx80', 'context ' + p + '% full')
  // A tool running far past its own p95. An Agent call lasts as long as the whole subagent, so it never counts.
  // Several at once (a parallel batch) become one toast.
  const slow = {}
  for (const [key, r] of Object.entries(S.running)) {
    if (r.tool === 'Agent') continue
    const st = S.tools[r.tool]
    const limit = st && st.durs.length >= 8 ? Math.max(45000, 3 * pctl(st.durs, 95)) : 90000
    if (now - r.t > limit && !S.alerted['stall' + key]) {
      S.alerted['stall' + key] = 1
      ;(slow[r.tool] ??= []).push(now - r.t)
    }
  }
  for (const [tool, ds] of Object.entries(slow)) out.push(ds.length > 1 ? tool + ' x' + ds.length + ' running over ' + Math.round(Math.min(...ds) / 1000) + 's (slow for this tool)' : tool + ' running ' + Math.round(ds[0] / 1000) + 's (slow for this tool)')
  const quiet = runningAgents(S).filter((a) => !a.current && now - a.lastAt > 120000 && !S.alerted['idle' + a.id + Math.floor(a.lastAt / 1000)])
  for (const a of quiet) S.alerted['idle' + a.id + Math.floor(a.lastAt / 1000)] = 1
  if (quiet.length === 1) out.push('subagent "' + quiet[0].desc + '" quiet for ' + Math.round((now - quiet[0].lastAt) / 1000) + 's')
  else if (quiet.length > 1) out.push(quiet.length + ' subagents quiet for over 2 minutes')
  for (const [path, f] of Object.entries(S.files)) {
    if (f.sinceEdit === 3) once('rr' + path, 'read ' + path.split('/').pop() + ' 3 times with no edit in between')
  }
  const keys = Object.keys(S.alerted)
  if (keys.length > 300) for (const k of keys.slice(0, 150)) delete S.alerted[k]
  return out
}

// ---------- persistence ----------
export function snapshot(S) {
  const { running, ...rest } = S
  return rest
}
export function restore(snap, ttlMin) {
  return { ...newState(ttlMin), ...snap, running: {}, ttlMin }
}
