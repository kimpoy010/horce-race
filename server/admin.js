'use strict';
/*
 * Operator admin console (/admin): the endpoints behind it. The operator's staff sign in with their own accounts (roles: viewer = read only,
 * support = also suspend / re-enable a client and handle its back-office users, admin = everything including clients, keys, RTP and staff).
 * Login, sessions, passwords, two-step sign-in, staff management and the audit log are the same engine as the clients' back office (backoffice.js);
 * this file adds what only the operator can do.
 */
const SECRETS_ONCE = 'Shown once. Pass it on over a safe channel; it cannot be displayed again.';

function pick(o, keys) { const r = {}; keys.forEach((k) => { if (o[k] !== undefined) r[k] = o[k]; }); return r; }

// deps: clients (ClientRegistry), clientUsers (UserStore of the clients' back-office users), clientBackOffice (BackOffice, to end sessions),
//       ops() -> health / alerts / snapshot of the running game
function adminRoutes(deps) {
  const { clients, clientUsers, clientBackOffice, ops } = deps;
  const walletHost = (c) => { try { return c.wallet.type === 'mock' ? 'mock wallet' : new URL(c.wallet.url).host; } catch (e) { return '-'; } };
  const lastApi = (c) => (c.apiKeys || []).reduce((m, k) => Math.max(m, k.lastUsedAt || 0), 0) || null;

  return async function route(x) {
    const { sub, method, engine, send, audit, need, httpErr } = x, me = x.me;
    const body = async () => JSON.parse(await x.ctx.readBody() || '{}');

    /* ---- overview: health, game numbers, RTP, clients ---- */
    if (sub === 'overview' && method === 'GET') {
      const rep = engine.report(), o = ops();
      return send(200, {
        ok: true, role: o.role, health: o.health, alerts: o.alerts, recentAlerts: o.recentAlerts, uptime: o.uptime, lease: o.lease, diskFreeMb: o.diskFreeMb, tickAge: o.tickAge, wallet: o.wallet,
        game: { rounds: rep.rounds, bets: rep.bets, staked: rep.staked, paid: rep.paid, ggr: rep.staked - rep.paid, rtpActual: rep.actualRtp, rtpSetting: rep.rtpSetting, rtpOfCurrentRace: rep.rtpOfCurrentRace,
          currentRound: rep.currentRound, sessions: rep.activeSessions, byCurrency: rep.byCurrency, pending: o.snapshot.pending, rtpZ: o.snapshot.rtpZ, ledger: o.snapshot.ledger, commit: rep.commit },
        rtp: engine.previewRtp(engine.rtp),
        defaultClient: !!engine.wallet, defaultStats: engine.wallet ? engine.clientReport('default') : null,
        clients: clients.list().map((c) => ({ id: c.id, name: c.name, status: c.status, currency: c.currency || null, wallet: walletHost(c), webhook: !!c.webhook, users: clientUsers.count(c.id), lastApiUse: lastApi(c),
          stats: engine.clientReport(c.id), walletHealth: engine.metrics.walletWindow(300000, c.id) }))
      });
    }
    if (sub === 'rtp/preview' && method === 'GET') { try { return send(200, engine.previewRtp(x.ctx.url.searchParams.get('value'))); } catch (e) { return send(400, { ok: false, error: e.code || 'BAD_RTP' }); } }
    if (sub === 'rtp' && method === 'POST') {
      need('admin'); const b = await body(); let r;
      try { r = engine.setRtp(b.rtp, 'admin:' + me.username); } catch (e) { return send(400, { ok: false, error: e.code || 'BAD_RTP', message: 'The RTP must be between 88% and 99%.' }); }
      audit({ action: 'rtp_set', detail: String(r.rtp) }); return send(200, r);
    }

    /* ---- clients ---- */
    if (sub === 'clients' && method === 'POST') {
      need('admin'); const b = await body(), r = clients.create(b.client || b);
      audit({ action: 'client_created', target: r.client.id }); return send(200, Object.assign({ ok: true, note: SECRETS_ONCE }, r));
    }
    const cm = /^clients\/([a-z0-9-]{2,32})(?:\/(status|rotate-key|revoke-key|rotate-wallet-secret|rotate-webhook-secret|delete|users)(?:\/([a-z0-9._@-]{3,64})\/(reset-password|status|delete))?)?$/.exec(sub);
    if (cm) {
      const id = cm[1], c = clients.get(id);
      if (!c) throw httpErr(404, 'NOT_FOUND', 'Unknown client.');
      const act = cm[2];
      if (!act && method === 'GET') {
        return send(200, { ok: true, client: clients.publicView(c), report: engine.clientReport(id), users: clientUsers.list(id), walletHealth: engine.metrics.walletWindow(300000, id),
          rounds: engine.rounds(id, 10).rounds, audit: engine.auditFor(id, 30).entries, lastApiUse: lastApi(c) });
      }
      if (!act && method === 'POST') {
        need('admin'); const b = await body(), patch = pick(b.client || b, ['name', 'currency', 'limits', 'currencyLimits', 'realityCheckMinutes', 'bigWinMin', 'allowedIps', 'returnUrlHosts', 'wallet', 'webhook']);
        if (patch.wallet && !patch.wallet.secret) delete patch.wallet.secret;                                      // an empty secret field means "keep it"
        if (patch.webhook && patch.webhook.url && !patch.webhook.secret) patch.webhook = Object.assign({}, c.webhook, patch.webhook, { secret: c.webhook ? c.webhook.secret : undefined });
        const r = clients.update(id, patch); audit({ action: 'client_updated', target: id, detail: Object.keys(patch).join(', ') + (patch.wallet && patch.wallet.secret ? ' (wallet secret)' : '') });
        return send(200, { ok: true, client: r });
      }
      if (act === 'status' && method === 'POST') { need('support'); const b = await body(), r = clients.setStatus(id, b.status === 'disabled' ? 'disabled' : 'active'); audit({ action: r.status === 'disabled' ? 'client_suspended' : 'client_enabled', target: id }); return send(200, { ok: true, client: r }); }
      if (act === 'rotate-key' && method === 'POST') {
        need('admin'); const b = await body(), grace = b.graceHours === undefined ? undefined : Math.max(0, Math.min(168, Number(b.graceHours) || 0)) * 3600000, r = clients.rotateKey(id, grace);
        audit({ action: 'api_key_rotated', target: id, detail: 'grace ' + (grace === undefined ? 24 : grace / 3600000) + ' h' }); return send(200, Object.assign({ ok: true, note: SECRETS_ONCE }, r));
      }
      if (act === 'revoke-key' && method === 'POST') { need('admin'); const b = await body(), r = clients.revokeKey(id, String(b.keyId || '')); audit({ action: 'api_key_revoked', target: id, detail: String(b.keyId || '') }); return send(200, { ok: true, client: r }); }
      if (act === 'rotate-wallet-secret' && method === 'POST') { need('admin'); const r = clients.rotateWalletSecret(id); audit({ action: 'wallet_secret_rotated', target: id }); return send(200, Object.assign({ ok: true, note: SECRETS_ONCE }, r)); }
      if (act === 'rotate-webhook-secret' && method === 'POST') { need('admin'); const r = clients.rotateWebhookSecret(id); audit({ action: 'webhook_secret_rotated', target: id }); return send(200, Object.assign({ ok: true, note: SECRETS_ONCE }, r)); }
      if (act === 'delete' && method === 'POST') {
        need('admin'); const b = await body(); if (b.confirm !== id) throw httpErr(400, 'CONFIRM', 'Type the client id to confirm.');
        clients.remove(id); audit({ action: 'client_deleted', target: id }); return send(200, { ok: true });
      }
      /* back-office users of this client */
      if (act === 'users') {
        const name = cm[3], what = cm[4];
        if (!name && method === 'GET') return send(200, { ok: true, users: clientUsers.list(id) });
        if (!name && method === 'POST') { need('admin'); const b = await body(), r = await clientUsers.create(id, { username: b.username, role: b.role }, 'operator:' + me.username); audit({ action: 'client_user_created', target: id + '/' + r.user.username, detail: r.user.role }); return send(200, Object.assign({ ok: true, note: SECRETS_ONCE }, r)); }
        if (name && method === 'POST') {
          const b = await body(); let out = {};
          if (what === 'reset-password') { need('support'); out = await clientUsers.resetPassword(id, name); out.note = SECRETS_ONCE; }
          else if (what === 'status') { need('support'); out = { user: clientUsers.setStatus(id, name, b.status) }; }
          else { need('admin'); clientUsers.remove(id, name); }
          clientBackOffice.endSessions(id, name); audit({ action: 'client_user_' + what.replace('-', '_'), target: id + '/' + name, detail: what === 'status' ? b.status : '' });
          return send(200, Object.assign({ ok: true }, out));
        }
      }
    }
    return false;
  };
}

module.exports = { adminRoutes };
