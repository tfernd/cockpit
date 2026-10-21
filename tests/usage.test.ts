import { expect, test } from 'claude-code/testing'
import { newState, onTurnStart, onTurnComplete, onStepStart, onStepEnd, onToolStart, onToolEnd, onSpawn } from '../lib/model.js'
import { usageSvg, usageTab } from '../lib/usage.js'

const NOW = 60_000
const usage = (model: string, read: number, wrote: number) => ({ usage: { model, input_tokens: 10, output_tokens: 200, cache_read_input_tokens: read, cache_creation_input_tokens: wrote }, stopReason: 'end_turn' })

// Two turns on opus, then a switch to sonnet whose first request has to write the whole cache again; a failing Bash;
// an Agent call (never a tool row); one subagent with a warm cache.
function seed(account: string | null = 'subscription') {
  const S: any = newState(60)
  Object.assign(S, {
    account,
    ctx: { tokens: 612_000, window: 1_000_000, percent: 61 },
    compactAt: 920_000,
    compactions: 2,
    cost: { usd: 7.42 },
    monthUsd: 142,
    limits: [
      { kind: 'five_hour', percentUsed: 72, resetsAt: new Date(NOW + 9_000_000).toISOString() },
      { kind: 'seven_day', percentUsed: 41, resetsAt: new Date(NOW + 250_000_000).toISOString() },
    ],
  })
  onTurnStart(S, { turnId: 't1', text: 'go' }, 1000)
  onStepStart(S, { turnId: 't1', index: 0, model: 'claude-opus-5-5' }, 1000)
  onStepEnd(S, { turnId: 't1', index: 0, model: 'claude-opus-5-5' }, usage('claude-opus-5-5', 90_000, 3_000), 4000)
  onToolStart(S, 'r1', 'Read', undefined, 4000, { file_path: '/w/a.ts' })
  onToolEnd(S, 'r1', false, 4200)
  onToolStart(S, 'b1', 'Bash', undefined, 4200, { command: 'pnpm test' })
  onToolEnd(S, 'b1', true, 9000, 'exit 1')
  onToolStart(S, 'g1', 'Agent', undefined, 9000, { description: 'look' })
  onToolEnd(S, 'g1', false, 9500)
  onTurnComplete(S, { turnId: 't1', reason: 'answer', answer: 'ok', durationMs: 8000, isAborted: false }, 9500)
  onTurnStart(S, { turnId: 't2', text: 'more' }, 20_000)
  onStepStart(S, { turnId: 't2', index: 0, model: 'claude-sonnet-5-5' }, 20_000)
  onStepEnd(S, { turnId: 't2', index: 0, model: 'claude-sonnet-5-5' }, usage('claude-sonnet-5-5', 0, 93_000), 23_000)
  onTurnComplete(S, { turnId: 't2', reason: 'answer', answer: 'ok', durationMs: 3000, isAborted: false }, 23_000)
  onSpawn(S, 'x1', { description: 'look', subagentType: 'Explore' }, 'claude-haiku-5-5', 21_000)
  onStepEnd(S, { turnId: 'x1t', index: 0, model: 'claude-haiku-5-5', agentId: 'x1' }, usage('claude-haiku-5-5', 1000, 2000), 22_000)
  return S
}

const Box = (props: any) => ({ type: 'Box', props })
const Text = (props: any) => ({ type: 'Text', props })
const Svg = (props: any) => ({ type: 'Svg', props })
function walk(n: any, out: any[] = []) {
  if (!n || typeof n !== 'object') return out
  out.push(n)
  for (const c of n.props?.children || []) walk(c, out)
  return out
}

