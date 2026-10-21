// Cockpit: one recorder, many views. All `$` calls live in this file (validate needs them written in full).
import {
  newState,
  onToolStart,
  onToolEnd,
  onStepStart,
  onStepEnd,
  onTurnStart,
  onTurnComplete,
  onSpawn,
  syncAgents,
  count,
  onStep,
  onPlan,
  alerts,
  trackPeak,
  closeStale,
  snapshot,
  restore as restoreState,
  resolveTtl,
} from '../lib/model.js'
import { TABS, paneBody } from '../lib/views.js'
import { band, bandTiles } from '../lib/band.js'

const PANE = 'cockpit'
let S = newState()
let tab = 'trace'
// Trace tab: which trace is shown (null = the latest).
let view = { root: null }
let tickN = 0
let shown = '' // what the band showed at the last redraw: the tick redraws only when it changes

// Add this session's cost growth to the month's running total, kept in $.store so every session shares it.
// The plan is read from the limits the account reports. A plan seen once is remembered, because the
// limits are empty until the first response comes back, and guessing from empty data was wrong.
function detectPlan() {
  if (S.limits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')) return 'subscription'
  if (S.limits.some(l => l.kind === 'spend_limit')) return 'api'
  return null
}

// The month total adds up the engine's own cost figure (what /cost shows, at API list rates) for every session that
// ran with cockpit loaded. On API / enterprise accounts it is shown as spend; on a subscription it is only what the
// usage would have cost at API rates, shown as a guess of its worth.
async function trackSpend($) {
  const usd = S.cost && S.cost.usd
  const month = new Date().toISOString().slice(0, 7)
  const rec = (await $.store.get('spend')) || {}
  const counting = true
  let total = rec.month === month ? rec.usd || 0 : 0
  const since = rec.month === month && rec.since ? rec.since : await $.clock.now()
  if (typeof usd === 'number') {
    const delta = S.lastCost === null ? 0 : usd - S.lastCost // first reading: do not count what came before
    S.lastCost = usd
    if (counting && delta > 0) total += delta
  }
  if (counting ? total !== (rec.usd || 0) || rec.month !== month : rec.usd) {
    await $.store.set('spend', { month, usd: counting ? total : 0, since })
  }
  S.monthUsd = counting ? total : 0
  S.monthSince = since
  S.budgetUsd = Number(await $.store.get('budget')) || 0
  S.planFee = Number(await $.store.get('planFee')) || 0
}

// Pull the figures the engine owns (context, plan limits, cost) and the agent list.
async function refresh($) {
  const u = await $.session.usage()
  S.ctx = u.context
  S.limits = u.rateLimits || []
  S.cost = u.cost || null
  // /cockpit account api|subscription pins the plan; auto (the default) reads it off the limits the account reports.
  const forced = await $.store.get('account')
  const plan = forced === 'api' || forced === 'subscription' ? forced : detectPlan()
  if (plan && plan !== S.account) {
    S.account = plan
    await $.store.set('plan', plan)
    await refreshTtl($) // the automatic lifetime depends on the account type
  }
  await trackSpend($)
  syncAgents(S, await $.agent.list())
}

// Which cache lifetime Claude Code is really using, read from its settings and environment (the literal names are listed
// by `claude plugin validate`). What it cannot tell us (a subscription in overage drops to 5 minutes) /cockpit ttl covers.
async function refreshTtl($) {
  let set = {}
  try {
    set = (await $.settings.read()) || {}
  } catch {
    // settings not readable: fall back to automatic
  }
  const flag = (v) => v === '1' || v === 'true'
  const env = async (get) => {
    try {
      return await get()
    } catch {
      return undefined // an unreadable variable counts as unset
    }
  }
  const r = resolveTtl({
    envMain: await env(() => $.env.get('CLAUDE_CODE_PROMPT_CACHE_TTL')),
    envSub: await env(() => $.env.get('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL')),
    setMain: set.promptCacheTtl,
    setSub: set.subagentPromptCacheTtl,
    force5m: flag(await env(() => $.env.get('FORCE_PROMPT_CACHING_5M'))),
    enable1h: flag(await env(() => $.env.get('ENABLE_PROMPT_CACHING_1H'))),
    manual: S.ttlManual,
    account: S.account,
  })
  S.ttlMin = r.main
  S.ttlSubMin = r.sub
  S.ttlSource = r.src
}

// Where auto-compaction will run: the context breakdown knows it, counted locally (the 'summary' form sends no request).
async function refreshCompact($) {
  try {
    const b = (await $.session.usage({ breakdown: 'summary' })).context.breakdown
    if (b) {
      S.autoCompact = b.isAutoCompactEnabled
      S.compactAt = b.isAutoCompactEnabled ? b.autoCompactThreshold ?? null : null
    }
  } catch {
    // no breakdown in this build: the context tile shows no compaction mark
  }
}

async function tick($) {
  const now = await $.clock.now()
  tickN++
  if (tickN % 5 === 0) {
    try {
      await refresh($)
    } catch {
      // usage not available yet; try again next time
    }
  }
  if (tickN % 60 === 0) {
    await refreshTtl($).catch(() => {}) // settings and env rarely change: once a minute is enough
    await refreshCompact($)
  }
  trackPeak(S)
  closeStale(S, now)
  for (const text of alerts(S, now)) $.ui.toast('cockpit: ' + text, { timeoutMs: 6000 })
  // Redraw when the band would read differently, or every 5 s while something runs (the Trace tab's lanes grow).
  // Not every second: on Desktop each redraw swaps the whole SVG, and a swap every second reads as blinking.
  const sig = JSON.stringify(bandTiles(S, now))
  const busy = Object.keys(S.running).length || S.curTurn || Object.values(S.agents).some((a) => a.status === 'running')
  if (sig !== shown || (busy && tickN % 5 === 0)) {
    shown = sig
    $.ui.invalidate('ui.render')
  }
}

async function persist($) {
  const sid = await $.session.id()
  // One snapshot per chat: several chats at once used to overwrite each other's single slot. Keep the last few.
  await $.store.set('snap:' + sid, snapshot(S))
  const idx = ((await $.store.get('snaps')) || []).filter((x) => x !== sid)
  idx.unshift(sid)
  for (const old of idx.splice(6)) await $.store.set('snap:' + old, undefined)
  await $.store.set('snaps', idx)
}

async function load($) {
  const ttl = await $.store.get('ttlMin')
  const ttlMin = ttl === 60 ? 60 : 5
  const manual = ttl === 60 || ttl === 5 ? ttl : null // only what the user set with /cockpit ttl
  const sid = await $.session.id()
  let snap = await $.store.get('snap:' + sid)
  if (!snap) {
    const old = await $.store.get('snap') // the single slot of versions before 0.12.2
    if (old && old.sid === sid) snap = old.S
  }
  S = snap ? restoreState(snap, ttlMin) : newState(ttlMin)
  S.ttlManual = manual
  S.account = (await $.store.get('plan')) || null // remembered from an earlier session
  S.startedAt = S.startedAt || (await $.clock.now())
}

export function register(on) {
  // ---- setup: restore history, start the 1s ticker, add /cockpit ----
  on('session.start', async ($, e, next) => {
    await load($)
    if (e.cwd) S.cwd = e.cwd
    count(S, 'session.start', await $.clock.now())
    try {
      await refresh($) // show context and plan limits straight away, before any turn
      await refreshTtl($)
      await refreshCompact($)
    } catch {
      // usage not available yet; the ticker retries
    }
    try {
      await $.tool.register({
        name: 'step',
        description: 'For subagents: report your progress to the Agents tab and band. Call it right after reading your brief with total (your plan, 3-8 steps) and done: 0, then again as each step finishes. Cheap; it only updates a bar.',
        inputSchema: { type: 'object', properties: { done: { type: 'integer', minimum: 0 }, total: { type: 'integer', minimum: 1 }, note: { type: 'string' } }, required: ['done'] },
      })
      await $.tool.register({
        name: 'plan',
        description: 'For the orchestrator: post the plan of tasks you will delegate, in order. Each task title should equal the Agent description you use, so the plan can tick off as they finish. Call again to re-plan.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            tasks: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, tier: { type: 'string' }, after: { type: 'array', items: { type: 'integer' } } }, required: ['title'] } },
          },
          required: ['tasks'],
        },
      })
    } catch {
      // tools unavailable in this build: the rest of the mod still works
    }
    $.clock.every(1000, () => tick($))
    $.clock.every(15000, () => persist($))
    try {
      await $.command.register({
        name: 'cockpit',
        description: 'Open the cockpit pane (context, cache, tools, files, agents)',
        argumentHint: '[tab | ttl 5|60|auto | budget 200 | plan 100 | account api|subscription|auto | reset]',
        immediate: true,
      })
    } catch {
      // name already taken: the pane can still be opened by another mod's command
    }
    return next(e)
  })

  // Workers report their own steps; the orchestrator posts its plan. Both only update state.
  on('tool.call', { tool: 'mcp__cockpit__step' }, async ($, e) => {
    if (!e.agentId) return { result: 'ignored: only subagents report steps' }
    const ok = onStep(S, e.agentId, e, await $.clock.now())
    $.ui.invalidate('ui.render')
    return { result: ok ? 'ok' : 'unknown agent' }
  })
  on('tool.call', { tool: 'mcp__cockpit__plan' }, async ($, e) => {
    onPlan(S, e)
    $.ui.invalidate('ui.render')
    return { result: 'ok: plan with ' + (S.plan ? S.plan.tasks.length : 0) + ' tasks' }
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const a = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (a[0] === 'ttl') {
      if (a[1] === 'auto') {
        S.ttlManual = null
        await $.store.set('ttlMin', undefined)
        await refreshTtl($)
        return { text: 'cache lifetime: read from Claude Code settings (' + S.ttlMin + ' min main, ' + S.ttlSubMin + ' min subagents)' }
      }
      if (a[1] !== '5' && a[1] !== '60') return { text: 'usage: /cockpit ttl 5   or   /cockpit ttl 60   or   /cockpit ttl auto' }
      S.ttlManual = Number(a[1])
      await $.store.set('ttlMin', S.ttlManual)
      await refreshTtl($)
      return { text: 'cache lifetime set to ' + a[1] + ' minutes' + (S.ttlSource === 'manual' ? '' : ' (but ' + (S.ttlSource === 'env' ? 'an environment variable' : 'a Claude Code setting') + ' sets ' + S.ttlMin + ' min and wins)') }
    }
    if (a[0] === 'budget') {
      const v = a[1] === 'off' ? 0 : Number(a[1])
      if (!(v >= 0)) return { text: 'usage: /cockpit budget 200   (monthly USD)  or  /cockpit budget off' }
      await $.store.set('budget', v)
      S.budgetUsd = v
      return { text: v ? 'monthly budget set to $' + v + ' (counts API-rate cost of sessions run with cockpit loaded)' : 'monthly budget cleared' }
    }
    if (a[0] === 'plan') {
      const v = a[1] === 'off' ? 0 : Number(a[1])
      if (!(v >= 0)) return { text: 'usage: /cockpit plan 100   (what you pay per month, USD)  or  /cockpit plan off' }
      await $.store.set('planFee', v)
      S.planFee = v
      return { text: v ? 'subscription fee set to $' + v + '/month, to compare with the API-rate value of your usage' : 'subscription fee cleared' }
    }
    if (a[0] === 'account') {
      if (a[1] !== 'api' && a[1] !== 'subscription' && a[1] !== 'auto') return { text: 'usage: /cockpit account api   |   subscription   |   auto (read it from the limits the account reports)' }
      await $.store.set('account', a[1])
      if (a[1] === 'auto') S.account = null
      else S.account = a[1]
      return { text: a[1] === 'auto' ? 'account type: read from the limits the account reports' : 'account type pinned to ' + a[1] }
    }
    if (a[0] === 'reset') {
      view = { root: null }
      S = newState(S.ttlMin)
      S.startedAt = await $.clock.now()
      return { text: 'cockpit stats cleared' }
    }
    if (TABS.some((t) => t.id === a[0])) tab = a[0]
    await $.ui.open({ id: PANE, title: 'Cockpit', focus: true, closeOnEscape: true })
    return {}
  })

  // ---- tool calls: counts, failures, durations, file reads/edits, todos ----
  // Read off the rows the session keeps (the model's tool_use block, then the tool's tool_result) instead of wrapping
  // tool.call: a wrapper stays open for the whole tool run, and /cockpit and other hooks would queue behind it.
  on('session.append', async ($, e, next) => {
    const t = await $.clock.now()
    let seen = false
    for (const b of e.message.content || []) {
      if (b.type === 'tool_use') {
        onToolStart(S, b.id, b.name, e.agentId, t, b.input)
        count(S, 'tool.call', t)
        seen = true
      } else if (b.type === 'tool_result') {
        const text = typeof b.content === 'string' ? b.content : (b.content || []).map((c) => c.text || '').join(' ')
        onToolEnd(S, b.tool_use_id, !!b.is_error, t, text)
        seen = true
      }
    }
    if (seen) $.ui.invalidate('ui.render')
    return next(e)
  })

  // ---- model requests: cache read/write, model changes, subagent tokens ----
  on('turn.step', async function* ($, e, next) {
    onStepStart(S, e, await $.clock.now()) // the request's own span: it ends when the response is in
    $.ui.invalidate('ui.render')
    const result = yield* next(e)
    const t1 = await $.clock.now()
    onStepEnd(S, e, result, t1)
    count(S, e.agentId ? 'turn.step (agent)' : 'turn.step', t1)
    $.ui.invalidate('ui.render')
    return result
  })

  // ---- turns ----
  on('turn.start', async ($, e, next) => {
    const t = await $.clock.now()
    onTurnStart(S, e, t)
    count(S, 'turn.start', t)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const t = await $.clock.now()
    onTurnComplete(S, e, t)
    count(S, e.agentId ? 'turn.complete (agent)' : 'turn.complete', t)
    $.ui.invalidate('ui.render')
    return r
  })

  // ---- subagents and message passing ----
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    const t = await $.clock.now()
    if (r && r.agentId) onSpawn(S, r.agentId, e, r.model, t)
    count(S, 'agent.spawn', t)
    return r
  })

  on('session.compact', async ($, e, next) => {
    S.compactions++
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    S.ctx = e.context
    S.limits = e.rateLimits || []
    S.cost = e.cost || null
    count(S, 'session.measure', await $.clock.now())
    $.ui.invalidate('ui.render')
    return next(e)
  })

  // ---- drawing: one line above the prompt ----
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const theirs = await next(e)
    if (e.props.hasSurvey) return theirs
    const { Box, Text, Svg } = $.ui.resolve(e)
    const mine = band(Box, Text, S, await $.clock.now(), e.props.bodyColumns, e.surface, Svg)
    if (!mine) return theirs
    return Box({ flexDirection: 'column', children: theirs ? [theirs, mine] : [mine] })
  })

  // ---- drawing: the pane with tabs ----
  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE) return next(e)
    const { Box, Text, Button, Svg } = $.ui.resolve(e)
    const now = await $.clock.now()
    const redraw = () => $.ui.invalidate('ui.render')
    // The Trace tab's buttons page between traces.
    const ctl = {
      ...view,
      show: (rootId) => {
        view = { root: rootId }
        redraw()
      },
    }
    const tabs = TABS.map((t) =>
      Button({
        key: 'tab-' + t.id,
        label: t.label,
        hotkey: t.key,
        plain: true,
        dimColor: tab !== t.id,
        onPress: () => {
          tab = t.id
          $.ui.invalidate('ui.render')
        },
      }),
    )
    return Box({
      flexDirection: 'column',
      children: [Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 2, children: tabs }), Text({ children: [' '] }), paneBody(Box, Text, tab, S, now, e.props.bodyColumns, { Button, ctl, surface: e.surface, Svg })],
    })
  })
}
