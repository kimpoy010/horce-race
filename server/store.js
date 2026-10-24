'use strict';
/*
 * Storage behind the game: plain files (default) or PostgreSQL (STORE=postgres, PG_URL=postgres://...).
 *
 * Everything that is persisted goes through a small "doc" object:   exists() read() write(text, {mode}) append(line) sig()
 *   FileDoc  a file in the data directory (what the game always did: atomic write via tmp + rename, owner-only permissions)
 *   PgDoc    a row of the `docs` table, or, for the ledger, the lines of the `ledger` table
 *
 * The game logic is synchronous and keeps its state in memory, so PgStore loads every doc and the whole ledger at start-up and
 * serves reads from memory. Writes update memory first and are sent to PostgreSQL in order by a single queue (write-behind, retried
 * with back-off when the database is away). `pending()` / `lastError()` show how far behind it is, and `flush()` waits for it
 * (shutdown does that). The hash chain of the ledger is computed in the process as before; PostgreSQL only stores the lines.
 */
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');

/* ---------- files ---------- */
class FileDoc {
  constructor(file) { this.file = file; }
  exists() { return fs.existsSync(this.file); }
  read() { try { return fs.readFileSync(this.file, 'utf8'); } catch (e) { return null; } }
  write(text, opts) {
    const tmp = this.file + '.tmp', mode = opts && opts.mode;
    fs.writeFileSync(tmp, text, mode ? { mode } : undefined); fs.renameSync(tmp, this.file);
  }
  append(line) { fs.appendFileSync(this.file, line + '\n'); }
  sig() { try { const st = fs.statSync(this.file); return st.mtimeMs + ':' + st.size; } catch (e) { return ''; } }
}

// a path, a doc object or null -> a doc object or null
function asDoc(x) { return !x ? null : typeof x === 'string' ? new FileDoc(x) : x; }

/* ---------- PostgreSQL ---------- */
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS docs (name text PRIMARY KEY, body text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS ledger (seq bigserial PRIMARY KEY, line text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())',
  'CREATE TABLE IF NOT EXISTS instance (id int PRIMARY KEY, holder text NOT NULL, host text, pid int, renewed_at timestamptz NOT NULL DEFAULT now(), since timestamptz)',
  // the ledger is append-only: the application role may insert and select, never change or remove lines
  "CREATE OR REPLACE FUNCTION ledger_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'the ledger is append-only'; END $$ LANGUAGE plpgsql",
  'DROP TRIGGER IF EXISTS ledger_no_change ON ledger',
  'CREATE TRIGGER ledger_no_change BEFORE UPDATE OR DELETE ON ledger FOR EACH ROW EXECUTE FUNCTION ledger_immutable()'
];

class PgDoc {
  constructor(store, name) { this.store = store; this.name = name; }
  exists() { return this.store.docs.has(this.name) || (this.name === 'ledger.jsonl' && this.store.ledgerLines.length > 0); }
  read() {
    if (this.name === 'ledger.jsonl') return this.store.ledgerLines.length ? this.store.ledgerLines.join('\n') + '\n' : null;
    return this.store.docs.has(this.name) ? this.store.docs.get(this.name) : null;
  }
  write(text) { this.store._put(this.name, text); }
  append(line) { this.store._append(line); }
  sig() { return this.store.docs.has(this.name) ? sha(this.store.docs.get(this.name)) : ''; }
}

class PgStore {
  constructor(opts) {
    opts = opts || {};
    this.url = opts.url; this.docs = new Map(); this.ledgerLines = []; this.dirty = new Set(); this.queue = Promise.resolve(); this.n = 0; this.err = null;
    this.type = 'postgres'; this.pool = null; this.closed = false;
    this.Pool = opts.Pool || require('pg').Pool;
  }
  async init() {
    this.pool = new this.Pool({ connectionString: this.url, max: 4 });
    this.pool.on('error', (e) => { this.err = e.message; });
    for (const sql of SCHEMA) await this.pool.query(sql);
    await this._loadDocs();
    const r = await this.pool.query('SELECT line FROM ledger ORDER BY seq');
    this.ledgerLines = r.rows.map((x) => x.line);
    return this;
  }
  async _loadDocs() {
    const r = await this.pool.query('SELECT name, body FROM docs');
    for (const row of r.rows) if (!this.dirty.has(row.name)) this.docs.set(row.name, row.body);
  }
  doc(name) { return new PgDoc(this, name); }
  // picks up documents changed by somebody else (the clients CLI, a second tool); skips the ones with a write still queued
  async refresh() { if (!this.closed) await this._loadDocs(); }

