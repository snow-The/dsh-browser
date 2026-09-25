/**
 * dsh-browser - browser interaction tools via playwright-core + system Chrome/Edge.
 *
 * Real browser, local-only: one lazy browser instance reused across tool calls,
 * headful by default so the user sees what the agent does. Screenshots save a
 * PNG file whose path the agent can feed to vision tools.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { registerQueryTools, disposeQuery } from './query.js';

export const name = 'dsh-browser';

export const inject = ['tools'];

// ---------------------------------------------------------------------------
// browser lifecycle
// ---------------------------------------------------------------------------

let browser = null;
let page = null;
let launchError = null;

function detectExecutable() {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const cands = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return undefined;
}

async function ensureBrowser(headless) {
  if (browser && browser.isConnected()) {
    const cur = browser._dshHeadless !== false;
    if ((headless === true || headless === false) && cur !== !!headless) {
      await browser.close().catch(() => {});
      browser = null;
      page = null;
    } else {
      return browser;
    }
  }
  if (launchError) { const e = launchError; launchError = null; throw e; }
  const { chromium } = await import('playwright-core');
  const exe = detectExecutable();
  try {
    browser = await chromium.launch({
      headless: !!headless,
      executablePath: exe,
      args: ['--disable-blink-features=AutomationControlled', '--no-first-run'],
    });
    browser._dshHeadless = !!headless;
    const ctx = browser.contexts()[0] || (await browser.newContext({ viewport: { width: 1280, height: 800 } }));
    page = await ctx.newPage();
    page.setDefaultTimeout(15000);
    const errs = [];
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 300)); });
    page.on('pageerror', (e) => errs.push('PAGEERROR: ' + String(e.message || e).slice(0, 300)));
    page._dshErrors = errs;
    return browser;
  } catch (e) {
    launchError = new Error('browser launch failed: ' + (exe ? 'using ' + exe : 'no Chrome/Edge found') + ' - ' + String(e.message || e).slice(0, 200));
    throw launchError;
  }
}

function screenshotDir() {
  const d = join(homedir(), '.dsh', 'browser-shots');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

function snapshotText(p) {
  const errs = p._dshErrors || [];
  return p.evaluate(() => {
    const sel = (el) => {
      if (el.id) return '#' + el.id;
      const cls = (el.className && typeof el.className === 'string') ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
      const tag = el.tagName.toLowerCase();
      const name = el.getAttribute && el.getAttribute('name');
      const ph = el.getAttribute && el.getAttribute('placeholder');
      const txt = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40);
      return (cls ? tag + '.' + cls : tag) + (name ? '[name=' + name + ']' : '') + (ph ? '[ph=' + ph + ']' : '') + (txt ? ' (' + txt + ')' : '');
    };
    const interact = [];
    document.querySelectorAll('a[href],button,input,select,textarea,[role=button],[role=link]').forEach((el) => {
      if (el.offsetParent === null) return;
      const s = sel(el);
      if (interact.length < 40 && !interact.includes(s)) interact.push(s);
    });
    const bodyText = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n').trim();
    return {
      title: document.title,
      url: location.href,
      // .toWellFormed(): a character-count slice can split a UTF-16 surrogate pair, and a lone surrogate is
      // not valid JSON text — every later request carrying it fails with a non-retryable 400.
      text: bodyText.slice(0, 4000).toWellFormed(),
      interact: interact.slice(0, 40),
    };
  }).then((r) => {
    const lines = [];
    lines.push('title: ' + r.title);
    lines.push('url: ' + r.url);
    lines.push('');
    lines.push('interactive elements (selectors):');
    for (const i of r.interact) lines.push('  - ' + i);
    if (errs.length) {
      lines.push('');
      lines.push('console errors (' + errs.length + '):');
      for (const e of errs.slice(-5)) lines.push('  - ' + e);
    }
    lines.push('');
    lines.push('visible text (first 4000 chars):');
    lines.push(r.text);
    return lines.join('\n');
  });
}

// ---------------------------------------------------------------------------
// tools
// ---------------------------------------------------------------------------

function registerBrowserTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open a URL in the local browser (lazy-launches a Chrome/Edge instance on first call and reuses it). headless=true hides the window (screenshots still work). Returns a page snapshot.',
    parameters: {
      url: { type: 'string', required: true, description: 'http(s) URL to open' },
      headless: { type: 'boolean', description: 'Launch hidden (default false = visible window)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      const url = String(args?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
      const headless = args?.headless === true;
      await ensureBrowser(headless);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(600);
      return 'opened ' + page.url() + '\n' + (await snapshotText(page));
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Structured snapshot of the current page: title, url, interactive element selectors, console errors, and the first 4000 chars of visible text.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      await ensureBrowser(false);
      return snapshotText(page);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element by CSS selector (e.g. "button", "#id", "a[href*=\"/docs\"]").',
    parameters: { selector: { type: 'string', required: true, description: 'CSS selector of the element to click' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const sel = String(args?.selector || '').trim();
      if (!sel) throw new Error('selector required');
      await page.click(sel, { timeout: 10000 });
      await page.waitForTimeout(400);
      return 'clicked ' + sel + '\nurl: ' + page.url();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an input/textarea (replaces existing value), optionally pressing Enter afterwards.',
    parameters: {
      selector: { type: 'string', required: true, description: 'CSS selector of the input' },
      text: { type: 'string', required: true, description: 'Text to type' },
      enter: { type: 'boolean', description: 'Press Enter after typing (default false)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const sel = String(args?.selector || '').trim();
      const text = String(args?.text ?? '');
      if (!sel) throw new Error('selector required');
      await page.fill(sel, text);
      if (args?.enter === true) { await page.press(sel, 'Enter'); await page.waitForTimeout(600); }
      return 'typed into ' + sel + (args?.enter ? ' + Enter' : '') + '\nurl: ' + page.url();
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_press',
    description: 'Press a keyboard key (Enter, Escape, ArrowDown, Tab, F5...) on the focused element or a selector.',
    parameters: {
      key: { type: 'string', required: true, description: 'Key name (Enter, Escape, Tab, ArrowDown, F5...)' },
      selector: { type: 'string', description: 'Optional selector to focus first' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const key = String(args?.key || '').trim();
      if (!key) throw new Error('key required');
      if (args?.selector) await page.focus(String(args.selector));
      await page.keyboard.press(key);
      await page.waitForTimeout(300);
      return 'pressed ' + key;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_scroll',
    description: 'Scroll the page (direction down/up, default 800px) or scroll an element into view (direction=toElement).',
    parameters: {
      direction: { type: 'string', description: 'down | up | toElement' },
      selector: { type: 'string', description: 'Required when direction=toElement' },
      amount: { type: 'number', description: 'Pixels to scroll (default 800)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const dir = String(args?.direction || 'down');
      if (dir === 'toElement') {
        const sel = String(args?.selector || '');
        if (!sel) throw new Error('selector required for toElement');
        await page.locator(sel).scrollIntoViewIfNeeded({ timeout: 8000 });
        return 'scrolled to ' + sel;
      }
      const amt = Number(args?.amount ?? 800) || 800;
      await page.evaluate(([d, a]) => window.scrollBy(0, d === 'up' ? -a : a), [dir, amt]);
      return 'scrolled ' + dir + ' ' + amt + 'px';
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Run a JavaScript expression in the page and return its JSON value (keep it small; return primitives or short strings).',
    parameters: { expression: { type: 'string', required: true, description: 'JS expression, e.g. "document.title"' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const expr = String(args?.expression || '');
      if (!expr) throw new Error('expression required');
      const out = await page.evaluate((e) => {
        const v = eval(e);
        if (typeof v === 'string') return v.slice(0, 3000);
        return JSON.stringify(v)?.slice(0, 3000) ?? String(v);
      }, expr);
      return String(out);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Save a PNG screenshot of the page and return its file path (read the file with read_image to see the page).',
    parameters: {
      path: { type: 'string', description: 'Optional absolute file path; default ~/.dsh/browser-shots/shot-<timestamp>.png' },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page (default false)' },
    },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const dest = String(args?.path || '').trim() || join(screenshotDir(), 'shot-' + Date.now() + '.png');
      await page.screenshot({ path: dest, fullPage: args?.fullPage === true });
      return 'screenshot saved: ' + dest;
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_wait',
    description: 'Wait for a fixed duration (ms) after actions that trigger async loads (default 1000).',
    parameters: { ms: { type: 'number', description: 'Milliseconds (default 1000, max 60000)' } },
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute(args) {
      await ensureBrowser(false);
      const ms = Math.min(Math.max(Number(args?.ms ?? 1000) || 1000, 0), 60000);
      await page.waitForTimeout(ms);
      return 'waited ' + ms + 'ms';
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close the browser instance (frees the window). The next browser_* call relaunches it.',
    parameters: {},
    output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
    async execute() {
      if (browser) {
        await browser.close().catch(() => {});
        browser = null;
        page = null;
        return 'browser closed';
      }
      return 'no browser open';
    },
  }));
}

export async function apply(ctx) {
  registerBrowserTools(ctx);
  registerQueryTools(ctx);
  return () => {
    if (browser) browser.close().catch(() => {});
    disposeQuery();
    browser = null;
    page = null;
  };
}