import { resolveTtl, parseTtl, subCache } from '../lib/model.js'
import { expect, mock, test } from 'claude-code/testing'
import { alerts, newState, onSpawn, onToolStart, onToolEnd, onStepStart, onStepEnd, onTurnStart, onTurnComplete, showPath, traceRoots, traceTree, snapshot, restore, MAX_SPANS } from '../lib/model.js'

const BAND = { plugin: 'cockpit', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 3 }, view: {} } } as const
const PANE = {
  plugin: 'cockpit',
  component: 'Pane',
  requestId: 'cockpit',
  viewport: { columns: 140, rows: 40 },
  props: { title: 'Cockpit', isFocused: true, bodyColumns: 110, placement: 'inline', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

// On Desktop the band is one Svg whose `alt` lists every pill; in the terminal it is Text elements in Boxes.
async function seen(ui: any, surface: string, needle: RegExp) {
  if (surface === 'desktop') {
    const svg = await ui.find({ type: 'Svg' })
    return svg && needle.test(svg.props.alt) ? svg : undefined
  }
  return ui.find({ type: 'Text', text: needle })
}

const TABS = ['trace', 'usage', 'files', 'debug']

// Stubs for everything Claude Code would answer, then drive one turn through the mod's hooks.
async function boot($: any, on: any, opts: { limits?: any[]; budget?: number; spend?: boolean } = {}) {
  mock.clock(on, { now: 1_700_000_000_000 })
  const saved = new Map<string, unknown>()
  if (opts.budget) saved.set('budget', opts.budget)
  if (opts.spend) saved.set('spend', { month: new Date().toISOString().slice(0, 7), usd: 142, since: Date.now() - 3 * 86_400_000 })
  on('store.get', ($: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', ($: any, e: any) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sid-1' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 280_000, window: 1_000_000, percent: 28 },
      rateLimits: opts.limits ?? [
        { kind: 'five_hour', percentUsed: 22, resetsAt: new Date(Date.now() + 9_000_000).toISOString() },
        { kind: 'seven_day', percentUsed: 58, resetsAt: new Date(Date.now() + 90_000_000).toISOString() },
      ],
      cost: { usd: 1.23 },
    },
  }))
  let spawned = 0
  on('agent.spawn', () => ({ model: 'haiku', agentId: 'ag' + ++spawned }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }))
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* ($: any, e: any) {
    yield { kind: 'text', index: 0, text: 'ok' }
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: { model: e.model, input_tokens: 5, output_tokens: 40, cache_read_input_tokens: e.model === 'claude-opus-5-5' ? 90_000 : 0, cache_creation_input_tokens: e.model === 'claude-opus-5-5' ? 3_000 : 93_000 },
    }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })
  let step = await stream.next()
  while (step.done !== true) step = await stream.next()
  await runTool($, 'Read', { file_path: '/a/x.ts' })
  await runTool($, 'Read', { file_path: '/a/x.ts' })
  await runTool($, 'Bash', { command: 'ls' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 4200, isAborted: false, usage: null })
}

