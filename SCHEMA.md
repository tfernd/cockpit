# SCHEMA.md

What the engine tells a mod, and in what shape. Read this before adding a recorder or a view. Shapes are from Claude Code 2.1.304 (`.claude-plugin/types/claude-code/index.d.ts`, about 22k lines); the API is early access and moves between releases, so when something here disagrees with the types, the types win. Grep them for the name at hand (`'turn.step'`, `export type TurnStepResult`).

Built-in tool inputs and results live in `.claude-plugin/types/claude-code-tools/index.d.ts` (`BuiltinToolInputs`, `BuiltinToolResults`).

## How a hook works

```js
on(event, matcher?, ($, e, next) => { ... })
```

- `$` is the engine (`$.session`, `$.agent`, `$.clock`, `$.store`, `$.fs`, `$.ui`, ...). `e` is the event's input, frozen. `next(e)` runs the plugins beneath and then the engine, and resolves to the event's result.
- Observe: `return next(e)`. Observe the result: `const r = await next(e); ...; return r`. Rewrite: `next({ ...e, x })`. Answer alone: return without `next`.
- A hook that awaits `next` stays open until the engine is done. For `tool.call` that is the whole tool run (an `Agent` call = the whole subagent), and other hooks (`/cockpit`) queue behind it. That is why cockpit reads tool calls from `session.append` instead.
- Two events stream: `turn.step` and `process.spawn`. Their hook is an async generator: `const r = yield* next(e)`.
- Each hook has a time budget (its own code; `next` and `$` calls in flight do not count). A hook that throws or overruns is skipped and the chain goes on without it.
- Settings-file hooks are hookable too, as `classic.<Event>` (`classic.PostToolUse`, `classic.SubagentStop`), with `e` = what that hook gets on stdin.

## Events

All events, grouped. "Cockpit" marks the ones `hooks/register.js` hooks today. Every loop event carries `agentId` inside a subagent and none on the main loop.

| Event | Fires | Cockpit | Use for a trace |
| --- | --- | --- | --- |
| `session.start` | plugin loaded, before the first prompt; again on reload | yes | setup, timers |
| `session.end` | exit, `/clear`, resume, logout | | flush state |
| `session.append` | every row a conversation keeps (main and subagents) | yes | tool spans (start, end, input, error text) |
| `session.measure` | after each main turn, when a limit moves a point | yes | context, limits, cost |
| `session.compact` | before compaction | yes | marker on the timeline |
| `session.send` / `session.receive` | message to / from another agent or session | yes | message markers |
| `session.attach` / `session.detach` | a remote client joins / leaves | | |
| `turn.start` | a turn begins (main or subagent), before its first request | yes | turn span start |
| `turn.step` (stream) | one model request | yes | LLM span (model, effort, tokens, stop) |
| `turn.complete` | a turn ends | yes | turn span end, answer, reason, usage |
| `agent.spawn` | Agent tool or workflow `agent()` about to start one | yes | parent/child link |
| `agent.offer` | an agent type listed for the model | | |
| `tool.call` | a tool is about to run (wraps the run) | only `step` / `plan` | avoid: holds hooks up |
| `tool.check` | permission verdict | | permission wait marker |
| `tool.describe` | tool schema first rendered | | |
| `prompt.submit` | prompt submitted | | trace title |
| `prompt.*` (fill, suggest, edit, change, autocomplete, section, context, compose, attachment, mention) | prompt box and system prompt | | |
| `command.run` / `command.describe` | slash commands | yes (`/cockpit`) | |
| `ui.render` | a component is drawn | yes (`AbovePrompt`, `Pane`) | drawing |
| `ui.press` / `ui.input` / `ui.select` / `ui.focus` / `ui.scroll` | interaction with what a hook drew | | expand rows, pick a span |
| `ui.message` / `ui.fault` | a `Client` posts / fails | | |
| `ui.resolve` | element tables built | | |
| `config.*`, `telemetry.*`, `skill.prompt`, `attribution.text`, `plugin.register`, `engine.create` | the rest | | |
| `classic.PostToolUse` | after a tool succeeds | | engine-measured `duration_ms`, structured `tool_response` |
| `classic.PostToolUseFailure` | after a tool fails | | `error`, `is_interrupt`, `duration_ms` |
| `classic.PostToolBatch` | after a batch of parallel tools | | |
| `classic.SubagentStart` / `classic.SubagentStop` | subagent starts / stops | | `agent_transcript_path` |
| `classic.Stop`, `classic.PreModelSwitch`, `classic.PermissionRequest`, `classic.PermissionDenied`, ... | settings-hook events | | |

