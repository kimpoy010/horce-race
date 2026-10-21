#!/usr/bin/env node
'use strict';
/*
 * Manage the clients (platforms) that offer the game. Works on data/clients.json; a running server picks the change up within seconds.
 *
 *   node scripts/clients.js list
 *   node scripts/clients.js show <id>
 *   node scripts/clients.js add <id> --name "Acme Casino" --wallet-url https://acme.example/horse-api [--wallet-secret <16+ chars>] [options]
 *   node scripts/clients.js update <id> [options]
 *   node scripts/clients.js rotate-key <id> [--grace-hours 24]      new API key; the old ones keep working for the grace time (0 = revoke now)
 *   node scripts/clients.js revoke-key <id> <keyId>
 *   node scripts/clients.js disable <id> | enable <id>               a disabled client's launches and sessions stop working
 *   node scripts/clients.js remove <id> --yes
 *
 * back-office logins of a client (data/users.json):
 *   node scripts/clients.js add-user <client> <username> --role viewer|support|admin     prints a temporary password (changed at the first sign-in)
 *   node scripts/clients.js list-users <client>
 *   node scripts/clients.js reset-password <client> <username>
 *   node scripts/clients.js disable-user|enable-user <client> <username>
 *   node scripts/clients.js remove-user <client> <username> --yes
 *
 * staff accounts of the game operator for the /admin console (data/admins.json):
 *   node scripts/clients.js add-operator <username> --role admin|support|viewer      prints a temporary password
 *   node scripts/clients.js list-operators | reset-operator-password <username> | disable-operator <username> | enable-operator <username> | remove-operator <username> --yes
 *
 * options: --name --currency PHP --wallet-url --wallet-secret --wallet-key-id --wallet-auth hmac|bearer --webhook-url --webhook-secret --webhook-events a,b
 *          --min-bet --max-bet --max-round-stake --daily-loss-limit (minor units) --reality-check-min --big-win-min --ips a,b (IPs or CIDR for the client API)
 *          --return-hosts a,b --mock (play-money wallet, needs ALLOW_MOCK_WALLET=1)
 * CLIENTS_KEY (env) encrypts the wallet / webhook secrets in the file; keep it the same as the server's.
 */
const path = require('path');
const { ClientRegistry } = require('../server/clients.js');
const { UserStore } = require('../server/users.js');

const file = process.env.CLIENTS_FILE || path.join(__dirname, '..', 'data', 'clients.json');
const reg = new ClientRegistry({ file, secret: process.env.CLIENTS_KEY, allowMock: process.env.ALLOW_MOCK_WALLET === '1' && process.env.NODE_ENV !== 'production', allowHttp: process.env.ALLOW_HTTP_WALLET === '1' });
if (reg.loadError) { console.error('Cannot read ' + file + ': ' + reg.loadError); process.exit(1); }

function parse(argv) {
  const pos = [], f = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const nx = argv[i + 1]; if (nx === undefined || nx.startsWith('--')) f[k] = true; else { f[k] = nx; i++; } } else pos.push(argv[i]);
  }
  return { pos, f };
}
const list = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean);
const num = (v, n) => { const x = Number(v); if (!Number.isFinite(x)) { console.error('--' + n + ' must be a number'); process.exit(1); } return x; };
function build(f, base) {
  const c = {};
  if (f.name) c.name = String(f.name);
  if (f.currency) c.currency = String(f.currency).toUpperCase();
  if (f.mock) c.wallet = { type: 'mock' };
  else if (f['wallet-url'] || f['wallet-secret'] || f['wallet-key-id'] || f['wallet-auth']) {
    c.wallet = {}; if (f['wallet-url']) c.wallet.url = f['wallet-url']; if (f['wallet-secret']) c.wallet.secret = f['wallet-secret'];
    if (f['wallet-key-id']) c.wallet.keyId = f['wallet-key-id']; if (f['wallet-auth']) c.wallet.auth = f['wallet-auth'];
  }
  if (f['webhook-url'] || f['webhook-secret'] || f['webhook-events']) {
    c.webhook = Object.assign({}, base && base.webhook); if (f['webhook-url']) c.webhook.url = f['webhook-url']; if (f['webhook-secret']) c.webhook.secret = f['webhook-secret']; if (f['webhook-events']) c.webhook.events = list(f['webhook-events']).join(',');
  }
  const lim = {};
  if (f['min-bet']) lim.minBet = num(f['min-bet'], 'min-bet'); if (f['max-bet']) lim.maxBet = num(f['max-bet'], 'max-bet'); if (f['max-round-stake']) lim.maxRoundStake = num(f['max-round-stake'], 'max-round-stake');
  if (f['daily-loss-limit'] !== undefined) lim.dailyLossLimit = num(f['daily-loss-limit'], 'daily-loss-limit');
  if (Object.keys(lim).length) c.limits = Object.assign({}, base && base.limits, lim);
  if (f['reality-check-min'] !== undefined) c.realityCheckMinutes = num(f['reality-check-min'], 'reality-check-min');
  if (f['big-win-min']) c.bigWinMin = num(f['big-win-min'], 'big-win-min');
  if (f.ips) c.allowedIps = list(f.ips); if (f['return-hosts']) c.returnUrlHosts = list(f['return-hosts']);
  return c;
}
function show(c) {
  console.log(JSON.stringify(c, null, 2));
}
function secretNotice(r) {
  console.log('\n=== SHOW ONCE: keep these, they cannot be displayed again ===');
  if (r.apiKey) console.log('API key (the client sends it as "Authorization: Bearer ..." to /api/client/...):\n  ' + r.apiKey);
  if (r.walletSecret) console.log('Wallet signing secret (the client\'s platform uses it to verify the game\'s signed wallet calls):\n  ' + r.walletSecret);
}

