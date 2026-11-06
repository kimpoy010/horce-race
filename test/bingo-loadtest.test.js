'use strict';
/* The load test tool of Bingo Pinball (laravel/bin/bingo-loadtest.cjs) against a small fake server: it counts plays, notices a server that is not idempotent, and refuses non-local hosts. */
const assert = require('assert');
const http = require('http');
const { spawnSync } = require('child_process');
const path = require('path');
const tool = path.join(__dirname, '..', 'laravel', 'bin', 'bingo-loadtest.cjs');
const { run, pct, isLocal } = require(tool);

function server(opts) {
  const rounds = {}; let id = 0;
  return http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => body += c); req.on('end', () => {
      const j = body ? JSON.parse(body) : {}, send = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.endsWith('/auth')) return send(200, { ok: true, session: 's' + Math.random(), balance: 1e6, minIntervalMs: 50, limits: { minBet: 100, maxBet: 1000 } });
      if (req.url.endsWith('/play')) {
        if (rounds[j.requestId]) return send(200, opts.broken ? { ok: true, repeat: false, round: { id: ++id, stake: j.stake, payout: 0 }, balance: 1 } : { ok: true, repeat: true, round: rounds[j.requestId], balance: 1 });
        rounds[j.requestId] = { id: ++id, stake: j.stake, payout: id % 3 === 0 ? j.stake * 2 : 0 };
        return send(200, { ok: true, repeat: false, round: rounds[j.requestId], balance: 1 });
      }
      send(404, { ok: false, error: 'NOT_FOUND' });
    });
  });
}

(async () => {
  assert.strictEqual(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.ok(isLocal('localhost') && isLocal('127.0.0.1') && isLocal('10.1.2.3') && isLocal('staging.test'));
  assert.ok(!isLocal('example.com') && !isLocal('8.8.8.8'));

  for (const broken of [false, true]) {
    const s = server({ broken }); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + s.address().port;
    const sum = await run({ base, client: 'demo', players: 4, durationS: 2, stake: 100, tokens: null, repeatRate: 1, rampS: 0 });
    s.close();
    assert.ok(sum.plays >= 8, 'plays were made: ' + sum.plays);
    assert.strictEqual(sum.players, 4);
    assert.strictEqual(sum.staked, sum.plays * 100);
    assert.ok(sum.latencyMs.p95 >= 0 && sum.playsPerSecond > 0);
    if (broken) assert.ok(sum.repeatViolations > 0 && sum.errors.REPEAT_NOT_IDEMPOTENT > 0, 'a server that plays twice for one request id is caught');
    else assert.strictEqual(sum.repeatViolations, 0);
  }

  const refuse = spawnSync('node', [tool, '--base', 'https://casino.example.com'], { encoding: 'utf8' });
  assert.strictEqual(refuse.status, 2, 'refuses a non-local host');
  assert.ok(/not a local address/.test(refuse.stderr));
  console.log('bingo load test tool tests passed');
})().catch((e) => { console.error(e); process.exit(1); });
