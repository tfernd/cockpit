# Gallery

Every view of the cockpit, drawn by `make render` from a seeded session (`.shots/shots.test.ts`). The pane's element tree is laid out as flexbox HTML in headless Chrome (1 column = 8 px), so this shows the layout, not a capture of the Desktop app. Each view is shown 120 columns wide; the 52-column version is linked. `big` is the same session with about 110 more subagents.

## Band above the prompt

Tiles: context with its auto-compact mark, cache, the 5-hour and weekly limits, work. [52 columns](band-52.png).

![Band above the prompt](band-120.png)

## Band above the prompt, big crew

Tiles: context with its auto-compact mark, cache, the 5-hour and weekly limits, work. [52 columns](band-big-52.png).

![Band above the prompt](band-big-120.png)

## Band on an enterprise account

A spend limit instead of plan windows: the budget in dollars with the even-pace tick and the projection, and this chat. [52 columns](band-enterprise-52.png).

![Band on an enterprise account](band-enterprise-120.png)

## Trace tab

Where the time went: every model call, tool call and subagent of one prompt on a shared time axis. [52 columns](trace-52.png).

![Trace tab](trace-120.png)

## Trace tab, big crew

Where the time went: every model call, tool call and subagent of one prompt on a shared time axis. [52 columns](trace-big-52.png).

![Trace tab](trace-big-120.png)

## Usage tab

Context, plan limits, money, session stats, and the prompt cache: window, hit rate, switches, each request. [52 columns](usage-52.png).

![Usage tab](usage-120.png)

## Usage tab, big crew

Context, plan limits, money, session stats, and the prompt cache: window, hit rate, switches, each request. [52 columns](usage-big-52.png).

![Usage tab](usage-big-120.png)

## Usage tab on an enterprise account

The budget card: the month as a burn-down (what was spent, the even pace, the limit, where the month ends at this pace). [52 columns](usage-enterprise-52.png).

![Usage tab on an enterprise account](usage-enterprise-120.png)
