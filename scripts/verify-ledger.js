#!/usr/bin/env node
'use strict';
// node scripts/verify-ledger.js [data/ledger.jsonl]   checks the hash chain of the ledger; exit code 0 = intact, 1 = broken
// PG_URL=postgres://... node scripts/verify-ledger.js --pg   checks the ledger table in PostgreSQL instead
const path = require('path');
const { verifyFile, verifyText } = require('../server/ledger.js');
function report(label, r) {
  console.log('ledger:     ' + label);
  console.log('lines:      ' + r.lines + ' (' + r.chained + ' chained, ' + r.legacy + ' from before the chain started)');
  if (r.ok) { console.log('result:     INTACT'); console.log('head hash:  ' + r.head + '   (compare with the ledger hash in the round.settled webhook)'); process.exit(0); }
  console.log('result:     BROKEN at line ' + r.broken.line + ': ' + r.broken.reason);
  process.exit(1);
}
if (process.argv.includes('--pg')) {
  if (!process.env.PG_URL) { console.error('set PG_URL'); process.exit(1); }
  const { Pool } = require('pg'), pool = new Pool({ connectionString: process.env.PG_URL });
  pool.query('SELECT line FROM ledger ORDER BY seq').then((r) => { pool.end(); report('PostgreSQL (table ledger)', verifyText(r.rows.map((x) => x.line).join('\n') + (r.rows.length ? '\n' : ''))); })
    .catch((e) => { console.error('Error: ' + e.message); process.exit(1); });
} else {
  const file = process.argv[2] || path.join(__dirname, '..', 'data', 'ledger.jsonl');
  report(file, verifyFile(file));
}
