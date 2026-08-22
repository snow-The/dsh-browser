# dsh-browser

Drive the local Chrome/Edge from DeepSeek Harness (real browser, local-only).

## Tools

- `browser_open` - open a URL (lazy-launches the browser, reuses it)
- `browser_snapshot` - title / url / interactive selectors / console errors / visible text
- `browser_click` - click by CSS selector
- `browser_type` - fill inputs (optional Enter)
- `browser_press` - keyboard keys
- `browser_scroll` - scroll or bring element into view
- `browser_evaluate` - run JS in the page
- `browser_screenshot` - save PNG (feed to vision tools)
- `browser_wait` - wait ms
- `browser_close` - close the instance

## How it works

One lazy browser instance (headful by default so you see what the agent does),
launched via `playwright-core` against the system Chrome/Edge; no browser
download, no external daemon, nothing leaves the machine.