  _enqueue(job) {
    this.n++;
    this.queue = this.queue.then(async () => {
      let wait = 250;
      for (;;) {
        try { await job(); this.err = null; break; } catch (e) {
          this.err = e.message;
          if (this.closed && this.n > 0 && !this.pool) break;
          await new Promise((ok) => setTimeout(ok, wait)); wait = Math.min(wait * 2, 5000);
        }
      }
      this.n--;
    });
  }
  _put(name, text) {
    this.docs.set(name, text); this.dirty.add(name);
    this._enqueue(async () => {
      await this.pool.query('INSERT INTO docs (name, body) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = now()', [name, this.docs.get(name)]);
      if (this.docs.get(name) === text) this.dirty.delete(name);
    });
  }
  _append(line) {
    this.ledgerLines.push(line);
    this._enqueue(async () => { await this.pool.query('INSERT INTO ledger (line) VALUES ($1)', [line]); });
  }
  pending() { return this.n; }
  lastError() { return this.err; }
  flush() { return this.queue; }
  async close() { await this.flush(); this.closed = true; if (this.pool) { const p = this.pool; this.pool = null; await p.end(); } }
  status() { return { type: 'postgres', pending: this.n, error: this.err, ledgerLines: this.ledgerLines.length }; }
}

/* ---------- single-writer lease on PostgreSQL: an advisory lock held by a dedicated connection ---------- */
const LOCK_KEY = 727001;
class PgLease {
  constructor(store, opts) {
    opts = opts || {};
    this.store = store; this.ttlMs = opts.ttlMs || 10000; this.now = opts.now || Date.now;
    this.id = crypto.randomBytes(8).toString('hex'); this.host = os.hostname(); this.pid = process.pid;
    this.client = null; this.heldSince = null; this.lastBeat = 0; this.alive = false; this.other = null; this.timer = null;
  }
  async tryAcquire() {
    if (this.heldSince !== null) return true;
    const c = await this.store.pool.connect();
    try {
      const r = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY]);
      if (!r.rows[0].ok) {
        const o = await c.query('SELECT holder, host, pid, EXTRACT(EPOCH FROM now() - renewed_at) AS age FROM instance WHERE id = 1');
        this.other = o.rows[0] ? { holder: o.rows[0].holder, host: o.rows[0].host, pid: o.rows[0].pid, ageSeconds: Math.round(Number(o.rows[0].age)), mine: false } : null;
        c.release(); return false;
      }
    } catch (e) { c.release(true); throw e; }
    this.client = c; this.heldSince = this.now(); this.lastBeat = this.now(); this.alive = true;
    await c.query('INSERT INTO instance (id, holder, host, pid, since) VALUES (1, $1, $2, $3, now()) ON CONFLICT (id) DO UPDATE SET holder = $1, host = $2, pid = $3, since = now(), renewed_at = now()', [this.id, this.host, this.pid]);
    c.on('error', () => { this.alive = false; });
    this.timer = setInterval(() => this._beat(), 1000); this.timer.unref && this.timer.unref();
    return true;
  }
  _beat() {
    if (!this.client) return;
    const t = setTimeout(() => { this.alive = false; }, this.ttlMs * 0.5);
    this.client.query('UPDATE instance SET renewed_at = now() WHERE id = 1 AND holder = $1', [this.id])
      .then((r) => { clearTimeout(t); if (r.rowCount === 1) { this.alive = true; this.lastBeat = this.now(); } else this.alive = false; })
      .catch(() => { clearTimeout(t); this.alive = false; });
  }
  renew() { return this.heldSince !== null && this.alive; }
  valid() { return this.heldSince !== null && this.alive && this.now() - this.lastBeat < this.ttlMs * 0.7; }
  release() {
    if (this.timer) clearInterval(this.timer); this.timer = null;
    const c = this.client; this.client = null; this.heldSince = null; this.alive = false;
    if (c) c.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {}).then(() => c.release(true)).catch(() => {});
  }
  info() {
    if (this.heldSince !== null) return { holder: this.id, host: this.host, pid: this.pid, ageSeconds: Math.round((this.now() - this.lastBeat) / 1000), mine: true };
    return this.other;
  }
}

// STORE=postgres -> PgStore (PG_URL); otherwise null (callers use files in the data directory)
async function openStore(env) {
  if ((env.STORE || 'file') !== 'postgres') return null;
  if (!env.PG_URL) throw new Error('STORE=postgres needs PG_URL, for example postgres://user:password@localhost:5432/horserace');
  return new PgStore({ url: env.PG_URL }).init();
}

module.exports = { FileDoc, PgDoc, PgStore, PgLease, asDoc, openStore, SCHEMA };
