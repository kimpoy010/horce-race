'use strict';
/*
 * Tamper-evident ledger: an append-only JSON-lines file where every line carries a hash that covers the line and the hash of the
 * line before it:   h = sha256(previousHash + JSON-of-the-event-without-h)
 * Changing, deleting, inserting or re-ordering any line breaks every hash after it, so edits to the audit log are detectable
 * (scripts/verify-ledger.js, and the server checks the chain when it starts). The newest hash (`head`) is also sent in the
 * round.settled webhook: once the platform keeps it, even someone who can rewrite the whole file cannot hide the change.
 * Lines written before this feature (no `h`) are accepted as a legacy prefix; the chain starts from the hash of that prefix.
 */
const fs = require('fs');
const crypto = require('crypto');
const { asDoc } = require('./store.js');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// text of a ledger file -> { ok, lines, chained, legacy, head, broken: {line, reason} | null }
function verifyText(text) {
  const rows = text.split('\n');
  const res = { ok: true, lines: 0, chained: 0, legacy: 0, head: null, broken: null };
  let legacy = '', started = false, head = null;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    if (!raw) continue;
    res.lines++;
    let ev;
    try { ev = JSON.parse(raw); } catch (e) { res.ok = false; res.broken = { line: i + 1, reason: i === rows.length - 1 || (i === rows.length - 2 && !rows[rows.length - 1]) ? 'truncated last line' : 'unreadable line' }; break; }
    if (typeof ev.h !== 'string') {
      if (started) { res.ok = false; res.broken = { line: i + 1, reason: 'line without a hash inside the chain' }; break; }
      legacy += raw + '\n'; res.legacy++; continue;
    }
    if (!started) { started = true; head = sha(legacy); }
    const h = ev.h; delete ev.h;
    if (sha(head + JSON.stringify(ev)) !== h) { res.ok = false; res.broken = { line: i + 1, reason: 'hash does not match (line changed, or lines removed / inserted before it)' }; break; }
    head = h; res.chained++;
  }
  res.head = res.broken ? null : (started ? head : sha(legacy));
  return res;
}

function verifyFile(file) {
  if (!fs.existsSync(file)) return { ok: true, lines: 0, chained: 0, legacy: 0, head: sha(''), broken: null };
  return verifyText(fs.readFileSync(file, 'utf8'));
}

class Ledger {
  constructor(file) {                      // file: a path, a storage doc (server/store.js) or null (memory only)
    this.doc = asDoc(file); this.file = this.doc ? true : null; this.head = sha(''); this.lines = 0; this.check = { ok: true, broken: null };
    if (this.doc && this.doc.exists()) {
      const r = verifyText(this.doc.read() || '');
      this.check = { ok: r.ok, broken: r.broken, chained: r.chained, legacy: r.legacy };
      this.lines = r.lines;
      if (r.ok) this.head = r.head;
    }
  }
  get ok() { return this.check.ok; }
  // returns the stored line; ev must be a plain object
  append(ev) {
    const body = JSON.stringify(ev), h = sha(this.head + body);
    const line = JSON.stringify(Object.assign({}, ev, { h }));
    if (this.doc) this.doc.append(line);
    this.head = h; this.lines++;
    return line;
  }
}

module.exports = { Ledger, verifyText, verifyFile, sha };
