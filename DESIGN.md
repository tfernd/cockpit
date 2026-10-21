# DESIGN.md

The plan for cockpit's next version: a trace waterfall ("where did the time go") in place of the stats tables, and a calmer band. The data it needs is in [SCHEMA.md](SCHEMA.md). Status: steps 1 to 3 built in 0.13.0 (span recorder, realistic seed, Trace tab), step 4 in 0.14.0 (band), Overview and Cache merged into Usage in 0.15.0, and Tools, Agents and Timeline folded into Trace in 0.16.0 (crew line, plan, step progress, per-tool stats). Session messages to and from other sessions are no longer shown. In 0.17.0 the row-per-span waterfall gave way to swimlanes (one lane per agent, `lib/lanes.js`), after it proved too verbose in use. In 0.20.0 the band became stat tiles (`lib/band.js`); in 0.21.0 Files and Debug went, Usage became panels in one SVG (`lib/usage.js`), and accounts with a spend limit got a budget tile and a month burn-down.

## What is wrong now

Seen in `assets/` and the code:

1. **No time axis.** The pane is seven tabs of counts and mean/sd/p95/p99 tables. Nothing answers "which subagent or tool took the time", which is the question we open it for. Timeline is a text list of "20.0s ago" lines that shift every second.
2. **The band jumps.** On desktop it is one SVG image whose pill widths are guessed (by a width estimate; that renderer was replaced in 0.20.0); `balance()` re-cuts the rows on every redraw, and the 1 s tick (`tick` in `hooks/register.js`) redraws every second. "2h 30m" becoming "2h 29m" can move pills between rows.
3. **Pills vanish.** At 52 columns the band keeps 3 of 8 pills by `pri`, without saying so (`assets/band-52.png`).
4. **Repeats.** Overview repeats the band; Agents repeats Overview; Cache, Tools and Overview each show token totals.
5. **Heavy colour.** Full-saturation green and yellow bars (Budget card, Cache requests), and green means both "good" and "read from cache".
6. **The demo hides bugs.** `.shots/shots.test.ts` runs tools in zero time, so Tools shows `0ms` everywhere and an empty bar column; the gallery never shows a real layout.
7. **The recorder keeps totals, not spans.** `onToolEnd` pushes a duration into `S.tools[name].durs` and drops the start, the input, the agent and the error text, so no view can draw a timeline.

## Target

The reference: a trace header (title, live), a KPI row (duration, cost, tokens, model calls, tool calls, errors), then one row per span: name and short detail on the left, a bar on a shared time axis on the right, `duration · cost` after the bar, a SLOWEST badge, subagents collapsible with `+N`, failed spans in red with the error text, a detail card for the selected span. Mocked up from a real session (workbench, 429 s, 4 subagents, 155 spans) and checked: every span and every parent link is in the data.

### Pane: four tabs instead of seven

| Tab | Holds | Replaces |
| --- | --- | --- |
| Trace (default) | the waterfall of the current conversation | Timeline, Agents, Tools |
| Usage | context, 5 h / 7 d limits, cache window and hit rate, cost or worth | Overview, Cache |
| Files | reads, edits, re-reads | Files |
| Debug | events seen | Debug |

Tool stats (calls, failures, p95) become a footer of the Trace tab, and per-agent stats move into the detail card.

### Recorder: spans

One list `S.spans`, JSON-serialisable, capped (2000 spans; older turns fold into one summary span each).

```js
{ id, parent, kind: 'turn' | 'llm' | 'tool' | 'agent', name, detail, model,
  t0, t1 /* null while running */, status: 'running' | 'ok' | 'error' | 'aborted',
  usage /* llm: the four token counts */, cost, err /* first 200 chars */, agentId }
```

| Span | Opened by | Closed by | Parent |
| --- | --- | --- | --- |
| turn (main) | `turn.start` | `turn.complete` | none (one row per prompt) |
| llm | `turn.step`, `$.clock.now()` before `yield* next(e)` | after it; `usage`, `stopReason` | its loop's current turn |
| tool | `session.append` `tool_use` (input gives `detail`) | `tool_result` (`is_error`, error text) | its loop's current turn |
| agent | `agent.spawn` (`tool_use_id`, description, type, model) | its `turn.complete` (`agentId`) | the `Agent` tool span with that `tool_use_id` |

Cost is per llm span (`costOf`), summed up the tree. `detail` per tool: `file_path` basename, `description` or `command` for Bash, `pattern`, `query`, `url`, `description` for Agent. Background agents return their `Agent` call in under a second, so the agent span (not the call) carries the bar; the call row is folded into it.

### Drawing

One row = `Box(row)[ Button(label column, fixed width) , Box(track) ]`. The track is three flex children whose `flexGrow` are the gap before the bar, the bar and the rest, in permille of the axis (at most 1000, under the 10000 cap). That lays out the same on terminal and desktop with no width estimates. Desktop colours the bar with `backgroundColor`; terminal the same, one cell high.

- Axis row: tick labels as flex spacers at round intervals (10 s, 30 s, 1 m, 5 m by span length).
- The label column truncates (`truncate-end`); the `duration · cost` label sits after the bar, or before it past 70 % of the axis.
- Pressing a label selects the span (detail card under the list) and, on an agent, expands or collapses it.
- Running spans grow with the tick; a now line is the right end of the axis while live.
- Narrow (52 columns): the label column shrinks to 18 cells and the cost drops from the bar label first.
- Scroll: the pane scrolls; the list starts at the latest turn, older turns collapsed to one row each.

### Band: calm, not clever

- A fixed set: context, 5 h (and 7 d when above 50 %), and one "now" pill naming what runs (`builder · Write 12s`, or the turn's elapsed time). Cost only on API accounts.
- Every pill a fixed width with tabular figures, so nothing moves when numbers change; no row balancing. Below the width for all, drop whole pills from the end and show `+N` in the last.
- Redraw on events; the 1 s tick only invalidates while a countdown or a running timer is on screen.

## Build order

Each step ends green on `make check`, with `make render` looked at.

1. Recorder: `S.spans` in `lib/model.js` with pure mutators, hooked from `hooks/register.js`; tests for nesting, background agents, errors, caps, snapshot and restore.
2. Seed: `.shots/shots.test.ts` advances the clock per tool and model call (real durations), with one failed tool and one running agent.
3. Trace tab on both surfaces; gallery entry in `.shots/render.mjs`.
4. Band rewrite; drop `balance()` and `textW` row cutting.
5. Fold tabs: Usage replaces Overview and Cache; Timeline, Agents and Tools go once Trace covers them.

## Open questions

- Desktop bars as Boxes (portable, clickable) or one interactive `Svg` per pane (hover tooltips, finer bars, but not clickable and widths estimated again)? Proposal: Boxes first, `Svg` only if Boxes look too coarse.
- A `Client` module could keep expand and selection state on the surface with hover cards; worth it after step 3 if the round trip through the hooks feels slow.
- Rebuild the trace from the transcript file on reload (SCHEMA.md, "The transcript on disk") instead of the 15 s snapshot?
