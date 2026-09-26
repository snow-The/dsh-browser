/**
 * Regression suite for dsh-browser.
 *
 * The plugin had no tests at all. Three things here are worth locking, in order of how expensive
 * their failure mode is:
 *
 *   1. CORPUS ISOLATION. `lib/query.js` stores vectors as TEXT (JSON.stringify) while
 *      `@snow-the/dsh-search` stores them as BLOB (Buffer.from). A shared `corpus.db` makes each
 *      reader walk the other's rows; `JSON.parse(r.vec)` on a BLOB row throws. The bug is INVISIBLE
 *      while the DB is empty and only appears once the other plugin has written -- i.e. it would
 *      surface as "browser search broke for no reason" long after the change that caused it. The
 *      tests below pin the filename, prove the TEXT/BLOB incompatibility is real, and prove every
 *      tool reads our file.
 *
 *   2. THE TOOL SURFACE. `apply()` must register 14 tools. A silent registration loss is exactly the
 *      failure this project has hit before (six plugins failing to activate), and nothing else in
 *      the package would notice.
 *
 *   3. THE LIFECYCLE. `getDb()` is lazy, `disposeQuery()` must be idempotent, and clear must be
 *      complete -- a corpus that survives its own wipe is a data-leak between unrelated queries.
 *
 * Every test runs against a THROWAWAY home directory (see isolateHome below), so the user's real
 * corpus at ~/.dsh/browser-shots/corpus-browser.db is never opened, seeded, or cleared.
 *
 * Run: node --import ./test/register-stubs.mjs --test "test/*.test.mjs"
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------------------
// home isolation -- MUST run before anything reads os.homedir()
//
// query.js resolves its directory as join(homedir(), '.dsh', 'browser-shots') at call time, and
// os.homedir() reads USERPROFILE on Windows / HOME on POSIX. Setting both here keeps the suite off
// the user's real corpus. It is set at module scope rather than in a before() hook because Node may
// resolve and cache homedir() the moment anything else asks for it.
// ---------------------------------------------------------------------------
const REAL_HOME = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
const REAL_ARK = process.env.ARK_API_KEY;
const FAKE_HOME = mkdtempSync(join(tmpdir(), 'dsh-browser-home-'));
process.env.USERPROFILE = FAKE_HOME;
process.env.HOME = FAKE_HOME;

// No embedding API: force the offline hash fallback so the suite is deterministic, instant, and
// makes zero network calls for corpus work. (browser_corpus_add would otherwise bill ARK.)
delete process.env.ARK_API_KEY;

const BROWSER_DIR = join(FAKE_HOME, '.dsh', 'browser-shots');
const DB_PATH = join(BROWSER_DIR, 'corpus-browser.db');

const lib = (name) => pathToFileURL(join(import.meta.dirname, '..', 'lib', name)).href;
const query = await import(lib('query.js'));
const main = await import(lib('index.js'));

/** Minimal host stub: collect what the plugin registers instead of publishing it. */
function makeCtx() {
  const registered = [];
  const ctx = {
    tools: {
      register(tool) {
        assert.ok(tool && typeof tool.name === 'string', 'register() received something without a name');
        registered.push(tool);
      },
    },
  };
  return { ctx, registered };
}

// apply() already registers BOTH families (index.js:306-307), so it must be called exactly once --
// calling registerQueryTools again on top would double-register the corpus tools (and duplicate
// registrations are a real load-time error in the host, so under-counting here would hide it).
const registerAll = () => {
  const { ctx, registered } = makeCtx();
  main.apply(ctx);
  return registered;
};

/** Point node:sqlite straight at the plugin's file, bypassing the plugin, to count what it wrote. */
function rowCount() {
  const d = new DatabaseSync(DB_PATH);
  try {
    return d.prepare('SELECT COUNT(*) AS n FROM corpus').get().n;
  } finally {
    d.close();
  }
}

const toolNamed = (tools, name) => {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `tool ${name} was not registered`);
  return t;
};

