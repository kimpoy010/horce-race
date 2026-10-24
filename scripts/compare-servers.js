#!/usr/bin/env node
'use strict';
/*
 * Compares the numbers of two game servers (the Node server and the Laravel app) through their operator API, for the cutover (docs/CUTOVER.md):
 *
 *   node scripts/compare-servers.js <nodeUrl> <nodeKey> <laravelUrl> <laravelKey>
 *   node scripts/compare-servers.js http://127.0.0.1:8080 KEY1 http://127.0.0.1:8000 KEY2
 *
 * Run it right after the import, with both servers between races (no open bets): races, bets, staked, paid, how often each pair won, the RTP setting,
 * the block list and every client's own figures must be identical. Exit code 0 = identical, 1 = a difference.
 */
const [nodeUrl, nodeKey, lvUrl, lvKey] = process.argv.slice(2);
if (!lvKey) { console.error('usage: node scripts/compare-servers.js <nodeUrl> <nodeKey> <laravelUrl> <laravelKey>'); process.exit(2); }

async function get(base, key, path) {
  const res = await fetch(base.replace(/\/$/, '') + path, { headers: { 'x-controller-key': key } });
  if (!res.ok) throw new Error(base + path + ' answered ' + res.status);
  return res.json();
}
const pick = (o, keys) => keys.reduce((r, k) => { r[k] = o[k]; return r; }, {});

(async () => {
  const [a, b] = await Promise.all([get(nodeUrl, nodeKey, '/api/report'), get(lvUrl, lvKey, '/api/report')]);
  const [ca, cb] = await Promise.all([get(nodeUrl, nodeKey, '/api/clients'), get(lvUrl, lvKey, '/api/clients')]);
  const rows = [], bad = [];
  const cmp = (name, x, y) => { const same = JSON.stringify(x) === JSON.stringify(y); rows.push([name, same ? 'same' : 'DIFFERENT', JSON.stringify(x), JSON.stringify(y)]); if (!same) bad.push(name); };
  ['rounds', 'bets', 'staked', 'paid', 'rtpSetting', 'blockedPlayers'].forEach((k) => cmp(k, a[k], b[k]));
  cmp('wins per pair', a.wins, b.wins);
  const cur = (r) => Object.keys(r.byCurrency || {}).sort().map((c) => [c, r.byCurrency[c].staked, r.byCurrency[c].paid]);
  cmp('money per currency', cur(a), cur(b));
  const fig = (list) => (list.clients || []).map((c) => [c.id, c.status, c.stats.bets, c.stats.staked, c.stats.paid]).sort();
  cmp('clients (id, status, bets, staked, paid)', fig(ca), fig(cb));
  const w = [34, 10];
  rows.forEach((r) => console.log(r[0].padEnd(w[0]) + r[1].padEnd(w[1]) + (r[1] === 'same' ? '' : 'node ' + r[2] + '  laravel ' + r[3])));
  console.log(bad.length ? '\n' + bad.length + ' difference(s): do not switch traffic yet.' : '\nidentical: the Laravel app holds the same numbers as the Node server.');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('Error: ' + e.message); process.exit(2); });
