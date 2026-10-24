#!/usr/bin/env node
'use strict';
// Plays a short history on the Node server's engine (two clients, wins, a credit the wallet did not confirm, a blocked player, an RTP change, a race
// still taking bets) and writes the data directory the Node server would leave behind: tests/fixtures/node-state/
// The Laravel importer (php artisan import:node) is tested against it.   node laravel/tests/fixtures/make-node-state.cjs
const fs = require('fs');
const path = require('path');
const { Engine } = require('../../../server/engine.js');
const { ClientRegistry } = require('../../../server/clients.js');
const { MockWallet } = require('../../../server/wallet.js');
const rng = require('../../../server/rng.js');

const dir = path.join(__dirname, 'node-state');
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const KEY = 'clients-key-for-tests-1234';
let clock = 1800000000000, failCredits = false;

(async () => {
  const reg = new ClientRegistry({ file: path.join(dir, 'clients.json'), secret: KEY, allowMock: true, now: () => clock });
  reg.create({ id: 'acme', name: 'Acme', wallet: { type: 'mock' }, currency: 'PHP' });
  reg.create({ id: 'zeta', name: 'Zeta', wallet: { type: 'mock' }, currency: 'PHP' });
  const wallets = { acme: new MockWallet({ startBalance: 1000000 }), zeta: new MockWallet({ startBalance: 1000000 }) };
  reg.walletFor = (id) => {
    const w = wallets[id], orig = w.credit.bind(w);
    w.credit = async (...a) => { if (failCredits) throw new Error('NO_ANSWER'); return orig(...a); };
    return w;
  };
  const eng = new Engine({ wallet: null, clients: reg, now: () => clock, ledgerFile: path.join(dir, 'ledger.jsonl'),
    config: { settingsFile: path.join(dir, 'settings.json'), blockedFile: path.join(dir, 'blocked.json'), betMs: 25000 } });
  const all = (stake) => rng.COMBOS.map((c) => ({ combo: c, stake }));
  const exp = { rounds: [] };
  const finish = async () => { clock += 25000; await eng.tick(); clock += 36000; await eng.tick(); };

  await eng.tick();                                                                       // round 1: ann (acme) covers every pair, zed (zeta) one pair
  const ann = (await eng.auth('demo-ann', 'acme')).session, zed = (await eng.auth('demo-zed', 'zeta')).session;
  await eng.placeBets(ann, all(1000)); await eng.placeBets(zed, [{ combo: '1-2', stake: 500 }]);
  await finish();
  clock += 10000; await eng.tick();                                                       // round 2: the win cannot be credited (wallet silent)
  await eng.placeBets(ann, all(2000));
  failCredits = true;
  await finish();
  eng.setRtp(0.93, 'admin:olga');
  eng.blockPlayer('acme:bad', 'backoffice:acme:ann');
  clock += 10000; await eng.tick();                                                       // round 3 opens with the new RTP ... and takes bets
  await eng.placeBets(ann, [{ combo: '1-2', stake: 700 }]);
  await eng.placeBets(zed, [{ combo: '3-4', stake: 300 }]);
  await eng.shutdown(200);                                                                // a clean stop in the middle of the betting phase

  for (const r of [...eng.done, eng.cur]) exp.rounds.push({ raceNo: r.raceNo, status: r.status, combo: r.combo || null, staked: r.staked || 0, paid: r.paid || 0, bets: r.bets.length, seed: r.seed, commit: r.commit, rtp: r.rtp });
  exp.pendingCredits = [...eng.pending.keys()];
  exp.ledgerLines = eng.ledger.lines; exp.ledgerHead = eng.ledger.head;
  exp.balances = { 'acme:ann': wallets.acme.accounts.get('ann'), 'zeta:zed': wallets.zeta.accounts.get('zed') };
  exp.clientsKey = KEY;
  fs.writeFileSync(path.join(dir, 'expected.json'), JSON.stringify(exp, null, 2));
  console.log('wrote', dir, JSON.stringify(exp.rounds.map((r) => [r.raceNo, r.status, r.combo, r.staked, r.paid])), 'pending', exp.pendingCredits);
})().catch((e) => { console.error(e); process.exit(1); });
