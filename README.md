# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289. Works in the terminal and in the Desktop Code tab.

## What you see

**Band above the prompt**: a strip of tiles, each a small label, a big number, a thin bar and one line of detail. On Desktop one SVG (light and dark theme), in the terminal coloured Boxes; narrow, the tiles wrap into rows. Colour changes only when something needs a look: amber, then red.
- **Context**: how full, tokens of the window, and a tick on the bar where auto-compaction will run (from Claude Code's own context breakdown); after a compaction, how many there were.
- **Cache**: how long the prompt cache stays warm, and whether the last call really read from it ("98% from cache", or "last call missed: wrote 140k").
- **5-hour** and **Week** (subscriptions) or **Spend** (gateway and enterprise accounts): % used and when it resets.
- **Cost** (API accounts only): this chat, and the month spent → projected against the budget you set. Never on a subscription.
- **Work**: agents running, done and failed, tools in flight, todo and plan progress; on Desktop a dot per subagent.

**`/cockpit` pane** (keys 1-2 switch tabs):
1. **Trace** (opens first): where the time went in one prompt, as swimlanes. The main session and each subagent (under the one that spawned it) get a lane with their model; their thinking (faded) and tool calls (solid) sit on one time axis, a dashed track while they wait, a line where work was handed off, failed calls in red; a triangle over a model call marks a cache write (amber) or a cache miss (red), and its tooltip says how much was read and written and whether the cache had expired. A drawn legend explains every mark. On Desktop, once the trace is done, hover a block for its detail (a live trace is drawn as a plain image: an interactive SVG reloads its frame on every update and blinks) (the command or file, how long, tokens, the error); hover a name for the subagent's answer. Time counts from the latest prompt (0s); the one before shows as a short lead-in (a quarter of the latest's length, negative time), each prompt marked where it began (◆ and its words), so a new message does not start from nothing. Between turns the main lane is idle (a dotted line: waiting on you), not waiting; a finished subagent ends in ✓. A subagent whose end the mod never heard is closed from Claude Code's own agent list; ◀ ▶ show one earlier prompt at a time. A turn its subagents wake stays in the same trace.
2. **Usage**: soft panels in one picture. **Context**: % full with the auto-compact notch and how much is left before it. **Plan limits**: a ring per 5-hour and weekly window with its reset. **Budget this month** (accounts with a spend limit): spent so far (in dollars once you set `/cockpit budget 250`), on pace for, and the month as a burn-down: what was spent (every chat records the server's readings), the even pace, the limit, and a dashed projection to the reset. **Cache**: how long it stays warm, the last call's read share, one dot per subagent cache, a column chart of recent requests (read, written, uncached) with model switches marked and what they re-cached. **Session**: turns, turn times, tokens, cost or worth. **Tools**: calls, failures in red, p95.

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
