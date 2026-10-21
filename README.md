# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289. Works in the terminal and in the Desktop Code tab.

## What you see

**Band above the prompt**: pill badges justified edge to edge, spread evenly over the fewest rows they need (3-3-1 rather than 4-2-1; at most three rows on Desktop, two in the terminal, dropping the lowest-priority pills if they do not fit). On Desktop they are drawn as an SVG (rounded, tinted, icons, thin bars, light and dark theme); in the terminal as colored blocks.
- context: how full, of what window size (the exact token count is on the Overview tab)
- *subscription*: 5-hour and weekly windows with reset times
- *API / enterprise*: spend limit (when the account has one), **chat** cost, and **month** (spent so far → projected, against the budget you set). None of these show on a subscription.
- *subscription*: a **worth** pill, a guess of what this chat's usage would cost at API rates (≈$ chat, ≈$ month), next to the fee you set with `/cockpit plan 100`
- cache countdown and hit rate
- tokens this session: in (new input + cache writes), out, cached (served by the cache)
- a **model / effort switch** pill for ten minutes after a change, saying whether the cache was kept or re-written
- The band is laid out in three groups, each on its own rows: gauges (context, cache, limits, plan, tasks), what is happening now (turn, tools, crew), and totals (tokens, money, model switch).
- current turn and task progress (from `TodoWrite`), plus the plan pill while a posted plan has tasks left
- **tools pill** (only while tools run): how many run in parallel right now, how many of them are inside subagents, and the most seen at once
- **crew pill** (only while subagents are running): done / total, one square per subagent in spawn order (blue running, grey done, red failed, amber stopped, hollow = planned and not started; brighter as its context fills), and failed / running counts. Crews over forty are grouped, each square showing the busiest state in its group.

**`/cockpit` pane** (keys 1-8 switch tabs):
1. **Trace** (opens first): where the time went in one prompt. Each model call, tool call and subagent is a row with a bar on a shared time axis, `duration · cost` after it, nested under the subagent that ran it; failed spans are red, the slowest call is marked, running ones grow live. Press a row to see its detail (model, tokens, input, the error text or the subagent's answer); press a subagent again to open or close it. A turn its subagents wake while they still run stays in the same trace; ◀ ▶ page through earlier prompts.
2. **Overview**: the same gauges as the pills, as bars with the detail a pill has no room for (tokens, reset times, cache hit rate, task, plan and agent progress, month against budget), then session counters (turns, tool calls, failures, re-reads, compactions), turn-time stats, tokens, money, model, workspace, and what is running now. The pills are not repeated here: they live above the prompt
3. **Tools**: per tool calls, failures, mean, sd, p50, p95, p99, with a p95 bar (last 500 calls per tool)
4. **Files**: reads, edits and repeated reads per file. Paths are relative to the workspace folder; a file outside it is shown in full with ↗
5. **Cache**: main-window countdown, the **subagent caches** (how many are still warm, when the next cools),  read / wrote / new / output totals, every model or effort switch with the tokens it forced the cache to re-write, a stacked bar per request
6. **Agents**: (Desktop: the square grid first) fleet bar with the most running at once, the plan's progress, **per-subagent statistics** (time, turns, tools, tokens, cost: mean, p50, p95, max), **by model** and **by type** tables, then the agents themselves. Up to 24 it is a full tree under the loop that spawned each, with step progress and the result handed back. Past that it lists only what needs a look (running, failed, the latest finished), one line each; `/cockpit all` lists everything. Loops that send events but were never announced (a workflow's agents, engine forks) are picked up from those events and marked *unlisted*.
7. **Timeline**: spawns, subagent results, session messages, model changes, compactions
8. **Debug**: which events the recorder has actually seen, and when. Start here if a panel is empty.

**Toasts** (each fires once; several of the same kind arrive as one): cache expiring in 30 s, context 80% / 90%, a tool running too long, a subagent quiet for over 2 minutes, the same file read 3 times with no edit. "Too long" is 90 s until a tool has 8 recorded calls, then `max(45 s, 3 × its p95)`. Note the `Agent` tool lasts as long as the whole subagent run, so it trips this on any subagent over 90 s ("Agent running 90s (slow for this tool)"); that is expected, not a fault.