test('the usage picture carries context, limits, cache, session and tools', () => {
  const { svg, h } = usageSvg(seed(), NOW, 944)
  expect(h).toBeGreaterThan(400)
  const missing = [
    '>CONTEXT<', '>61%<', '612k of 1M tokens', 'auto-compact at 92%', 'compacted 2× this chat', // context, its compaction mark and count
    '>72%<', '>5-hour<', 'resets in 2h 30m', '>41%<', '>Week<', // plan limits
    '60 min window', '>60m<tspan class="u" dx="5">left<', '48% from cache overall', '1 of 1 warm', // cache: main window, hit rate, subagents
    'model: opus 5.5 → sonnet 5.5', 're-cached 93k tokens', // the switch and what it cost
    '>TURNS<', 'median · p95 8.0s', '>96k<', '>400<', '>90k<', // session: turn time, tokens in, out, cached
    '>Read<', '>Bash<', 'style="fill:#e5534b">1<', // tools, the failure in red
  ].filter((s) => !svg.includes(s))
  expect(missing).toEqual([])
  expect(svg).not.toContain('>Agent<') // a subagent's run is not a tool call
})

test('money is a bill only on an API account; elsewhere it is worth at API rates', () => {
  const sub = usageSvg(seed('subscription'), NOW, 944).svg
  expect(sub).toContain('≈$7.42')
  expect(sub).toContain('at API rates, not a bill')
  expect(sub).not.toContain('>COST<')
  expect(sub).not.toContain('month')
  const unknown = usageSvg(seed(null), NOW, 944).svg
  expect(unknown).toContain('>WORTH<')
  expect(unknown).toContain('API-rate estimate')
  const api = usageSvg(seed('api'), NOW, 944).svg
  expect(api).toContain('>COST<')
  expect(api).toContain('>$7.42<')
  expect(api).toContain('month $142')
  expect(api).not.toContain('≈')
})

test('two columns of cards from 640 px, one below', () => {
  expect(usageSvg(seed(), NOW, 944).svg).toContain('width="466" height=') // (944 - 12) / 2
  const narrow = usageSvg(seed(), NOW, 400).svg
  expect(narrow).not.toContain('width="466"')
  expect(narrow).toMatch(/<rect x="0" y="0" width="400" height="\d+" rx="12" class="card"\/>/)
})

test('a new session says what has not happened yet instead of drawing empty charts', () => {
  const svg = usageSvg(newState(), NOW, 944).svg
  for (const s of ['no reading yet', 'no request yet', 'no tool calls yet', 'no turn yet']) expect(svg).toContain(s)
  expect(svg).not.toContain('from cache overall')
  expect(svg).not.toContain('PLAN LIMITS')
})

test('desktop gets one SVG image with its words in alt; the terminal gets Boxes and Text only', () => {
  const S = seed()
  const d: any[] = usageTab(Box, Text, S, NOW, 118, { surface: 'desktop', Svg })
  expect(d.length).toBe(1)
  expect(d[0].type).toBe('Svg')
  expect(d[0].props.isInteractive).toBe(false) // an interactive SVG reloads its frame and blinks on every redraw
  expect(d[0].props.width).toBe(944)
  expect(d[0].props.alt).toMatch(/Context 61% .*5-hour 72%, resets in 2h 30m .*Cache 60m left, 48% from cache overall .*Worth ≈\$7\.42 .*Tools: Read 1, Bash 1 \(1 failed\)/)
  const t = usageTab(Box, Text, S, NOW, 80, { surface: 'terminal', Svg }).flatMap((n: any) => walk(n))
  expect(t.some((n: any) => n.type === 'Svg')).toBe(false)
  const words = t.filter((n: any) => n.type === 'Text').map((n: any) => n.props.children.join(''))
  const missing = ['CONTEXT', '61% · 612k of 1M', 'PLAN LIMITS', '72% · resets in 2h 30m', 'CACHE', '60m left of 60 min', 're-cached 93k tokens', 'SESSION', '≈$7.42', 'TOOLS', 'Read'].filter((w) => !words.includes(w))
  expect(missing).toEqual([])
  expect(words).not.toContain('Agent')
})
