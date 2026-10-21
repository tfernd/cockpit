import { mock, test } from 'claude-code/testing'

// Not a real test: it seeds a busy session and prints the tree of every tab (and the band) as JSON, for
// .shots/render.mjs to turn into PNGs. Only `make render` runs it (it copies this file into a scratch plugin).
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
const TABS = ['trace', 'usage']

// A tool call as the session records it: the model's tool_use, `ms` of work on the mocked clock, then the tool_result.
// The mocked clock's start: reset times are built from it, as the engine's are from the real clock.
const T0 = 1_700_000_000_000
let clock: any
let crew = false
async function runTool($: any, tool: string, input: Record<string, unknown> = {}, agentId?: string, isError = false, ms = 200, out = 'ok') {
  const id = 'tu' + Math.random().toString(36).slice(2)
  await $.session.append({ agentId, message: { type: 'assistant', content: [{ type: 'tool_use', id, name: tool, input }] } })
  await clock.advance(ms)
  await $.session.append({ agentId, message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: isError ? out : 'ok', is_error: isError }] } })
}

test('dump trees for screenshots', async ($: any, on: any) => {
  if (!OUT) return
  clock = mock.clock(on, { now: T0 })
  const saved = new Map<string, unknown>([['budget', 200]])
  on('store.get', (_: any, e: any) => ({ value: saved.get(e.key) }))
  on('store.set', (_: any, e: any) => (saved.set(e.key, e.value), { value: undefined }))
  on('session.id', () => ({ value: 'sid-shots' }))
  on('agent.list', () => ({ value: [] }))
  on('command.register', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // A subscription first (5-hour and weekly windows); the enterprise shots at the end swap in a spend limit.
  let rateLimits: any[] = [
    { kind: 'five_hour', percentUsed: 72, resetsAt: new Date(T0 + 9_000_000).toISOString() },
    { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(T0 + 250_000_000).toISOString() },
  ]
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 612_000, window: 1_000_000, percent: 61, breakdown: { isAutoCompactEnabled: true, autoCompactThreshold: 920_000 } },
      rateLimits,
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
    // The big crew's requests are short: each mocked second runs the 1 s tick, and the harness stops at 5 s of real time.
    await clock.advance(crew ? 200 : e.agentId ? 2600 + e.index * 900 : e.model === 'claude-opus-5-5' ? 4300 + e.index * 1300 : 2100)
    yield { kind: 'text', index: 0, text: 'ok' }
    const fresh = e.model === 'claude-sonnet-5-5'
    return { turnId: e.turnId, index: e.index, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: { model: e.model, input_tokens: 6, output_tokens: 300 + e.index * 40, cache_read_input_tokens: fresh ? 0 : 140_000 + e.index * 9_000, cache_creation_input_tokens: fresh ? 160_000 : 2_500 } }
  })

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const step = async (turnId: string, index: number, model: string, effort?: string, agentId?: string) => {
    const s = $.turn.step({ turnId, index, model, effort, messageCount: index + 1, agentId } as any)
    let r = await s.next()
    while (r.done !== true) r = await s.next()
  }
  for (let t = 1; t <= 4; t++) {
    await $.turn.start({ text: ['map the repo', 'tidy the band', 'fix the cache pill', 'release notes'][t - 1], turnId: 't' + t })
    await step('t' + t, 0, 'claude-opus-5-5', 'xhigh')
    for (const f of ['/work/src/server/routes/index.ts', '/work/src/lib/model.js', '/work/README.md', '/home/me/.config/claude/settings.json']) await runTool($, 'Read', { file_path: f }, undefined, false, 140)
    await runTool($, 'Edit', { file_path: '/work/src/lib/model.js' }, undefined, false, 600)
    await runTool($, 'Read', { file_path: '/work/src/lib/model.js' }, undefined, false, 120)
    await runTool($, 'Grep', { pattern: 'x' }, undefined, false, 900)
    await runTool($, 'Bash', { command: 'ls', description: 'List the folder' }, undefined, false, 400)
    if (t === 2) await runTool($, 'Bash', { command: 'false', description: 'Run the failing check' }, undefined, true, 1200)
    await runTool($, 'TodoWrite', { todos: [{ status: 'completed' }, { status: 'completed' }, { status: 'in_progress' }, { status: 'pending' }, { status: 'pending' }] }, undefined, false, 30)
    await $.turn.complete({ turnId: 't' + t, reason: 'answer', answer: 'done', durationMs: 18_000 + t * 7_000, isAborted: false, usage: null })
    if (t === 2) {
      await step('t2b', 1, 'claude-sonnet-5-5', 'medium')
    }
  }
  await $.tool.call({ tool: 'mcp__cockpit__plan', title: 'ship 0.9', tasks: [{ title: 'map the code', tier: 'light' }, { title: 'fix the layout', tier: 'careful' }, { title: 'write tests', tier: 'light' }, { title: 'release', tier: 'light' }] } as any)

  // The showcase trace: one prompt that fans out to subagents (one nested, one failing a check, one still running).
  await $.turn.start({ text: 'Ship the pricing page by Friday', turnId: 't5' })
  await step('t5', 0, 'claude-opus-5-5', 'xhigh')
  await runTool($, 'Read', { file_path: '/work/src/pricing/page.tsx' }, undefined, false, 180)
  await runTool($, 'Grep', { pattern: 'seatPrice' }, undefined, false, 900)
  await step('t5', 1, 'claude-opus-5-5', 'xhigh')
  // Agent calls: the model's tool_use, then agent.spawn naming it; background agents answer the call at once.
  const spawn = async (d: string, type: string, parentAgentId?: string) => {
    await $.session.append({ agentId: parentAgentId, message: { type: 'assistant', content: [{ type: 'tool_use', id: 'u' + d, name: 'Agent', input: { description: d } }] } } as any)
    const r = await $.agent.spawn({ tool_use_id: 'u' + d, prompt: 'p', description: d, subagentType: type, provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false, parentAgentId } as any)
    await $.session.append({ agentId: parentAgentId, message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'u' + d, content: 'launched' }] } } as any)
    await $.turn.start({ text: 'p', turnId: 'r' + r.agentId, agentId: r.agentId } as any)
    return r
  }
  const lead = await spawn('map the code', 'Explore')
  await clock.advance(300)
  const fix = await spawn('fix the layout', 'general-purpose')
  await clock.advance(300)
  const tests = await spawn('write tests', 'general-purpose')
  const sub = (a: any, i: number, model = 'claude-haiku-5-5') => step('r' + a.agentId, i, model, undefined, a.agentId)
  await sub(lead, 0)
  await runTool($, 'Read', { file_path: '/work/src/pricing/plans.ts' }, lead.agentId, false, 300)
  await runTool($, 'Grep', { pattern: 'coupon' }, lead.agentId, false, 1100)
  const kid = await spawn('read the tests', 'Explore', lead.agentId)
  await sub(kid, 0)
  await runTool($, 'Read', { file_path: '/work/tests/checkout.test.ts' }, kid.agentId, false, 200)
  await $.turn.complete({ turnId: 'r' + kid.agentId, agentId: kid.agentId, reason: 'error', answer: '', durationMs: 9_000, isAborted: false, usage: null })
  await sub(fix, 0, 'claude-sonnet-5-5')
  await runTool($, 'Edit', { file_path: '/work/src/pricing/page.tsx' }, fix.agentId, false, 700)
  await runTool($, 'Bash', { command: 'pnpm test checkout', description: 'Run checkout tests' }, fix.agentId, true, 8400, "2 of 14 checkout tests fail: coupon codes aren't applied to seat prices")
  await sub(fix, 1, 'claude-sonnet-5-5')
  await runTool($, 'Edit', { file_path: '/work/src/pricing/coupons.ts' }, fix.agentId, false, 500)
  await runTool($, 'Bash', { command: 'pnpm test checkout', description: 'Run checkout tests again' }, fix.agentId, false, 7800)
  await sub(lead, 1)
  await $.turn.complete({ turnId: 'r' + lead.agentId, agentId: lead.agentId, reason: 'answer', answer: 'the model lives in lib/model.js; views are pure functions of its state', durationMs: 31_000, isAborted: false, usage: null })
  await sub(fix, 2, 'claude-sonnet-5-5')
  await $.turn.complete({ turnId: 'r' + fix.agentId, agentId: fix.agentId, reason: 'answer', answer: 'coupons now apply per seat; checkout tests pass', durationMs: 31_000, isAborted: false, usage: null })
  await sub(tests, 0)
  await runTool($, 'Write', { file_path: '/work/tests/pricing.test.ts' }, tests.agentId, false, 600)
  for (const a of [lead, kid, fix]) await $.tool.call({ tool: 'mcp__cockpit__step', agentId: a.agentId, done: 2, total: 5, note: 'reading code' } as any)
  await $.tool.call({ tool: 'mcp__cockpit__step', agentId: tests.agentId, done: 2, total: 5, note: 'writing tests' } as any)
  await step('t5', 2, 'claude-opus-5-5', 'xhigh')
  // Still running when the shots are taken: two main-loop tools and one in the test writer.
  for (const [n, a] of [['Bash', undefined], ['Read', undefined], ['Grep', tests.agentId]] as const) await $.session.append({ agentId: a, message: { type: 'assistant', content: [{ type: 'tool_use', id: 'run' + n, name: n, input: n === 'Bash' ? { description: 'Build the site' } : n === 'Read' ? { file_path: '/work/src/pricing/faq.md' } : { pattern: 'renders' } } ] } } as any)
  await clock.advance(6_000)

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

  crew = true
  // A big crew: 110 more agents in parallel, most finished, a few failed, some running, and loops nobody announced.
  const ids: string[] = []
  for (let i = 0; i < 110; i++) {
    const r = await $.agent.spawn({ tool_use_id: 'j' + i, prompt: 'p', description: 'job ' + i + ' check module ' + (i % 17), subagentType: i % 3 ? 'Explore' : 'general-purpose', provider: { plugin: 'engine', tier: 'core' }, parentModel: 'm', background: true, fork: false } as any)
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
    for (const id of ['trace', 'usage']) {
      await ui.press({ key: 'tab-' + id })
      dump[`${id}-big-${columns}`] = await ui.drawn()
    }
    await ui.unmount()
    const band = await $.ui.mount({ ...BAND(columns), surface: 'desktop' } as any)
    dump[`band-big-${columns}`] = await band.drawn()
    await band.unmount()
  }
  // Enterprise: a $250 monthly spend limit at 59%, 17 days before it resets (day 14 of 31), so the month runs ahead of pace.
  const resetsAt = new Date(T0 + 17 * 86_400_000).toISOString() // the seed's clock has moved only minutes past T0
  rateLimits = [{ kind: 'spend_limit', percentUsed: 59, resetsAt }]
  saved.set('budget', 250)
  // Two weeks of readings that earlier chats recorded: busy weekdays, quiet weekends, climbing to 57%.
  const start = Date.parse(resetsAt) - 30 * 86_400_000
  const points: [number, number][] = []
  for (let h = 12, p = 0; start + h * 3_600_000 < T0 - 3_600_000; h += 6) {
    const weekday = new Date(start + h * 3_600_000).getUTCDay() % 6 !== 0
    p += weekday ? 0.9 + ((h * 7) % 5) * 0.12 : 0.15
    points.push([start + h * 3_600_000, Math.min(57, Math.round(p * 10) / 10)])
  }
  saved.set('spendHist', { resetsAt, points })
  await clock.advance(6000) // the tick reads usage every 5 s
  for (const columns of [52, 120]) {
    const band = await $.ui.mount({ ...BAND(columns), surface: 'desktop' } as any)
    dump[`band-enterprise-${columns}`] = await band.drawn()
    await band.unmount()
    const ui = await $.ui.mount({ ...PANE(columns), surface: 'desktop' } as any)
    await ui.press({ key: 'tab-usage' })
    dump[`usage-enterprise-${columns}`] = await ui.drawn()
    await ui.unmount()
  }
  console.log('@@TREES@@' + JSON.stringify(dump) + '@@END@@')
})
