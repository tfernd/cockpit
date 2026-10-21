// Cockpit recorder: plain state + pure mutators. No `$` in here, so it is unit-testable.

export const MAX_DURS = 500
export const MAX_STEPS = 200
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
    compactions: 0,
    ctx: null, // { tokens, window, percent }
    limits: [], // [{ kind, percentUsed, resetsAt }]
    cost: null,
    todos: null, // { done, total }
    alerted: {},
    dbg: {}, // event name -> { n, last }: what the recorder has actually seen
    cwd: null, // the workspace folder, to show paths relative to it
    peakRunning: 0, // most subagents running at once
    peakTools: 0, // most tool calls running at once (main loop and subagents together)
    // The trace (Trace tab): id -> { id, p (parent id), r (root id), k: 'turn'|'llm'|'tool'|'agent', n (name), d (detail),
    // m (model), ef (effort, model calls), a (agentId), t0, t1 (null while running), st: 'run'|'ok'|'err'|'abort', tok, cost, err, res }. Insertion ordered.
    spans: {},
    trace: null, // root span of the latest trace: a main-loop prompt, plus the turns its running subagents woke
    openTurn: {}, // 'main' -> the main loop's open turn span
    agentSpan: {}, // agentId -> its span (the Agent call it was started by, when there was one)
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

// ---------- tools & files ----------
export function onToolStart(S, id, tool, agentId, t, e) {
  const key = id ?? 'n' + S.seq++
  S.toolCalls++
  S.tools[tool] ??= { n: 0, fail: 0, durs: [] }
  S.tools[tool].n++
  S.running[key] = { tool, t, agentId }
  const live = Object.keys(S.running).length
  if (live > (S.peakTools || 0)) S.peakTools = live
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
  addSpan(S, { id: 't:' + key, p: parentFor(S, agentId, t), k: 'tool', n: tool, d: snip(detailOf(e), 160), a: agentId, t0: t, t1: null, st: 'run' })
  return key
}

