/*
 * Operator admin console. Talks to /admin/api/* (server/admin.js, server/backoffice.js). All data is put on the page with textContent / DOM nodes, never as HTML.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var S = { me: null, csrf: '', tab: 'overview', clientId: null, timer: null };
  var RANK = { viewer: 1, support: 2, admin: 3 };

  /* ---------- helpers ---------- */
  function h(tag, attrs) {
    var el = document.createElement(tag), i, k;
    if (attrs) for (k in attrs) { if (k === 'class') el.className = attrs[k]; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k] === true ? '' : attrs[k]); }
    for (i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(function (x) { add(el, x); }); else el.appendChild(c.nodeType ? c : document.createTextNode(String(c))); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function can(role) { return S.me && RANK[S.me.role] >= RANK[role]; }
  function api(method, path, body) {
    var o = { method: method, credentials: 'same-origin', headers: { 'X-CSRF-Token': S.csrf } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch('/admin/api/' + path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function money(m, d) { d = d == null ? 2 : d; return (m / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function when(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }
  function pct(x) { return x == null ? '-' : (x * 100).toFixed(2) + '%'; }
  function ago(ms) { if (!ms) return 'never'; var s = Math.max(0, Math.round((Date.now() - ms) / 1000)); return s < 90 ? s + ' s ago' : s < 5400 ? Math.round(s / 60) + ' min ago' : s < 172800 ? Math.round(s / 3600) + ' h ago' : Math.round(s / 86400) + ' days ago'; }
  function msg(kind, text) { return h('div', { class: kind === 'err' ? 'err' : 'note' }, text); }
  function card(k, v, cls) { return h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: 'v ' + (cls || '') }, v)); }
  function td(v, cls) { return h('td', { class: cls || '' }, v); }
  function table(head, rows) { return h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, head.map(function (x) { return h('th', { class: x[1] || '' }, x[0]); }))), h('tbody', null, rows))); }
  function errText(r, fb) { return (r.data && (r.data.message || r.data.error)) || fb || 'Something went wrong.'; }
  function statusPill(st) { return h('span', { class: 'status ' + st }, st); }
  function field(label, input, hint) { return h('div', null, h('label', null, label), input, hint ? h('div', { class: 'mute', style: 'font-size:12px;margin-top:3px' }, hint) : null); }
  function secretBox(title, lines) { return h('div', { class: 'secret' }, h('strong', null, title), lines.map(function (l) { return h('div', null, l[0] + ' ', h('code', { class: 'mono' }, l[1])); }), h('div', { class: 'mute' }, 'Shown once. Pass it on over a safe channel; it cannot be displayed again.')); }
  function modal(title, body) {
    var m = h('div', { class: 'modal', onclick: function (e) { if (e.target === m) close(); } }), box = h('div', { class: 'box' });
    function close() { if (m.parentNode) m.parentNode.removeChild(m); }
    box.appendChild(h('div', { class: 'head' }, h('h2', { style: 'margin:0' }, title), h('button', { onclick: close }, 'Close'))); box.appendChild(body); m.appendChild(box); document.body.appendChild(m); return close;
  }
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
  function handleAuth(r) { if (r.status === 401) { showLogin(r.data.error === 'SESSION_EXPIRED' ? 'Your session expired. Please sign in again.' : ''); return true; } return false; }

  /* ---------- login ---------- */
  function showLogin(note, needOtp, keep) {
    stopTimer(); S.me = null; clear(app);
    var user = h('input', { autocomplete: 'username', value: (keep && keep.user) || '', required: true }), pass = h('input', { type: 'password', autocomplete: 'current-password', required: true }), otp = h('input', { inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123456' }), form = h('form');
    form.appendChild(h('h1', null, 'Operator console')); form.appendChild(h('p', null, 'Horse Race - sign in with your staff account.'));
    if (note) form.appendChild(msg('err', note));
    form.appendChild(h('label', null, 'Username')); form.appendChild(user); form.appendChild(h('label', null, 'Password')); form.appendChild(pass);
    if (needOtp) { form.appendChild(h('label', null, 'Authenticator code')); form.appendChild(otp); }
    form.appendChild(h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      api('POST', 'login', { username: user.value.trim(), password: pass.value, otp: otp.value.trim() }).then(function (r) {
        if (r.status === 200) boot(r.data); else if (r.data.error === 'OTP_REQUIRED') showLogin('', true, { user: user.value }); else showLogin(errText(r, 'Sign in failed.'), needOtp, { user: user.value });
      }).catch(function () { showLogin('Cannot reach the server.', needOtp); });
    });
    app.appendChild(h('div', { class: 'login' }, form)); (user.value ? pass : user).focus();
  }
  function boot(me) { S.me = me.user; S.me.role = me.role; S.csrf = me.csrf; if (S.me.mustChange) forceChange(); else shell(); }
  function forceChange() {
    clear(app);
    var cur = h('input', { type: 'password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' }), out = h('div'), form = h('form');
    form.appendChild(h('h1', null, 'Choose a new password')); form.appendChild(h('p', null, 'You signed in with a temporary password. Choose your own (12 characters or more).')); form.appendChild(out);
    form.appendChild(h('label', null, 'Temporary password')); form.appendChild(cur); form.appendChild(h('label', null, 'New password')); form.appendChild(n1); form.appendChild(h('label', null, 'New password again')); form.appendChild(n2);
    form.appendChild(h('button', { class: 'primary', type: 'submit' }, 'Save and continue'));
    form.addEventListener('submit', function (ev) { ev.preventDefault(); clear(out); if (n1.value !== n2.value) return out.appendChild(msg('err', 'The two new passwords are not the same.')); api('POST', 'password', { current: cur.value, next: n1.value }).then(function (r) { if (r.status === 200) { S.me.mustChange = false; shell(); } else out.appendChild(msg('err', errText(r))); }); });
    app.appendChild(h('div', { class: 'login' }, form));
  }

  /* ---------- shell ---------- */
  function logout() { api('POST', 'logout', {}).then(function () { showLogin(); }); }
  function go(tab, clientId) { S.tab = tab; S.clientId = clientId || null; shell(); }
  function shell() {
    stopTimer(); clear(app);
    var tabs = [['overview', 'Overview'], ['clients', 'Clients']]; if (can('admin')) tabs.push(['staff', 'Staff']); tabs.push(['security', 'Security']); if (can('admin')) tabs.push(['audit', 'Audit log']);
    var nav = h('nav', { class: 'tabs' }), view = h('main');
    tabs.forEach(function (t) { nav.appendChild(h('button', { class: S.tab === t[0] ? 'on' : '', onclick: function () { go(t[0]); } }, t[1])); });
    app.appendChild(h('header', { class: 'top' }, h('span', { class: 'brand' }, 'HORSE RACE OPERATOR CONSOLE'), h('span', { class: 'who' }, S.me.username, h('span', { class: 'role' }, S.me.role), ' ', h('button', { onclick: logout }, 'Sign out'))));
    app.appendChild(nav); app.appendChild(view);
    if (S.tab === 'clients' && S.clientId) clientDetail(view, S.clientId);
    else ({ overview: overview, clients: clients, staff: staff, security: security, audit: audit }[S.tab] || overview)(view);
  }

  /* ---------- overview ---------- */
  function overview(view) {
    function load() {
      api('GET', 'overview').then(function (r) {
        if (handleAuth(r)) return; if (r.status !== 200) return clear(view), view.appendChild(msg('err', r.data.error === 'STANDBY' ? 'This server is on standby; the console works on the active server.' : errText(r)));
        var d = r.data, g = d.game, crit = d.alerts.filter(function (a) { return a.severity === 'critical'; }).length;
        clear(view);
        view.appendChild(h('div', { class: 'head2' }, h('h1', null, 'Overview'), h('span', { class: 'status ' + (d.alerts.length ? (crit ? 'bad' : 'warn') : 'ok') }, d.alerts.length ? d.alerts.length + ' alert' + (d.alerts.length === 1 ? '' : 's') : 'all systems normal'), h('span', { class: 'mute' }, 'role: ' + d.role + ', up ' + Math.round(d.uptime / 60) + ' min')));
        d.alerts.forEach(function (a) { view.appendChild(h('div', { class: 'alert ' + a.severity }, h('strong', null, a.name.replace(/_/g, ' ').toUpperCase() + ' '), a.message, h('span', { class: 'mute' }, '  (since ' + ago(a.since) + ')'))); });
        view.appendChild(h('div', { class: 'cards', style: 'margin-top:12px' }, card('Races', g.rounds.toLocaleString()), card('Bets', g.bets.toLocaleString()), card('Staked', money(g.staked)), card('Paid out', money(g.paid)), card('Gross gaming revenue', money(g.ggr)), card('Actual return', pct(g.rtpActual)),
          card('RTP setting', pct(g.rtpSetting)), card('Players online', g.sessions), card('Wins pending', g.pending.credits.count, g.pending.credits.count ? 'bad' : ''), card('Rollbacks pending', g.pending.rollbacks.count, g.pending.rollbacks.count ? 'bad' : ''), card('Ledger', g.ledger.ok ? 'intact' : 'BROKEN', g.ledger.ok ? 'ok' : 'bad'), card('Payouts vs odds', (g.rtpZ >= 0 ? '+' : '') + g.rtpZ.toFixed(1) + ' sd')));
        view.appendChild(h('h2', null, 'Return to player (RTP)'));
        view.appendChild(rtpPanel(d.rtp, g));
        view.appendChild(h('h2', null, 'Clients'));
        view.appendChild(clientsTable(d.clients, d.defaultClient ? d.defaultStats : null));
      }).catch(function () { /* offline */ });
    }
    view.appendChild(h('p', { class: 'mute' }, 'Loading...')); load(); S.timer = setInterval(load, 10000);
  }
  function rtpPanel(prev, g) {
    var box = h('div', { class: 'panel rtp' }), inp = h('input', { type: 'number', min: 88, max: 99, step: 0.1, value: (g.rtpSetting * 100).toFixed(1) }), out = h('div'), tbody = h('tbody');
    function drawRows(p) { clear(tbody); p.rows.forEach(function (x) { tbody.appendChild(h('tr', null, td('x' + x.odds), td((x.probability * 100).toFixed(2) + '%', 'right'), td((x.rtp * 100).toFixed(2) + '%', 'right ' + (x.cheap ? 'bad' : '')), td(x.cheap ? 'cheapest pair (absorbs the shortfall)' : ''))); }); }
    drawRows(prev);
    inp.addEventListener('input', function () { api('GET', 'rtp/preview?value=' + encodeURIComponent(inp.value)).then(function (r) { if (r.status === 200) drawRows(r.data); }); });
    box.appendChild(h('div', { class: 'bar' }, h('span', null, 'RTP setting (88% to 99%, applies from the next race; the odds never change, all clients share it)'), inp, can('admin') ? h('button', { class: 'primary', onclick: function () {
      api('POST', 'rtp', { rtp: Number(inp.value) }).then(function (r) { if (handleAuth(r)) return; out.replaceChildren(r.status === 200 ? msg('ok', 'RTP set to ' + (r.data.rtp * 100).toFixed(2) + ', from race ' + r.data.appliesFromRace + '.') : msg('err', errText(r))); });
    } }, 'Apply') : h('span', { class: 'mute' }, '(read only for your role)')));
    box.appendChild(out);
    box.appendChild(h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, [h('th', null, 'Odds'), h('th', { class: 'right' }, 'Win chance'), h('th', { class: 'right' }, 'Return of a bet'), h('th', null, '')])), tbody)));
    return box;
  }

  /* ---------- clients ---------- */
  function clientsTable(list, dflt) {
    var rows = list.map(function (c) {
      var s = c.stats || {}, w = c.walletHealth || {}, bad = w.calls >= 5 && w.failRate > 0.2;
      return h('tr', { class: 'click', onclick: function () { go('clients', c.id); } },
        td([h('strong', null, c.id), h('small', null, c.name)]), td(statusPill(c.status)), td(c.currency || '-'), td([c.wallet, h('small', null, c.webhook ? 'webhook on' : 'no webhook')]),
        td([(s.bets || 0).toLocaleString() + ' bets', h('small', null, 'staked ' + money(s.staked || 0) + ' / GGR ' + money(s.ggr || 0))]), td([(s.activeSessions || 0) + ' online', h('small', null, c.users + ' staff users')]),
        td([w.calls ? h('span', { class: bad ? 'bad' : 'ok' }, bad ? 'failing ' + Math.round(w.failRate * 100) + '%' : 'ok') : h('span', { class: 'mute' }, 'no calls'), h('small', null, 'API key used ' + ago(c.lastApiUse))]));
    });
    if (dflt) rows.push(h('tr', null, td([h('strong', null, 'default'), h('small', null, 'implicit: WALLET_* settings')]), td(statusPill('active')), td('-'), td('env wallet'), td([(dflt.bets || 0) + ' bets', h('small', null, 'staked ' + money(dflt.staked || 0))]), td((dflt.activeSessions || 0) + ' online'), td('')));
    if (!rows.length) return h('p', { class: 'mute' }, 'No clients yet.');
    return table([['Client'], ['Status'], ['Currency'], ['Wallet'], ['Business'], ['People'], ['Health']], rows);
  }
  function clients(view) {
    function load() {
      api('GET', 'overview').then(function (r) {
        if (handleAuth(r) || r.status !== 200) return; clear(view);
        view.appendChild(h('div', { class: 'head2' }, h('h1', null, 'Clients'), h('span', { class: 'mute' }, 'platforms that offer the game; all share one race and one RTP'), h('div', { class: 'sp' }, can('admin') ? h('button', { class: 'primary', onclick: newClient }, 'Add a client') : null)));
        view.appendChild(clientsTable(r.data.clients, r.data.defaultClient ? r.data.defaultStats : null));
      });
    }
    view.appendChild(h('p', { class: 'mute' }, 'Loading...')); S.refresh = load; load(); S.timer = setInterval(load, 15000);
  }
  function numField(name, label, hint) { return field(label, h('input', { name: name, inputmode: 'decimal', placeholder: 'default' }), hint); }
  function toMinor(v, d) { v = String(v || '').trim(); if (!v) return undefined; var n = Number(v.replace(/,/g, '')); if (!isFinite(n) || n < 0) throw new Error('"' + v + '" is not a valid amount'); return Math.round(n * Math.pow(10, d)); }
  function newClient() {
    var f = h('form'), out = h('div'), id = h('input', { name: 'id', required: true, pattern: '[a-z0-9][a-z0-9-]{1,31}', placeholder: 'acme' }), name = h('input', { name: 'name', placeholder: 'Acme Casino' }), cur = h('input', { name: 'currency', placeholder: 'PHP', maxlength: 5 }),
      url = h('input', { name: 'url', placeholder: 'https://platform.example/horse-api' }), secret = h('input', { name: 'secret', placeholder: 'leave empty to generate' }), hook = h('input', { name: 'hook', placeholder: 'https://platform.example/horse-events (optional)' }), mock = h('input', { type: 'checkbox', name: 'mock' });
    f.appendChild(out); f.appendChild(h('div', { class: 'fgrid' }, field('Client id', id, 'lower-case letters, digits and -'), field('Name', name), field('Currency', cur)));
    f.appendChild(field('Wallet URL', url, 'the platform\'s wallet API (https)')); f.appendChild(field('Wallet signing secret', secret, 'the platform uses it to verify our calls; generated and shown once when empty')); f.appendChild(field('Webhook URL', hook));
    f.appendChild(h('label', null, mock, ' play-money mock wallet (testing only; refused in production)'));
    f.appendChild(h('div', { style: 'margin-top:14px' }, h('button', { class: 'primary', type: 'submit' }, 'Create client')));
    var close = modal('Add a client', f);
    f.addEventListener('submit', function (ev) {
      ev.preventDefault(); var c = { id: id.value.trim(), name: name.value.trim() || undefined, currency: cur.value.trim().toUpperCase() || undefined, wallet: mock.checked ? { type: 'mock' } : { url: url.value.trim(), secret: secret.value.trim() || undefined } };
      if (hook.value.trim()) c.webhook = { url: hook.value.trim() };
      api('POST', 'clients', { client: c }).then(function (r) {
        if (handleAuth(r)) return; if (r.status !== 200) return out.replaceChildren(msg('err', errText(r)));
        var lines = [['API key:', r.data.apiKey]]; if (r.data.walletSecret) lines.push(['Wallet signing secret:', r.data.walletSecret]);
        if (S.refresh) S.refresh();
        clear(f); f.appendChild(msg('ok', 'Client ' + r.data.client.id + ' created.')); f.appendChild(secretBox('Give these to the client', lines));
        f.appendChild(h('p', { class: 'mute' }, 'Next: open the client, set its limits, and add its first back-office administrator.')); f.appendChild(h('button', { class: 'primary', onclick: function () { close(); go('clients', r.data.client.id); } }, 'Open the client'));
      });
    });
  }

  function clientDetail(view, id) {
    var out = h('div'), body = h('div');
    function load(keepOut) {
      api('GET', 'clients/' + id).then(function (r) {
        if (handleAuth(r)) return; if (r.status !== 200) { clear(view); view.appendChild(msg('err', errText(r))); return view.appendChild(h('button', { onclick: function () { go('clients'); } }, 'Back to clients')); }
        draw(r.data);
      });
    }
    function act(path, payload, okText, after) { return api('POST', 'clients/' + id + path, payload || {}).then(function (r) { if (handleAuth(r)) return; if (r.status === 200) { if (after) after(r.data); else out.replaceChildren(msg('ok', okText || 'Done.')); load(); } else out.replaceChildren(msg('err', errText(r))); }); }
    function draw(d) {
      var c = d.client, rep = d.report, dec = (c.limits && c.limits.decimals != null) ? c.limits.decimals : 2, lim = c.limits || {}, wh = d.walletHealth;
      clear(body);
      body.appendChild(h('div', { class: 'crumb' }, h('a', { onclick: function () { go('clients'); } }, 'Clients'), ' / ' + c.id));
      body.appendChild(h('div', { class: 'head2' }, h('h1', null, c.name || c.id), statusPill(c.status), h('span', { class: 'mute' }, c.id + ' - created ' + when(c.createdAt)), h('div', { class: 'sp' },
        can('support') ? h('button', { class: c.status === 'active' ? 'danger' : 'primary', onclick: function () { if (c.status === 'active' && !confirm('Suspend ' + c.id + '? Its sessions end now and launches and its API key stop working.')) return; act('/status', { status: c.status === 'active' ? 'disabled' : 'active' }, c.status === 'active' ? 'Client suspended.' : 'Client enabled.'); } }, c.status === 'active' ? 'Suspend' : 'Enable') : null,
        can('admin') ? h('button', { class: 'danger', onclick: function () { var t = prompt('Delete ' + c.id + ' for good? Its history stays in the ledger. Type the client id to confirm:'); if (t === c.id) api('POST', 'clients/' + id + '/delete', { confirm: t }).then(function (r) { if (r.status === 200) go('clients'); else out.replaceChildren(msg('err', errText(r))); }); } }, 'Delete') : null)));
      body.appendChild(out);
      body.appendChild(h('div', { class: 'cards' }, card('Bets', rep.bets.toLocaleString()), card('Staked', money(rep.staked, dec)), card('Paid out', money(rep.paid, dec)), card('GGR', money(rep.ggr, dec)), card('Return', pct(rep.rtp)), card('Players online', rep.activeSessions), card('Wins pending', rep.pendingCredits, rep.pendingCredits ? 'bad' : ''), card('Blocked players', rep.blockedPlayers)));

      /* settings + wallet + webhook */
      var two = h('div', { class: 'two' }); body.appendChild(two);
      var sf = h('form', { class: 'panel' }), E = function (n, v, extra) { return h('input', Object.assign({ name: n, value: v == null ? '' : v }, extra)); };
      var f = { name: E('name', c.name), currency: E('currency', c.currency, { maxlength: 5 }), minBet: E('minBet', lim.minBet != null ? money(lim.minBet, dec).replace(/,/g, '') : '', { placeholder: 'default' }), maxBet: E('maxBet', lim.maxBet != null ? money(lim.maxBet, dec).replace(/,/g, '') : '', { placeholder: 'default' }),
        maxRound: E('maxRound', lim.maxRoundStake != null ? money(lim.maxRoundStake, dec).replace(/,/g, '') : '', { placeholder: 'default' }), daily: E('daily', lim.dailyLossLimit ? money(lim.dailyLossLimit, dec).replace(/,/g, '') : '', { placeholder: 'none' }),
        reality: E('reality', c.realityCheckMinutes != null ? c.realityCheckMinutes : '', { placeholder: 'off' }), bigWin: E('bigWin', c.bigWinMin ? money(c.bigWinMin, dec).replace(/,/g, '') : '', { placeholder: 'default' }),
        ips: h('textarea', { name: 'ips', placeholder: 'any address' }, (c.allowedIps || []).join('\n')), hosts: h('textarea', { name: 'hosts', placeholder: 'any' }, (c.returnUrlHosts || []).join('\n')) };
      sf.appendChild(h('h3', null, 'Settings')); sf.appendChild(h('div', { class: 'sub' }, 'Amounts in ' + (c.currency || 'the client currency') + ' (not minor units). Empty = use the server default.'));
      sf.appendChild(h('div', { class: 'fgrid' }, field('Name', f.name), field('Currency', f.currency), field('Min bet', f.minBet), field('Max bet per pair', f.maxBet), field('Max stake per race', f.maxRound), field('Daily loss limit', f.daily), field('Reality check (minutes)', f.reality), field('Big win from', f.bigWin)));
      sf.appendChild(field('Allowed addresses for the client API (one per line: IP or CIDR)', f.ips)); sf.appendChild(field('Hosts allowed in the "back to lobby" link', f.hosts));
      if (can('admin')) sf.appendChild(h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Save settings')));
      sf.addEventListener('submit', function (ev) {
        ev.preventDefault(); if (!can('admin')) return;
        try {
          var limits = Object.assign({}, lim); ['minBet', 'maxBet', 'maxRoundStake', 'dailyLossLimit'].forEach(function (k) { delete limits[k]; });
          var m = { minBet: toMinor(f.minBet.value, dec), maxBet: toMinor(f.maxBet.value, dec), maxRoundStake: toMinor(f.maxRound.value, dec) }; Object.keys(m).forEach(function (k) { if (m[k]) limits[k] = m[k]; });
          var dl = toMinor(f.daily.value, dec); if (dl) limits.dailyLossLimit = dl;
          var patch = { name: f.name.value.trim(), limits: limits, allowedIps: f.ips.value.split(/[\s,]+/).filter(Boolean), returnUrlHosts: f.hosts.value.split(/[\s,]+/).filter(Boolean), realityCheckMinutes: f.reality.value.trim() === '' ? 0 : Number(f.reality.value), bigWinMin: toMinor(f.bigWin.value, dec) };
          if (f.currency.value.trim()) patch.currency = f.currency.value.trim().toUpperCase();
          if (!patch.bigWinMin) delete patch.bigWinMin;
          act('', patch, 'Settings saved.');
        } catch (e) { out.replaceChildren(msg('err', e.message)); }
      });
      two.appendChild(sf);

      var side = h('div'); two.appendChild(side);
      var wf = h('form', { class: 'panel' }), wurl = E('wurl', c.wallet.url || '', { placeholder: 'https://' }), wkey = E('wkey', c.wallet.keyId || ''), wauth = h('select', { name: 'wauth' }, ['hmac', 'bearer'].map(function (x) { return h('option', { value: x, selected: (c.wallet.auth || 'hmac') === x }, x); }));
      wf.appendChild(h('h3', null, 'Wallet')); wf.appendChild(h('div', { class: 'sub' }, c.wallet.type === 'mock' ? 'Play-money mock wallet (testing).' : 'Where the game calls the platform\'s wallet. Calls are signed with the secret ' + (c.wallet.secret || '') + '.'));
      if (c.wallet.type !== 'mock') {
        wf.appendChild(field('Wallet URL', wurl)); wf.appendChild(h('div', { class: 'fgrid' }, field('Key id (sent as X-Key-Id)', wkey), field('Signing', wauth)));
        wf.appendChild(h('p', { class: wh.calls >= 5 && wh.failRate > 0.2 ? 'bad' : 'mute' }, 'Last 5 minutes: ' + wh.calls + ' calls, ' + Math.round(wh.failRate * 100) + '% failed, p95 ' + Math.round(wh.p95) + ' ms'));
        if (can('admin')) wf.appendChild(h('div', { class: 'bar' }, h('button', { class: 'primary', type: 'submit' }, 'Save wallet'), h('button', { type: 'button', class: 'danger', onclick: function () { if (confirm('Create a new signing secret? The platform must switch to it at the same moment, or its calls will be rejected.')) act('/rotate-wallet-secret', {}, '', function (r) { out.replaceChildren(secretBox('New wallet signing secret for ' + id, [['Secret:', r.walletSecret]])); }); } }, 'New signing secret')));
        wf.addEventListener('submit', function (ev) { ev.preventDefault(); act('', { wallet: { url: wurl.value.trim(), keyId: wkey.value.trim(), auth: wauth.value } }, 'Wallet saved.'); });
      }
      side.appendChild(wf);
      var hf = h('form', { class: 'panel' }), hurl = E('hurl', c.webhook ? c.webhook.url : '', { placeholder: 'https://platform.example/horse-events' }), hev = E('hev', c.webhook ? c.webhook.events : 'round.settled,big.win');
      hf.appendChild(h('h3', null, 'Webhook')); hf.appendChild(h('div', { class: 'sub' }, 'Results (round.settled) and big wins (big.win) are posted here, signed.')); hf.appendChild(field('URL (empty removes the webhook)', hurl)); hf.appendChild(field('Events', hev));
      if (can('admin')) hf.appendChild(h('div', { class: 'bar' }, h('button', { class: 'primary', type: 'submit' }, 'Save webhook'), c.webhook ? h('button', { type: 'button', class: 'danger', onclick: function () { if (confirm('Create a new webhook secret?')) act('/rotate-webhook-secret', {}, '', function (r) { out.replaceChildren(secretBox('New webhook secret for ' + id, [['Secret:', r.webhookSecret]])); }); } }, 'New secret') : null));
      hf.addEventListener('submit', function (ev) { ev.preventDefault(); act('', { webhook: hurl.value.trim() ? { url: hurl.value.trim(), events: hev.value.trim() || undefined } : null }, 'Webhook saved.'); });
      side.appendChild(hf);

      /* API keys */
      body.appendChild(h('h2', null, 'API keys'));
      var kp = h('div', { class: 'panel' }); body.appendChild(kp);
      kp.appendChild(h('p', { class: 'mute' }, 'The client sends a key as "Authorization: Bearer ..." to /api/client/... Only a hash is stored: keys cannot be shown again. Last use is when the key was last accepted.'));
      kp.appendChild(table([['Key'], ['Created'], ['Last used'], ['Expires'], ['']], c.apiKeys.map(function (k) { return h('tr', null, td(k.id), td(when(k.createdAt), 'nowrap'), td(k.lastUsedAt ? ago(k.lastUsedAt) : 'never'), td(k.expiresAt ? when(k.expiresAt) : 'no expiry', 'nowrap'), td(can('admin') ? h('button', { class: 'danger', onclick: function () { if (confirm('Revoke key ' + k.id + ' now?')) act('/revoke-key', { keyId: k.id }, 'Key revoked.'); } }, 'Revoke') : '')); })));
      if (can('admin')) { var gr = h('input', { type: 'number', min: 0, max: 168, value: 24, style: 'max-width:90px' }); kp.appendChild(h('div', { class: 'bar', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: function () { act('/rotate-key', { graceHours: Number(gr.value) }, '', function (r) { out.replaceChildren(secretBox('New API key for ' + id, [['Key:', r.apiKey]])); }); } }, 'Create a new key'), h('span', { class: 'mute' }, 'older keys keep working for'), gr, h('span', { class: 'mute' }, 'hours (0 = revoke them now)'))); }

      /* back-office users of the client */
      body.appendChild(h('h2', null, 'Back-office users of ' + (c.name || c.id) + ' (/backoffice)'));
      var up = h('div', { class: 'panel' }); body.appendChild(up);
      up.appendChild(d.users.length ? table([['User'], ['Role'], ['Status'], ['2-step'], ['Last sign-in'], ['']], d.users.map(function (u) {
        var a = h('div', { class: 'bar', style: 'margin:0' });
        if (can('support')) { a.appendChild(h('button', { onclick: function () { if (confirm('Reset the password of ' + u.username + '? They get a temporary one and are signed out.')) api('POST', 'clients/' + id + '/users/' + u.username + '/reset-password', {}).then(function (r) { out.replaceChildren(r.status === 200 ? secretBox('New temporary password for ' + u.username, [['Password:', r.data.tempPassword]]) : msg('err', errText(r))); }); } }, 'Reset password')); a.appendChild(h('button', { onclick: function () { act('/users/' + u.username + '/status', { status: u.status === 'active' ? 'disabled' : 'active' }, 'Done.'); } }, u.status === 'active' ? 'Disable' : 'Enable')); }
        if (can('admin')) a.appendChild(h('button', { class: 'danger', onclick: function () { if (confirm('Delete the user ' + u.username + '?')) act('/users/' + u.username + '/delete', {}, 'User deleted.'); } }, 'Delete'));
        return h('tr', null, td(u.username), td(u.role), td(statusPill(u.status === 'active' ? 'active' : 'disabled')), td(u.totp ? 'on' : 'off'), td(when(u.lastLoginAt), 'nowrap'), td(a));
      })) : h('p', { class: 'mute' }, 'No users yet. Add the first administrator below; they get a temporary password and choose their own at the first sign-in.'));
      if (can('admin')) {
        var un = h('input', { placeholder: 'username' }), ur = h('select', null, ['admin', 'support', 'viewer'].map(function (x) { return h('option', { value: x }, x); }));
        up.appendChild(h('div', { class: 'bar', style: 'margin-top:10px' }, un, ur, h('button', { class: 'primary', onclick: function () { act('/users', { username: un.value.trim(), role: ur.value }, '', function (r) { out.replaceChildren(secretBox('User ' + r.user.username + ' created', [['Temporary password:', r.tempPassword]])); }); } }, 'Add user')));
      }

      /* activity */
      body.appendChild(h('h2', null, 'Recent races')); body.appendChild(d.rounds.length ? table([['Race'], ['Time'], ['Winning pair'], ['Players', 'right'], ['Bets', 'right'], ['Staked', 'right'], ['Paid', 'right']], d.rounds.map(function (r) { return h('tr', null, td(r.raceNo), td(when(r.at), 'nowrap'), td(r.combo + ' (x' + r.odds + ')'), td(r.players, 'right'), td(r.bets, 'right'), td(money(r.staked, dec), 'right'), td(money(r.paid, dec), 'right')); })) : h('p', { class: 'mute' }, 'No races with this client\'s players yet.'));
      body.appendChild(h('h2', null, 'Recent activity in its back office')); body.appendChild(d.audit.length ? table([['Time'], ['User'], ['Action'], ['Target'], ['Detail']], d.audit.map(function (e) { return h('tr', null, td(when(e.at), 'nowrap'), td(e.user || '-'), td(e.action), td(e.target || ''), td(e.detail || '')); })) : h('p', { class: 'mute' }, 'Nothing yet.'));
    }
    view.appendChild(body); load();
  }

  /* ---------- staff (admin) ---------- */
  function staff(view) {
    var out = h('div'), list = h('div');
    function load() {
      api('GET', 'users').then(function (r) {
        if (handleAuth(r)) return; clear(list);
        list.appendChild(table([['Staff account'], ['Role'], ['Status'], ['2-step'], ['Last sign-in'], ['']], r.data.users.map(function (u) {
          var self = u.username === S.me.username, role = h('select', { disabled: self }, ['viewer', 'support', 'admin'].map(function (x) { return h('option', { value: x, selected: x === u.role }, x); }));
          role.addEventListener('change', function () { api('POST', 'users/' + u.username + '/role', { role: role.value }).then(function (r2) { out.replaceChildren(r2.status === 200 ? msg('ok', 'Role of ' + u.username + ' is now ' + role.value + '.') : msg('err', errText(r2))); load(); }); });
          var a = h('div', { class: 'bar', style: 'margin:0' });
          if (!self) {
            a.appendChild(h('button', { onclick: function () { if (confirm('Reset the password of ' + u.username + '?')) api('POST', 'users/' + u.username + '/reset-password', {}).then(function (r2) { out.replaceChildren(r2.status === 200 ? secretBox('New temporary password for ' + u.username, [['Password:', r2.data.tempPassword]]) : msg('err', errText(r2))); }); } }, 'Reset password'));
            a.appendChild(h('button', { onclick: function () { api('POST', 'users/' + u.username + '/status', { status: u.status === 'active' ? 'disabled' : 'active' }).then(function (r2) { if (r2.status !== 200) out.replaceChildren(msg('err', errText(r2))); load(); }); } }, u.status === 'active' ? 'Disable' : 'Enable'));
            a.appendChild(h('button', { class: 'danger', onclick: function () { if (confirm('Delete ' + u.username + '?')) api('POST', 'users/' + u.username + '/delete', {}).then(function (r2) { if (r2.status !== 200) out.replaceChildren(msg('err', errText(r2))); load(); }); } }, 'Delete'));
          }
          return h('tr', null, td(u.username + (self ? ' (you)' : '')), td(role), td(statusPill(u.status === 'active' ? 'active' : 'disabled')), td(u.totp ? 'on' : 'off'), td(when(u.lastLoginAt), 'nowrap'), td(a));
        })));
      });
    }
    var name = h('input', { placeholder: 'username' }), role = h('select', null, ['viewer', 'support', 'admin'].map(function (x) { return h('option', { value: x }, x); }));
    var form = h('form', { class: 'panel' }, h('strong', null, 'Add a staff account'), h('div', { class: 'two' }, field('Username', name), field('Role', role)),
      h('p', { class: 'mute' }, 'viewer: read only. support: also suspends clients and handles their back-office users. admin: everything, including clients, keys, RTP and staff.'), h('button', { class: 'primary', type: 'submit' }, 'Create account'));
    form.addEventListener('submit', function (ev) { ev.preventDefault(); api('POST', 'users', { username: name.value.trim(), role: role.value }).then(function (r) { if (r.status === 200) { name.value = ''; out.replaceChildren(secretBox('Account ' + r.data.user.username + ' created', [['Temporary password:', r.data.tempPassword]])); load(); } else out.replaceChildren(msg('err', errText(r))); }); });
    view.appendChild(h('h2', null, 'Staff accounts of the game operator')); view.appendChild(out); view.appendChild(list); view.appendChild(form); load();
  }

  /* ---------- security ---------- */
  function security(view) {
    var out = h('div'), cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    var pw = h('form', { class: 'panel' }, h('strong', null, 'Change password'), h('label', null, 'Current password'), cur, h('label', null, 'New password (12 characters or more)'), n1, h('label', null, 'New password again'), n2, h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Change password')));
    pw.addEventListener('submit', function (ev) { ev.preventDefault(); if (n1.value !== n2.value) return out.replaceChildren(msg('err', 'The two new passwords are not the same.')); api('POST', 'password', { current: cur.value, next: n1.value }).then(function (r) { if (handleAuth(r)) return; out.replaceChildren(r.status === 200 ? msg('ok', 'Password changed. Your other sessions were signed out.') : msg('err', errText(r))); if (r.status === 200) cur.value = n1.value = n2.value = ''; }); });
    var two = h('div', { class: 'panel' });
    function drawTwo() {
      clear(two); two.appendChild(h('strong', null, 'Two-step sign-in'));
      if (S.me.totp) {
        var p = h('input', { type: 'password', placeholder: 'Your password' });
        two.appendChild(h('p', { class: 'ok' }, 'On. A code from your authenticator app is needed at every sign-in.')); two.appendChild(p);
        two.appendChild(h('div', { style: 'margin-top:10px' }, h('button', { class: 'danger', onclick: function () { api('POST', 'totp/disable', { password: p.value }).then(function (r) { if (r.status === 200) { S.me.totp = false; drawTwo(); } else out.replaceChildren(msg('err', errText(r))); }); } }, 'Turn off')));
      } else {
        two.appendChild(h('p', { class: 'mute' }, 'Strongly recommended for every operator account: this console can create clients, keys and change the RTP.'));
        two.appendChild(h('button', { onclick: function () {
          api('POST', 'totp/setup', {}).then(function (r) {
            if (r.status !== 200) return out.replaceChildren(msg('err', errText(r)));
            var code = h('input', { placeholder: '6-digit code', inputmode: 'numeric', maxlength: 7 }); clear(two); two.appendChild(h('strong', null, 'Set up two-step sign-in'));
            two.appendChild(h('p', null, 'In your authenticator app add an account manually (time based) with this key:')); two.appendChild(h('div', { class: 'secret' }, h('code', { class: 'mono' }, r.data.secret.replace(/(.{4})/g, '$1 ').trim())));
            two.appendChild(h('label', null, 'Then enter the code the app shows')); two.appendChild(code);
            two.appendChild(h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: function () { api('POST', 'totp/enable', { otp: code.value }).then(function (r2) { if (r2.status === 200) { S.me.totp = true; drawTwo(); out.replaceChildren(msg('ok', 'Two-step sign-in is on.')); } else out.replaceChildren(msg('err', errText(r2))); }); } }, 'Turn on')));
          });
        } }, 'Set up'));
      }
    }
    drawTwo(); view.appendChild(h('h2', null, 'Security')); view.appendChild(out); view.appendChild(h('div', { class: 'two' }, pw, two));
  }

  /* ---------- audit (admin) ---------- */
  function audit(view) {
    api('GET', 'audit?limit=400').then(function (r) {
      if (handleAuth(r)) return; clear(view); view.appendChild(h('h2', null, 'Audit log of the operator console'));
      view.appendChild(h('p', { class: 'mute' }, 'Every sign-in and change made here: clients, keys, secrets, RTP, staff. The same entries are in the tamper-evident ledger.'));
      view.appendChild(table([['Time'], ['User'], ['Action'], ['Target'], ['Detail'], ['Address']], r.data.entries.map(function (e) { return h('tr', null, td(when(e.at), 'nowrap'), td(e.user || '-'), td(e.action), td(e.target || ''), td(e.detail || ''), td(e.ip || '')); })));
    });
  }

  api('GET', 'me').then(function (r) { if (r.status === 200) boot(r.data); else showLogin(r.data && r.data.error === 'STANDBY' ? 'The game server is starting. Try again in a moment.' : ''); }).catch(function () { showLogin('Cannot reach the server.'); });
})();