**Workers and the plan**: subagents can call `mcp__cockpit__step` (`done`, `total`, `note`) to report their own steps, and the orchestrator can call `mcp__cockpit__plan` (`title`, `tasks`) to post the plan. The plan shows as a pill until every task is done. Both are optional; without them, cockpit still counts agents from the engine's own events. To make agents use them, paste the block in [AGENTS-SNIPPET.md](AGENTS-SNIPPET.md) into your CLAUDE.md. Checked: both tools are listed in a real `claude -p` session under these names.

**Commands**: `/cockpit [tab]`, `/cockpit ttl 5|60|auto` (cache lifetime, saved; only used when no Claude Code setting decides), `/cockpit budget 200` (monthly USD budget, `off` clears), `/cockpit plan 100` (what you pay for a subscription per month, `off` clears), `/cockpit account api|subscription|auto` (pin the account type; `auto` reads it off the limits the account reports, and a plain API key reports none, so pin `api` there), `/cockpit all` (list every subagent instead of the busy and recent ones), `/cockpit reset`.

## What is measured and what is guessed

- **Measured** (reported by Claude Code for every model request, main loop and subagents alike): input, output, cache-read and cache-write tokens, the model, context fill, the 5-hour / weekly / spend-limit percentages with reset times, and the session cost total (`/cost`, API list rates).
- **Detected**: the account type (subscription or enterprise gateway) from which limit windows the account reports; pin it with `/cockpit account` if that is wrong or empty.
- **Read from Claude Code's configuration**: the cache lifetimes. The main window uses `CLAUDE_CODE_PROMPT_CACHE_TTL` or `promptCacheTtl` ("5m" / "1h"), else `FORCE_PROMPT_CACHING_5M` / `ENABLE_PROMPT_CACHING_1H`, else automatic (1 hour on a subscription, 5 minutes on an API key). Subagents use `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` or `subagentPromptCacheTtl`, else 5 minutes. The API does not report the lifetime, so each countdown is counted from the end of the last request. `/cockpit ttl 5|60` covers a case cockpit cannot see (a subscription in overage drops to 5 minutes)
- **Set by you**: the monthly budget, the subscription fee.
- **Estimated by cockpit**: per-subagent and per-type cost (a built-in price table at list rates), the month projection, the subscription *worth*.

## Money, honestly

- *Subscription* (Pro / Max): the 5-hour and weekly pills are the plan's real windows. Nothing is billed per token; the **worth** pill is what the same usage would cost at API rates, a comparison with your fee, not a bill.
- *Enterprise / gateway*: the account reports a `spend_limit` percentage and reset, shown as the spend pill. The API does not report the dollar quota, so cockpit never invents one: **month** is compared only with a budget you set. Costs use list rates, so a negotiated contract price will differ.
- *Month*: the engine's cost of every session that ran with cockpit loaded, added up. Sessions run without cockpit are not counted, so it can undercount; the projection needs three days of data.

## Develop

    claude --plugin-dir ~/claude/plugins/cockpit     # hot reloads on save
    claude plugin validate .
    claude plugin test .                             # draws every tab for terminal and desktop

Installed from this folder through a local marketplace (`claude plugin install cockpit@tfernandes-mods`). Claude Code installs a copy under `~/.claude/plugins/cache/`, keyed by the `version` in `.claude-plugin/plugin.json`, so bump the version (one commit per version, `cockpit X.Y.Z: what changed`) for the installed copy to pick up an edit; `--plugin-dir` always uses the working tree. See [AGENTS.md](AGENTS.md) for the code layout.

## Gallery

Every view (the band and each tab) at a narrow (52 columns) and a wide (120 columns) pane is in [assets/README.md](assets/README.md). `make render` draws them from a seeded session: the pane's element tree laid out as flexbox HTML in headless Chrome, so they show the layout, not a capture of the Desktop app itself.

## Known limits

- Tool durations include time waiting on permission prompts.
- The cache lifetime is a setting (the API does not report it); the countdown starts at the end of the last main-loop request.
- Stats are saved every 15 s and restored for the same session id; `/clear` starts fresh. Counting starts when the plugin loads, not at the start of the conversation.
- Todo progress only reads the `TodoWrite` tool.

**Several chats at once**: each chat is its own session with its own recorder, so every pill and tab shows that chat only. What they share is the saved settings (budget, fee, account, `/cockpit ttl`) and the month's spend, to which each chat adds its own growth. Each chat keeps its own saved snapshot (the last six are kept), so resuming one restores its own stats.