export function onToolEnd(S, key, failed, t, errText) {
  const sp = S.spans['t:' + key]
  // An Agent call that started a subagent is that subagent's span: its run, not the call, decides when it ends.
  if (sp && (sp.k === 'tool' || (failed && sp.st === 'run'))) {
    sp.t1 = t
    sp.st = failed ? 'err' : 'ok'
    if (failed) sp.err = snip(errText, 200)
  }
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
  const sp = S.spans[stepId(e)] || onStepStart(S, e, t)
  sp.t1 = t
  sp.m = model
  sp.st = u || (result && result.stopReason) ? 'ok' : 'err'
  if (u) {
    sp.tok = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
    sp.cost = costOf(model, u)
    sp.cr = u.cache_read_input_tokens || 0 // cache read, written and sent fresh: the Trace tab marks misses and writes
    sp.cw = u.cache_creation_input_tokens || 0
    sp.cf = u.input_tokens || 0
  }
  const effort = e.effort === undefined ? null : e.effort
  let sw = null // a model or effort change seen on THIS request: its cache write is the price of switching
  if (!e.agentId) {
    S.lastMainStepAt = t
    if (model && model !== S.model) {
      if (S.model) {
        sw = { t, kind: 'model', from: S.model, to: model, rewrote: 0 }
      }
      S.model = model
      S.modelLog.push({ t, model })
      cap(S.modelLog, 50)
    }
    if (S.effortSeen && effort !== S.effort) {
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
  if (e.agentId) {
    // A subagent's run is its span; a message that wakes it again reopens it.
    const sp = ensureAgentSpan(S, e.agentId, t)
    if (sp.st !== 'run') Object.assign(sp, { t1: null, st: 'run' })
    return
  }
  S.curTurn = { id: e.turnId, t0: t, tools0: S.toolCalls, fails0: S.fails }
  // A turn that starts while the latest trace still has subagents running was woken by them (or typed while they work):
  // it continues that trace instead of starting a new one.
  const root = S.trace && S.spans[S.trace]
  const goesOn = root && Object.values(S.spans).some((s) => s.r === root.id && s.k === 'agent' && s.st === 'run')
  const sp = addSpan(S, { id: 'u:' + e.turnId, p: goesOn ? root.id : null, k: 'turn', n: snip(e.text, 80), t0: t, t1: null, st: 'run' })
  if (!goesOn) S.trace = sp.id
  S.openTurn.main = sp.id
}

const endState = (e) => (e.isAborted || e.reason === 'aborted' ? 'abort' : e.reason === 'error' || e.reason === 'refusal' ? 'err' : 'ok')

export function onTurnComplete(S, e, t) {
  if (e.agentId) {
    ensureAgentSpan(S, e.agentId, t)
    closeAgentSpan(S, e.agentId, t, endState(e), snip(e.answer, 200))
  } else {
    const sp = S.spans['u:' + e.turnId]
    if (sp) Object.assign(sp, { t1: t, st: endState(e) })
    if (S.openTurn.main === 'u:' + e.turnId) S.openTurn.main = null
  }
  if (e.agentId) {
    const a = ensureAgent(S, e.agentId, t)
    if (a) {
      a.lastAt = t
      a.endedAt = t
      a.current = null
      a.status = e.isAborted ? 'killed' : e.reason === 'error' ? 'failed' : 'completed'
      a.result = snip(e.answer, 160)
      a.resultAt = t
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
  trackPeak(S)
  linkAgentSpan(S, id, e, S.agents[id].model, t)
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
      const sp = S.spans[S.agentSpan[a.id]]
      if (sp && sp.st === 'run') Object.assign(sp, { t1: a.lastAt, st: 'abort', res: a.result })
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

// Claude Code's own agent list. It also closes the lane of a subagent whose end we never heard (a background
// subagent's turn.complete does not always reach the mod), at its last sign of life.
const ENDED = { completed: 'ok', failed: 'err', killed: 'abort' }
export function syncAgents(S, list) {
  for (const info of list || []) {
    const a = S.agents[info.id]
    if (a && info.status && a.status !== 'completed') a.status = info.status
    if (ENDED[info.status]) closeAgentSpan(S, info.id, a ? a.lastAt : null, ENDED[info.status])
  }
}

// Ends a subagent's span and anything of its own still marked running (its last call, SubagentHandback, gets no result).
function closeAgentSpan(S, agentId, t, st, res) {
  const sp = S.spans[S.agentSpan[agentId]]
  if (!sp || sp.st !== 'run') return
  const end = Math.max(sp.t0, t ?? sp.t0)
  Object.assign(sp, { t1: end, st }, res === undefined ? {} : { res })
  for (const x of Object.values(S.spans)) if (x.a === agentId && x.st === 'run' && (x.k === 'tool' || x.k === 'llm')) Object.assign(x, { t1: Math.max(x.t0, end), st: 'ok' })
}

export function runningAgents(S) {
  return Object.values(S.agents).filter((a) => a.status === 'running')
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

// ---------- trace: spans for the waterfall ----------
export const MAX_SPANS = 3000

// Adds a span under its parent's root. Past MAX_SPANS the oldest trace goes whole; when only the live trace is left,
// its oldest finished model and tool calls go instead (a single very long prompt stays bounded too).
function addSpan(S, sp) {
  const parent = sp.p ? S.spans[sp.p] : null
  sp.r = parent ? parent.r : sp.id
  S.spans[sp.id] = sp
  let ids = Object.keys(S.spans)
  while (ids.length > MAX_SPANS) {
    const oldest = S.spans[ids[0]].r
    if (oldest !== S.trace && oldest !== sp.r) {
      for (const id of ids) if (S.spans[id].r === oldest) delete S.spans[id]
    } else {
      const leaf = ids.find((id) => (S.spans[id].k === 'tool' || S.spans[id].k === 'llm') && S.spans[id].t1 !== null)
      if (!leaf) break
      delete S.spans[leaf]
    }
    ids = Object.keys(S.spans)
  }
  return sp
}

// Where a new span of a loop goes: under its subagent's span, or the main loop's open turn.
function parentFor(S, agentId, t) {
  if (agentId) return ensureAgentSpan(S, agentId, t).id
  return S.openTurn.main && S.spans[S.openTurn.main] ? S.openTurn.main : null
}

// A loop's span, made from its first event when no agent.spawn announced it (workflow agents, engine forks).
function ensureAgentSpan(S, agentId, t) {
  const have = S.spans[S.agentSpan[agentId]]
  if (have) return have
  const a = S.agents[agentId]
  const sp = addSpan(S, { id: 'a:' + agentId, p: parentFor(S, null, t) || S.trace, k: 'agent', n: a ? a.desc : 'loop', d: 'unlisted', m: (a && a.model) || '', a: agentId, t0: t, t1: null, st: 'run' })
  S.agentSpan[agentId] = sp.id
  return sp
}

// agent.spawn names the Agent call it belongs to (tool_use_id): that call's span becomes the subagent's.
function linkAgentSpan(S, agentId, e, model, t) {
  const call = e.tool_use_id ? S.spans['t:' + e.tool_use_id] : null
  const had = S.spans[S.agentSpan[agentId]]
  let sp
  if (had) {
    sp = had
    if (call && call !== had && call.k === 'tool') delete S.spans[call.id]
  } else if (call) {
    sp = Object.assign(call, { k: 'agent', t1: null, st: 'run' })
  } else {
    // No Agent call (a plugin's spawn, a workflow): under the open turn, else the latest trace.
    sp = addSpan(S, { id: 'a:' + agentId, p: parentFor(S, e.parentAgentId, t) || S.trace, k: 'agent', t0: t, t1: null, st: 'run' })
  }
  Object.assign(sp, { n: snip(e.description, 60), d: e.subagentType || '', m: model || e.model || sp.m || '', a: agentId })
  S.agentSpan[agentId] = sp.id
}

const stepId = (e) => 'l:' + (e.agentId || 'main') + ':' + e.turnId + ':' + e.index

// A model request starts: its span runs until the response is in (onStepEnd closes it).
export function onStepStart(S, e, t) {
  return addSpan(S, { id: stepId(e), p: parentFor(S, e.agentId, t), k: 'llm', n: 'model call', m: e.model, ef: e.effort, a: e.agentId, t0: t, t1: null, st: 'run' })
}

// The one argument that says what a tool call is about: a path, a description, a command, a pattern.
function detailOf(inp) {
  if (!inp || typeof inp !== 'object') return ''
  for (const k of ['file_path', 'notebook_path', 'description', 'command', 'pattern', 'query', 'url', 'prompt', 'skill', 'path']) if (typeof inp[k] === 'string') return inp[k]
  return Object.values(inp).find((v) => typeof v === 'string') || ''
}

// The traces in order: main-loop prompts that started one.
export function traceRoots(S) {
  return Object.values(S.spans).filter((s) => !s.p && s.k === 'turn')
}

// One trace as a tree: children by parent, in start order, and each span's end with its subtree (running ones end now).
export function traceTree(S, rootId, now) {
  const kids = {}
  const all = Object.values(S.spans).filter((s) => s.r === rootId)
  for (const s of all) if (s.p) (kids[s.p] ??= []).push(s)
  for (const k of Object.values(kids)) k.sort((x, y) => x.t0 - y.t0)
  const end = {}
  const endOf = (s) => (end[s.id] ??= Math.max(s.t1 ?? now, ...(kids[s.id] || []).map(endOf)))
  for (const s of all) endOf(s)
  return { all, kids, end }
}

// ---------- persistence ----------
export function snapshot(S) {
  const { running, ...rest } = S
  return rest
}
export function restore(snap, ttlMin) {
  return { ...newState(ttlMin), ...snap, running: {}, ttlMin }
}
