#!/usr/bin/env node
'use strict';
/*
 * Copy the game's files into PostgreSQL (see docs/POSTGRES.md).
 *
 *   PG_URL=postgres://user:password@localhost:5432/horserace node scripts/migrate-to-pg.js [--dir data] [--dry-run] [--overwrite-docs]
 *
 * - checks the hash chain of ledger.jsonl first and refuses to import a broken one
 * - the ledger table must be empty (it is append-only: lines cannot be changed or removed afterwards)
 * - documents already in the database (clients, users, ...) are kept unless you add --overwrite-docs
 * - everything goes in one transaction; afterwards the ledger is read back from the database and checked again
 * The files are only read, never changed: keep them as a backup.
 */
const fs = require('fs');
const path = require('path');
const { PgStore } = require('../server/store.js');
const { verifyText } = require('../server/ledger.js');

const DOCS = ['clients.json', 'users.json', 'admins.json', 'sessions.json', 'blocked.json', 'settings.json'];

function parse(argv) { const f = {}; for (let i = 0; i < argv.length; i++) { if (argv[i].startsWith('--')) { const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) f[argv[i].slice(2)] = true; else { f[argv[i].slice(2)] = nx; i++; } } } return f; }

async function migrate(opts) {
  const dir = opts.dir, log = opts.log || console.log, out = { ledgerLines: 0, docs: [], skipped: [] };
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const text = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '';
  const v = verifyText(text);
  if (!v.ok) throw new Error('the hash chain of ' + ledgerFile + ' is broken at line ' + v.broken.line + ' (' + v.broken.reason + '): fix or restore it first (node scripts/verify-ledger.js)');
  const lines = text.split('\n').filter(Boolean);
  log('ledger:    ' + lines.length + ' lines, chain intact, head ' + v.head);

  const store = await new PgStore({ url: opts.url }).init();
  try {
    if (store.ledgerLines.length) throw new Error('the ledger table already has ' + store.ledgerLines.length + ' lines: the ledger is append-only, so it cannot be imported on top. Use an empty database.');
    const docs = DOCS.filter((n) => fs.existsSync(path.join(dir, n)));
    for (const n of docs) {
      if (store.docs.has(n) && !opts.overwriteDocs) { out.skipped.push(n); log('document:  ' + n + ' already in the database, kept (use --overwrite-docs to replace it)'); continue; }
      out.docs.push(n); log('document:  ' + n + ' (' + fs.statSync(path.join(dir, n)).size + ' bytes)');
    }
    if (opts.dryRun) { log('dry run: nothing written'); out.ledgerLines = lines.length; return out; }
    const c = await store.pool.connect();
    try {
      await c.query('BEGIN');
      for (let i = 0; i < lines.length; i += 500) {
        const part = lines.slice(i, i + 500);
        await c.query('INSERT INTO ledger (line) SELECT * FROM unnest($1::text[])', [part]);
      }
      for (const n of out.docs) await c.query('INSERT INTO docs (name, body) VALUES ($1, $2) ON CONFLICT (name) DO UPDATE SET body = EXCLUDED.body, updated_at = now()', [n, fs.readFileSync(path.join(dir, n), 'utf8')]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    out.ledgerLines = lines.length;
    // read it back and check
    const back = await store.pool.query('SELECT line FROM ledger ORDER BY seq');
    const r = verifyText(back.rows.map((x) => x.line).join('\n') + (back.rows.length ? '\n' : ''));
    if (!r.ok || r.lines !== lines.length || r.head !== v.head) throw new Error('verification after the import failed: ' + (r.broken ? r.broken.reason : 'line count or head hash differ'));
    log('done:      ' + back.rows.length + ' ledger lines imported and verified in the database (head ' + r.head + ')');
  } finally { await store.close(); }
  return out;
}

if (require.main === module) {
  const f = parse(process.argv.slice(2)), url = process.env.PG_URL;
  if (!url) { console.error('set PG_URL, for example  PG_URL=postgres://user:password@localhost:5432/horserace'); process.exit(1); }
  migrate({ dir: path.resolve(f.dir || path.join(__dirname, '..', 'data')), url, dryRun: !!f['dry-run'], overwriteDocs: !!f['overwrite-docs'] })
    .catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
}

module.exports = { migrate };
