import { expect, mock, test } from 'claude-code/testing'

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

const TABS = ['overview', 'tools', 'files', 'cache', 'agents', 'timeline', 'debug']

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
  await $.tool.call({ tool: 'Read', file_path: '/a/x.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/a/x.ts' })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.turn.complete({ turnId: 't1', reason: 'answer', answer: 'done', durationMs: 4200, isAborted: false, usage: null })
}

test('the band draws context, cache, turn and limits on both surfaces', async ($, on) => {
  await boot($, on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    const missing: string[] = []
    for (const needle of [/ctx/, /28%/, /5h/, /22%/, /7d/, /58%/, /⟳2h/, /cache/, /turn 1/, /out/, /cached/]) {
      if (!(await seen(ui, surface, needle))) missing.push(surface + ' ' + needle)
    }
    expect(missing).toEqual([])
    // subscription: no per-token bill, and the model is already in Claude's own footer
    expect(await seen(ui, surface, /1\.23/)).toBeUndefined()
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
    await ui.press({ key: 'tab-tools' })
    expect(await ui.find({ type: 'Text', text: 'Read' })).toBeDefined()
    await ui.press({ key: 'tab-debug' })
    expect(await ui.find({ type: 'Text', text: 'tool.call' })).toBeDefined()
    await ui.unmount()
  }
})

test('the agents pill and tab count launched, running, finished and failed', async ($, on) => {
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
    expect(await seen(band, surface, /1\/3/)).toBeDefined() // 1 of 3 finished
        expect(await seen(band, surface, /1 failed/)).toBeDefined()
    expect(await seen(band, surface, /three/)).toBeDefined() // the still-running agent has a pill labelled with its task
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ type: 'Text', text: /3 launched · 1 finished · 1 running · 1 failed/ })).toBeDefined()
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
    expect(await seen(band, surface, /model →/)).toBeDefined()
    expect(await seen(band, surface, /sonnet 5\.5/)).toBeDefined()
    expect(await seen(band, surface, /re-cached 93k/)).toBeDefined()
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    await ui.press({ key: 'tab-cache' })
    expect(await ui.find({ type: 'Text', text: /re-cached 93k tokens/ })).toBeDefined()
    await ui.unmount()
  }
})

test('subagents nest under the loop that spawned them, workers report steps, the plan pill ticks off', async ($, on) => {
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
    expect(await seen(band, surface, /plan/)).toBeDefined()
    expect(await seen(band, surface, /1\/2/)).toBeDefined()
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE, surface } as any)
    await ui.press({ key: 'tab-agents' })
    expect(await ui.find({ type: 'Text', text: /├─|└─/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /step 2\/5 · reading code/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the Agents tab on Desktop shows one square per subagent, with the plan as hollow squares', async ($, on) => {
  await boot($, on)
  for (const d of ['a', 'b', 'c']) await ($ as any).agent.spawn({ tool_use_id: 'g' + d, prompt: 'p', description: d, subagentType: 'Explore', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false })
  await $.tool.call({ tool: 'mcp__cockpit__plan', title: 'grid', tasks: [{ title: 'a', tier: 'light' }, { title: 'z', tier: 'light' }] } as any)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  await ui.press({ key: 'tab-agents' })
  const svgs = await ui.find({ type: 'Svg' })
  expect(svgs).toBeDefined()
  expect(svgs.props.alt).toMatch(/3 agents/)
  await ui.unmount()
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