// The recorder reads the rows the session keeps, so a test "runs a tool" by appending the model's tool_use and then the tool_result.
async function runTool($: any, tool: string, input: Record<string, unknown> = {}, agentId?: string, isError = false) {
  const id = 'tu' + Math.random().toString(36).slice(2)
  await $.session.append({ agentId, message: { type: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } })
  await $.session.append({ agentId, message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', is_error: isError }] } })
}

test('the band draws context, cache, turn and limits on both surfaces', async ($, on) => {
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    const missing: string[] = []
    for (const needle of [/context/, /28%/, /5h/, /22%/, /7d/, /58%/, /⟳2h/, /cache/, /last turn/, /3 tools/]) {
      if (!(await seen(ui, surface, needle))) missing.push(surface + ' ' + needle)
    }
    expect(missing).toEqual([])
    // subscription: no per-token bill, only a guess of what the usage is worth at API rates; the model is already in Claude's own footer
    expect(await seen(ui, surface, /worth/)).toBeUndefined()
    expect(await seen(ui, surface, /month/)).toBeUndefined()
    expect(await seen(ui, surface, /opus 5\.5/)).toBeUndefined()
    await ui.unmount()
  }
})

test('on Desktop a band that wraps is stretched edge to edge; a short one keeps its natural width', async ($, on) => {
  await boot($, on)
  // 60 columns * 8px = 480px: too narrow for one row, so every row but a short last one is justified to exactly 480
  const narrow = await $.ui.mount({ ...BAND, props: { ...BAND.props, bodyColumns: 60 }, surface: 'desktop' } as any)
  const svg = await narrow.find({ type: 'Svg' })
  expect(svg.props.width).toBe(480)
  expect(svg.props.source).toContain('width="480"')
  await narrow.unmount()
  // 120 columns: everything fits on one row, which is also the last row, so it is not stretched across the slot
  const wide = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  const w = await wide.find({ type: 'Svg' })
  expect(w.props.width).toBeLessThanOrEqual(962)
  expect(w.props.source).toContain('width="' + w.props.width + '"')
  await wide.unmount()
})

test('an enterprise / gateway account shows chat cost, the month with its projection, and the limit', async ($, on) => {
  await boot($, on, { limits: [{ kind: 'spend_limit', percentUsed: 42, resetsAt: new Date(Date.now() + 864_000_000).toISOString() }], budget: 200, spend: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    for (const needle of [/spend/, /42%/, /chat/, /1\.23/, /month/, /\$142/, /→ ~\$/, /\/\$200/]) {
      expect(await seen(ui, surface, needle)).toBeDefined()
    }
    expect(await seen(ui, surface, /5h/)).toBeUndefined() // no 5-hour window on a gateway account
    await ui.unmount()
  }
})

test('every pane tab draws a valid tree on both surfaces', async ($, on) => {
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    for (const id of TABS) {
      await ui.press({ key: 'tab-' + id })
      expect(await ui.find({ key: 'tab-' + id })).toBeDefined()
    }
    await ui.press({ key: 'tab-trace' })
    expect(await ui.find({ type: 'Text', text: 'Tools this session' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Read' })).toBeDefined()
    await ui.press({ key: 'tab-debug' })
    expect(await ui.find({ type: 'Text', text: 'tool.call' })).toBeDefined()
    await ui.unmount()
  }
})

test('the now pill and the Agents tab count launched, running, finished and failed', async ($, on) => {
  await boot($, on)
  const spawn = (d: string) =>
    ($ as any).agent.spawn({ tool_use_id: 'u' + d, prompt: 'p', description: d, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false })
  await spawn('one')
  await spawn('two')
  await spawn('three')
  await $.turn.complete({ turnId: 'a1', agentId: 'ag1', reason: 'answer', answer: 'found it', durationMs: 900, isAborted: false, usage: null })
  await $.turn.complete({ turnId: 'a2', agentId: 'ag2', reason: 'error', answer: '', durationMs: 900, isAborted: false, usage: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as any)
    expect(await seen(band, surface, /1 agent/)).toBeDefined() // the now pill counts the one still running
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: /3 subagents · 1 done · 1 running · 1 failed/ })).toBeDefined()
    await ui.press({ key: 'sp-a:ag1' })
    expect(await ui.find({ type: 'Text', text: /found it/ })).toBeDefined()
    await ui.unmount()
  }
})

test('a model switch shows what it cost the cache, and the Cache tab lists it', async ($, on) => {
  await boot($, on)
  const step = async (model: string, effort: string | undefined) => {
    const stream = $.turn.step({ turnId: 't2', index: 1, model, effort, messageCount: 4 } as any)
    let r = await stream.next()
    while (r.done !== true) r = await stream.next()
  }
  await step('claude-sonnet-5-5', 'high') // new model: nothing cached for it, so the whole prefix is written again
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as any)
    expect(await seen(band, surface, /model →/)).toBeUndefined() // switches live in the Cache tab, not the band
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    await ui.press({ key: 'tab-usage' })
    expect(await ui.find({ type: 'Text', text: /re-cached 93k tokens/ })).toBeDefined()
    await ui.unmount()
  }
})