## Payloads

Only the fields worth recording. `?` = may be absent.

### `session.append`

One row, before it is stored. Cockpit's source for tool calls.

```ts
e = {
  message: {
    type: 'user' | 'assistant' | 'attachment' | 'system',
    name?: string,            // attachment type or notice subtype ('compact_boundary', ...)
    role?: 'user' | 'assistant',
    isMeta?: true,            // not typed by the person (reminders, deliveries)
    content: ApiContentBlock[], // Messages API blocks
  },
  door: 'prompt' | 'command' | 'response' | 'tool-result' | 'tool-message' | 'delivery'
      | 'attachment' | 'hook-context' | 'note' | 'compaction' | 'notice' | 'queue',
  origin: { kind: 'model', model } | { kind: 'tool', tool } | prompt / attachment origins,
  uuid: string,               // the row's id in the transcript file
  agentId?: string,
}
```

Blocks that matter:

- assistant `tool_use`: `{ id, name, input }`. Appended when the model has written the call, so it is the tool span's start (it includes any permission-prompt wait).
- user `tool_result`: `{ tool_use_id, content, is_error }`. The span's end; `content` holds the error text on failure.
- `text`, `thinking` blocks of the response.

Not on `e` (stored as made, only in the transcript file): timestamps, `parentUuid`, the structured `toolUseResult`.

### `turn.start` / `turn.complete`

```ts
turn.start    e = { text, turnId, agentId? }        // text: the prompt ("" for a continuation)
turn.complete e = {
  turnId, agentId?,
  answer: string,          // final visible text; a subagent's report
  durationMs: number,      // wall clock of the turn
  isAborted: boolean,
  reason: 'answer' | 'aborted' | 'refusal' | 'error',
  refusal?: { category, explanation },
  usage?: TurnUsage,       // all requests of the turn summed, model = the last
}
```

A subagent's whole run is one turn: its `turn.complete` (with `agentId`) is the agent span's end. Every hook hears it, the spawner's too.

### `turn.step` (one model request)

```ts
e = { turnId, index /* from 0 */, model, effort?, messageCount, agentId? }
result = {
  turnId, index,
  answer: string,
  toolUses: { name, input }[],          // no ids here; ids are on the session.append rows
  serverToolUses?: { id, name, input, startedAt, endedAt? }[], // advisor etc., timed by the engine
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'pause_turn' | 'refusal'
            | 'model_context_window_exceeded' | 'compaction' | 'stop_sequence' | null,
  usage: { model, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens } | null,
}
```

Cockpit reads the time only after `yield* next(e)`. For an LLM span, also read `$.clock.now()` before it: the gap is the request's latency. The chunks (`text`, `thinking`, `tool` with id and name, `input`, `stop`) can be read with `for await` if time-to-first-token is ever wanted.

### `agent.spawn`

```ts
e = {
  tool_use_id,       // the Agent call in the parent loop (a workflow agent: the Workflow call)
  prompt, description, subagentType,
  model?,            // as asked; parentModel is the parent's
  parentModel, parentAgentId?, permissionMode?,
  background: boolean, fork: boolean,
  isTeammate?: true, name?, cwd?,
  workflow?: { runId, agentIndex },
  resume?: { agentId },            // a resumed run
  provider: { plugin, tier },
}
result = { model /* resolved */, agentId?, teammateId? }  // or { deny }
```

`tool_use_id` is the link from the parent's `Agent` tool span to the child's loop (`agentId`). Cockpit does not keep it yet.

### `tool.call`

```ts
e = { tool, tool_use_id, agentId?, ...the tool's arguments spread in (e.command for Bash) }
result = { result, text, isError, isReadOnly } | { deny }
```

The `Agent` tool's `result` is rich: `totalDurationMs`, `totalTokens`, `totalToolUseCount`, `usage` (with `cache_creation.ephemeral_1h/5m`, `server_tool_use.web_search_requests`), `toolStats` (`readCount`, `bashCount`, `linesAdded`, ...), `resolvedModel`, `modelsUsed`. Background launches answer `{ status: 'async_launched', agentId, outputFile }` instead. Do not await it here (see Known gotchas in AGENTS.md); the same record arrives in `classic.PostToolUse`.

