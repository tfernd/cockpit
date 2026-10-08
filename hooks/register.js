// Cockpit: one recorder, many views. All `$` calls live in this file (validate needs them written in full).
import {
  newState,
  onToolStart,
  onToolEnd,
  onStepEnd,
  onTurnStart,
  onTurnComplete,
  onSpawn,
  syncAgents,
  pushMsg,
  count,
  alerts,
  snapshot,
  restore as restoreState,
} from '../lib/model.js'
import { TABS } from '../lib/views.js'
import { band, paneBody } from '../lib/pills.js'

const PANE = 'cockpit'
let S = newState()
let tab = 'overview'
let tickN = 0

// Add this session's cost growth to the month's running total, kept in $.store so every session shares it.
async function trackSpend($) {
  const usd = S.cost && S.cost.usd
  const month = new Date().toISOString().slice(0, 7)
  const rec = (await $.store.get('spend')) || {}
  let total = rec.month === month ? rec.usd || 0 : 0
  if (typeof usd === 'number') {
    const delta = S.lastCost === null ? 0 : usd - S.lastCost // first reading: do not count what came before
    S.lastCost = usd
    if (delta > 0) {
      total += delta
      await $.store.set('spend', { month, usd: total })
    }
  }
  S.monthUsd = total
  S.budgetUsd = Number(await $.store.get('budget')) || 0
}

// Pull the figures the engine owns (context, plan limits, cost) and the agent list.
async function refresh($) {
  const u = await $.session.usage()
  S.ctx = u.context
  S.limits = u.rateLimits || []
  S.cost = u.cost || null
  await trackSpend($)
  syncAgents(S, await $.agent.list())
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
  for (const text of alerts(S, now)) $.ui.toast('cockpit: ' + text, { timeoutMs: 6000 })
  $.ui.invalidate('ui.render')
}

async function persist($) {
  const sid = await $.session.id()
  await $.store.set('snap', { sid, S: snapshot(S) })
}

async function load($) {
  const ttl = await $.store.get('ttlMin')
  const ttlMin = ttl === 60 ? 60 : 5
  const snap = await $.store.get('snap')
  const sid = await $.session.id()
  S = snap && snap.sid === sid && snap.S ? restoreState(snap.S, ttlMin) : newState(ttlMin)
  S.startedAt = S.startedAt || (await $.clock.now())
}

export function register(on) {
  // ---- setup: restore history, start the 1s ticker, add /cockpit ----
  on('session.start', async ($, e, next) => {
    await load($)
    count(S, 'session.start', await $.clock.now())
    try {
      await refresh($) // show context and plan limits straight away, before any turn
    } catch {
      // usage not available yet; the ticker retries
    }
    $.clock.every(1000, () => tick($))
    $.clock.every(15000, () => persist($))
    try {
      await $.command.register({
        name: 'cockpit',
        description: 'Open the cockpit pane (context, cache, tools, files, agents)',
        argumentHint: '[tab | ttl 5|60 | budget 200 | reset]',
        immediate: true,
      })
    } catch {
      // name already taken: the pane can still be opened by another mod's command
    }
    return next(e)
  })

  on('command.run', { command: 'cockpit' }, async ($, e) => {
    const a = String(e.args || '').trim().toLowerCase().split(/\s+/)
    if (a[0] === 'ttl') {
      if (a[1] !== '5' && a[1] !== '60') return { text: 'usage: /cockpit ttl 5   or   /cockpit ttl 60' }
      S.ttlMin = Number(a[1])
      await $.store.set('ttlMin', S.ttlMin)
      return { text: 'cache lifetime set to ' + a[1] + ' minutes' }
    }
    if (a[0] === 'budget') {
      const v = a[1] === 'off' ? 0 : Number(a[1])
      if (!(v >= 0)) return { text: 'usage: /cockpit budget 200   (monthly USD)  or  /cockpit budget off' }
      await $.store.set('budget', v)
      S.budgetUsd = v
      return { text: v ? 'monthly budget set to $' + v + ' (counts API-rate cost of sessions run with cockpit loaded)' : 'monthly budget cleared' }
    }
    if (a[0] === 'reset') {
      S = newState(S.ttlMin)
      S.startedAt = await $.clock.now()
      return { text: 'cockpit stats cleared' }
    }
    if (TABS.some((t) => t.id === a[0])) tab = a[0]
    await $.ui.open({ id: PANE, title: 'Cockpit', focus: true, closeOnEscape: true })
    return {}
  })

  // ---- tool calls: counts, failures, durations, file reads/edits, todos ----
  on('tool.call', async ($, e, next) => {
    const t0 = await $.clock.now()
    const key = onToolStart(S, e.tool_use_id, e.tool, e.agentId, t0, e)
    count(S, 'tool.call', t0)
    $.ui.invalidate('ui.render')
    let failed = true
    try {
      const r = await next(e)
      failed = !!(r && (r.deny || r.isError))
      return r
    } finally {
      onToolEnd(S, key, failed, await $.clock.now())
      $.ui.invalidate('ui.render')
    }
  })

  // ---- model requests: cache read/write, model changes, subagent tokens ----
  on('turn.step', async function* ($, e, next) {
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

  on('session.send', async ($, e, next) => {
    pushMsg(S, await $.clock.now(), 'send', (typeof e.to === 'string' ? e.to : JSON.stringify(e.to)) + ': ' + e.text)
    return next(e)
  })

  on('session.receive', async ($, e, next) => {
    pushMsg(S, await $.clock.now(), 'recv', (e.origin && e.origin.kind) + ': ' + e.text)
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    S.compactions++
    pushMsg(S, await $.clock.now(), 'compact', 'conversation compacted')
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
      children: [Box({ flexDirection: 'row', columnGap: 2, children: tabs }), Text({ children: [' '] }), paneBody(Box, Text, tab, S, now, e.props.bodyColumns, e.surface, Svg)],
    })
  })
}
