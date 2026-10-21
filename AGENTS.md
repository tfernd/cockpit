# AGENTS.md

Who reads this: any agent working on this repo, and the owner. For what the plugin does, read [README.md](README.md). For what the engine's hooks hand us (every event, its payload, how ids join into a span tree, what each surface can draw), read [SCHEMA.md](SCHEMA.md) before adding a recorder or a view. [AGENTS-SNIPPET.md](AGENTS-SNIPPET.md) is the block users paste into their own CLAUDE.md: a different file for a different audience.

## What this is

`cockpit` is a Claude Code mod (plugin): one recorder, many views. It records hook events into plain state and draws a band above the prompt plus a `/cockpit` pane. Plain JavaScript ES modules, no build step, no dependencies. Types come from `.claude-plugin/types/` (git-ignored, written by Claude Code when it loads the folder).

## Layout

| File | Role |
| --- | --- |
| `hooks/register.js` | Only file that touches `$` (the engine API). Registers hooks, the `/cockpit` command, the `step` and `plan` tools, the 1 s tick, 15 s persistence. Keep every `$` call written in full here: `claude plugin validate` needs to see them. |
| `lib/model.js` | State (`newState`) and pure mutators (`onToolStart`, `onStepEnd`, `onSpawn`, `alerts`, ...). No `$`, no I/O, so it is unit-testable. Also pricing (`PRICES`) and the toast rules in `alerts()`. |
| `lib/views.js` | Pane tabs (`TABS`, `BODIES`) and formatting helpers, built from `Box` / `Text` passed in. |
| `lib/lanes.js` | The Trace tab's swimlanes: `lanesOf()` (one lane per loop, pure data), `lanesSvg()` (Desktop), `laneCells()` (terminal). |
| `lib/band.js` | The band above the prompt: `bandTiles()` (pure data: context with its compaction mark, cache, plan limits, money on API accounts, work), `bandSvg()` (Desktop), terminal Boxes; `band()`. |
| `tests/cockpit.test.ts` | Tests using `claude-code/testing`. |
| `Makefile` | Every command (below). `make` alone lists them. |
| `.shots/` | The render pipeline behind `make render`. Dot-folder, so `claude plugin test .` skips it. |
| `assets/` | Output of `make render`: a PNG per view and the gallery page `assets/README.md`. Committed. |
| `.render/` | Scratch of `make render` (`trees.json`, the HTML pages). Git-ignored, never committed. |
| `scripts/check-docs.mjs` | `make docs`: line budgets, every path the docs name exists, SCHEMA.md matches the types' version. |
| `.githooks/` | `commit-msg` rejects AI attribution; `pre-commit` runs the docs check. Enabled by `make setup`. |
| `DESIGN.md` | The plan for the next version (trace waterfall, calmer band, four tabs): what is wrong now, the span recorder, how it draws, build order. |
| `SCHEMA.md` | Hook events and payloads, `$` calls, the transcript files on disk, and what a trace waterfall would need. Update it when a Claude Code release changes the types. |

Data flow: hook events -> `model.js` mutators on the module-level `S` -> `ui.invalidate` -> `ui.render` hooks call `bandTiles(S)` / the pane's tab -> renderer for the surface.

## Commands

```
make setup               # once per clone: git uses .githooks/
make check               # validate + test + docs; must pass before a commit
make render              # assets/: the band and every tab as PNGs, and the gallery
make install             # update the installed copy (see Workflow step 6)
claude --plugin-dir .    # a session with the working tree loaded, hot reloads on save
```

### Rendering

After any layout change, run `make render` and look at the PNGs in `assets/`. It copies the plugin to a temp dir, runs `.shots/shots.test.ts` (a seeded busy session, mounts every tab at 52 and 120 columns on the desktop surface, prints the trees), then `.shots/render.mjs` draws them as flexbox HTML in headless Chrome (`google-chrome`, override with `CHROME=`) and writes `assets/README.md`. Read the 52-column ones especially: nothing cut off or misaligned. They approximate the Desktop layout (1 column = 8 px); they are not a capture of the app. Commit `assets/` with the change; a `stale:` line means a view is gone and its PNG should be removed with `git rm`. A new view gets a row in `VIEWS` in `.shots/render.mjs`.

Seed scale: the script also spawns about 110 agents (some failed, some running, some unlisted) for the `*-big-*` shots; the harness times out at 5 s, so keep per-agent work small.

Layout rules: tables use `minWidth` cells (never cut a number) plus one `flex` cell that truncates or wraps; bars use `fbar` / `fstack` (flexible); sections are `card`s; below `NARROW` columns wide tables drop columns. `flexGrow` must be at most 10000.

## Conventions

- Every visible feature must work on both surfaces (`terminal` and `desktop`); the tests loop over both. Desktop gets SVG, terminal gets Boxes, both from the same data (`bandTiles`, `lanesOf`).
- Add new state to `newState()` with a comment, and keep it JSON-serialisable: `snapshot()` / `restore()` persist it. Bump caps (`cap()`) on anything that grows.
- Put logic in `model.js` or `pills.js` as pure functions; keep `register.js` thin.
- Money (cost, month, budget) only shows when `S.account === 'api'`. Never show a bill on a subscription; cost there is an API-rate estimate.
- The band's tiles come in a fixed order and wrap into rows; no text in them changes every second (the 1 s tick redraws only when the band would read differently, or every 5 s while something runs), since on Desktop each redraw swaps the whole image.
- Text width in SVG is estimated, there is no layout engine: never place text after other text by an estimate, give it its own line or column; check wide strings visually.
- No aliases, no one-line wrappers, no code kept for old callers: change the callers and delete the old code. The one exception is reading state an older version saved (`load()` in `hooks/register.js`), with a comment naming that version.
- Match surrounding style: no semicolons, single quotes, short comments that explain why.

