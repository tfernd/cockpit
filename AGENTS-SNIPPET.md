# Add this to your CLAUDE.md so agents report to cockpit

Paste the block below into `~/.claude/CLAUDE.md` (or the project's CLAUDE.md). It is optional: without it, cockpit still counts subagents and their tokens, cost and time from the engine's own events. The block only adds per-step progress and the plan.

```
## Reporting to cockpit (only if the cockpit plugin is loaded)

- Orchestrator: before delegating several tasks, call `mcp__cockpit__plan` with a short `title` and the ordered `tasks`
  (each `title` exactly equal to the Agent `description` you will use, and `tier` if you use one).
- Subagent: right after reading your brief, call `mcp__cockpit__step` with `total` (your plan, 3-8 steps) and `done: 0`.
  Call it again as each step finishes, with `done` and a short `note` for the step in progress.
- Both calls are cheap; skip them if the tools are not available.
```
