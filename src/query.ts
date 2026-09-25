/**
 * dsh-browser query toolkit core — TypeScript rewrite (v0.3.0).
 *
 * Browser-less fetch + ephemeral vector corpus, obscura-inspired:
 * no Chrome, no GPU — pure Node fetch + text extraction + embeddings
 * + node:sqlite. Performance notes vs the hand-written ESM version:
 *  - precompiled regexes (module-level constants)
 *  - prepared statements for all corpus ops
 *  - vectors stored as BLOB float32 (4 bytes/dim vs JSON strings)
 *  - typed-array cosine over Float32Array
 *  - sentence-aware chunking with overlap (better retrieval quality)
 *  - batched embedding (16 texts per ARK call)
 */
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';

// --- precompiled regexes (module-level, compiled once) ---
const RE_SCRIPT = /<script[\s\S]*?<\/script>/gi;
const RE_STYLE = /<style[\s\S]*?<\/style>/gi;
const RE_NAV = /<nav[\s\S]*?<\/nav>/gi;
const RE_FOOTER = /<footer[\s\S]*?<\/footer>/gi;
const RE_COMMENT = /<!--[\s\S]*?-->/g;
const RE_TAG = /<[^>]+>/g;
const RE_WS = /\s+/g;
const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&hellip;': '...',
  '&mdash;': '—', '&ndash;': '–', '&copy;': '©',
};
const RE_ENTITY = new RegExp(Object.keys(ENTITIES).join('|'), 'g');

export const EMBED_DIM = 64;
const BATCH = 16;
const MAX_TEXT = 60000;
const DEFAULT_CHUNK = 800;
const CHUNK_OVERLAP = 100;

// ---------- text extraction ----------
export function extractText(html: string): string {
  let t = String(html);
  t = t.replace(RE_SCRIPT, ' ').replace(RE_STYLE, ' ').replace(RE_NAV, ' ').replace(RE_FOOTER, ' ');
  t = t.replace(RE_COMMENT, ' ').replace(RE_TAG, ' ');
  t = t.replace(RE_ENTITY, (m) => ENTITIES[m] ?? ' ');
  t = t.replace(RE_WS, ' ').trim();
  return t.slice(0, MAX_TEXT);
}

/** Sentence-aware chunking with overlap: splits on sentence/paragraph
 * boundaries when possible, falls back to hard size cuts. */
export function chunkText(text: string, size = DEFAULT_CHUNK): string[] {
  const src = String(text);
  if (src.length <= size) return src.length ? [src] : [];
  const chunks: string[] = [];
  let start = 0;
  const re = /(?<=[。！？.!?\n])\s*/g;
  while (start < src.length) {
    const endBase = Math.min(start + size, src.length);
    let end = endBase;
    if (end < src.length) {
      const m = re.exec(src.slice(endBase - 120, endBase + 120));
      if (m) end = endBase - 120 + m.index + m[0].length;
    }
    const piece = src.slice(start, Math.max(end, start + 1));
    chunks.push(piece);
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
    if (end === endBase && src.slice(endBase).length > 0 && endBase <= start) break;
  }
  return chunks;
}

// ---------- embeddings ----------
export function hashEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  const s = String(text).toLowerCase();
  for (let i = 0; i < s.length - 2; i++) {
    let h = 7;
    for (let j = 0; j < 3; j++) h = (h * 31 + s.charCodeAt(i + j)) >>> 0;
    v[h % EMBED_DIM]++;
  }
  const norm = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

async function arkEmbed(texts: string[]): Promise<Float32Array[] | null> {
  const key = process.env.ARK_API_KEY;
  if (!key) return null;
  try {
    const model = process.env.DSH_BROWSER_EMBED_MODEL || 'doubao-embedding-large';
    const res = await fetch('https://ark.cn-beijing.volces.com/api/v3/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model, input: texts }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return null;
    const j = await res.json() as { data?: { embedding: number[] }[] };
    if (!Array.isArray(j.data) || j.data.length !== texts.length) return null;
    return j.data.map((d) => Float32Array.from(d.embedding));
  } catch {
    return null;
  }
}

/** Batched embedding: ARK first, local hash fallback. */
export async function embedTexts(texts: string[]): Promise<Float32Array[]> {
  const out: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += BATCH) {
    const batch = texts.slice(i, i + BATCH);
    const remote = await arkEmbed(batch);
    out.push(...(remote ?? batch.map(hashEmbed)));
  }
  return out;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

// ---------- corpus store (node:sqlite, prepared stmts, float32 BLOB) ----------
export interface CorpusDoc { url: string; chunk: string; vec: Float32Array }

export class CorpusStore {
  private db: DatabaseSync;
  private insertStmt: ReturnType<DatabaseSync['prepare']>;
  private selectAllStmt: ReturnType<DatabaseSync['prepare']>;
  private countStmt: ReturnType<DatabaseSync['prepare']>;
  private clearStmt: ReturnType<DatabaseSync['prepare']>;

  constructor(dbPath?: string) {
    const dir = dbPath ? join(dbPath, '..') : join(homedir(), '.dsh', 'browser-shots');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new DatabaseSync(dbPath ?? join(dir, 'corpus.db'));
    this.db.exec('CREATE TABLE IF NOT EXISTS corpus (id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, chunk TEXT, vec BLOB)');
    this.insertStmt = this.db.prepare('INSERT INTO corpus (url, chunk, vec) VALUES (?, ?, ?)');
    this.selectAllStmt = this.db.prepare('SELECT url, chunk, vec FROM corpus');
    this.countStmt = this.db.prepare('SELECT COUNT(*) AS n FROM corpus');
    this.clearStmt = this.db.prepare('DELETE FROM corpus');
  }

  add(url: string, chunks: string[], vecs: Float32Array[]): number {
    const tx = this.db.exec('BEGIN');
    try {
      for (let i = 0; i < chunks.length; i++) {
        this.insertStmt.run(url, chunks[i], Buffer.from(vecs[i].buffer));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return chunks.length;
  }

  count(): number {
    const row = this.countStmt.get() as { n: number };
    return Number(row.n);
  }

  search(query: Float32Array, topK = 5): { url: string; chunk: string; score: number }[] {
    const rows = this.selectAllStmt.all() as { url: string; chunk: string; vec: Buffer }[];
    const scored = rows.map((r) => ({
      url: r.url,
      chunk: r.chunk,
      score: cosine(query, new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4)),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  clear(): void {
    this.clearStmt.run();
  }

  close(): void {
    try { this.db.close(); } catch { /* noop */ }
  }
}

// singleton for plugin lifetime
let store: CorpusStore | null = null;
export function getStore(): CorpusStore {
  if (!store) store = new CorpusStore();
  return store;
}
export function resetStore(): void {
  if (store) { store.close(); store = null; }
}