test('subagents nest under the loop that spawned them in Trace, with their step progress and the plan', async ($, on) => {
  await boot($, on)
  const spawn = (d: string, parentAgentId?: string) =>
    ($ as any).agent.spawn({ tool_use_id: 'x' + d, prompt: 'p', description: d, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false, parentAgentId })
  const lead = await spawn('lead task')
  await spawn('child task', lead.agentId)
  await $.tool.call({ tool: 'mcp__cockpit__step', agentId: lead.agentId, done: 2, total: 5, note: 'reading code' } as any)
  await $.tool.call({ tool: 'mcp__cockpit__plan', title: 'release', tasks: [{ title: 'lead task', tier: 'careful' }, { title: 'other task', tier: 'light' }] } as any)
  await $.turn.complete({ turnId: 'z', agentId: lead.agentId, reason: 'answer', answer: 'ok', durationMs: 1, isAborted: false, usage: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as any)
    expect(await seen(band, surface, /1 agent/)).toBeDefined()
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: /child task/ })).toBeDefined() // nested under lead task's row
    expect(await ui.find({ type: 'Text', text: /plan release 1\/2/ })).toBeDefined()
    await ui.press({ key: 'sp-a:' + lead.agentId })
    expect(await ui.find({ type: 'Text', text: /step 2\/5 · reading code/ })).toBeDefined()
    await ui.unmount()
  }
})

test('an unknown plan shows no money pills', async ($, on) => {
  await boot($, on, { limits: [] })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await seen(ui, 'terminal', /month/)).toBeUndefined()
  expect(await seen(ui, 'terminal', /chat/)).toBeUndefined()
  await ui.unmount()
})

test('a subscription never shows a month bill, even with spend recorded before', async ($, on) => {
  await boot($, on, { spend: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await seen(ui, 'terminal', /month/)).toBeUndefined()
  await ui.unmount()
})

test('loops the engine never announced (workflow agents) are recorded from their events', async ($, on) => {
  await boot($, on)
  await runTool($, 'Read', { file_path: '/work/a.ts' }, 'wf-1')
  await $.turn.complete({ turnId: 'w1', agentId: 'wf-1', reason: 'answer', answer: 'checked', durationMs: 5, isAborted: false, usage: null })
  await runTool($, 'Read', { file_path: '/work/b.ts' }, 'wf-2')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect(await ui.find({ type: 'Text', text: /2 subagents · 1 done · 1 running/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /unlisted/ })).toBeDefined()
  await ui.unmount()
})

test('120 parallel subagents: counted, summarised, and only the ones worth a look are listed', async ($, on) => {
  await boot($, on)
  const spawned: string[] = []
  for (let i = 0; i < 120; i++) {
    const r = await ($ as any).agent.spawn({ tool_use_id: 'm' + i, prompt: 'p', description: 'job ' + i, subagentType: i % 2 ? 'Explore' : 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false })
    spawned.push(r.agentId)
  }
  for (const id of spawned.slice(0, 100)) await $.turn.complete({ turnId: 'f' + id, agentId: id, reason: id === spawned[3] ? 'error' : 'answer', answer: 'ok', durationMs: 1000, isAborted: false, usage: null })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface } as any)
    expect(await seen(band, surface, /20 agents/)).toBeDefined()
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    expect(await ui.find({ type: 'Text', text: /120 subagents · 99 done · 20 running · 1 failed · most at once 120/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /more rows/ })).toBeDefined() // the list is capped, not 120 rows
    await ui.unmount()
  }
})

