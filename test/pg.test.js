'use strict';
/*
 * PostgreSQL storage tests. They need a PostgreSQL server:
 *   - PG_TEST_URL=postgres://user:pw@localhost:5432/postgres   uses that server (a throw-away database is created and dropped), or
 *   - the PostgreSQL 16 binaries (/usr/lib/postgresql/*) : a temporary cluster is started and removed again, or
 *   - neither: the tests are skipped.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { PgStore, PgLease } = require('../server/store.js');
const { Ledger, verifyText } = require('../server/ledger.js');
const { ClientRegistry } = require('../server/clients.js');
const { migrate } = require('../scripts/migrate-to-pg.js');

function findBin() {
  const base = '/usr/lib/postgresql';
  try { const v = fs.readdirSync(base).sort().pop(); const b = path.join(base, v, 'bin'); if (fs.existsSync(path.join(b, 'initdb'))) return b; } catch (e) { /* none */ }
  return null;
}

async function withServer(fn) {
  const { Client } = require('pg');
  if (process.env.PG_TEST_URL) {
    const admin = new Client({ connectionString: process.env.PG_TEST_URL }); await admin.connect();
    const dbName = 'horsetest_' + process.pid; await admin.query('CREATE DATABASE ' + dbName);
    const u = new URL(process.env.PG_TEST_URL); u.pathname = '/' + dbName;
    try { await fn(u.toString()); } finally { await admin.query('DROP DATABASE IF EXISTS ' + dbName + ' WITH (FORCE)').catch(() => {}); await admin.end(); }
    return;
  }
  const bin = findBin();
  if (!bin) { console.log('pg tests skipped (no PostgreSQL server found; set PG_TEST_URL to run them)'); return; }
  const root = process.getuid && process.getuid() === 0, dir = fs.mkdtempSync(path.join('/tmp', 'pgtest-')), port = 55000 + (process.pid % 900);
  const run = (cmd, args) => (root ? execFileSync('su', ['postgres', '-c', [cmd].concat(args).map((a) => "'" + a + "'").join(' ')], { stdio: 'pipe' }) : execFileSync(cmd, args, { stdio: 'pipe' }));
  if (root) execFileSync('chown', ['postgres', dir]);
  try {
    run(path.join(bin, 'initdb'), ['-D', dir + '/d', '-A', 'trust', '-U', 'postgres']);
    run(path.join(bin, 'pg_ctl'), ['-D', dir + '/d', '-o', '-p ' + port + ' -k ' + dir + ' -c listen_addresses=127.0.0.1', '-l', dir + '/log', '-w', 'start']);
    const admin = new Client({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres' }); await admin.connect();
    await admin.query('CREATE DATABASE horsetest'); await admin.end();
    await fn('postgres://postgres@127.0.0.1:' + port + '/horsetest');
  } finally {
    try { run(path.join(bin, 'pg_ctl'), ['-D', dir + '/d', '-m', 'immediate', 'stop']); } catch (e) { /* already stopped */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await withServer(async (url) => {
    /* documents + ledger round-trip through a restart */
    let a = await new PgStore({ url }).init();
    const led = new Ledger(a.doc('ledger.jsonl'));
    for (let i = 0; i < 25; i++) led.append({ e: 'bet', id: 'b' + i, stake: 100 + i, t: 1000 + i });
    a.doc('settings.json').write(JSON.stringify({ rtp: 0.93 }));
    assert.strictEqual(a.pending() > 0, true, 'writes are queued, not yet in the database');
    await a.flush(); assert.strictEqual(a.pending(), 0); assert.strictEqual(a.lastError(), null);
    await a.close();

    let b = await new PgStore({ url }).init();
    assert.strictEqual(JSON.parse(b.doc('settings.json').read()).rtp, 0.93, 'document survives a restart');
    const led2 = new Ledger(b.doc('ledger.jsonl'));
    assert.strictEqual(led2.ok, true); assert.strictEqual(led2.lines, 25); assert.strictEqual(led2.head, led.head, 'the hash chain continues where it stopped');
    led2.append({ e: 'bet', id: 'b25', stake: 1, t: 2000 }); await b.flush();
    assert.strictEqual(verifyText(b.doc('ledger.jsonl').read()).ok, true);

    /* the ledger table is append-only */
    await assert.rejects(b.pool.query("UPDATE ledger SET line = 'x' WHERE seq = 1"), /append-only/);
    await assert.rejects(b.pool.query('DELETE FROM ledger WHERE seq = 1'), /append-only/);

    /* a change made by somebody else is picked up by refresh() and shows in the registry */
    const reg = new ClientRegistry({ file: b.doc('clients.json'), secret: 'k'.repeat(20), allowMock: true });
    assert.strictEqual(reg.count(), 0);
    const other = await new PgStore({ url }).init();
    const reg2 = new ClientRegistry({ file: other.doc('clients.json'), secret: 'k'.repeat(20), allowMock: true });
    const made = reg2.create({ id: 'acme', name: 'Acme', currency: 'PHP', wallet: { type: 'mock' } });
    assert.ok(made.apiKey); await other.flush();
    await b.refresh(); assert.strictEqual(reg.reload(), true, 'registry reloads the new client'); assert.ok(reg.get('acme'));
    assert.ok(reg.authenticate(made.apiKey, '1.2.3.4'), 'the API key works against the database copy');
    assert.ok(!/"secret":"[0-9a-f]{20}/.test(b.doc('clients.json').read() || ''), 'wallet secrets are stored encrypted');
    await other.close();

    /* single-writer lease */
    const l1 = new PgLease(b), l2 = new PgLease(b);
    assert.strictEqual(await l1.tryAcquire(), true);
    assert.strictEqual(l1.valid(), true);
    assert.strictEqual(await l2.tryAcquire(), false, 'a second instance cannot take the lease');
    assert.ok(l2.info() && l2.info().pid === process.pid);
    l1.release(); await new Promise((ok) => setTimeout(ok, 300));
    assert.strictEqual(await l2.tryAcquire(), true, 'the lease is free after release');
    l2.release(); await new Promise((ok) => setTimeout(ok, 300));
    await b.close();

    /* the database being away: writes wait and are retried, nothing is lost */
    const c = await new PgStore({ url }).init();
    const realQuery = c.pool.query.bind(c.pool); let down = true;
    c.pool.query = (...args) => (down ? Promise.reject(new Error('connection lost')) : realQuery(...args));
    c.doc('blocked.json').write('["p1"]'); c.doc('ledger.jsonl').append(JSON.stringify({ e: 'x' }));
    await new Promise((ok) => setTimeout(ok, 600));
    assert.strictEqual(c.pending() >= 1 && c.lastError() === 'connection lost', true, 'queue keeps the writes and reports the error');
    down = false; await c.flush(); assert.strictEqual(c.pending(), 0); assert.strictEqual(c.lastError(), null);
    await c.close();
    const d = await new PgStore({ url }).init();
    assert.strictEqual(d.doc('blocked.json').read(), '["p1"]'); assert.strictEqual(d.ledgerLines.length, 27);
    await d.close();
  });

  /* migration from files (needs its own empty database) */
  await withServer(async (url) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-'));
    const mem = new Ledger(null); const lines = [];
    const fileLed = new Ledger(path.join(dir, 'ledger.jsonl'));
    for (let i = 0; i < 1200; i++) fileLed.append({ e: 'bet', id: 'm' + i, stake: i, t: i });
    fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify({ version: 1, clients: [] }));
    fs.writeFileSync(path.join(dir, 'blocked.json'), '["x"]');
    const quiet = () => {};
    const dry = await migrate({ dir, url, dryRun: true, log: quiet });
    assert.strictEqual(dry.ledgerLines, 1200);
    const r = await migrate({ dir, url, log: quiet });
    assert.strictEqual(r.ledgerLines, 1200); assert.deepStrictEqual(r.docs.sort(), ['blocked.json', 'clients.json']);
    const s = await new PgStore({ url }).init();
    assert.strictEqual(s.ledgerLines.length, 1200); assert.strictEqual(new Ledger(s.doc('ledger.jsonl')).head, fileLed.head, 'same head hash as the file');
    assert.strictEqual(s.doc('blocked.json').read(), '["x"]'); await s.close();
    await assert.rejects(migrate({ dir, url, log: quiet }), /already has 1200 lines/, 'a second import is refused');
    // a tampered file is refused
    const bad = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').split('\n'); bad[5] = bad[5].replace('"stake":5', '"stake":9'); fs.writeFileSync(path.join(dir, 'ledger.jsonl'), bad.join('\n'));
    await assert.rejects(migrate({ dir, url, dryRun: true, log: quiet }), /hash chain .* broken/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  console.log('pg tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
