#!/usr/bin/env node
'use strict';
// Generates tests/fixtures/parity.json from the Node implementation: the Laravel port must give the same numbers.
//   node laravel/tests/fixtures/make-parity.cjs
const fs = require('fs');
const path = require('path');
const rng = require('../../../server/rng.js');
const odds = require('../../../server/odds.js');
const { Ledger } = require('../../../server/ledger.js');
const sign = require('../../../server/sign.js');
const { ClientRegistry, encrypt } = require('../../../server/clients.js');

const seeds = [];
for (let i = 0; i < 40; i++) seeds.push(require('crypto').createHash('sha256').update('seed' + i).digest('hex'));
const values = rng.COMBOS.map((c) => odds.DEFAULT_ODDS[c]).sort((a, b) => a - b);
const out = { values, odds: {}, rtps: {}, draws: [], layouts: [], commits: [], ledger: null };
out.odds = odds.build();
[0.88, 0.9, 0.9234, 0.95, 0.99].forEach((r) => { const t = odds.buildForRtp(odds.DEFAULT_ODDS, r); out.rtps[r] = { weights: t.weights, cheap: t.cheap, cheapRtp: t.cheapRtp, bestRtp: t.bestRtp, total: t.total }; });
seeds.forEach((s, i) => {
  const layout = rng.oddsLayout(s, i + 1, values), t = odds.buildForRtp(layout, 0.9);
  out.layouts.push({ seed: s, raceNo: i + 1, layout, weights: t.weights });
  out.draws.push({ seed: s, raceNo: i + 1, weights: t.weights, result: rng.draw(s, i + 1, t.weights), uniform: rng.draw(s, i + 1) });
  out.commits.push({ seed: s, commit: rng.commitOf(s) });
});
const led = new Ledger(null); const lines = [];
for (let i = 0; i < 12; i++) lines.push(led.append(i % 3 === 0 ? { e: 'open', raceNo: i, seed: seeds[i], commit: rng.commitOf(seeds[i]), odds: out.layouts[i].layout, rtp: 0.9, openAt: 1700000000000 + i, betCloseAt: 1700000025000 + i, t: 1700000000000 + i }
  : { e: 'bet', raceNo: i, id: 'b' + i, playerId: 'alice', combo: '1-2', stake: 100 * i, txId: 'bet:' + i, currency: 'PHP', brandId: null, t: 1700000000000 + i }));
out.ledger = { lines, head: led.head };
out.signature = sign.signature('secret-secret-secret', '1700000000000', 'abc', 'POST', '/horse-api/wallet/debit', '{"a":1}');
// a client registry written by the Node server (secrets encrypted with CLIENTS_KEY): the Laravel import must read it and its API key must work
const KEY = 'clients-key-for-tests-1234', tmp = path.join(require('os').tmpdir(), 'parity-clients-' + process.pid + '.json');
const reg = new ClientRegistry({ file: tmp, secret: KEY });
const made = reg.create({ id: 'acme', name: 'Acme Casino', currency: 'PHP', wallet: { url: 'https://platform.acme.example/horse-api', secret: 'wallet-secret-acme-1234567890', keyId: 'w1' },
  webhook: { url: 'https://platform.acme.example/horse-events', events: 'round.settled' }, limits: { minBet: 200, maxBet: 50000 }, allowedIps: ['203.0.113.0/24'], returnUrlHosts: ['lobby.acme.example'] });
out.clients = { key: KEY, apiKey: made.apiKey, file: fs.readFileSync(tmp, 'utf8'), enc: encrypt('wallet-secret-value-123', KEY), plain: 'wallet-secret-value-123' };
fs.unlinkSync(tmp);
fs.writeFileSync(path.join(__dirname, 'parity.json'), JSON.stringify(out));
console.log('wrote parity.json:', out.draws.length, 'draws,', lines.length, 'ledger lines');
