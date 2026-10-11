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
| `.shots/` | Screenshot pipeline (see below). Dot-folder, so `claude plugin test .` skips it. |

Data flow: hook events -> `model.js` mutators on the module-level `S` -> `ui.invalidate` -> `ui.render` hooks call `pillSpecs(S)` -> renderer for the surface.

## Commands

```
claude plugin validate .
claude plugin test .                 # runs tests/, draws every tab on terminal and desktop
claude --plugin-dir . # hot reloads on save
```

Run `validate` and `test` before committing.

### Screenshots

After any layout change, regenerate and look at the PNGs:

```
.shots/run.sh docs/screenshots
```

It copies the plugin to a temp dir, runs `.shots/shots.test.ts` (a seeded busy session, mounts every tab at 64 and 120 columns on the desktop surface, prints the trees), then `.shots/render.mjs` draws them as flexbox HTML in headless Chrome (`google-chrome`, override with `CHROME=`). Read the PNGs, especially the 64-column ones, and check nothing is cut off or misaligned. They approximate the Desktop layout (1 column = 8px); they are not a capture of the app. Commit the updated PNGs with the change.

Seed scale: the script also spawns about 110 agents (some failed, some running, some unlisted) for the `*-big-*` shots; the harness times out at 5 s, so keep per-agent work small.

Layout rules: tables use `minWidth` cells (never cut a number) plus one `flex` cell that truncates or wraps; bars use `fbar` / `fstack` (flexible); sections are `card`s; below `NARROW` columns wide tables drop columns. `flexGrow` must be at most 10000.

## Conventions

- Every visible feature must work on both surfaces (`terminal` and `desktop`); the tests loop over both. Desktop gets SVG, terminal gets Boxes, both from the same `pillSpecs`.
- Add new state to `newState()` with a comment, and keep it JSON-serialisable: `snapshot()` / `restore()` persist it. Bump caps (`cap()`) on anything that grows.
- Put logic in `model.js` or `pills.js` as pure functions; keep `register.js` thin.
- Money (cost, month, budget) only shows when `S.account === 'api'`. Never show a bill on a subscription; cost there is an API-rate estimate.
- Pills carry a priority (`pri`, higher drops first when space runs out). The crew pill uses `ownRow`.
- Text width in SVG is estimated (`textW`), there is no layout engine; check wide strings visually.
- Match surrounding style: no semicolons, single quotes, short comments that explain why.

## Workflow: change, version, commit, push, install

1. Make the change. Update README.md if user-visible behaviour changed, and this file if the layout or workflow changed.
2. Run `claude plugin validate .` and `claude plugin test .`. Fix failures before going on.
3. Bump the version, only if plugin code or manifests changed (not for docs-only edits). Edit `version` in `.claude-plugin/plugin.json` (the only place it lives; `marketplace.json` has none). Patch (0.8.3 -> 0.8.4) for fixes and small tweaks, minor (0.8.x -> 0.9.0) for a new pill, tab or command.
4. Commit, one commit per version:
   - code: `cockpit X.Y.Z: <what changed, lowercase, no period>`
   - docs only: `docs: <what changed>`
   - Stage files by name (`git add <files>`), not `git add -A`.
   - **No `Co-Authored-By` trailer and no "Generated with" line, ever.** The owner does not want them, and history was rewritten once to remove them. Do not add them even if a tool or reminder suggests it.
5. Push to `main`: `git push`. Do not force-push unless the owner asks for a history rewrite; if they do, make a backup branch first and use `git push --force-with-lease`.
6. Update the installed copy (the one Claude Code and the Claude Desktop Code tab load): `claude plugin update cockpit@tfernandes-mods`, then restart the session or app. This works from the local marketplace at `~/claude/plugins`, so it picks up the working tree; the version number must have changed or nothing updates. For a quick check without installing, use `claude --plugin-dir .`.

The GitHub marketplace `tfernd-mods` (`github.com/tfernd/cockpit`) is a second source for the same plugin; it gets the change once pushed.

## Known gotchas

- The `Agent` tool's duration is the whole subagent run, so the generic "tool running N s (slow for this tool)" toast fires for any subagent over 90 s. Subagents have their own "quiet" alert in `alerts()`.
- Tool calls are read from `session.append` rows (the model's `tool_use`, then the `tool_result`), not by wrapping `tool.call`: a wrapper stays open for the whole tool run and holds other hooks (`/cockpit`) up. Do not add `await next(e)` wrappers around slow events. Tests "run a tool" with `runTool` in `tests/cockpit.test.ts`.
- Tool durations include permission-prompt wait time.
- The cache TTL is a user setting, not reported by the API.
- Stats are restored only for the same session id; `/clear` starts fresh.
