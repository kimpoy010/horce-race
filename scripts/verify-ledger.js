#!/usr/bin/env node
'use strict';
// node scripts/verify-ledger.js [data/ledger.jsonl]   checks the hash chain of the ledger; exit code 0 = intact, 1 = broken
const path = require('path');
const { verifyFile } = require('../server/ledger.js');
const file = process.argv[2] || path.join(__dirname, '..', 'data', 'ledger.jsonl');
const r = verifyFile(file);
console.log('ledger:     ' + file);
console.log('lines:      ' + r.lines + ' (' + r.chained + ' chained, ' + r.legacy + ' from before the chain started)');
if (r.ok) { console.log('result:     INTACT'); console.log('head hash:  ' + r.head + '   (compare with the ledger hash in the round.settled webhook)'); process.exit(0); }
console.log('result:     BROKEN at line ' + r.broken.line + ': ' + r.broken.reason);
process.exit(1);
