# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289. Works in the terminal and in the Desktop Code tab.

## What you see

**Band above the prompt**: pill badges justified edge to edge, spread evenly over the fewest rows they need (3-3-1 rather than 4-2-1; at most three rows on Desktop, two in the terminal, dropping the lowest-priority pills if they do not fit). On Desktop they are drawn as an SVG (rounded, tinted, icons, thin bars, light and dark theme); in the terminal as colored blocks.
- context, with tokens used of the window
- *subscription*: 5-hour and weekly windows with reset times
- *API / enterprise*: spend limit (when the account has one), **chat** cost, and **month** (spent so far → projected, against the budget you set). None of these show on a subscription.
- *subscription*: a **worth** pill, a guess of what this chat's usage would cost at API rates (≈$ chat, ≈$ month), next to the fee you set with `/cockpit plan 100`
- cache countdown and hit rate
- tokens this session: in (new input + cache writes), out, cached (served by the cache)
- a **model / effort switch** pill for ten minutes after a change, saying whether the cache was kept or re-written
- current turn and task progress (from `TodoWrite`), plus the plan pill while a posted plan has tasks left
- **crew pill** (only while subagents are running, always on its own last row): done / total, one square per subagent in spawn order (blue running, grey done, red failed, amber stopped, hollow = planned and not started; brighter as its context fills), and failed / running counts. Crews over forty are grouped, each square showing the busiest state in its group.

**`/cockpit` pane** (keys 1-7 switch tabs):
1. **Overview**: budget bars (context, 5-hour, weekly, cache window, task progress), stat tiles (turns, tool calls, failures, re-reads, agents, compactions, cost), turn-time mean / sd / p95 / p99, what is running now
2. **Tools**: per tool calls, failures, mean, sd, p50, p95, p99, with a p95 bar (last 500 calls per tool)
3. **Files**: reads, edits and repeated reads per file
4. **Cache**: window countdown, read / wrote / new / output totals, every model or effort switch with the tokens it forced the cache to re-write, a stacked bar per request
5. **Agents**: (Desktop: the square grid first) fleet progress bar, the plan's progress, a per-type table (runs, done, failed, tokens, cost, average time), then **every** subagent as a tree under the loop that spawned it, with its step progress, tokens, cost and the result it handed back. Nothing is cut off.
6. **Timeline**: spawns, subagent results, session messages, model changes, compactions
7. **Debug**: which events the recorder has actually seen, and when. Start here if a panel is empty.

**Toasts** (each fires once): cache expiring in 30 s, context 80% / 90%, a tool running too long, a subagent quiet for over 2 minutes, the same file read 3 times with no edit. "Too long" is 90 s until a tool has 8 recorded calls, then `max(45 s, 3 × its p95)`. Note the `Agent` tool lasts as long as the whole subagent run, so it trips this on any subagent over 90 s ("Agent running 90s (slow for this tool)"); that is expected, not a fault.

**Workers and the plan**: subagents can call `mcp__cockpit__step` (`done`, `total`, `note`) to report their own steps, and the orchestrator can call `mcp__cockpit__plan` (`title`, `tasks`) to post the plan. The plan shows as a pill until every task is done. Both are optional; without them, cockpit still counts agents from the engine's own events. To make agents use them, paste the block in [AGENTS-SNIPPET.md](AGENTS-SNIPPET.md) into your CLAUDE.md. Checked: both tools are listed in a real `claude -p` session under these names.

**Commands**: `/cockpit [tab]`, `/cockpit ttl 5|60` (cache lifetime, saved), `/cockpit budget 200` (monthly USD budget, `off` clears), `/cockpit plan 100` (what you pay for a subscription per month, `off` clears), `/cockpit reset`.

## What is measured and what is guessed

- **Measured** (reported by Claude Code for every model request, main loop and subagents alike): input, output, cache-read and cache-write tokens, the model, context fill, the 5-hour / weekly / spend-limit percentages with reset times, and the session cost total (`/cost`, API list rates).
- **Set by you**: the cache lifetime (`/cockpit ttl`, the API does not report it, so the countdown is a guess from the end of the last main-loop request), the monthly budget, the subscription fee.
- **Estimated by cockpit**: per-subagent and per-type cost (a built-in price table at list rates), the month projection, the subscription *worth*. Subagent cache windows are not tracked, only the main loop's.

## Money, honestly

- *Subscription* (Pro / Max): the 5-hour and weekly pills are the plan's real windows. Nothing is billed per token; the **worth** pill is what the same usage would cost at API rates, a comparison with your fee, not a bill.
- *Enterprise / gateway*: the account reports a `spend_limit` percentage and reset, shown as the spend pill. The API does not report the dollar quota, so cockpit never invents one: **month** is compared only with a budget you set. Costs use list rates, so a negotiated contract price will differ.
- *Month*: the engine's cost of every session that ran with cockpit loaded, added up. Sessions run without cockpit are not counted, so it can undercount; the projection needs three days of data.

## Develop

    claude --plugin-dir ~/claude/plugins/cockpit     # hot reloads on save
    claude plugin validate .
    claude plugin test .                             # draws every tab for terminal and desktop

Installed from this folder through a local marketplace (`claude plugin install cockpit@tfernandes-mods`). Claude Code installs a copy under `~/.claude/plugins/cache/`, keyed by the `version` in `.claude-plugin/plugin.json`, so bump the version (one commit per version, `cockpit X.Y.Z: what changed`) for the installed copy to pick up an edit; `--plugin-dir` always uses the working tree. See [AGENTS.md](AGENTS.md) for the code layout.

## Screenshots

PNGs of every tab at a narrow (64 columns) and a wide (120 columns) pane are in [docs/screenshots](docs/screenshots). They are made by `.shots/run.sh` from a seeded session: the pane's element tree drawn as flexbox HTML in headless Chrome, so they show the layout, not a capture of the Desktop app itself.

## Known limits

- Tool durations include time waiting on permission prompts.
- The cache lifetime is a setting (the API does not report it); the countdown starts at the end of the last main-loop request.
- Stats are saved every 15 s and restored for the same session id; `/clear` starts fresh. Counting starts when the plugin loads, not at the start of the conversation.
- Todo progress only reads the `TodoWrite` tool.