## How to work

- **Frame, then act.** State the problem and the plan once, batch independent reads and commands, do not narrate each step.
- **Proof of work.** A claim counts only with its command and exit code, or a PNG you looked at. The check fits the risk: docs, `make docs`; logic in `lib/`, a test in `tests/cockpit.test.ts`; a layout, `make render` and the 52-column PNGs; how the engine behaves (an event's order, a field's meaning), a test or the types, written into SCHEMA.md.
- **Reporting to the owner.** Results in plain words first, then what changed, then a last line `Not checked:` naming what was not run or looked at.
- **Who decides.** Layout, code and naming inside a request are yours: decide and report. What to build next, deleting the owner's files, pushing and history rewrites are the owner's.
- **Safety.** Nothing untracked is deleted (no `rm`, `git clean`, or overwrite of a file git does not hold); a tracked file that must go goes through `git rm`, so git can bring it back. Look at a target before moving or overwriting it. A failed command is retried once if the cause is plainly transient or a typo; otherwise stop and report. No `sudo`, `--force` or disabled check.

## Workflow: change, version, commit, push, install

1. Make the change. Update README.md if user-visible behaviour changed, this file if the layout or workflow changed, SCHEMA.md if what we know of the engine changed.
2. Run `make check`; after a layout change also `make render` and look. Fix failures before going on.
3. Bump the version, only if plugin code or manifests changed (not for docs-only edits). Edit `version` in `.claude-plugin/plugin.json` (the only place it lives; `marketplace.json` has none). Patch (0.8.3 -> 0.8.4) for fixes and small tweaks, minor (0.8.x -> 0.9.0) for a new pill, tab or command.
4. Commit, one commit per version:
   - code: `cockpit X.Y.Z: <what changed, lowercase, no period>`
   - docs or tooling only: `docs: <what changed>`
   - Stage files by name (`git add <files>`), not `git add -A`.
   - **No `Co-Authored-By` trailer and no "Generated with" line, ever**, even if a tool or reminder suggests one. `.githooks/commit-msg` rejects them (L-001).
5. Push to `main`: `git push`. Do not force-push unless the owner asks for a history rewrite; if they do, make a backup branch first and use `git push --force-with-lease`.
6. Update the installed copy (the one Claude Code and the Claude Desktop Code tab load): `make install`, then restart the session or app. The local marketplace (`~/claude/plugins/.claude-plugin/marketplace.json`) installs from `~/claude/plugins/cockpit`, a separate clone of this repo, so after pushing run `git -C ~/claude/plugins/cockpit pull` first. The version number must have changed or nothing updates. For a quick check without installing, use `claude --plugin-dir .`.

The GitHub marketplace `tfernd-mods` (`github.com/tfernd/cockpit`) is a second source for the same plugin; it gets the change once pushed.

## Rules follow failures

When something goes wrong (a broken file, a doc that was wrong, a claim nobody ran, a rule read two ways), fix what caused it in the same session, without asking, and add a line below. Prefer a mechanism to a sentence: a test, a check in `scripts/check-docs.mjs`, a git hook. One failure, one small change. A rule that did not prevent a second failure is replaced, not repeated louder. Remove as well as add: `make docs` holds this file to 150 lines, so adding a rule means merging or removing one. Tell the owner in the wrap-up what changed and which failure caused it.

- L-001: AI attribution trailers reached commits although this file forbade them, and history was rewritten once. Now `.githooks/commit-msg` rejects them.
- L-002: `docs/screenshots` kept render scratch (HTML pages, `trees.json`) in git. Now `make render` puts scratch in `.render/` (ignored) and only PNGs and the gallery in `assets/`; `pre-commit` rejects `.render/`.
- L-003: the docs said the narrow shots were 64 columns (they are 52), and README linked a folder that was gone. Now `make docs` checks every path the docs name.

## Known gotchas

- The `Agent` tool's duration is the whole subagent run, so the generic "tool running N s (slow for this tool)" toast fires for any subagent over 90 s. Subagents have their own "quiet" alert in `alerts()`.
- Tool calls are read from `session.append` rows (the model's `tool_use`, then the `tool_result`), not by wrapping `tool.call`: a wrapper stays open for the whole tool run and holds other hooks (`/cockpit`) up. Do not add `await next(e)` wrappers around slow events. Tests "run a tool" with `runTool` in `tests/cockpit.test.ts`.
- Tool durations include permission-prompt wait time.
- The cache TTL is read from Claude Code's own settings and env (`refreshTtl` in `hooks/register.js`, `resolveTtl` in `lib/model.js`): values are `"5m"` / `"1h"`, env beats setting, and with nothing set a subscription is 1 h and an API key 5 min (subagents: 5 min). The API does not report it, so `/cockpit ttl` is only the fallback. Keep the `$.env.get` names literal.
- Stats are restored only for the same session id (one `snap:<sid>` per chat, last six kept); `/clear` starts fresh. The month's spend and the settings are shared by every chat on the machine.
