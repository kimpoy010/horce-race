/*
 * Client back office. Talks to /bo/api/* (see server/backoffice.js). All data is put on the page with textContent / DOM nodes, never as HTML.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var S = { me: null, csrf: '', tab: 'dashboard', client: null, timer: null };
  var RANK = { viewer: 1, support: 2, admin: 3 };

  /* ---------- tiny helpers ---------- */
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
    return fetch('/bo/api/' + path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function dec() { var c = S.client; return c && c.limits && c.limits.decimals != null ? c.limits.decimals : 2; }
  function money(m, cur) { var d = dec(); return (cur ? cur + ' ' : '') + (m / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function when(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }
  function pct(x) { return x == null ? '-' : (x * 100).toFixed(2) + '%'; }
  function pair(c) { return c || '-'; }
  function msg(kind, text) { return h('div', { class: kind === 'err' ? 'err' : 'note' }, text); }
  function card(k, v) { return h('div', { class: 'card' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)); }
  function table(head, rows, opts) {
    var tb = h('tbody'); rows.forEach(function (r) { tb.appendChild(r); });
    return h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, head.map(function (x) { return h('th', { class: x[1] || '' }, x[0]); }))), tb));
  }
  function td(v, cls) { return h('td', { class: cls || '' }, v); }
  function errText(r, fallback) { return (r.data && (r.data.message || r.data.error)) || fallback || 'Something went wrong.'; }
  function confirmBox(text) { return window.confirm(text); }

  /* ---------- login ---------- */
  function showLogin(note, needOtp, keep) {
    stopTimer(); S.me = null; clear(app);
    var client = h('input', { id: 'lc', autocomplete: 'organization', value: (keep && keep.client) || localStorage.getItem('bo.client') || '', required: true }),
      user = h('input', { id: 'lu', autocomplete: 'username', value: (keep && keep.user) || '', required: true }),
      pass = h('input', { id: 'lp', type: 'password', autocomplete: 'current-password', required: true }),
      otp = h('input', { id: 'lo', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, placeholder: '123456' }),
      box = h('div', { class: 'login' }), form = h('form');
    form.appendChild(h('h1', null, 'Back office')); form.appendChild(h('p', null, 'Horse Race - sign in to manage your players and reports.'));
    if (note) form.appendChild(msg('err', note));
    form.appendChild(h('label', null, 'Client id')); form.appendChild(client);
    form.appendChild(h('label', null, 'Username')); form.appendChild(user);
    form.appendChild(h('label', null, 'Password')); form.appendChild(pass);
    if (needOtp) { form.appendChild(h('label', null, 'Authenticator code')); form.appendChild(otp); }
    form.appendChild(h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      api('POST', 'login', { client: client.value.trim(), username: user.value.trim(), password: pass.value, otp: otp.value.trim() }).then(function (r) {
        if (r.status === 200) { localStorage.setItem('bo.client', client.value.trim().toLowerCase()); boot(r.data); }
        else if (r.data.error === 'OTP_REQUIRED') showLogin('', true, { client: client.value, user: user.value });
        else showLogin(errText(r, 'Sign in failed.'), needOtp, { client: client.value, user: user.value });
      }).catch(function () { showLogin('Cannot reach the server.', needOtp); });
    });
    box.appendChild(form); app.appendChild(box); (user.value ? pass : client.value ? user : client).focus();
  }

  function boot(me) {
    S.me = me.user; S.me.role = me.role; S.csrf = me.csrf; S.clientId = me.client; S.idle = me.idleMinutes;
    api('GET', 'client').then(function (r) { S.client = r.data.client || { id: S.clientId, name: S.clientId }; if (S.me.mustChange) forceChange(); else shell(); });
  }

  function forceChange() {
    clear(app);
    var cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' }), out = h('div'), form = h('form');
    form.appendChild(h('h1', null, 'Choose a new password')); form.appendChild(h('p', null, 'You signed in with a temporary password. Choose your own (at least 12 characters).')); form.appendChild(out);
    form.appendChild(h('label', null, 'Temporary password')); form.appendChild(cur); form.appendChild(h('label', null, 'New password')); form.appendChild(n1); form.appendChild(h('label', null, 'New password again')); form.appendChild(n2);
    form.appendChild(h('button', { class: 'primary', type: 'submit' }, 'Save and continue'));
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); clear(out); if (n1.value !== n2.value) return out.appendChild(msg('err', 'The two new passwords are not the same.'));
      api('POST', 'password', { current: cur.value, next: n1.value }).then(function (r) { if (r.status === 200) { S.me.mustChange = false; api('GET', 'client').then(function (r2) { if (r2.data && r2.data.client) S.client = r2.data.client; shell(); }); } else out.appendChild(msg('err', errText(r))); });
    });
    app.appendChild(h('div', { class: 'login' }, form));
  }

  /* ---------- shell ---------- */
  function stopTimer() { if (S.timer) { clearInterval(S.timer); S.timer = null; } }
  function logout() { api('POST', 'logout', {}).then(function () { showLogin(); }); }
  function handleAuth(r) { if (r.status === 401) { showLogin(r.data.error === 'SESSION_EXPIRED' ? 'Your session expired. Please sign in again.' : ''); return true; } return false; }

  function shell() {
    stopTimer(); clear(app);
    var tabs = [['dashboard', 'Dashboard'], ['players', 'Players'], ['rounds', 'Rounds']];
    if (can('admin')) tabs.push(['users', 'Users']);
    tabs.push(['security', 'Security']); if (can('admin')) tabs.push(['audit', 'Audit log']);
    var nav = h('nav', { class: 'tabs' }), view = h('main');
    tabs.forEach(function (t) { nav.appendChild(h('button', { class: S.tab === t[0] ? 'on' : '', onclick: function () { S.tab = t[0]; shell(); } }, t[1])); });
    app.appendChild(h('header', { class: 'top' }, h('span', { class: 'brand' }, 'HORSE RACE BACK OFFICE'), h('strong', null, S.client.name || S.clientId),
      h('span', { class: 'who' }, S.me.username, h('span', { class: 'role' }, S.me.role), ' ', h('button', { onclick: logout }, 'Sign out'))));
    app.appendChild(nav); app.appendChild(view);
    var views = { dashboard: dashboard, players: players, rounds: rounds, users: users, security: security, audit: audit };
    (views[S.tab] || dashboard)(view);
  }

  /* ---------- dashboard ---------- */
  function sparkline(rs) {
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), W = 600, H = 64, data = rs.slice().reverse().map(function (r) { return r.staked - r.paid; });
    svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H); svg.setAttribute('preserveAspectRatio', 'none');
    var max = Math.max.apply(null, data.map(Math.abs).concat([1])), bw = W / Math.max(data.length, 1);
    data.forEach(function (v, i) {
      var r = document.createElementNS(NS, 'rect'), hh = Math.max(1, Math.abs(v) / max * (H / 2 - 4));
      r.setAttribute('x', i * bw + 1); r.setAttribute('width', Math.max(1, bw - 2)); r.setAttribute('height', hh); r.setAttribute('y', v >= 0 ? H / 2 - hh : H / 2); r.setAttribute('fill', v >= 0 ? '#5ee08a' : '#ff7b7b'); svg.appendChild(r);
    });
    var ln = document.createElementNS(NS, 'line'); ln.setAttribute('x1', 0); ln.setAttribute('x2', W); ln.setAttribute('y1', H / 2); ln.setAttribute('y2', H / 2); ln.setAttribute('stroke', '#27324a'); svg.appendChild(ln);
    return svg;
  }
  function dashboard(view) {
    function load() {
      api('GET', 'report').then(function (r) {
        if (handleAuth(r)) return; if (r.status !== 200) return;
        var d = r.data, cur = Object.keys(d.byCurrency || {}), c1 = cur.length === 1 ? cur[0] : (S.client.currency || '');
        clear(view);
        view.appendChild(h('h2', null, 'Overview (since the game server started recording)'));
        view.appendChild(h('div', { class: 'cards' }, card('Bets', d.bets.toLocaleString()), card('Staked', money(d.staked, c1)), card('Paid out', money(d.paid, c1)), card('Gross gaming revenue', money(d.ggr, c1)),
          card('Return to players', pct(d.rtp)), card('Players online', d.activeSessions), card('Wins / refunds pending', d.pendingCredits + (d.pendingRollbacks ? ' + ' + d.pendingRollbacks + ' rollbacks' : '')), card('Blocked players', d.blockedPlayers)));
        if (cur.length > 1) view.appendChild(h('div', { class: 'panel' }, h('strong', null, 'By currency'), table([['Currency'], ['Staked', 'right'], ['Paid', 'right'], ['GGR', 'right']], cur.map(function (c) { var x = d.byCurrency[c]; return h('tr', null, td(c), td(money(x.staked), 'right'), td(money(x.paid), 'right'), td(money(x.staked - x.paid), 'right')); }))));
        view.appendChild(h('h2', null, 'Last races with your bets (gross gaming revenue per race)'));
        if (d.rounds.length) { view.appendChild(sparkline(d.rounds)); view.appendChild(roundsTable(d.rounds, c1)); } else view.appendChild(h('p', { class: 'mute' }, 'No settled races with your players yet.'));
      }).catch(function () { /* offline: keep what is shown */ });
    }
    view.appendChild(h('p', { class: 'mute' }, 'Loading...')); load(); S.timer = setInterval(load, 10000);
  }
  function roundsTable(list, cur) {
    return table([['Race'], ['Time'], ['Winning pair'], ['Odds', 'right'], ['Players', 'right'], ['Bets', 'right'], ['Staked', 'right'], ['Paid', 'right'], ['GGR', 'right'], ['Proof']], list.map(function (r) {
      return h('tr', null, td(r.raceNo), td(when(r.at), 'nowrap'), td(pair(r.combo)), td('x' + r.odds, 'right'), td(r.players, 'right'), td(r.bets, 'right'), td(money(r.staked, cur), 'right'), td(money(r.paid, cur), 'right'),
        td(money(r.staked - r.paid, cur), 'right ' + (r.staked - r.paid >= 0 ? 'ok' : 'bad')), td(h('a', { href: '/api/round/' + r.raceNo, target: '_blank', rel: 'noopener' }, 'draw proof')));
    }));
  }
  function rounds(view) {
    api('GET', 'rounds?limit=200').then(function (r) {
      if (handleAuth(r)) return; clear(view);
      view.appendChild(h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'Races'), h('a', { href: '/bo/api/export/rounds.csv', download: 'rounds.csv' }, 'Download CSV')));
      view.appendChild(r.data.rounds.length ? roundsTable(r.data.rounds, S.client.currency || '') : h('p', { class: 'mute' }, 'No races yet.'));
      view.appendChild(h('p', { class: 'mute' }, 'The draw proof of a race shows the commit made before betting closed and the seed revealed afterwards, so the result can be checked independently.'));
    });
  }

  /* ---------- players ---------- */
  function players(view) {
    var q = h('input', { placeholder: 'Search player id', type: 'search' }), box = h('div'), t = null;
    function load() {
      api('GET', 'players?limit=200&query=' + encodeURIComponent(q.value.trim())).then(function (r) {
        if (handleAuth(r)) return; clear(box); var d = r.data;
        if (!d.players.length) return box.appendChild(h('p', { class: 'mute' }, 'No players found.'));
        box.appendChild(h('p', { class: 'mute' }, d.total + ' player' + (d.total === 1 ? '' : 's') + (d.total > d.players.length ? ' (showing ' + d.players.length + ')' : '')));
        box.appendChild(table([['Player'], ['Bets', 'right'], ['Staked', 'right'], ['Paid', 'right'], ['Player net', 'right'], ['Last bet'], ['Status']], d.players.map(function (p) {
          var tr = h('tr', { class: 'click', onclick: function () { playerDetail(p.playerId); } }, td(p.playerId), td(p.bets, 'right'), td(money(p.staked), 'right'), td(money(p.paid), 'right'), td(money(p.paid - p.staked), 'right ' + (p.paid - p.staked >= 0 ? 'ok' : 'bad')), td(when(p.lastBetAt), 'nowrap'),
            td([p.online ? h('span', { class: 'pill on' }, 'online') : null, p.blocked ? h('span', { class: 'pill off' }, 'blocked') : null]));
          return tr;
        })));
      });
    }
    q.addEventListener('input', function () { clearTimeout(t); t = setTimeout(load, 250); });
    view.appendChild(h('div', { class: 'bar' }, h('h2', { style: 'margin:0' }, 'Players'), q, h('a', { href: '/bo/api/export/players.csv', download: 'players.csv' }, 'Download CSV')));
    view.appendChild(box); load();
  }
  function modal(title, body) {
    var m = h('div', { class: 'modal', onclick: function (e) { if (e.target === m) close(); } }), box = h('div', { class: 'box' });
    function close() { if (m.parentNode) m.parentNode.removeChild(m); }
    box.appendChild(h('div', { class: 'head' }, h('h2', { style: 'margin:0' }, title), h('button', { onclick: close }, 'Close'))); box.appendChild(body); m.appendChild(box); document.body.appendChild(m); return close;
  }
  function playerDetail(id) {
    api('GET', 'players/' + encodeURIComponent(id)).then(function (r) {
      if (handleAuth(r)) return; if (r.status !== 200) return; var d = r.data, body = h('div'), close;
      body.appendChild(h('div', { class: 'cards' }, card('Bets', d.totals.bets), card('Staked', money(d.totals.staked)), card('Paid', money(d.totals.paid)), card('Daily net loss', money(d.dailyNetLoss)), card('Sessions open', d.sessions.length), card('Status', d.blocked ? 'blocked' : 'active')));
      if (can('support')) {
        var reason = h('input', { placeholder: 'Reason (kept in the audit log)' }), out = h('div');
        function act(path, ok) { api('POST', 'players/' + encodeURIComponent(id) + '/' + path, { reason: reason.value }).then(function (r2) { if (handleAuth(r2)) return; out.replaceChildren(msg(r2.status === 200 ? 'ok' : 'err', r2.status === 200 ? ok : errText(r2))); if (r2.status === 200) setTimeout(function () { close(); playerDetail(id); }, 700); }); }
        body.appendChild(h('div', { class: 'panel' }, h('strong', null, 'Player controls'), h('label', null, 'Reason'), reason,
          h('div', { class: 'bar', style: 'margin-top:10px' }, d.blocked ? h('button', { onclick: function () { act('unblock', 'Player unblocked.'); } }, 'Unblock') : h('button', { class: 'danger', onclick: function () { if (confirmBox('Block ' + id + '? Their sessions end now and they cannot start the game.')) act('block', 'Player blocked and logged out.'); } }, 'Block (self-exclusion)'),
            h('button', { onclick: function () { act('close-sessions', 'Sessions closed.'); } }, 'Close sessions')), out));
      }
      body.appendChild(h('h2', null, 'Recent races'));
      var rows = []; d.rounds.forEach(function (rd) { rd.bets.forEach(function (b) { rows.push(h('tr', null, td(rd.raceNo), td(b.combo), td('x' + b.odds, 'right'), td(money(b.stake, b.currency), 'right'), td(h('span', { class: 'pill ' + b.status }, b.status)), td(money(b.payout || 0, b.currency), 'right'), td(when(b.placedAt), 'nowrap'))); }); });
      body.appendChild(rows.length ? table([['Race'], ['Pair'], ['Odds', 'right'], ['Stake', 'right'], ['Result'], ['Paid', 'right'], ['Placed']], rows.slice(0, 120)) : h('p', { class: 'mute' }, 'No bets yet.'));
      close = modal('Player ' + id, body);
    });
  }

  /* ---------- users (admin) ---------- */
  function secretBox(title, lines) {
    return h('div', { class: 'secret' }, h('strong', null, title), lines.map(function (l) { return h('div', null, l[0] + ' ', h('code', { class: 'mono' }, l[1])); }), h('div', { class: 'mute' }, 'Shown once. Pass it on over a safe channel; it cannot be displayed again.'));
  }
  function users(view) {
    var out = h('div'), list = h('div');
    function load() {
      api('GET', 'users').then(function (r) {
        if (handleAuth(r)) return; clear(list);
        list.appendChild(table([['User'], ['Role'], ['Status'], ['2-step'], ['Last sign-in'], ['']], r.data.users.map(function (u) {
          var self = u.username === S.me.username, role = h('select', { disabled: self }, ['viewer', 'support', 'admin'].map(function (x) { return h('option', { value: x, selected: x === u.role }, x); }));
          role.addEventListener('change', function () { api('POST', 'users/' + u.username + '/role', { role: role.value }).then(function (r2) { if (r2.status !== 200) { out.replaceChildren(msg('err', errText(r2))); } else out.replaceChildren(msg('ok', 'Role of ' + u.username + ' is now ' + role.value + '.')); load(); }); });
          var actions = h('div', { class: 'bar', style: 'margin:0' });
          if (!self) {
            actions.appendChild(h('button', { onclick: function () { if (confirmBox('Reset the password of ' + u.username + '? They get a temporary one and are signed out.')) api('POST', 'users/' + u.username + '/reset-password', {}).then(function (r2) { out.replaceChildren(r2.status === 200 ? secretBox('New temporary password for ' + u.username, [['Password:', r2.data.tempPassword]]) : msg('err', errText(r2))); }); } }, 'Reset password'));
            actions.appendChild(h('button', { onclick: function () { api('POST', 'users/' + u.username + '/status', { status: u.status === 'active' ? 'disabled' : 'active' }).then(function (r2) { if (r2.status !== 200) out.replaceChildren(msg('err', errText(r2))); load(); }); } }, u.status === 'active' ? 'Disable' : 'Enable'));
            actions.appendChild(h('button', { class: 'danger', onclick: function () { if (confirmBox('Delete the user ' + u.username + '?')) api('POST', 'users/' + u.username + '/delete', {}).then(function (r2) { if (r2.status !== 200) out.replaceChildren(msg('err', errText(r2))); load(); }); } }, 'Delete'));
          }
          return h('tr', null, td(u.username + (self ? ' (you)' : '')), td(role), td(h('span', { class: 'pill ' + (u.status === 'active' ? 'on' : 'off') }, u.status)), td(u.totp ? 'on' : 'off'), td(when(u.lastLoginAt), 'nowrap'), td(actions));
        })));
      });
    }
    var name = h('input', { placeholder: 'username (letters, digits . _ @ -)' }), role = h('select', null, ['viewer', 'support', 'admin'].map(function (x) { return h('option', { value: x }, x); }));
    var form = h('form', { class: 'panel' }, h('strong', null, 'Add a user'), h('div', { class: 'grid2' }, h('div', null, h('label', null, 'Username'), name), h('div', null, h('label', null, 'Role'), role)),
      h('p', { class: 'mute' }, 'viewer: reports only. support: also blocks players. admin: also manages users and the API key.'), h('button', { class: 'primary', type: 'submit' }, 'Create user'));
    form.addEventListener('submit', function (ev) { ev.preventDefault(); api('POST', 'users', { username: name.value.trim(), role: role.value }).then(function (r) { if (r.status === 200) { name.value = ''; out.replaceChildren(secretBox('User ' + r.data.user.username + ' created', [['Temporary password:', r.data.tempPassword]])); load(); } else out.replaceChildren(msg('err', errText(r))); }); });
    view.appendChild(h('h2', null, 'Users of ' + (S.client.name || S.clientId))); view.appendChild(out); view.appendChild(list); view.appendChild(form); load();
  }

  /* ---------- security ---------- */
  function security(view) {
    var out = h('div'), cur = h('input', { type: 'password', autocomplete: 'current-password' }), n1 = h('input', { type: 'password', autocomplete: 'new-password' }), n2 = h('input', { type: 'password', autocomplete: 'new-password' });
    var pw = h('form', { class: 'panel' }, h('strong', null, 'Change password'), h('label', null, 'Current password'), cur, h('label', null, 'New password (12 characters or more)'), n1, h('label', null, 'New password again'), n2, h('div', { style: 'margin-top:12px' }, h('button', { class: 'primary', type: 'submit' }, 'Change password')));
    pw.addEventListener('submit', function (ev) { ev.preventDefault(); if (n1.value !== n2.value) return out.replaceChildren(msg('err', 'The two new passwords are not the same.')); api('POST', 'password', { current: cur.value, next: n1.value }).then(function (r) { if (handleAuth(r)) return; out.replaceChildren(r.status === 200 ? msg('ok', 'Password changed. Your other sessions were signed out.') : msg('err', errText(r))); if (r.status === 200) { cur.value = n1.value = n2.value = ''; } }); });
    var two = h('div', { class: 'panel' });
    function drawTwo() {
      clear(two); two.appendChild(h('strong', null, 'Two-step sign-in'));
      if (S.me.totp) {
        var p = h('input', { type: 'password', placeholder: 'Your password' });
        two.appendChild(h('p', { class: 'ok' }, 'On. A code from your authenticator app is needed at every sign-in.')); two.appendChild(p);
        two.appendChild(h('div', { style: 'margin-top:10px' }, h('button', { class: 'danger', onclick: function () { api('POST', 'totp/disable', { password: p.value }).then(function (r) { if (r.status === 200) { S.me.totp = false; drawTwo(); } else out.replaceChildren(msg('err', errText(r))); }); } }, 'Turn off')));
      } else {
        two.appendChild(h('p', { class: 'mute' }, 'Adds a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, ...) to your sign-in. Recommended for everyone, required in practice for administrators.'));
        two.appendChild(h('button', { onclick: function () {
          api('POST', 'totp/setup', {}).then(function (r) {
            if (r.status !== 200) return out.replaceChildren(msg('err', errText(r)));
            var code = h('input', { placeholder: '6-digit code', inputmode: 'numeric', maxlength: 7 }); clear(two); two.appendChild(h('strong', null, 'Set up two-step sign-in'));
            two.appendChild(h('p', null, 'In your authenticator app add an account manually (time based) with this key:')); two.appendChild(h('div', { class: 'secret' }, h('code', { class: 'mono' }, r.data.secret.replace(/(.{4})/g, '$1 ').trim())));
            two.appendChild(h('p', { class: 'mute' }, 'Or open this link on your phone: '), h('div', { class: 'mono mute' }, h('a', { href: r.data.otpauth }, 'add to authenticator')));
            two.appendChild(h('label', null, 'Then enter the code the app shows')); two.appendChild(code);
            two.appendChild(h('div', { style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: function () { api('POST', 'totp/enable', { otp: code.value }).then(function (r2) { if (r2.status === 200) { S.me.totp = true; drawTwo(); out.replaceChildren(msg('ok', 'Two-step sign-in is on.')); } else out.replaceChildren(msg('err', errText(r2))); }); } }, 'Turn on')));
          });
        } }, 'Set up'));
      }
    }
    drawTwo();
    view.appendChild(h('h2', null, 'Security')); view.appendChild(out); view.appendChild(h('div', { class: 'grid2' }, pw, two));
    // configuration of the client (read only) and the API key
    var cfg = h('div', { class: 'panel' }); view.appendChild(h('h2', null, 'Your integration')); view.appendChild(cfg);
    function drawCfg() {
      api('GET', 'client').then(function (r) {
        if (handleAuth(r)) return; var c = r.data.client; S.client = c; clear(cfg);
        function row(k, v) { return h('tr', null, td(k, 'mute'), td(v)); }
        var lim = c.limits || {};
        cfg.appendChild(h('div', { class: 'scroll' }, h('table', null, h('tbody', null,
          row('Client id', c.id), row('Status', c.status), row('Currency', c.currency || '-'), row('Wallet', c.wallet ? (c.wallet.url || c.wallet.type) : 'default'), row('Webhook', c.webhook ? c.webhook.url : 'none'),
          row('Bet limits', lim.minBet || lim.maxBet ? 'min ' + (lim.minBet ? money(lim.minBet) : '-') + ', max ' + (lim.maxBet ? money(lim.maxBet) : '-') + ', per race ' + (lim.maxRoundStake ? money(lim.maxRoundStake) : '-') : 'server defaults'),
          row('Daily loss limit', lim.dailyLossLimit ? money(lim.dailyLossLimit) : 'none'), row('Allowed API addresses', (c.allowedIps || []).join(', ') || 'any'), row('Return link hosts', (c.returnUrlHosts || []).join(', ') || 'any')))));
        cfg.appendChild(h('p', { class: 'mute' }, 'Limits, wallet and webhook settings are changed by the game operator. Contact them for changes.'));
        if (c.apiKeys) {
          cfg.appendChild(h('h2', null, 'API keys')); cfg.appendChild(table([['Key'], ['Created'], ['Last used'], ['Expires']], c.apiKeys.map(function (k) { return h('tr', null, td(k.id), td(when(k.createdAt)), td(when(k.lastUsedAt)), td(k.expiresAt ? when(k.expiresAt) : 'no expiry')); })));
          if (can('admin')) {
            var grace = h('input', { type: 'number', min: 0, max: 168, value: 24, style: 'max-width:90px' }), keyOut = h('div');
            cfg.appendChild(h('div', { class: 'bar', style: 'margin-top:10px' }, h('button', { class: 'danger', onclick: function () {
              if (!confirmBox('Create a new API key? The old keys stop working after the grace period.')) return;
              api('POST', 'apikey/rotate', { graceHours: Number(grace.value) }).then(function (r2) { if (r2.status === 200) { keyOut.replaceChildren(secretBox('New API key', [['Key:', r2.data.apiKey]])); S.client = r2.data.client; } else keyOut.replaceChildren(msg('err', errText(r2))); });
            } }, 'Rotate API key'), h('span', { class: 'mute' }, 'old keys stay valid for'), grace, h('span', { class: 'mute' }, 'hours (0 = stop at once)')), keyOut);
          }
        }
      });
    }
    drawCfg();
  }

  /* ---------- audit (admin) ---------- */
  function audit(view) {
    api('GET', 'audit?limit=300').then(function (r) {
      if (handleAuth(r)) return; clear(view); view.appendChild(h('h2', null, 'Audit log'));
      view.appendChild(h('p', { class: 'mute' }, 'Everything done in this back office (and by the operator for your client): sign-ins, player controls, user changes, exports.'));
      view.appendChild(table([['Time'], ['User'], ['Action'], ['Target'], ['Detail'], ['Address']], r.data.entries.map(function (e) { return h('tr', null, td(when(e.at), 'nowrap'), td(e.user || '-'), td(e.action), td(e.target || ''), td(e.detail || ''), td(e.ip || '')); })));
    });
  }

  /* ---------- start ---------- */
  api('GET', 'me').then(function (r) { if (r.status === 200) boot(r.data); else showLogin(r.data && r.data.error === 'STANDBY' ? 'The game server is starting. Try again in a moment.' : ''); }).catch(function () { showLogin('Cannot reach the server.'); });
})();
