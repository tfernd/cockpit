# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289. Works in the terminal and in the Desktop Code tab.

## What you see

**Band above the prompt**: pill badges justified edge to edge, spread evenly over the fewest rows they need (3-3-1 rather than 4-2-1; at most three rows on Desktop, two in the terminal, dropping the lowest-priority pills if they do not fit). On Desktop they are drawn as an SVG (rounded, tinted, icons, thin bars, light and dark theme); in the terminal as colored blocks.
- context: how full, of what window size (the exact token count is on the Usage tab)
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

**`/cockpit` pane** (keys 1-4 switch tabs):
1. **Trace** (opens first): where the time went in one prompt, as swimlanes. The main session and each subagent (under the one that spawned it) get a lane with their model; their thinking (faded) and tool calls (solid) sit on one time axis, a dashed track while they wait, a line where work was handed off, failed calls in red; a triangle over a model call marks a cache write (amber) or a cache miss (red), and its tooltip says how much was read and written and whether the cache had expired. A drawn legend explains every mark. On Desktop, once the trace is done, hover a block for its detail (a live trace is drawn as a plain image: an interactive SVG reloads its frame on every update and blinks) (the command or file, how long, tokens, the error); hover a name for the subagent's answer. The latest prompt is drawn with the one before it on the same axis, each marked where it began (◆ and its words), so a new message does not start from zero; ◀ ▶ show one earlier prompt at a time. A turn its subagents wake stays in the same trace.
2. **Usage**: context, the 5-hour and weekly windows with reset times, task, plan and agent progress, money (API accounts) or worth (subscriptions), session counters and turn-time stats; then the prompt cache: main-window countdown, the subagent caches, read / wrote / new totals, every model or effort switch with the tokens it re-cached, and a stacked bar per request; at the bottom, calls, failures and p50 / p95 per tool for the whole session
3. **Files**: reads, edits and repeated reads per file. Paths are relative to the workspace folder; a file outside it is shown in full with ↗
4. **Debug**: which events the recorder has actually seen, and when. Start here if a panel is empty.

**Toasts** (each fires once; several of the same kind arrive as one): cache expiring in 30 s, context 80% / 90%, a tool running too long, a subagent quiet for over 2 minutes, the same file read 3 times with no edit. "Too long" is 90 s until a tool has 8 recorded calls, then `max(45 s, 3 × its p95)`. Note the `Agent` tool lasts as long as the whole subagent run, so it trips this on any subagent over 90 s ("Agent running 90s (slow for this tool)"); that is expected, not a fault.

**Workers and the plan**: subagents can call `mcp__cockpit__step` (`done`, `total`, `note`) to report their own steps, and the orchestrator can call `mcp__cockpit__plan` (`title`, `tasks`) to post the plan. The plan shows as a pill until every task is done. Both are optional; without them, cockpit still counts agents from the engine's own events. To make agents use them, paste the block in [AGENTS-SNIPPET.md](AGENTS-SNIPPET.md) into your CLAUDE.md. Checked: both tools are listed in a real `claude -p` session under these names.

**Commands**: `/cockpit [tab]`, `/cockpit ttl 5|60|auto` (cache lifetime, saved; only used when no Claude Code setting decides), `/cockpit budget 200` (monthly USD budget, `off` clears), `/cockpit plan 100` (what you pay for a subscription per month, `off` clears), `/cockpit account api|subscription|auto` (pin the account type; `auto` reads it off the limits the account reports, and a plain API key reports none, so pin `api` there), `/cockpit reset`.

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
