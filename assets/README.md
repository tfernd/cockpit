# Gallery

Every view of the cockpit, drawn by `make render` from a seeded session (`.shots/shots.test.ts`). The pane's element tree is laid out as flexbox HTML in headless Chrome (1 column = 8 px), so this shows the layout, not a capture of the Desktop app. Each view is shown 120 columns wide; the 52-column version is linked. `big` is the same session with about 110 more subagents.

## Band above the prompt

The pills: gauges, what runs now, totals. [52 columns](band-52.png).

![Band above the prompt](band-120.png)

## Band above the prompt, big crew

The pills: gauges, what runs now, totals. [52 columns](band-big-52.png).

![Band above the prompt](band-big-120.png)

## Trace tab

Where the time went: every model call, tool call and subagent of one prompt on a shared time axis. [52 columns](trace-52.png).

![Trace tab](trace-120.png)

## Trace tab, big crew

Where the time went: every model call, tool call and subagent of one prompt on a shared time axis. [52 columns](trace-big-52.png).

![Trace tab](trace-big-120.png)

## Overview tab

Budget bars, session stats, what is running. [52 columns](overview-52.png).

![Overview tab](overview-120.png)

## Overview tab, big crew

Budget bars, session stats, what is running. [52 columns](overview-big-52.png).

![Overview tab](overview-big-120.png)

## Tools tab

Calls, failures and durations per tool. [52 columns](tools-52.png).

![Tools tab](tools-120.png)

## Files tab

Reads, edits and re-reads per file. [52 columns](files-52.png).

![Files tab](files-120.png)

## Cache tab

Cache hit rate, lifetimes, switches that re-cached. [52 columns](cache-52.png).

![Cache tab](cache-120.png)

## Agents tab

Subagents: status, models, steps, plan. [52 columns](agents-52.png).

![Agents tab](agents-120.png)

## Agents tab, big crew

Subagents: status, models, steps, plan. [52 columns](agents-big-52.png).

![Agents tab](agents-big-120.png)

## Timeline tab

Spawns, results, messages, model switches. [52 columns](timeline-52.png).

![Timeline tab](timeline-120.png)

## Debug tab

Which events the recorder has seen. [52 columns](debug-52.png).

![Debug tab](debug-120.png)
