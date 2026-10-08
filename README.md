# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289. Works in the terminal and in the Desktop Code tab.

## What you see

**Band above the prompt**: pill badges that stretch to fill each row. On Desktop they are drawn as an SVG (rounded, tinted, icons, thin bars, light and dark theme); in the terminal as colored blocks.
- context, with tokens used of the window
- *subscription*: 5-hour and weekly windows with reset times
- *API / enterprise*: spend limit (when the account has one), **chat** cost, and **month** (spent so far → projected, against what is allowed). None of these show on a subscription.
- cache countdown and hit rate
- tokens this session: in (new input + cache writes), out, cached (served by the cache)
- a **model / effort switch** pill for ten minutes after a change, saying whether the cache was kept or re-written
- current turn, subagent summary plus **one pill for each running agent** (type, current tool, elapsed, context, silent warning), task progress

**`/cockpit` pane** (keys 1-7 switch tabs):
1. **Overview**: budget bars (context, 5-hour, weekly, cache window, task progress), stat tiles (turns, tool calls, failures, re-reads, agents, compactions, cost), turn-time mean / sd / p95 / p99, what is running now
2. **Tools**: per tool calls, failures, mean, sd, p50, p95, p99, with a p95 bar (last 500 calls per tool)
3. **Files**: reads, edits and repeated reads per file
4. **Cache**: window countdown, read / wrote / new / output totals, every model or effort switch with the tokens it forced the cache to re-write, a stacked bar per request
5. **Agents**: fleet progress bar (launched / finished / running / failed), then a tree of subagents with status, model, tools, context, what each is doing now, stalled flag, and the result it handed back to main
6. **Timeline**: spawns, subagent results, session messages, model changes, compactions
7. **Debug**: which events the recorder has actually seen, and when. Start here if a panel is empty.

**Toasts**: cache expiring in 30 s, context 80% / 90%, a tool running far past its own p95, a quiet subagent, the same file read 3 times with no edit.

**Commands**: `/cockpit [tab]`, `/cockpit ttl 5|60` (cache lifetime, saved), `/cockpit budget 200` (monthly USD budget, `off` clears), `/cockpit reset`.

## Money, honestly

- *Subscription* (Pro / Max): the 5-hour and weekly pills are the plan's real windows. Session cost is an API-rate estimate, not a bill.
- *Enterprise / gateway*: the account reports a `spend_limit` window, shown as the spend-limit pill with its reset.
- *Month projection*: spent so far plus the average daily spend since cockpit started counting, over the days left. Rough, and only as good as the sessions it saw.
- *Allowed*: the dollar limit you set with `/cockpit budget`; on a gateway account with a spend-limit percentage, cockpit backs out an approximate dollar limit and shows it with `≈`.
- *Monthly budget*: the API does not expose it, so cockpit adds up the cost of every session that ran with it loaded and compares that with the number you set. Sessions run without cockpit are not counted.

## Develop

    claude --plugin-dir ~/claude/plugins/cockpit     # hot reloads on save
    claude plugin validate .
    claude plugin test .                             # draws every tab for terminal and desktop

Installed from this folder through a local marketplace (`claude plugin install cockpit@tfernandes-mods`), so edits apply to the next session you start; no push or version bump needed.

## Known limits

- Tool durations include time waiting on permission prompts.
- The cache lifetime is a setting (the API does not report it); the countdown starts at the end of the last main-loop request.
- Stats are saved every 15 s and restored for the same session id; `/clear` starts fresh. Counting starts when the plugin loads, not at the start of the conversation.
- Todo progress only reads the `TodoWrite` tool.
