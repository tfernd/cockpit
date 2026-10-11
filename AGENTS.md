# AGENTS.md

Guide for agents working on this repo. For what the plugin does, read [README.md](README.md). For the block users paste into their own CLAUDE.md, see [AGENTS-SNIPPET.md](AGENTS-SNIPPET.md); that is a different file with a different audience.

## What this is

`cockpit` is a Claude Code mod (plugin): one recorder, many views. It records hook events into plain state and draws a band above the prompt plus a `/cockpit` pane. Plain JavaScript ES modules, no build step, no dependencies. Types come from `.claude-plugin/types/` (git-ignored, provided by Claude Code).

## Layout

| File | Role |
| --- | --- |
| `hooks/register.js` | Only file that touches `$` (the engine API). Registers hooks, the `/cockpit` command, the `step` and `plan` tools, the 1 s tick, 15 s persistence. Keep every `$` call written in full here: `claude plugin validate` needs to see them. |
| `lib/model.js` | State (`newState`) and pure mutators (`onToolStart`, `onStepEnd`, `onSpawn`, `alerts`, ...). No `$`, no I/O, so it is unit-testable. Also pricing (`PRICES`) and the toast rules in `alerts()`. |
| `lib/views.js` | Pane tabs (`TABS`, `BODIES`) and formatting helpers, built from `Box` / `Text` passed in. |
| `lib/pills.js` | `pillSpecs()` decides *what* pills to show (pure data); terminal renderer (colored Boxes); `band()` and `paneBody()`. |
| `lib/svgband.js` | Desktop renderer: pills as one SVG, row balancing and justification, crew squares, `dotGridSvg`. |
| `tests/cockpit.test.ts` | Tests using `claude-code/testing`. |

Data flow: hook events -> `model.js` mutators on the module-level `S` -> `ui.invalidate` -> `ui.render` hooks call `pillSpecs(S)` -> renderer for the surface.

## Commands

```
claude plugin validate .
claude plugin test .                 # runs tests/, draws every tab on terminal and desktop
claude --plugin-dir . # hot reloads on save
```

Run `validate` and `test` before committing.

## Conventions

- Every visible feature must work on both surfaces (`terminal` and `desktop`); the tests loop over both. Desktop gets SVG, terminal gets Boxes, both from the same `pillSpecs`.
- Add new state to `newState()` with a comment, and keep it JSON-serialisable: `snapshot()` / `restore()` persist it. Bump caps (`cap()`) on anything that grows.
- Put logic in `model.js` or `pills.js` as pure functions; keep `register.js` thin.
- Money (cost, month, budget) only shows when `S.account === 'api'`. Never show a bill on a subscription; cost there is an API-rate estimate.
- Pills carry a priority (`pri`, higher drops first when space runs out). The crew pill uses `ownRow`.
- Text width in SVG is estimated (`textW`), there is no layout engine; check wide strings visually.
- Match surrounding style: no semicolons, single quotes, short comments that explain why.

## Releasing

One commit per version: bump `version` in `.claude-plugin/plugin.json`, commit as `cockpit X.Y.Z: <what changed>`. The installed copy only updates when the version changes. Update README.md if user-visible behaviour changed.

## Known gotchas

- The `Agent` tool's duration is the whole subagent run, so the generic "tool running N s (slow for this tool)" toast fires for any subagent over 90 s. Subagents have their own "quiet" alert in `alerts()`.
- Tool durations include permission-prompt wait time.
- The cache TTL is a user setting, not reported by the API.
- Stats are restored only for the same session id; `/clear` starts fresh.
