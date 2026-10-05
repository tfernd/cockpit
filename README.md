# cockpit

A Claude Code mod: one recorder, many views. Built against Claude Code 2.1.289.

**Band above the prompt** (one line): context bar, cache countdown and hit rate, current turn (tools and failures), running subagents, todo progress, 5-hour limit.

**`/cockpit` pane** (keys 1-6 switch tabs):
1. Overview: context, plan limits, cost, turns, tool calls and failure rate, repeated reads, model, what is running now
2. Tools: per tool n, failures, mean, sd, p50, p95, p99 (last 500 calls)
3. Files: reads, edits, repeated reads per file
4. Cache: window countdown, per-request read / wrote / new / hit%, session totals
5. Agents: each subagent's status, model, requests, tools, context, current tool, idle time
6. Timeline: spawns, subagent results, session messages, model changes, compactions

**Toasts**: cache expiring in 30s, context 80% / 90%, a tool running far longer than its own p95, a quiet subagent, the same file read 3 times with no edit.

**Commands**: `/cockpit [tab]`, `/cockpit ttl 5|60` (cache lifetime, saved), `/cockpit reset`.

## Run it

    claude --plugin-dir /path/to/cockpit

Edits hot-reload. To keep it: put it in a marketplace (see `marketplace.json` example in the mods docs) and `/plugin install`.

## Known limits

- Tool durations include time waiting on permission prompts.
- The cache lifetime is a setting (the API does not report it); the countdown starts at the end of the last main-loop request.
- Stats are saved every 15 s to `$.store` and restored for the same session id, so a hot reload keeps history; `/clear` starts fresh.
- Todo progress only reads the `TodoWrite` tool; other task tools are not tracked yet.
- Not yet run inside a live session: pure logic was smoke-tested and `claude plugin validate` passes, but the drawing has not been looked at on screen.
