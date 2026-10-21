'use strict';
/*
 * Single-writer lease for active / standby operation. Exactly one process may run the game (rounds, draws and wallet calls live in one
 * process and the ledger has one writer). The active process renews a lease file in the shared data directory every second; a standby
 * process waits and takes over when the lease has not been renewed for `ttlMs`. The new active process replays the ledger (in-flight
 * races are settled or refunded, queued wallet calls resume). A process that cannot renew its lease stops (fencing), so two processes
 * never act at once, even after a freeze.
 *
 * The data directory must be on storage both machines see with normal POSIX file semantics (local disk for a restart on the same
 * machine, or a shared volume). This is a practical lease, not a replacement for a real lock service: see docs/DEPLOY.md.
 */
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

class Lease {
  constructor(file, opts) {
    opts = opts || {};
    this.file = file; this.ttlMs = opts.ttlMs || 10000; this.now = opts.now || Date.now;
    this.id = crypto.randomBytes(8).toString('hex'); this.host = os.hostname(); this.pid = process.pid;
    this.heldSince = null; this.lastRenew = 0;
  }
  read() { try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (e) { return null; } }
  _write(extra) {
    const tmp = this.file + '.' + this.id + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.assign({ holder: this.id, host: this.host, pid: this.pid, renewedAt: this.now(), since: this.heldSince }, extra)), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  // true when this process now holds the lease
  async tryAcquire() {
    const cur = this.read(), t = this.now();
    if (cur && cur.holder !== this.id && t - cur.renewedAt < this.ttlMs) return false;     // somebody else is alive
    this.heldSince = this.heldSince || t; this._write();
    // two standbys can race for a stale lease: whoever's write is the one left after a short wait wins
    await new Promise((ok) => setTimeout(ok, 150));
    const now = this.read();
    if (!now || now.holder !== this.id) { this.heldSince = null; return false; }
    this.lastRenew = t; return true;
  }
  // false = the lease was lost (another process took it, or it could not be written): the caller must stop
  renew() {
    const cur = this.read();
    if (cur && cur.holder !== this.id) return false;
    try { this._write(); this.lastRenew = this.now(); return true; } catch (e) { return false; }
  }
  // still safe to act? (we renewed recently enough that nobody can have taken over)
  valid() { return this.heldSince !== null && this.now() - this.lastRenew < this.ttlMs * 0.7; }
  release() { const cur = this.read(); if (cur && cur.holder === this.id) { try { fs.unlinkSync(this.file); } catch (e) { /* gone */ } } this.heldSince = null; }
  info() { const cur = this.read(); return cur ? { holder: cur.holder, host: cur.host, pid: cur.pid, ageSeconds: Math.round((this.now() - cur.renewedAt) / 1000), mine: cur.holder === this.id } : null; }
}

module.exports = { Lease };
