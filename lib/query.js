/**
 * dsh-browser query toolkit - browser-less fetch + ephemeral vector corpus.
 *
 * Design (obscura-style): no Chrome needed - pure Node fetch + text
 * extraction + embeddings + SQLite (node:sqlite builtin). Works on
 * headless/remote hosts (no GPU, no browser). Corpus is a throwaway
 * toolbox: clear it when done, nothing long-lived is stored.
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

let db = null;

/**
 * 本插件【必须】用自己的语料库文件, 不能和 @snow-the/dsh-search 共用 corpus.db。
 *
 * 原因(实测, 不是理论风险): 两个插件各有一代实现, 向量编码不兼容——
 *   - 本文件(手写版):   INSERT ... JSON.stringify(vec)          -> 存成 TEXT
 *   - dsh-search/src/query.ts(重写版): Buffer.from(vec.buffer)  -> 存成 BLOB
 * 表结构同为 corpus(id,url,chunk,vec), 两边会互相读到对方写的行。两种失效模式【不对称】:
 *
 *   本文件读 BLOB 行 -> JSON.parse 抛 SyntaxError            (响亮, 立刻可见)
 *   dsh-search 读 TEXT 行 -> new Float32Array(row.vec.buffer) 静默得到【长度 0 的向量】
 *                            -> 余弦全部为 0, 搜索悄悄返回错误结果 (无声, 最危险)
 *
 * 注意: 列声明成 TEXT 还是 BLOB 【不产生任何约束】, SQLite 的类型亲和性不校验存入值
 * (实测两种声明的行为逐字相同), 所以不能靠 DDL 防这件事。
 *
 * 语料库本来就是【插件作用域】的临时数据(注释见文件头: throwaway toolbox),
 * 因此正确做法不是共享, 而是各用各的文件。dsh-search 继续用 corpus.db,
 * 本插件用 corpus-browser.db。
 */
const DB_FILENAME = 'corpus-browser.db';

function getDb() {
  if (db) return db;
  const dir = join(homedir(), '.dsh', 'browser-shots');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, DB_FILENAME));
  db.exec('CREATE TABLE IF NOT EXISTS corpus (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, chunk TEXT, vec TEXT)');
  return db;
}

function closeDb() {
  if (db) { try { db.close(); } catch {} db = null; }
}

// --- text extraction from raw HTML (no browser, no external parser) ---
function extractText(html) {
  let t = String(html);
  t = t.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  t = t.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  t = t.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  t = t.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  t = t.replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/<[^>]+>/g, ' ');
  t = t.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 60000);
}

function chunkText(text, size) {
  const n = size || 800;
  const chunks = [];
  for (let i = 0; i < text.length; i += n) chunks.push(text.slice(i, i + n));
  return chunks;
}

// --- embeddings: ARK API first, local hash fallback (zero-dep, offline) ---
async function embedTexts(texts) {
  const key = process.env.ARK_API_KEY;
  if (key) {
    try {
      const model = process.env.DSH_BROWSER_EMBED_MODEL || 'doubao-embedding-large';
      const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model, input: texts }),
      });
      if (res.ok) {
        const j = await res.json();
        if (Array.isArray(j.data) && j.data.length === texts.length) return j.data.map((d) => d.embedding);
      }
    } catch { /* fall through to local */ }
  }
  return texts.map(hashEmbed);
}

function hashEmbed(text) {
  const dim = 64;
  const v = new Array(dim).fill(0);
  const s = String(text).toLowerCase();
  for (let i = 0; i < s.length - 2; i++) {
    let h = 7;
    for (let j = 0; j < 3; j++) h = (h * 31 + s.charCodeAt(i + j)) >>> 0;
    v[h % dim]++;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / norm);
}

function cosine(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

const textOut = { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] };

export function registerQueryTools(ctx) {
  ctx.tools.register(defineTool({
    name: 'browser_fetch',
    description: 'Fetch a URL WITHOUT a browser (pure Node fetch): returns extracted page text. Works on headless/remote hosts with no Chrome installed. Use for pure information queries; use browser_open when you need real page interaction.',
    parameters: { url: { type: 'string', required: true, description: 'http(s) URL' } },
    output: textOut,
    timeoutMs: 30000,
    async execute(args) {
      const url = String(args?.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http(s)://');
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dsh-browser-query)' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
      const html = await res.text();
      const text = extractText(html);
      return 'url: ' + res.url + '\nchars: ' + text.length + '\n\n' + text.slice(0, 8000);
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_corpus_add',
    description: 'Fetch several URLs and index their text into an ephemeral SQLite vector corpus (embeddings via ARK API, or a local hash fallback when no key). Later browser_corpus_search queries it. Nothing is stored long-term - browser_corpus_clear wipes it.',
    parameters: { urls: { type: 'string', required: true, description: 'Comma-separated http(s) URLs to fetch and index' } },
    output: textOut,
    timeoutMs: 120000,
    async execute(args) {
      const urls = String(args?.urls || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!urls.length) throw new Error('urls required (comma separated)');
      const d = getDb();
      const allChunks = [];
      const meta = [];
      for (const url of urls) {
        if (!/^https?:\/\//i.test(url)) throw new Error('bad url: ' + url);
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (dsh-browser-query)' }, redirect: 'follow', signal: AbortSignal.timeout(25000) });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url);
        const text = extractText(await res.text());
        for (const c of chunkText(text)) { allChunks.push(c); meta.push(url); }
      }
      const vecs = await embedTexts(allChunks);
      const ins = d.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)');
      for (let i = 0; i < allChunks.length; i++) ins.run(meta[i], allChunks[i], JSON.stringify(vecs[i]));
      return 'indexed ' + allChunks.length + ' chunks from ' + urls.length + ' url(s)';
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_corpus_search',
    description: 'Vector-search the ephemeral corpus (see browser_corpus_add) and return the most relevant text chunks with scores. Fallback cosine over local hash vectors when no embedding API is configured.',
    parameters: { query: { type: 'string', required: true, description: 'Search query' }, top: { type: 'number', description: 'How many chunks to return (default 5, max 10)' } },
    output: textOut,
    timeoutMs: 30000,
    async execute(args) {
      const q = String(args?.query || '').trim();
      if (!q) throw new Error('query required');
      const top = Math.min(Math.max(Number(args?.top ?? 5) || 5, 1), 10);
      const d = getDb();
      const rows = d.prepare('SELECT url, chunk, vec FROM corpus').all();
      if (!rows.length) return 'corpus is empty - add URLs with browser_corpus_add first';
      const qv = (await embedTexts([q]))[0];
      const scored = rows.map((r) => ({ url: r.url, chunk: r.chunk, score: cosine(qv, JSON.parse(r.vec)) })).sort((a, b) => b.score - a.score).slice(0, top);
      const out = [];
      for (const s of scored) {
        out.push('[' + s.score.toFixed(3) + '] ' + s.url);
        out.push(s.chunk.slice(0, 500));
        out.push('');
      }
      return out.join('\n');
    },
  }));

  ctx.tools.register(defineTool({
    name: 'browser_corpus_clear',
    description: 'Wipe the ephemeral corpus (throwaway toolbox - call when the query session is done).',
    parameters: {},
    output: textOut,
    async execute() {
      const d = getDb();
      d.exec('DELETE FROM corpus');
      return 'corpus cleared';
    },
  }));
}

export function disposeQuery() { closeDb(); }