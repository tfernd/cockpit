// Cockpit recorder: plain state + pure mutators. No `$` in here, so it is unit-testable.

export const MAX_DURS = 500
export const MAX_STEPS = 200
export const MAX_MSGS = 200
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function newState(ttlMin = 5) {
  return {
    v: 1,
    ttlMin, // prompt-cache lifetime in minutes (5 or 60)
    startedAt: 0,
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
  const a = agentId ? S.agents[agentId] : null
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
    const a = S.agents[e.agentId]
    if (a) {
      a.steps++
      a.out += out
      a.ctx = read + wrote + fresh
      a.lastAt = t
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
    const a = S.agents[e.agentId]
    if (a) {
      a.lastAt = t
      a.endedAt = t
      a.current = null
      a.status = e.isAborted ? 'killed' : e.reason === 'error' ? 'failed' : 'completed'
      a.result = snip(e.answer, 160)
      a.resultAt = t
      pushMsg(S, t, 'result', a.desc + ' → ' + snip(e.answer, 90))
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

export function onSpawn(S, id, e, model, t) {
  S.agents[id] = {
    id,
    desc: snip(e.description, 60),
    type: e.subagentType,
    model: model || e.model || '',
    bg: !!e.background,
    startedAt: t,
    lastAt: t,
    tools: 0,
    fails: 0,
    steps: 0,
    out: 0,
    ctx: 0,
    status: 'running',
    current: null,
  }
  pushMsg(S, t, 'spawn', e.subagentType + ': ' + snip(e.description, 80))
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
  for (const [key, r] of Object.entries(S.running)) {
    const st = S.tools[r.tool]
    const limit = st && st.durs.length >= 8 ? Math.max(45000, 3 * pctl(st.durs, 95)) : 90000
    if (now - r.t > limit) once('stall' + key, r.tool + ' running ' + Math.round((now - r.t) / 1000) + 's (slow for this tool)')
  }
  for (const a of runningAgents(S)) {
    if (!a.current && now - a.lastAt > 120000) once('idle' + a.id + Math.floor(a.lastAt / 1000), 'subagent "' + a.desc + '" quiet for ' + Math.round((now - a.lastAt) / 1000) + 's')
  }
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