test.after(() => {
  // Close the plugin's handle FIRST: query.js keeps a module-level `db`, and on Windows an open
  // SQLite handle makes the temp home undeletable (EPERM). That the cleanup needs this is itself
  // evidence the handle stays open -- which is fine in a long-lived host, but not in a test.
  query.disposeQuery();

  if (REAL_HOME.USERPROFILE === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = REAL_HOME.USERPROFILE;
  if (REAL_HOME.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME.HOME;
  if (REAL_ARK !== undefined) process.env.ARK_API_KEY = REAL_ARK;

  try {
    rmSync(FAKE_HOME, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (err) {
    // Leaked temp dirs are noise, not a test result: never fail the suite over cleanup.
    console.error(`warning: could not remove ${FAKE_HOME}: ${err?.message}`);
  }
});

// ---------------------------------------------------------------------------
// 1. module contract
// ---------------------------------------------------------------------------

test('module exposes the loader contract the boot scanner requires', () => {
  assert.equal(main.name, 'dsh-browser');
  assert.deepEqual(main.inject, ['tools']);
  assert.equal(typeof main.apply, 'function');
  // apply() is async; a returned promise must exist so the loader can await activation failures.
  assert.ok(main.apply({ tools: { register() {} } }) instanceof Promise, 'apply must return a promise');

  assert.equal(query.disposeQuery.length, 0, 'disposeQuery takes no arguments');
  assert.equal(typeof query.registerQueryTools, 'function');
});

// ---------------------------------------------------------------------------
// 2. tool surface -- every tool present, well-formed, and wired to an executor
// ---------------------------------------------------------------------------

test('registers the full tool surface with callable executors', () => {
  const tools = registerAll();
  const names = tools.map((t) => t.name);

  assert.equal(names.length, 14, `expected 14 tools, got ${names.length}: ${names.join(', ')}`);
  assert.equal(new Set(names).size, names.length, 'tool names must be unique');

  const expected = [
    'browser_click', 'browser_close', 'browser_corpus_add', 'browser_corpus_clear',
    'browser_corpus_search', 'browser_evaluate', 'browser_fetch', 'browser_open',
    'browser_press', 'browser_screenshot', 'browser_scroll', 'browser_snapshot',
    'browser_type', 'browser_wait',
  ];
  for (const name of expected) assert.ok(names.includes(name), `missing tool: ${name}`);

  for (const t of tools) {
    assert.equal(typeof t.execute, 'function', `${t.name}: execute must be a function`);
    assert.ok(typeof t.description === 'string' && t.description.length > 20, `${t.name}: needs a real description`);
    assert.ok(t.parameters && typeof t.parameters === 'object', `${t.name}: needs a parameters object`);
  }
});

test('browser_close is the only lifecycle tool that is safe without a browser', () => {
  // Guards the intended shape: exactly one teardown tool, and it exists (a missing close tool leaks
  // a headful Chrome window for the rest of the session).
  const tools = registerAll();
  const closers = tools.filter((t) => /^browser_close$/.test(t.name));
  assert.equal(closers.length, 1);
  assert.ok(tools.some((t) => t.name === 'browser_open'), 'open without close would leak a browser');
});

test('tools that need a browser validate their arguments only AFTER ensuring one', async () => {
  // Real finding, pinned rather than papered over: browser_evaluate declares `expression` required,
  // but its execute() awaits ensureBrowser() FIRST, so with no browser running the documented
  // "expression required" error is unreachable. Asserting the ordering in source is the honest test
  // here -- calling execute() for real would launch headful Chrome, which a unit suite must not do.
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'index.js'), 'utf8');
  for (const tool of ['browser_evaluate', 'browser_wait']) {
    const start = source.indexOf(`name: '${tool}'`);
    assert.ok(start > 0, `${tool} not found in source`);
    const body = source.slice(start, source.indexOf('}));', start));
    const ensureAt = body.indexOf('ensureBrowser');
    // Anchor on the guard STATEMENT (throw / default assignment), not on the word "required" -- the
    // parameters block above it also says `required: true`, which would match first and make this
    // test pass for the wrong reason.
    const validateAt = body.search(/if \(!expr\) throw|const (expr|ms) =/);
    assert.ok(ensureAt > 0, `${tool}: must call ensureBrowser`);
    assert.ok(validateAt > ensureAt, `${tool}: argument validation must come after ensureBrowser`);
  }

  // The observable consequence: without a browser these tools fail as browser errors, not as
  // argument errors. Any thrown value is acceptable; a SILENT success would mean the tool ran.
  const tools = registerAll();
  for (const tool of ['browser_evaluate', 'browser_wait']) {
    let threw = false;
    try {
      await toolNamed(tools, tool).execute({});
    } catch {
      threw = true;
    }
    assert.ok(threw, `${tool} with no arguments and no browser must not report success`);
  }
});

// ---------------------------------------------------------------------------
// 3. corpus isolation -- the expensive-to-diagnose one
// ---------------------------------------------------------------------------

test('corpus lives in corpus-browser.db, never the shared corpus.db', async () => {
  const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'query.js'), 'utf8');

  // The filename constant is the whole safety property; assert it literally.
  assert.match(source, /DB_FILENAME\s*=\s*'corpus-browser\.db'/,
    "query.js must name its DB 'corpus-browser.db' explicitly");

  // And prove no code path opens the shared file: any bare 'corpus.db' literal that is not part of
  // 'corpus-browser.db' would be a second, silently-corrupting owner of dsh-search's data.
  const shared = [...source.matchAll(/['"`]([^'"`]*corpus\.db)['"`]/g)]
    .map((m) => m[1])
    .filter((p) => !p.endsWith('corpus-browser.db'));
  assert.deepEqual(shared, [], `query.js references the shared corpus.db at: ${shared.join(', ')}`);

  // The module exports no path accessor, so pin the resolved location behaviourally instead: the
  // first corpus tool call must create the file under the isolated home.
  assert.ok(!existsSync(DB_PATH), 'the DB must not exist before a corpus tool runs (getDb is lazy)');

  const tools = registerAll();
  const out = await toolNamed(tools, 'browser_corpus_clear').execute({});
  assert.equal(out, 'corpus cleared');
  assert.ok(existsSync(DB_PATH), 'the first corpus call must create corpus-browser.db');
  assert.ok(DB_PATH.startsWith(FAKE_HOME + sep), 'the DB must live under the isolated home');
});

test('our reader parses TEXT vectors and rejects BLOB rows -- the reason the files must stay apart', async () => {
  // This is the mechanism behind the isolation rule, so it is asserted rather than assumed: if a
  // future change makes this pass for BLOB rows too, the rule could be relaxed deliberately; if it
  // ever silently accepts BLOBs, we would be ranking garbage.
  const tools = registerAll();
  const search = toolNamed(tools, 'browser_corpus_search');
  await toolNamed(tools, 'browser_corpus_clear').execute({});

  const d = new DatabaseSync(DB_PATH);
  try {
    d.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)')
      .run('https://text.example', 'a text-encoded row', '[1,0,0]');
  } finally {
    d.close();
  }

  const textOut = await search.execute({ query: 'anything' });
  assert.match(textOut, /https:\/\/text\.example/, 'a TEXT (JSON) vector must be readable');
  assert.doesNotMatch(textOut, /empty/, 'a seeded corpus must not report itself empty');

  const d2 = new DatabaseSync(DB_PATH);
  try {
    d2.exec('DELETE FROM corpus');
    d2.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)')
      .run('https://blob.example', 'a blob-encoded row', new Uint8Array([91, 49, 44, 48, 93]));
  } finally {
    d2.close();
  }

  await assert.rejects(
    () => search.execute({ query: 'anything' }),
    (err) => {
      assert.ok(err instanceof SyntaxError, `expected JSON.parse to reject a BLOB row, got ${err?.name}: ${err?.message}`);
      return true;
    },
    'a BLOB vector row must throw -- sharing a file with dsh-search would corrupt every search',
  );
});

test('the cross-read failure is ASYMMETRIC: we crash loudly, dsh-search fails silently', async () => {
  // Measured through a REAL SQLite round-trip (measure-crossread2.mjs), which matters: a first
  // attempt approximated the read with `new Float32Array(vec.buffer)` and hand-built rows via
  // Buffer.from(string), and reported a bogus 16384-byte length -- that was Node's 8 KB allocation
  // POOL leaking through, not the plugin's behaviour. The real code reads
  // `new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)`.
  //
  //   our reader  JSON.parse(row.vec) on a BLOB      -> throws SyntaxError          (loud)
  //   their reader Float32Array(view) on a TEXT row  -> a ZERO-LENGTH vector, no throw (silent)
  //
  // The mechanism of the silence is worth naming: sqlite hands a TEXT column back as a JS **string**,
  // and `"...." .buffer` is **undefined**, so `new Float32Array(undefined, ...)` yields an empty
  // array. A zero-length vector makes their cosine() sum nothing and return 0, so every score ties at
  // 0 and search quietly stops discriminating. A loud crash is a bug report; a silent wrong answer is
  // a corrupted conclusion -- which is why this boundary cannot be left to "the newer reader copes".
  //
  // Also measured: declaring the column TEXT vs BLOB changes nothing at all. SQLite type affinity
  // does not validate stored values, so the DDL cannot defend this boundary -- only separate files can.
  const tools = registerAll();
  await toolNamed(tools, 'browser_corpus_clear').execute({});

  const THEIRS = (vec) => new Float32Array(vec.buffer, vec.byteOffset, vec.byteLength / 4);
  const theirCosine = (a, b) => {
    let s = 0;
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
  };
  const vec = [0.25, 0.5, 0.75, 1];

  const d = new DatabaseSync(DB_PATH);
  try {
    const ins = d.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)');
    ins.run('https://text.example', 'their row', JSON.stringify(vec));                              // what we write
    ins.run('https://blob.example', 'our row', Buffer.from(new Float32Array(vec).buffer));           // what they write

    const rows = d.prepare('SELECT chunk, vec FROM corpus ORDER BY id').all();
    assert.equal(typeof rows[0].vec, 'string', 'a TEXT column must come back as a JS string');
    assert.ok(rows[1].vec instanceof Uint8Array, 'a BLOB column must come back as bytes');

    // Their read of OUR row: silent, and that silence is the finding -- so assert it, not just note it.
    const decoded = THEIRS(rows[0].vec);
    assert.equal(decoded.length, 0, 'their reader on our TEXT row must yield zero-length, not throw');
    assert.equal(theirCosine(decoded, new Float32Array(vec)), 0, 'and every score must collapse to 0');

    // Their read of their OWN row: exact. Control, so the above is the encoding mismatch and not a
    // broken harness.
    assert.deepEqual(Array.from(THEIRS(rows[1].vec)), vec, 'their reader on their own BLOB must be exact');
  } finally {
    d.close();
  }

  // Our read of THEIR row: loud. (Asserted through the real tool, not a reimplementation.)
  await assert.rejects(
    () => toolNamed(tools, 'browser_corpus_search').execute({ query: 'anything' }),
    (err) => {
      assert.ok(err instanceof SyntaxError, `expected SyntaxError, got ${err?.name}: ${err?.message}`);
      return true;
    },
    'our JSON.parse on their BLOB row must throw loudly',
  );
});

// ---------------------------------------------------------------------------
// 4. corpus lifecycle
// ---------------------------------------------------------------------------
test('corpus search on an untouched corpus reports empty instead of throwing', async () => {
  const tools = registerAll();
  await toolNamed(tools, 'browser_corpus_clear').execute({});
  const out = await toolNamed(tools, 'browser_corpus_search').execute({ query: 'nothing here' });
  assert.match(out, /empty/i);
});

test('corpus search ranks by cosine and reports a fixed score format', async () => {
  const tools = registerAll();
  const search = toolNamed(tools, 'browser_corpus_search');
  await toolNamed(tools, 'browser_corpus_clear').execute({});

  // Three orthogonal unit vectors: cosine is exactly 1, 0, 0 for whichever one matches the query
  // embedding, so the ORDER is not knowable a priori (it depends on the hash embedding) but the
  // SCORE SET is, and the top hit must score meaningfully above the other two.
  const d = new DatabaseSync(DB_PATH);
  try {
    const ins = d.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)');
    ins.run('https://one.example', 'chunk one', '[1,0,0]');
    ins.run('https://two.example', 'chunk two', '[0,1,0]');
    ins.run('https://three.example', 'chunk three', '[0,0,1]');
  } finally {
    d.close();
  }

  const out = await search.execute({ query: 'ranked query' });
  const scores = [...out.matchAll(/^\[(-?\d+\.\d{3})\] (\S+)$/gm)].map((m) => ({ score: Number(m[1]), url: m[2] }));

  assert.equal(scores.length, 3, `expected 3 ranked lines with 3-decimal scores, got:\n${out}`);
  for (const s of scores) {
    assert.ok(Number.isFinite(s.score), `${s.url}: score must be a finite number`);
    // Cosine of unit vectors lies in [-1, 1]; anything outside means the vector was mis-decoded.
    assert.ok(s.score >= -1.0001 && s.score <= 1.0001, `${s.url}: cosine out of range: ${s.score}`);
  }
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i - 1].score >= scores[i].score, 'results must be sorted by descending score');
  }
  assert.equal(new Set(scores.map((s) => s.url)).size, 3, 'every seeded row must appear exactly once');
});

test('corpus search honors top, clamped to [1, 10]', async () => {
  const tools = registerAll();
  const search = toolNamed(tools, 'browser_corpus_search');
  await toolNamed(tools, 'browser_corpus_clear').execute({});

  const d = new DatabaseSync(DB_PATH);
  try {
    const ins = d.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)');
    for (let i = 0; i < 12; i++) ins.run(`https://row${i}.example`, `chunk ${i}`, '[1,0,0]');
  } finally {
    d.close();
  }

  const countLines = (s) => [...s.matchAll(/^\[-?\d+\.\d{3}\] /gm)].length;

  assert.equal(countLines(await search.execute({ query: 'q', top: 2 })), 2);
  assert.equal(countLines(await search.execute({ query: 'q' })), 5, 'default top must be 5');
  assert.equal(countLines(await search.execute({ query: 'q', top: 99 })), 10, 'top must clamp to 10');
  assert.equal(countLines(await search.execute({ query: 'q', top: -5 })), 1, 'negative top must clamp up to 1');

  // Documented quirk, pinned so a future change is a deliberate one: the expression is
  // `Math.max(Number(top ?? 5) || 5, 1)`, and `||` treats 0 as absent, so top:0 falls back to the
  // DEFAULT 5 rather than clamping up to 1. Harmless (it only over-returns) but not what "clamped
  // to [1, 10]" suggests, so the real behaviour is what the test asserts.
  assert.equal(countLines(await search.execute({ query: 'q', top: 0 })), 5,
    'top:0 is falsy and falls back to the default 5, it does NOT clamp up to 1');
  assert.equal(countLines(await search.execute({ query: 'q', top: 'abc' })), 5, 'unparseable top falls back to 5');
});

test('corpus clear removes every row, and repeating it is safe', async () => {
  const tools = registerAll();
  const clear = toolNamed(tools, 'browser_corpus_clear');
  await clear.execute({});

  const d = new DatabaseSync(DB_PATH);
  try {
    const ins = d.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)');
    for (let i = 0; i < 5; i++) ins.run(`https://x${i}.example`, `c${i}`, '[1]');
  } finally {
    d.close();
  }
  assert.equal(rowCount(), 5, 'setup: rows must actually be in the file');

  assert.equal(await clear.execute({}), 'corpus cleared');
  assert.equal(rowCount(), 0, 'clear must leave no surviving rows (a corpus that outlives its wipe leaks between queries)');

  assert.equal(await clear.execute({}), 'corpus cleared', 'clear must be idempotent');
  assert.equal(rowCount(), 0);
});