test('files inside the workspace show relative, files outside show in full with a marker', async ($, on) => {
  await boot($, on)
  await runTool($, 'Read', { file_path: '/work/src/deep/m.ts' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  await ui.press({ key: 'tab-files' })
  expect(await ui.find({ type: 'Text', text: 'src/deep/m.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↗ /a/x.ts' })).toBeDefined()
  await ui.unmount()
})

test('a pinned account type shows API money even when the account reports no limits', async ($, on) => {
  await boot($, on, { limits: [], budget: 200, spend: true })
  await $.command.run({ command: 'cockpit', args: 'account api' } as any)
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect(await seen(ui, 'terminal', /chat/)).toBeDefined()
  await ui.unmount()
})

test('toasts: an Agent call never counts as a slow tool, and batches become one toast', async () => {
  const S: any = newState()
  const t0 = 1_700_000_000_000
  onToolStart(S, 'a1', 'Agent', undefined, t0, {})
  onToolStart(S, 'b1', 'Bash', undefined, t0, {})
  onToolStart(S, 'b2', 'Bash', undefined, t0, {})
  for (let i = 0; i < 5; i++) onSpawn(S, 'g' + i, { description: 'job' + i, subagentType: 'Explore' }, 'haiku', t0)
  const out = alerts(S, t0 + 200_000)
  expect(out.some((x: string) => /^Agent/.test(x))).toBe(false)
  expect(out.filter((x: string) => /^Bash x2/.test(x)).length).toBe(1)
  expect(out.filter((x: string) => /5 subagents quiet/.test(x)).length).toBe(1)
  expect(alerts(S, t0 + 201_000)).toEqual([]) // each fires once
})

test('paths: relative inside the workspace, full and flagged outside', async () => {
  expect(showPath('/w/proj', '/w/proj/src/a.ts')).toEqual({ t: 'src/a.ts', outside: false })
  expect(showPath('/w/proj/', '/w/proj/a.ts')).toEqual({ t: 'a.ts', outside: false })
  expect(showPath('/w/proj', '/w/project/a.ts')).toEqual({ t: '/w/project/a.ts', outside: true })
  expect(showPath('/w/proj', '/etc/hosts')).toEqual({ t: '/etc/hosts', outside: true })
  expect(showPath(null, '/etc/hosts')).toEqual({ t: '/etc/hosts', outside: false })
})

test('cache lifetimes follow Claude Code: env beats setting, a subscription is 1 h on its own, subagents are 5 min unless 1 h is enabled', () => {
  expect(resolveTtl({ account: 'subscription' })).toEqual({ main: 60, sub: 5, src: 'auto' })
  expect(resolveTtl({ account: 'api' })).toEqual({ main: 5, sub: 5, src: 'auto' })
  expect(resolveTtl({ setMain: '1h', envMain: '5m', account: 'subscription' }).main).toBe(5)
  expect(resolveTtl({ setMain: '1h', setSub: '1h' })).toEqual({ main: 60, sub: 60, src: 'setting' })
  expect(resolveTtl({ enable1h: true, account: 'api' })).toEqual({ main: 60, sub: 60, src: 'env' })
  expect(resolveTtl({ force5m: true, account: 'subscription' }).main).toBe(5)
  expect(resolveTtl({ manual: 5, account: 'subscription' }).main).toBe(5)
  expect(parseTtl('bogus')).toBeNull()
})

test('subagent caches count from the end of each one\'s last request', () => {
  const S: any = { ttlSubMin: 5, agents: { a: { stepAt: 1000 }, b: { stepAt: 200_000 }, c: {} } }
  expect(subCache(S, 310_000)).toMatchObject({ seen: 2, warm: 1, next: 190_000 })
  expect(subCache(S, 700_000).warm).toBe(0)
})

test('the now pill names the newest tool in flight and counts the others', async ($, on) => {
  await boot($, on)
  const open = (name: string, agentId?: string) => $.session.append({ agentId, message: { type: 'assistant', content: [{ type: 'tool_use', id: 'p' + name + (agentId ?? ''), name, input: {} }] } })
  await open('Bash')
  await open('Read')
  await open('Grep', 'ag1')
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    for (const needle of [/now/, /Grep/, /\+2 tools/]) expect(await seen(ui, surface, needle)).toBeDefined()
    await ui.unmount()
  }
})

// ---------- trace ----------
const usage = (model: string) => ({ usage: { model, input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000 }, stopReason: 'end_turn' })

// One prompt: a model call, two tools (one fails), a background subagent with its own model call and tool,
// then a turn the subagent wakes while it still runs, then the subagent ends.
function seedTrace() {
  const S: any = newState()
  onTurnStart(S, { turnId: 't1', text: 'ship the pricing page' }, 1000)
  onStepStart(S, { turnId: 't1', index: 0, model: 'claude-opus-5-5' }, 1000)
  onStepEnd(S, { turnId: 't1', index: 0, model: 'claude-opus-5-5' }, usage('claude-opus-5-5'), 4000)
  onToolStart(S, 'r1', 'Read', undefined, 4000, { file_path: '/work/a.ts' })
  onToolEnd(S, 'r1', false, 4200)
  onToolStart(S, 'b1', 'Bash', undefined, 4200, { command: 'pnpm test', description: 'Run checkout tests' })
  onToolEnd(S, 'b1', true, 12_600, '2 of 14 checkout tests fail')
  onToolStart(S, 'ag1', 'Agent', undefined, 13_000, { description: 'research competitors' })
  onSpawn(S, 'x1', { tool_use_id: 'ag1', description: 'research competitors', subagentType: 'Explore', background: true }, 'claude-sonnet-5-5', 13_100)
  onToolEnd(S, 'ag1', false, 13_400) // a background agent's call returns at once: its span runs on
  onTurnStart(S, { agentId: 'x1', turnId: 'x1t' }, 13_200)
  onStepStart(S, { turnId: 'x1t', index: 0, model: 'claude-sonnet-5-5', agentId: 'x1' }, 13_200)
  onStepEnd(S, { turnId: 'x1t', index: 0, model: 'claude-sonnet-5-5', agentId: 'x1' }, usage('claude-sonnet-5-5'), 20_000)
  onToolStart(S, 'w1', 'WebSearch', 'x1', 20_000, { query: 'linear pricing' })
  onToolEnd(S, 'w1', false, 25_400)
  onTurnComplete(S, { turnId: 't1', reason: 'answer', answer: 'started', durationMs: 13_000, isAborted: false }, 14_000)
  onTurnStart(S, { turnId: 't2', text: '' }, 30_000) // woken while x1 still runs: same trace
  onTurnComplete(S, { turnId: 't2', reason: 'answer', answer: '', durationMs: 1000, isAborted: false }, 31_000)
  onTurnComplete(S, { turnId: 'x1t', agentId: 'x1', reason: 'answer', answer: 'Linear charges per seat', durationMs: 40_000, isAborted: false }, 53_000)
  return S
}

test('the trace nests model calls, tools and subagents under their prompt, timed by their own events', () => {
  const S = seedTrace()
  const roots = traceRoots(S)
  expect(roots.map((r: any) => r.n)).toEqual(['ship the pricing page'])
  const { kids, end } = traceTree(S, roots[0].id, 60_000)
  const names = (id: string) => (kids[id] || []).map((s: any) => s.k + ':' + s.n)
  expect(names('u:t1')).toEqual(['llm:model call', 'tool:Read', 'tool:Bash', 'agent:research competitors', 'turn:'])
  // the Agent call became the subagent's span: it ends with the subagent's run, not when the call returned
  const agent = S.spans['t:ag1']
  expect([agent.k, agent.d, agent.m, agent.t0, agent.t1, agent.st, agent.res]).toEqual(['agent', 'Explore', 'claude-sonnet-5-5', 13_000, 53_000, 'ok', 'Linear charges per seat'])
  expect(names('t:ag1')).toEqual(['llm:model call', 'tool:WebSearch'])
  const bash = S.spans['t:b1']
  expect([bash.st, bash.err, bash.d]).toEqual(['err', '2 of 14 checkout tests fail', 'Run checkout tests'])
  const call = S.spans['l:main:t1:0']
  expect([call.t0, call.t1, call.tok]).toEqual([1000, 4000, 51_210])
  expect(call.cost).toBeGreaterThan(0)
  expect(end['u:t1']).toBe(53_000) // the prompt's trace lasts until its subagent is done
})

test('a prompt sent once the subagents are done starts a new trace; the oldest traces go past the cap', () => {
  const S = seedTrace()
  onTurnStart(S, { turnId: 't3', text: 'now the docs' }, 60_000)
  expect(traceRoots(S).map((r: any) => r.n)).toEqual(['ship the pricing page', 'now the docs'])
  for (let i = 0; i < MAX_SPANS + 10; i++) {
    onToolStart(S, 'm' + i, 'Read', undefined, 61_000 + i, { file_path: '/x' })
    onToolEnd(S, 'm' + i, false, 61_000 + i)
  }
  expect(Object.keys(S.spans).length).toBeLessThanOrEqual(MAX_SPANS)
  expect(traceRoots(S).map((r: any) => r.n)).toEqual(['now the docs'])
  expect(S.spans['t:ag1']).toBeUndefined()
})

test('the trace survives a snapshot and restore', () => {
  const S = seedTrace()
  const back: any = restore(JSON.parse(JSON.stringify(snapshot(S))), 5)
  expect(Object.keys(back.spans)).toEqual(Object.keys(S.spans))
  expect(back.trace).toBe('u:t1')
})

test('the Trace tab draws the waterfall on both surfaces; rows select, open and close, and the card shows the error', async ($, on) => {
  await boot($, on)
  // a second prompt with a failing tool and a subagent that runs one tool
  await $.turn.start({ text: 'fix the checkout', turnId: 't2' })
  await $.session.append({ message: { type: 'assistant', content: [{ type: 'tool_use', id: 'tu-fail', name: 'Bash', input: { command: 'pnpm test checkout' } }] } } as any)
  await $.session.append({ message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-fail', content: [{ type: 'text', text: '2 of 14 checkout tests fail' }], is_error: true }] } } as any)
  const r = await $.agent.spawn({ tool_use_id: 'u-sub', prompt: 'p', description: 'read the tests', subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false } as any)
  await runTool($, 'Grep', { pattern: 'coupon' }, r.agentId)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    await ui.press({ key: 'tab-trace' })
    for (const needle of [/^Trace$/, /fix the checkout/, /● live/, /trace 2 of 2/, /tool calls/, /read the tests/, /Grep/, /coupon/]) expect([surface, needle, !!(await ui.find({ type: 'Text', text: needle }))]).toEqual([surface, needle, true])
    // the failed Bash: select it, the card shows what failed
    expect(await ui.find({ type: 'Text', text: /2 of 14 checkout tests fail/ })).toBeUndefined()
    await ui.press({ key: 'sp-t:tu-fail' })
    expect(await ui.find({ type: 'Text', text: /2 of 14 checkout tests fail/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /tool call · failed/ })).toBeDefined()
    // close the subagent: its tool row goes; open it again: it is back
    const agentKey = 'sp-a:' + r.agentId
    await ui.press({ key: agentKey })
    await ui.press({ key: agentKey })
    expect(await ui.find({ type: 'Text', text: /coupon/ })).toBeUndefined()
    await ui.press({ key: agentKey })
    expect(await ui.find({ type: 'Text', text: /coupon/ })).toBeDefined()
    // show failed only: the Bash stays, the subagent's Grep goes; back to all
    await ui.press({ key: 'filter-failed' })
    expect(await ui.find({ type: 'Text', text: /pnpm test checkout/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /coupon/ })).toBeUndefined()
    await ui.press({ key: 'filter-all' })
    // page back to the first trace and forth again
    await ui.press({ key: 'trace-prev' })
    expect(await ui.find({ type: 'Text', text: /trace 1 of 2/ })).toBeDefined()
    await ui.press({ key: 'trace-next' })
    await ui.unmount()
  }
})