const { pos, f } = parse(process.argv.slice(2)), cmd = pos[0], id = pos[1];
const usersFile = process.env.USERS_FILE || path.join(path.dirname(file), 'users.json');
async function userCmd() {
  const op = /-operator$/.test(cmd) || cmd === 'list-operators';                 // staff of the game operator (the /admin console)
  const us = new UserStore({ file: op ? path.join(path.dirname(file), 'admins.json') : usersFile, secret: process.env.CLIENTS_KEY }), name = op ? pos[1] : pos[2], id = op ? '_operator' : pos[1];
  if (us.loadError) throw new Error('Cannot read ' + usersFile + ': ' + us.loadError);
  if (!id) throw new Error('give the client id');
  if (!op && cmd !== 'list-users' && !reg.get(id) && id !== 'default') throw new Error('unknown client ' + id);
  if (cmd === 'list-users' || cmd === 'list-operators') us.list(id).forEach((u) => console.log(u.username.padEnd(24) + u.role.padEnd(10) + u.status.padEnd(10) + (u.totp ? '2fa ' : '    ') + (u.mustChange ? 'temporary password' : '')));
  else if (cmd === 'add-user' || cmd === 'add-operator') { const r = await us.create(id, { username: name, role: f.role || 'admin' }, 'operator'); console.log('created ' + r.user.username + ' (' + r.user.role + ')\n\n=== SHOW ONCE ===\nTemporary password: ' + r.tempPassword + '\n(the user must choose a new one at the first sign-in at ' + (op ? '/admin' : '/backoffice') + ')'); }
  else if (cmd === 'reset-password' || cmd === 'reset-operator-password') { const r = await us.resetPassword(id, name); console.log('Temporary password for ' + name + ': ' + r.tempPassword); }
  else if (/^(disable|enable)-(user|operator)$/.test(cmd)) { const off = cmd.startsWith('disable'); us.setStatus(id, name, off ? 'disabled' : 'active'); console.log(name + (off ? ' disabled' : ' enabled')); }
  else if (cmd === 'remove-user' || cmd === 'remove-operator') { if (!f.yes) throw new Error('add --yes to remove ' + name); us.remove(id, name); console.log(name + ' removed'); }
}
if (['add-user', 'list-users', 'reset-password', 'disable-user', 'enable-user', 'remove-user', 'add-operator', 'list-operators', 'reset-operator-password', 'disable-operator', 'enable-operator', 'remove-operator'].includes(cmd)) { userCmd().catch((e) => { console.error('Error: ' + e.message); process.exit(1); }); } else try {
  if (cmd === 'list' || !cmd) {
    const l = reg.list(); if (!l.length) console.log('no clients yet. Add one: node scripts/clients.js add <id> --name "..." --wallet-url https://...');
    l.forEach((c) => console.log(c.id.padEnd(20) + c.status.padEnd(10) + (c.currency || '-').padEnd(6) + (c.wallet.type === 'mock' ? 'mock wallet' : c.wallet.url) + (c.webhook ? '   webhook ' + c.webhook.url : '')));
  } else if (cmd === 'show') { const c = reg.get(id); if (!c) throw new Error('unknown client'); show(reg.publicView(c)); }
  else if (cmd === 'add') {
    const c = build(f); c.id = id; if (!c.wallet) { console.error('give --wallet-url (or --mock)'); process.exit(1); }
    const r = reg.create(c); show(r.client); secretNotice(r);
  } else if (cmd === 'update') { const c = reg.get(id); if (!c) throw new Error('unknown client'); show(reg.update(id, build(f, c))); }
  else if (cmd === 'rotate-key') { const r = reg.rotateKey(id, f['grace-hours'] !== undefined ? num(f['grace-hours'], 'grace-hours') * 3600000 : undefined); secretNotice(r); console.log('\nOld keys: ' + (f['grace-hours'] === '0' ? 'revoked now' : 'valid for ' + (f['grace-hours'] || 24) + ' more hours') + '.'); }
  else if (cmd === 'revoke-key') { show(reg.revokeKey(id, pos[2])); }
  else if (cmd === 'disable') { reg.setStatus(id, 'disabled'); console.log(id + ' disabled'); }
  else if (cmd === 'enable') { reg.setStatus(id, 'active'); console.log(id + ' enabled'); }
  else if (cmd === 'remove') { if (!f.yes) { console.error('add --yes to remove ' + id + ' (use disable to keep the history)'); process.exit(1); } reg.remove(id); console.log(id + ' removed'); }
  else { console.error('unknown command. See the header of scripts/clients.js'); process.exit(1); }
} catch (e) { console.error('Error: ' + e.message); process.exit(1); }
