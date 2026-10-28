/*
 * The player's own account page: register, sign in, wallet (deposit / withdraw requests) and the button that starts the game.
 * Talks to /player/api/*. Everything is put on the page with textContent / DOM nodes, never as HTML.
 */
(function () {
  'use strict';
  var app = document.getElementById('app');
  var S = { me: null, csrf: '', pay: null, tab: 'wallet', mode: 'login', wallet: null };
  var CODES = {
    BAD_LOGIN: 'The username or password is not right.', TOO_MANY_ATTEMPTS: 'Too many attempts. Please wait a few minutes.', ACCOUNT_SUSPENDED: 'This account is suspended. Please contact support.',
    SESSION_EXPIRED: 'Your session expired. Please sign in again.', NOT_LOGGED_IN: 'Please sign in.', REGISTRATION_CLOSED: 'Registration is closed right now.',
    INSUFFICIENT_FUNDS: 'Your balance is too low for that.', BAD_CSRF: 'Please reload the page and try again.', BAD_ORIGIN: 'Please reload the page and try again.'
  };

  function h(tag, attrs) {
    var el = document.createElement(tag), i, k;
    if (attrs) for (k in attrs) { if (k === 'class') el.className = attrs[k]; else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]); else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]); }
    for (i = 2; i < arguments.length; i++) add(el, arguments[i]);
    return el;
  }
  function add(el, c) { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(function (x) { add(el, x); }); else el.appendChild(c.nodeType ? c : document.createTextNode(String(c))); }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function api(method, path, body) {
    var o = { method: method, credentials: 'same-origin', headers: { 'X-CSRF-Token': S.csrf } };
    if (body !== undefined) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    return fetch('/player/api/' + path, o).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }
  function text(r, fallback) { var d = r.data || {}; return CODES[d.error] || d.message || d.error || fallback || 'Something went wrong. Please try again.'; }
  function money(m) { return (m / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function toMinor(v) { v = String(v || '').trim().replace(/,/g, ''); if (!/^\d+(\.\d{1,2})?$/.test(v)) throw new Error('Enter an amount like 500 or 500.00.'); return Math.round(parseFloat(v) * 100); }
  function when(ms) { return ms ? new Date(ms).toLocaleString() : '-'; }
  function msg(kind, t) { return h('div', { class: kind === 'err' ? 'err' : 'note' }, t); }
  function field(label, input, hint) { return h('div', null, h('label', null, label), input, hint ? h('div', { class: 'help' }, hint) : null); }
  function show(out, kind, t) { clear(out); out.appendChild(msg(kind, t)); }
  function pill(st) { return h('span', { class: 'pill ' + st }, st); }

  /* ---------- signed out ---------- */
  function signedOut(note) {
    clear(app); S.me = null;
    var out = h('div', { class: 'out' }); if (note) out.appendChild(msg('err', note));
    var open = !S.pay || S.pay.registration;
    if (!open) S.mode = 'login';
    var seg = h('div', { class: 'seg' }, h('button', { class: S.mode === 'login' ? 'on' : '', onclick: function () { S.mode = 'login'; signedOut(); } }, 'Sign in'),
      open ? h('button', { class: S.mode === 'register' ? 'on' : '', onclick: function () { S.mode = 'register'; signedOut(); } }, 'Register') : null);
    var box = h('div', { class: 'box' }, seg);
    var form = h('form', { novalidate: 'novalidate' });
    var user = h('input', { name: 'username', autocomplete: 'username', autocapitalize: 'none', required: 'required', maxlength: '20' });
    var pass = h('input', { name: 'password', type: 'password', autocomplete: S.mode === 'login' ? 'current-password' : 'new-password', required: 'required' });
    form.appendChild(field('Username', user, S.mode === 'register' ? '4 to 20 letters, digits or _, starting with a letter.' : null));
    if (S.mode === 'register') {
      var mobile = h('input', { name: 'mobile', type: 'tel', inputmode: 'numeric', autocomplete: 'tel', placeholder: '09171234567', required: 'required' });
      var email = h('input', { name: 'email', type: 'email', autocomplete: 'email', placeholder: 'optional' });
      var pass2 = h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', required: 'required' });
      var over18 = h('input', { type: 'checkbox', name: 'over18' }), terms = h('input', { type: 'checkbox', name: 'terms' });
      form.appendChild(field('Mobile number', mobile, 'Philippine mobile number. Used to reach you about deposits and withdrawals.'));
      form.appendChild(field('E-mail (optional)', email));
      form.appendChild(field('Password', pass, 'At least 8 characters.'));
      form.appendChild(field('Repeat password', pass2));
      form.appendChild(h('label', { class: 'check' }, over18, h('span', null, 'I am 18 years old or older.')));
      form.appendChild(h('label', { class: 'check' }, terms, h('span', null, 'I accept the terms and understand that gambling involves risk and I can lose the money I stake.')));
    } else { form.appendChild(field('Password', pass)); }
    var btn = h('button', { class: 'primary', type: 'submit', style: 'width:100%;margin-top:12px;padding:12px' }, S.mode === 'login' ? 'Sign in' : 'Create account');
    form.appendChild(btn); form.appendChild(out);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); clear(out);
      var body = { username: user.value.trim(), password: pass.value };
      if (S.mode === 'register') {
        if (pass.value !== pass2.value) return show(out, 'err', 'The two passwords are not the same.');
        body.mobile = mobile.value.trim(); body.email = email.value.trim(); body.over18 = over18.checked; body.terms = terms.checked;
      }
      btn.disabled = true;
      api('POST', S.mode === 'login' ? 'login' : 'register', body).then(function (r) {
        btn.disabled = false;
        if (r.status === 200 && r.data.ok) { S.me = r.data.player; S.csrf = r.data.csrf; S.pay = r.data.payment; S.tab = 'wallet'; signedIn(); } else show(out, 'err', text(r, 'Could not sign in.'));
      }).catch(function () { btn.disabled = false; show(out, 'err', 'Cannot reach the server.'); });
    });
    box.appendChild(form);
    app.appendChild(h('div', { class: 'acc' }, h('h1', null, 'Horse Race'), h('p', { class: 'sub' }, 'Sign in or create an account to play.'), box, foot()));
    user.focus();
  }
  function foot() { return h('div', { class: 'foot' }, h('a', { href: '/' }, 'Watch the races'), ' - Play responsibly. 18+ only.'); }

  /* ---------- signed in ---------- */
  function refreshMe() { return api('GET', 'me').then(function (r) { if (r.status === 200) { S.me = r.data.player; S.csrf = r.data.csrf; S.pay = r.data.payment; } return r; }); }
  function signedIn() {
    clear(app);
    var out = h('div', { class: 'out' });
    var play = h('button', { class: 'primary play', onclick: function () {
      play.disabled = true;
      api('POST', 'launch', {}).then(function (r) {
        if (r.status === 200 && r.data.token) location.href = '/?token=' + encodeURIComponent(r.data.token) + '&client=' + encodeURIComponent(r.data.client);
        else { play.disabled = false; if (r.status === 401) signedOut(text(r)); else show(out, 'err', text(r)); }
      }).catch(function () { play.disabled = false; show(out, 'err', 'Cannot reach the server.'); });
    } }, 'Play now');
    var head = h('div', { class: 'box' }, h('div', { class: 'bal' }, h('div', null, h('div', { class: 'who' }, 'Balance'), h('div', { class: 'amt' }, (S.pay ? S.pay.currency : 'PHP') + ' ' + money(S.me.balance))),
      h('div', { class: 'who' }, S.me.username, ' ', h('button', { style: 'margin-left:8px;padding:3px 10px', onclick: function () { api('POST', 'logout', {}).then(function () { S.mode = 'login'; signedOut(); }); } }, 'Sign out'))), play, out);
    var seg = h('div', { class: 'seg' }, [['wallet', 'Deposit / Withdraw'], ['history', 'History'], ['account', 'Account']].map(function (t) {
      return h('button', { class: S.tab === t[0] ? 'on' : '', onclick: function () { S.tab = t[0]; signedIn(); } }, t[1]);
    }));
    var body = h('div');
    app.appendChild(h('div', { class: 'acc' }, h('h1', null, 'My account'), head, seg, body, foot()));
    ({ wallet: walletTab, history: historyTab, account: accountTab }[S.tab] || walletTab)(body);
  }

  function methodSelect() { return h('select', { name: 'method' }, (S.pay.methods || []).map(function (m) { return h('option', { value: m.id }, m.label); })); }

  function walletTab(view) {
    var p = S.pay;
    if (!p.methods.length) { view.appendChild(h('div', { class: 'box' }, h('p', { class: 'mute' }, 'Deposits are not available yet. Please check back soon.'))); return; }
    /* deposit */
    var dep = h('div', { class: 'box' }, h('h2', null, 'Deposit'), h('p', { class: 'help' }, '1. Send the money to one of these accounts.  2. Enter the reference number of your payment below.  3. We check it and add it to your balance.'));
    p.methods.forEach(function (m) {
      var copy = h('button', { onclick: function () { try { navigator.clipboard.writeText(m.accountNumber); copy.textContent = 'Copied'; setTimeout(function () { copy.textContent = 'Copy'; }, 1500); } catch (e) { /* ignore */ } } }, 'Copy');
      dep.appendChild(h('div', { class: 'pay' }, h('b', null, m.label), h('div', { class: 'num' }, m.accountNumber, copy), m.accountName ? h('div', null, m.accountName) : null, m.note ? h('div', { class: 'help' }, m.note) : null));
    });
    var dout = h('div', { class: 'out' }), dform = h('form', { novalidate: 'novalidate' });
    var dm = methodSelect(), da = h('input', { name: 'amount', inputmode: 'decimal', placeholder: money(p.minDeposit), required: 'required' }), dn = h('input', { name: 'senderName', required: 'required', maxlength: '80', autocomplete: 'name' });
    var dnum = h('input', { name: 'senderNumber', inputmode: 'numeric', maxlength: '40', placeholder: 'optional' }), dr = h('input', { name: 'reference', required: 'required', maxlength: '40', autocapitalize: 'characters' });
    dform.appendChild(field('Paid with', dm)); dform.appendChild(field('Amount (' + p.currency + ')', da, 'Min ' + money(p.minDeposit) + ', max ' + money(p.maxDeposit) + '.'));
    dform.appendChild(field('Name on the account you paid from', dn)); dform.appendChild(field('Your account number', dnum)); dform.appendChild(field('Reference number of the payment', dr, 'Shown in your payment receipt.'));
    var db = h('button', { class: 'primary', type: 'submit', style: 'width:100%;margin-top:12px;padding:11px' }, 'I have paid - submit');
    dform.appendChild(db); dform.appendChild(dout);
    dform.addEventListener('submit', function (ev) {
      ev.preventDefault(); clear(dout); var amount;
      try { amount = toMinor(da.value); } catch (e) { return show(dout, 'err', e.message); }
      db.disabled = true;
      api('POST', 'deposit', { method: dm.value, amount: amount, senderName: dn.value.trim(), senderNumber: dnum.value.trim(), reference: dr.value.trim() }).then(function (r) {
        db.disabled = false;
        if (r.data.ok) { dform.reset(); show(dout, 'ok', 'Thank you. We will add the money to your balance as soon as we have checked your payment.'); } else show(dout, 'err', text(r));
      }).catch(function () { db.disabled = false; show(dout, 'err', 'Cannot reach the server.'); });
    });
    dep.appendChild(dform); view.appendChild(dep);
    /* withdraw */
    var wd = h('div', { class: 'box' }, h('h2', null, 'Withdraw'), h('p', { class: 'help' }, 'The amount leaves your balance now and we pay it to your account. One withdrawal at a time.'));
    var wout = h('div', { class: 'out' }), wform = h('form', { novalidate: 'novalidate' });
    var wm = methodSelect(), wa = h('input', { name: 'amount', inputmode: 'decimal', placeholder: money(p.minWithdraw), required: 'required' }), wn = h('input', { name: 'accountName', required: 'required', maxlength: '80' }), wnum = h('input', { name: 'accountNumber', required: 'required', inputmode: 'numeric', maxlength: '40' });
    wform.appendChild(field('Pay me with', wm)); wform.appendChild(field('Amount (' + p.currency + ')', wa, 'Min ' + money(p.minWithdraw) + ', max ' + money(p.maxWithdraw) + '.'));
    wform.appendChild(field('Account name', wn, 'It must be your own account.')); wform.appendChild(field('Account number', wnum));
    var wb = h('button', { type: 'submit', style: 'width:100%;margin-top:12px;padding:11px' }, 'Request withdrawal');
    wform.appendChild(wb); wform.appendChild(wout);
    wform.addEventListener('submit', function (ev) {
      ev.preventDefault(); clear(wout); var amount;
      try { amount = toMinor(wa.value); } catch (e) { return show(wout, 'err', e.message); }
      if (!confirm('Withdraw ' + p.currency + ' ' + money(amount) + ' to ' + wnum.value.trim() + '?')) return;
      wb.disabled = true;
      api('POST', 'withdraw', { method: wm.value, amount: amount, accountName: wn.value.trim(), accountNumber: wnum.value.trim() }).then(function (r) {
        wb.disabled = false;
        if (r.data.ok) { S.me.balance = r.data.balance; S.tab = 'history'; signedIn(); } else show(wout, 'err', text(r));
      }).catch(function () { wb.disabled = false; show(wout, 'err', 'Cannot reach the server.'); });
    });
    wd.appendChild(wform); view.appendChild(wd);
  }

  function table(head, rows) { return h('div', { class: 'scroll' }, h('table', null, h('thead', null, h('tr', null, head.map(function (x) { return h('th', null, x); }))), h('tbody', null, rows))); }
  function historyTab(view) {
    view.appendChild(h('div', { class: 'box' }, h('p', { class: 'mute' }, 'Loading...')));
    api('GET', 'wallet').then(function (r) {
      clear(view);
      if (r.status !== 200) return view.appendChild(msg('err', text(r)));
      var w = r.data; S.me.balance = w.balance;
      var dep = w.deposits.length ? table(['Date', 'Amount', 'Method', 'Reference', 'Status'], w.deposits.map(function (d) { return h('tr', null, h('td', null, when(d.at)), h('td', null, money(d.amount)), h('td', null, d.method), h('td', null, d.reference), h('td', null, pill(d.status), d.note ? h('div', { class: 'help' }, d.note) : null)); })) : h('p', { class: 'mute' }, 'No deposits yet.');
      var wd = w.withdrawals.length ? table(['Date', 'Amount', 'To', 'Status'], w.withdrawals.map(function (x) { return h('tr', null, h('td', null, when(x.at)), h('td', null, money(x.amount)), h('td', null, x.method + ' ' + x.account), h('td', null, pill(x.status), x.note ? h('div', { class: 'help' }, x.note) : null, x.payoutRef ? h('div', { class: 'help' }, 'ref ' + x.payoutRef) : null)); })) : h('p', { class: 'mute' }, 'No withdrawals yet.');
      var LABEL = { bet: 'Bet', win: 'Win', rollback: 'Bet cancelled', deposit: 'Deposit', withdraw_hold: 'Withdrawal', withdraw_release: 'Withdrawal returned', adjust: 'Adjustment' };
      var tx = w.tx.length ? table(['Date', 'What', 'Amount', 'Balance'], w.tx.map(function (t) { return h('tr', null, h('td', null, when(t.at)), h('td', null, LABEL[t.type] || t.type), h('td', { class: t.amount < 0 ? 'bad' : 'ok' }, (t.amount > 0 ? '+' : '') + money(t.amount)), h('td', null, money(t.balance))); })) : h('p', { class: 'mute' }, 'Nothing yet.');
      view.appendChild(h('div', { class: 'box' }, h('h2', null, 'Deposits'), dep)); view.appendChild(h('div', { class: 'box' }, h('h2', null, 'Withdrawals'), wd)); view.appendChild(h('div', { class: 'box' }, h('h2', null, 'Balance movements'), tx));
    });
  }

  function accountTab(view) {
    var out = h('div', { class: 'out' }), form = h('form', { novalidate: 'novalidate' });
    var cur = h('input', { type: 'password', autocomplete: 'current-password', required: 'required' }), nx = h('input', { type: 'password', autocomplete: 'new-password', required: 'required' });
    form.appendChild(field('Current password', cur)); form.appendChild(field('New password', nx, 'At least 8 characters.'));
    form.appendChild(h('button', { type: 'submit', style: 'margin-top:12px' }, 'Change password')); form.appendChild(out);
    form.addEventListener('submit', function (ev) {
      ev.preventDefault(); clear(out);
      api('POST', 'password', { current: cur.value, next: nx.value }).then(function (r) { if (r.data.ok) { form.reset(); show(out, 'ok', 'Password changed. Your other devices were signed out.'); } else show(out, 'err', text(r)); });
    });
    view.appendChild(h('div', { class: 'box' }, h('h2', null, 'Your details'), h('p', null, 'Username: ', h('b', null, S.me.username)), h('p', null, 'Mobile: ', h('b', null, S.me.mobile || '-')), h('h2', null, 'Change password'), form,
      h('div', { class: 'warn' }, 'Need help or want to close your account? Contact support.')));
  }

  function unavailable() { clear(app); app.appendChild(h('div', { class: 'acc' }, h('h1', null, 'Horse Race'), h('div', { class: 'box' }, h('p', null, 'Player accounts are not available on this site.')), foot())); }

  /* ---------- start ---------- */
  refreshMe().then(function (r) {
    if (r.status === 200) return signedIn();
    return fetch('/player/api/config', { credentials: 'same-origin' }).then(function (c) { return c.json(); }).then(function (c) { S.pay = c.payment; if (S.pay && !S.pay.enabled) return unavailable(); if (location.pathname === '/register' && S.pay && S.pay.registration) S.mode = 'register'; signedOut(); });
  }).catch(function () { signedOut('Cannot reach the server.'); });
})();