### `classic.PostToolUse` / `classic.PostToolUseFailure`

```ts
base = { session_id, transcript_path, cwd, agent_id?, agent_type?, permission_mode?, effort? }
PostToolUse        e = base & { tool_name, tool_input, tool_response, tool_use_id, duration_ms?, mcp_server? }
PostToolUseFailure e = base & { tool_name, tool_input, tool_use_id, error, is_interrupt?, duration_ms?, mcp_server? }
PostToolBatch      e = base & { tool_calls: { tool_name, tool_input, tool_use_id, tool_response? }[] }
SubagentStart      e = base & { agent_id, agent_type }
SubagentStop       e = base & { agent_id, agent_type, agent_transcript_path, last_assistant_message?, background_tasks? }
```

Fired after the tool, so hooking them does not hold anything up. `duration_ms` is the engine's own measure (to check: whether it excludes permission wait). `transcript_path` is the session's JSONL (below).

### `session.measure` and `$.session.usage()`

```ts
{ context: { tokens?, window, percent? }, rateLimits: { kind, percentUsed, resetsAt? }[],
  cost?: { usd }, changed: ('context' | 'rateLimits' | 'cost')[] }
```

`$.session.usage()` answers the same plus `startedAt`; `{ breakdown: 'summary' | 'full' }` adds the `/context` categories.

### Other session events

```ts
session.start   e = { cwd, surface, isInteractive }
session.end     e = { reason: 'clear' | 'resume' | 'logout' | 'prompt_input_exit' | 'other', sessionId, resume }
session.compact e = { trigger, agentId?, instructions?, messages }
session.send    e = { to, text, origin, agentId? }
session.receive e = { origin, text, event?, agentId? }
```

## Pulling instead of hooking

| Call | Answers |
| --- | --- |
| `$.session.messages({ agentId? })` | up to 4096 rows `{ role, text, toolUses, toolResults? }`; each `toolUses` entry is `{ tool_use_id, tool, input, result?, text?, isError?, agentId?, durationMs? }` once answered. Engine-timed durations, for a backfill. |
| `$.session.messages({ as: 'api', agentId? })` | the same as Messages API blocks |
| `$.agent.list()` | `{ id, description, type, status, parentId?, name?, teammateId?, spawnedBy? }[]`; status `pending | running | waiting | idle | completed | failed | killed`. Workflow agents are not listed. |
| `$.session.usage()` | context, limits, cost (above) |
| `$.session.id()`, `cwd()`, `model()`, `turns()`, `version()` | |
| `$.clock.now()` | ms; mocked in tests |
| `$.store.get/set` | values kept across sessions |
| `$.fs.read(path)` | text of a file, e.g. the transcript |

## The transcript on disk

`~/.claude/projects/<cwd with / as ->/<session id>.jsonl`, one JSON row per line (`transcript_path` in every classic hook). Unlike the events, every row has `timestamp` (ISO), `uuid`, `parentUuid`. Useful row kinds:

