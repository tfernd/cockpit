import { mock, test } from 'claude-code/testing'

// Not a real test: with COCKPIT_SHOTS_DIR set it seeds a busy session and dumps the tree of every tab
// (and the band) as JSON, for tools/shots.mjs to turn into PNGs. Without it, it does nothing.
const OUT = true

const PANE = (columns: number) =>
  ({
    plugin: 'cockpit',
    component: 'Pane',
    requestId: 'cockpit',
    viewport: { columns, rows: 50 },
    props: { title: 'Cockpit', isFocused: true, bodyColumns: columns - 4, placement: 'inline', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  }) as const
const BAND = (columns: number) => ({ plugin: 'cockpit', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: columns, scroll: { offset: 0, bodyRows: 3 }, view: {} } }) as const
const TABS = ['overview', 'tools', 'files', 'cache', 'agents', 'timeline', 'debug']

test('dump trees for screenshots', async ($: any, on: any) => {
  if (!OUT) return
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  const saved = new Map<string, unknown>([['budget', 200]])
  on('store.get', (_: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', (_: any, e: any) => (saved.set(e.key, e.value), { value: undefined }))
  on('session.id', () => ({ value: 'sid-shots' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 612_000, window: 1_000_000, percent: 61 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 72, resetsAt: new Date(Date.now() + 9_000_000).toISOString() },
        { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(Date.now() + 250_000_000).toISOString() },
      ],
      cost: { usd: 7.42 },
    },
  }))
  let n = 0
  on('agent.spawn', () => ({ model: n % 3 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', agentId: 'ag' + ++n }))
  on('session.start', () => ({ cwd: '/work' }))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId }))
  on('tool.call', async (_: any, e: any) => {
    await clock.advance(e.tool === 'Bash' ? 4200 : e.tool === 'Grep' ? 900 : e.tool === 'Agent' ? 38_000 : 120 + (e.file_path?.length ?? 0) * 9)
    return e.command === 'false' ? { isError: true, result: 'exit 1' } : { result: 'ok' }
  })
  on('turn.complete', () => ({ text: '' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  on('turn.step', async function* (_: any, e: any) {
    await clock.advance(1800)
    yield { kind: 'text', index: 0, text: 'ok' }
    const fresh = e.model === 'claude-sonnet-5-5'
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 6, output_tokens: 300 + e.index * 40, cache_read_input_tokens: fresh ? 0 : 140_000 + e.index * 9_000, cache_creation_input_tokens: fresh ? 160_000 : 2_500 } }
  })

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const step = async (turnId: string, index: number, model: string, effort?: string) => {
    const s = $.turn.step({ turnId, index, model, effort, messageCount: index + 1 } as any)
    let r = await s.next()
    while (r.done !== true) r = await s.next()
  }
  for (let t = 1; t <= 4; t++) {
    await $.turn.start({ text: 'go', turnId: 't' + t })
    await step('t' + t, 0, 'claude-opus-5-5', 'xhigh')
    for (const f of ['/work/src/server/routes/index.ts', '/work/src/lib/model.js', '/work/README.md', '/home/me/.config/claude/settings.json']) await $.tool.call({ tool: 'Read', file_path: f })
    await $.tool.call({ tool: 'Edit', file_path: '/work/src/lib/model.js' })
    await $.tool.call({ tool: 'Read', file_path: '/work/src/lib/model.js' })
    await $.tool.call({ tool: 'Grep', pattern: 'x' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    if (t === 2) await $.tool.call({ tool: 'Bash', command: 'false' })
    await $.tool.call({ tool: 'TodoWrite', todos: [{ status: 'completed' }, { status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'pending' }] })
    await $.turn.complete({ turnId: 't' + t, reason: 'answer', answer: 'done', durationMs: 18_000 + t * 7_000, isAborted: false, usage: null })
    if (t === 2) {
      await step('t2b', 1, 'claude-sonnet-5-5', 'medium')
    }
  }
  await $.tool.call({ tool: 'mcp__cockpit__plan', title: 'ship 0.9', tasks: [{ title: 'map the code', tier: 'light' }, { title: 'fix the layout', tier: 'careful' }, { title: 'write tests', tier: 'light' }, { title: 'release', tier: 'light' }] } as any)
  const spawn = (d: string, type: string, parentAgentId?: string) =>
    $.agent.spawn({ tool_use_id: 'u' + d, prompt: 'p', description: d, subagentType: type, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: false, fork: false, parentAgentId } as any)
  const lead = await spawn('map the code', 'Explore')
  const kid = await spawn('read the tests', 'Explore', lead.agentId)
  const fix = await spawn('fix the layout', 'general-purpose')
  await spawn('write tests', 'general-purpose')
  for (const a of [lead, kid, fix]) {
    await $.tool.call({ tool: 'mcp__cockpit__step', agentId: a.agentId, done: 2, total: 5, note: 'reading code' } as any)
    await $.tool.call({ tool: 'Read', agentId: a.agentId, file_path: '/work/a.ts' } as any)
    const s = $.turn.step({ turnId: 'a' + a.agentId, index: 0, model: 'claude-haiku-5-5', agentId: a.agentId, messageCount: 2 } as any)
    let r = await s.next()
    while (r.done !== true) r = await s.next()
  }
  await $.turn.complete({ turnId: 'z1', agentId: lead.agentId, reason: 'answer', answer: 'the model lives in lib/model.js; views are pure functions of its state', durationMs: 31_000, isAborted: false, usage: null })
  await $.turn.complete({ turnId: 'z2', agentId: kid.agentId, reason: 'error', answer: '', durationMs: 9_000, isAborted: false, usage: null })
  await clock.advance(20_000)

  const dump: Record<string, unknown> = {}
  for (const columns of [52, 120]) {
    const ui = await $.ui.mount({ ...PANE(columns), surface: 'desktop' } as any)
    for (const id of TABS) {
      await ui.press({ key: 'tab-' + id })
      dump[`${id}-${columns}`] = await ui.drawn()
    }
    await ui.unmount()
    const band = await $.ui.mount({ ...BAND(columns), surface: 'desktop' } as any)
    dump[`band-${columns}`] = await band.drawn()
    await band.unmount()
  }

  // A big crew: 110 more agents in parallel, most finished, a few failed, some running, and loops nobody announced.
  const ids: string[] = []
  for (let i = 0; i < 110; i++) {
    const r = await spawn('job ' + i + ' check module ' + (i % 17), i % 3 ? 'Explore' : 'general-purpose')
    ids.push(r.agentId)
  }
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]
    if (i % 9 === 8) continue // still running
    for (let k = 0; k < 1 + (i % 5 === 0 ? 1 : 0); k++) {
      if (i % 3 === 0) await $.tool.call({ tool: 'Read', agentId: id, file_path: '/work/a.ts' } as any)
      const s2 = $.turn.step({ turnId: 'b' + id + k, index: k, model: i % 4 ? 'claude-haiku-5-5' : 'claude-sonnet-5-5', agentId: id, messageCount: 2 } as any)
      let r2 = await s2.next()
      while (r2.done !== true) r2 = await s2.next()
    }
    await clock.advance(600 + (i % 7) * 900)
    await $.turn.complete({ turnId: 'bz' + id, agentId: id, reason: i % 23 === 5 ? 'error' : 'answer', answer: 'checked module ' + (i % 17) + ': no problems found in the code under review', durationMs: 4000, isAborted: false, usage: null })
  }
  for (const w of ['wf-1', 'wf-2', 'wf-3']) await $.tool.call({ tool: 'Grep', agentId: w, pattern: 'x' } as any)
  for (const columns of [52, 120]) {
    const ui = await $.ui.mount({ ...PANE(columns), surface: 'desktop' } as any)
    for (const id of ['overview', 'agents']) {
      await ui.press({ key: 'tab-' + id })
      dump[`${id}-big-${columns}`] = await ui.drawn()
    }
    await ui.unmount()
    const band = await $.ui.mount({ ...BAND(columns), surface: 'desktop' } as any)
    dump[`band-big-${columns}`] = await band.drawn()
    await band.unmount()
  }
  console.log('@@TREES@@' + JSON.stringify(dump) + '@@END@@')
})
