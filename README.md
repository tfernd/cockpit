# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289. Works in the terminal and in the Desktop Code tab.

## What you see

**Band above the prompt** (one row of chips, dropped by priority when the window is narrow):
context bar and tokens · cache countdown bar and last hit rate · current turn (tools, failures) · running subagents · 5-hour and weekly plan limits · todo progress · cost · model.

**`/cockpit` pane** (keys 1-7 switch tabs):
1. **Overview**: budget bars (context, 5-hour, weekly, cache window, task progress), stat tiles (turns, tool calls, failures, re-reads, agents, compactions, cost), turn-time mean / sd / p95 / p99, what is running now
2. **Tools**: per tool calls, failures, mean, sd, p50, p95, p99, with a p95 bar (last 500 calls per tool)
3. **Files**: reads, edits and repeated reads per file
4. **Cache**: window countdown, read / wrote / new totals, a stacked bar per request
5. **Agents**: tree of subagents with status, model, tools, context, what each is doing now, stalled flag, and the result it handed back to main
6. **Timeline**: spawns, subagent results, session messages, model changes, compactions
7. **Debug**: which events the recorder has actually seen, and when. Start here if a panel is empty.

**Toasts**: cache expiring in 30 s, context 80% / 90%, a tool running far past its own p95, a quiet subagent, the same file read 3 times with no edit.

**Commands**: `/cockpit [tab]`, `/cockpit ttl 5|60` (cache lifetime, saved), `/cockpit reset`.

## Develop

    claude --plugin-dir ~/claude/plugins/cockpit     # hot reloads on save
    claude plugin validate .
    claude plugin test .                             # draws every tab for terminal and desktop

Desktop installs from GitHub and caches by version: bump `version` in `.claude-plugin/plugin.json`, push, then update the plugin in Plugins.

## Known limits

- Tool durations include time waiting on permission prompts.
- The cache lifetime is a setting (the API does not report it); the countdown starts at the end of the last main-loop request.
- Stats are saved every 15 s and restored for the same session id; `/clear` starts fresh. Counting starts when the plugin loads, not at the start of the conversation.
- Todo progress only reads the `TodoWrite` tool.