- `assistant`: `message.usage` (with `cache_creation.ephemeral_1h_input_tokens` / `_5m_`, `output_tokens_details.thinking_tokens`, `server_tool_use`), `message.model`, `requestId`, `effort`, `thinkingDurationMs`.
- `user` with a `tool_result`: `toolUseResult` (the structured result: Bash `stdout/stderr/interrupted`, Agent's record), `sourceToolAssistantUUID`.
- `api-request`, `attachment`, `system` (`stop_hook_summary`), `queue-operation`, `custom-title`.

Subagents: `<session id>/subagents/agent-<id>.jsonl` (same rows, `isSidechain: true`, `agentId`) and `agent-<id>.meta.json`: `{ agentType, description, toolUseId, spawnDepth, finished }`. `toolUseId` links back to the parent's Agent call.

So a trace could be rebuilt from disk after a reload instead of from `snap:<sid>`. Files grow large; read them once, not per tick.

## Joining ids into a span tree

```
session
└─ turn            turn.start/complete           key turnId        (agentId: none = main)
   ├─ llm call     turn.step                     key turnId+index
   └─ tool         session.append tool_use/result key tool_use_id  (+ agentId of its loop)
      └─ subagent  agent.spawn                   e.tool_use_id = parent Agent call, result.agentId
         └─ turn   turn.start/complete with agentId = that id
            ├─ llm call ...
            └─ tool ...
```

- A tool belongs to the LLM call whose response held its `tool_use` (same loop, the latest step of that loop's turn).
- `parentAgentId` on `agent.spawn` gives nesting depth; `$.agent.list()` `parentId` the same.
- Workflow agents and engine forks send events with an `agentId` that no `agent.spawn` announced (cockpit's `ensureAgent` makes them "unlisted").

## What the surfaces can draw

| | terminal | desktop |
| --- | --- | --- |
| `Box`, `Text`, `Button`, `Input`, `Select`, `Markdown`, `Code` | yes | yes |
| `Svg` | no | yes; `isInteractive: true` gives CSS `:hover` and `<title>` tooltips (no scripts) |
| `Raster` (grid of colored cells), `Image` | yes | no |
| `Box` `hover` styles, `position: 'absolute'` (a card that appears over rows) | yes, where the terminal reports the mouse | yes |
| `Client` (a module of the plugin running on the surface, with local state, pointer and key events, `every` timer) | yes | yes (not mobile or vscode) |

A `Client` can keep expand/collapse and hover state locally without a round trip to the hooks; it draws with Box/Text (no Svg). Pane width: `e.props.bodyColumns`.

## Mapping a trace waterfall onto this

The reference design: a header (title, Live), a stats row (duration, cost, tokens, LLM calls, tool calls, errors), a span tree (agent rows with model, tool rows with a short input), a time axis with bars, `duration · cost` at each bar's end, a SLOWEST badge, a running spinner, collapse with `+N`, a now cursor, and a popover (status, duration, started +Ns, cost, spans, error text, input).

| Piece | Source | State |
| --- | --- | --- |
| Title | first `turn.start` text of the main loop, or `prompt.submit` | not kept |
| Live | any running turn or tool | have (`S.running`, agents) |
| Duration | session start / first turn to now | have |
| Cost | `turn.step` usage × `PRICES` per request; `session.measure` cost for the total | have per agent, not per span |
| Tokens | `turn.step` usage | have, as totals |
| LLM calls | count of `turn.step` | have for main (`S.steps`), agents count only |
| Tool calls, errors | `session.append` | have counts, not spans |
| Agent row: name, model | `agent.spawn` description / type, result model | have |
| Agent bar start/end | `agent.spawn` time, its `turn.complete` | have (`startedAt`, `endedAt`) |
| Tool row: name, short input | `tool_use.input` (file path, command, pattern, query) | input read, not kept |
| Tool bar start/end | `tool_use` / `tool_result` append times | measured, only the duration is kept (`durs[]`) |
| LLM call bar | `$.clock.now()` before and after `yield* next(e)` in `turn.step` | end only |
| Tool under its agent | `agentId` on the row | kept on running entries only |
| Agent under its Agent call | `agent.spawn` `tool_use_id` | not kept |
| Failed badge, error text | `tool_result.is_error`, its `content` | flag counted, text dropped |
| Status running / done / failed | `turn.complete` reason, `$.agent.list()` | have |
| SLOWEST | max duration among siblings | derivable |
| Now cursor | `$.clock.now()` | have (1 s tick) |
| Cache hit per call | `turn.step` usage | have for main steps |

The gap is one structure: a list of spans with ids, parents, start, end, kind, label, model, usage and error. Everything above fills it from events cockpit already hooks. Constraints for it: JSON-serialisable for `snapshot()`, capped (`cap()`) since a long session makes thousands of spans, and drawable at 52 columns on the terminal (a `Raster` row or `fbar` per span) as well as on desktop (`Svg`).

## To check before building

- `classic.PostToolUse` `duration_ms`: includes the permission prompt or not; whether it fires for subagent tools (`agent_id`).
- Whether hooking a `classic.*` event has a cost when no settings hook is configured.
- Ordering: can a subagent's `turn.start` arrive before `agent.spawn`'s `next` resolves (cockpit's `ensureAgent` already assumes yes).
- `turn.step` start time under parallel subagents: the hook's own budget counts only its code, so two `$.clock.now()` calls are safe.