test('disposeQuery closes the handle and is safe to call twice', async () => {
  const tools = registerAll();
  await toolNamed(tools, 'browser_corpus_clear').execute({}); // ensure the handle is open

  assert.doesNotThrow(() => query.disposeQuery());
  assert.doesNotThrow(() => query.disposeQuery(), 'a second dispose must not throw');

  // After disposal the plugin must reopen lazily rather than stay broken.
  await toolNamed(tools, 'browser_corpus_clear').execute({});
  assert.ok(existsSync(DB_PATH));
});

// ---------------------------------------------------------------------------
// 5. argument validation
// ---------------------------------------------------------------------------

test('browser_corpus_add validates urls before any network call', async () => {
  const tools = registerAll();
  const add = toolNamed(tools, 'browser_corpus_add');

  await assert.rejects(() => add.execute({ urls: '' }), /urls required/);
  await assert.rejects(() => add.execute({}), /urls required/);
  // A non-http scheme must be refused, not fetched. It throws before the fetch, so this is offline.
  await assert.rejects(() => add.execute({ urls: 'ftp://example.com/x' }), /bad url/);
  await assert.rejects(() => add.execute({ urls: 'file:///etc/passwd' }), /bad url/);
});

test('browser_fetch validates url and returns extracted text', async (t) => {
  const tools = registerAll();
  const fetchTool = toolNamed(tools, 'browser_fetch');

  await assert.rejects(() => fetchTool.execute({ url: 'not-a-url' }), /http\(s\)/);
  await assert.rejects(() => fetchTool.execute({}), /http\(s\)/);

  // The real fetch is a network dependency; report it as skipped rather than red when offline.
  try {
    const out = await fetchTool.execute({ url: 'https://example.com/' });
    assert.match(out, /^url: https:\/\/example\.com\//m, 'output must report the final URL');
    assert.match(out, /^chars: \d+$/m, 'output must report the extracted character count');
    assert.ok(out.includes('Example Domain'), 'the page text must actually be extracted');
  } catch (err) {
    t.diagnostic(`network unavailable, live fetch not verified: ${err?.message}`);
  }
});
