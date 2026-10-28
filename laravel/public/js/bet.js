/*
 * Betting panel (live mode only). The game is opened from the operator's platform as a redirect:
 *   https://GAME_HOST/?token=<launch token>
 * The token is exchanged for a game session (POST /api/auth), removed from the URL, and kept in sessionStorage.
 * All money handling happens on the server: this panel only sends bets and shows what the server reports.
 */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var S = { session: null, rules: null, me: null, pending: {}, chip: 0, busy: false, msgTimer: null, built: false };
  var el = { bet: $('bet'), layout: $('layout'), player: $('bPlayer'), balance: $('bBalance'), round: $('bRound'), timer: $('bTimer'),
    prog: $('bProg'), pay: $('bPay'), msg: $('bMsg'), grid: $('bGrid'), legend: $('bLegend'), chips: $('bChips'), clear: $('bClear'), rebet: $('bRebet'),
    place: $('bPlace'), hist: $('bHist'), histBtn: $('bHistBtn'), rc: $('bReality'), rcTxt: $('bRealityTxt'), rcGo: $('bRealityGo'), rcLeave: $('bRealityLeave'), total: $('bTotal'), placed: $('bPlaced'), last: $('bLast'), fair: $('bFair'), back: $('bBack'), tab: $('betTab') };

  var ERRORS = {
    BETTING_CLOSED: 'Betting is closed for this race.', INSUFFICIENT_FUNDS: 'Not enough balance for that bet.',
    MAX_BET_EXCEEDED: 'That is above the maximum bet for one combination.', MAX_ROUND_STAKE_EXCEEDED: 'That is above the maximum total bet for one race.',
    BAD_BET: 'That bet is not allowed (check the minimum and maximum).', TOO_MANY_REQUESTS: 'Slow down a little and try again.',
    INVALID_CLIENT: 'This launch link is not valid. Please open the game again from the lobby.', CLIENT_DISABLED: 'The game is not available from this site right now.', CLIENT_REQUIRED: 'This launch link is incomplete. Please open the game again from the lobby.', INVALID_PLAYER_ID: 'This player account cannot be used. Please contact support.',
    DAILY_LOSS_LIMIT: 'This bet would go over your daily loss limit.', PLAYER_BLOCKED: 'This account cannot play right now. Please contact support.',
    WALLET_UNAVAILABLE: 'The wallet is not responding. Your balance was not changed, please try again.', WALLET_REJECTED: 'The wallet rejected the bet.',
    SESSION_EXPIRED: 'Your session has expired. Please open the game again from the lobby.', INVALID_TOKEN: 'This launch link is invalid or has expired. Please open the game again from the lobby.'
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function dec() { return S.me && S.me.decimals != null ? S.me.decimals : 2; }
  function fmt(minor) { var d = dec(); return (minor / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function lim() { return (S.me && S.me.limits) || S.rules; }      // limits of this player (the platform may set them per player / currency)
  function money(minor) { return (S.currency ? S.currency + ' ' : '') + fmt(minor); }
  function chip(n) { return '<span class="chip h' + n + '">' + n + '</span>'; }

  function api(method, path, body) {
    var opts = { method: method, cache: 'no-store', headers: {} };
    if (S.session) opts.headers.Authorization = 'Bearer ' + S.session;
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { return { status: r.status, data: d }; }); });
  }

  function say(text, ok) {
    clearTimeout(S.msgTimer);
    el.msg.hidden = !text; el.msg.textContent = text || ''; el.msg.className = 'msg' + (ok ? ' ok' : '');
    if (text && ok) S.msgTimer = setTimeout(function () { el.msg.hidden = true; }, 4000);
  }

  function needLaunch(text) {
    S.session = null; try { sessionStorage.removeItem('hr.session'); } catch (e) { /* ignore */ }
    el.grid.hidden = el.chips.hidden = el.clear.parentNode.hidden = true;
    el.placed.innerHTML = el.last.innerHTML = '';
    say(text || ERRORS.SESSION_EXPIRED);
    guestPanel(text === LOBBY_HINT);
  }

  /* ---------- the operator's own site: a visitor without a session sees LOGIN / REGISTER in the (open) betting panel ---------- */
  var LOBBY_HINT = 'Open this game from the lobby to place bets. You can still watch the races.';
  var guest = false, guestBusy = false;
  function setGuest(on) {
    guest = on;
    var box = $('bAuth'); if (box) box.hidden = !on;
  }
  function guestPanel(quiet) {
    var shown = $('bAuth');
    if (guestBusy || (shown && !shown.hidden)) { guest = true; if (quiet) say(''); return; }          // already asked / already showing (refresh() calls this on every poll)
    guestBusy = true; guest = true;                                                    // keep the panel open while we find out whether the own site is switched on
    fetch('/player/api/config', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (c) {
      guestBusy = false;
      if (!c || !c.payment || !c.payment.enabled) { guest = false; return; }
      if (S.session) { guest = false; return; }                     // signed in meanwhile
      var box = $('bAuth');
      if (!box) {
        var st = document.createElement('style');
        st.textContent = '.auth{margin:8px 0;padding:10px;background:#1a2550;border:2px solid #46537f;text-align:center}.auth p{margin:0 0 8px;color:#d6e0ff;font-size:13px}' +
          '.auth .row{display:flex;gap:6px}.auth a{flex:1;display:block;padding:9px 6px;font:inherit;font-weight:bold;text-decoration:none;color:#fff;background:#2a3768;border:2px solid #46537f}' +
          '.auth a.primary{background:#1e8a3c;border-color:#4fe07a}';
        document.head.appendChild(st);
        box = document.createElement('div'); box.id = 'bAuth'; box.className = 'auth';
        var t = document.createElement('p'); t.textContent = 'Sign in to place bets. You can still watch the races.'; box.appendChild(t);
        var row = document.createElement('div'); row.className = 'row'; box.appendChild(row);
        var login = document.createElement('a'); login.href = '/login'; login.textContent = 'LOGIN'; login.className = 'primary'; row.appendChild(login);
        var reg = document.createElement('a'); reg.href = '/register'; reg.id = 'bAuthReg'; reg.textContent = 'REGISTER'; row.appendChild(reg);
        el.msg.parentNode.insertBefore(box, el.msg.nextSibling);
      }
      $('bAuthReg').hidden = !c.payment.registration;
      box.hidden = false;
      if (quiet) say('');                                            // the "open from the lobby" hint does not fit the own site
      setPanel(true);
    }).catch(function () { guestBusy = false; guest = false; });
  }

  /* ---------- build ---------- */
  function short(minor) { var m = Math.pow(10, dec()); return minor % m === 0 ? String(minor / m) : (minor / m).toFixed(dec()); }

  // chip values follow this player's minimum / maximum bet (they can differ per player and currency)
  function buildChips() {
    var l = lim(), key = l.minBet + ':' + l.maxBet + ':' + dec();
    if (S.chipsKey === key) return; S.chipsKey = key;
    var vals = [1, 5, 10, 50, 100, 500].map(function (m) { return m * l.minBet; }).filter(function (v) { return v <= l.maxBet; });
    if (!vals.length) vals = [l.minBet];
    S.chip = vals[0];
    el.chips.innerHTML = vals.map(function (v, i) { return '<button type="button" class="chipbtn' + (i ? '' : ' sel') + '" data-v="' + v + '">' + fmt(v) + '</button>'; }).join('');
  }

  // the board of the video karera chart: rows 1-5, columns 6 down to 2; every cell shows its odds (gold) and your bet (red)
  function build() {
    if (S.built) return; S.built = true;
    var r = S.rules, html = '<span class="bc"></span>', a, b;
    for (b = 6; b >= 2; b--) html += '<span class="bh">' + b + '</span>';
    for (a = 1; a <= 5; a++) {
      html += '<span class="bl">' + a + '</span>';
      for (b = 6; b >= 2; b--) {
        if (b > a) { var c = a + '-' + b; html += '<button type="button" class="cell" data-c="' + c + '" title="' + a + ' and ' + b + ' (any order)"><span class="odds">-</span><span class="bt">0</span></button>'; }
        else html += '<span class="blank"></span>';
      }
    }
    el.grid.innerHTML = html;
    el.legend.innerHTML = '<span class="lo">ODDS</span> <span class="lb">BET</span>';
    buildChips();
    el.pay.textContent = 'ANY ORDER - A WINNING PAIR PAYS STAKE x ODDS (STAKE INCLUDED). THE ODDS ARE SHUFFLED EVERY RACE.';

    el.grid.addEventListener('click', function (ev) {
      var minus = ev.target.closest('.minus'), t = ev.target.closest('.cell'); if (!t || t.disabled) return;
      var c = t.dataset.c, cur = S.pending[c] || 0, placed = placedBy()[c] || 0;
      if (minus) { cur = Math.max(0, cur - S.chip); } else { cur = Math.min(cur + S.chip, lim().maxBet - placed); }
      if (cur > 0) S.pending[c] = cur; else delete S.pending[c];
      render();
    });
    el.chips.addEventListener('click', function (ev) {
      var b2 = ev.target.closest('.chipbtn'); if (!b2) return;
      S.chip = +b2.dataset.v; [].forEach.call(el.chips.children, function (x) { x.classList.toggle('sel', x === b2); });
    });
    el.clear.addEventListener('click', function () { S.pending = {}; render(); });
    el.rebet.addEventListener('click', function () {
      var l = S.me && S.me.last; if (!l) return;
      S.pending = {}; l.bets.forEach(function (b2) { S.pending[b2.combo] = Math.min((S.pending[b2.combo] || 0) + b2.stake, lim().maxBet); }); render();
    });
    el.place.addEventListener('click', placeBets);
  }

  /* ---------- actions ---------- */
  function placeBets() {
    var list = Object.keys(S.pending).map(function (c) { return { combo: c, stake: S.pending[c] }; });
    if (!list.length || S.busy) return;
    if (window.HorseGame && window.HorseGame.sound) window.HorseGame.sound.ching();
    S.busy = true; render();
    api('POST', 'api/bet', { bets: list }).then(function (res) {
      S.busy = false;
      if (res.data.ok) { S.pending = {}; if (S.me) S.me.balance = res.data.balance; say('Bet placed. Good luck!', true); refresh(); }
      else { var code = res.data.error; if (code === 'SESSION_EXPIRED') return needLaunch(); say(ERRORS[code] || 'The bet could not be placed.'); refresh(); }
      render();
    }).catch(function () { S.busy = false; say('Connection problem. Please try again.'); render(); });
  }

  function placedBy() {
    var o = {}; ((S.me && S.me.bets) || []).forEach(function (b) { o[b.combo] = (o[b.combo] || 0) + b.stake; }); return o;
  }

  function refresh() {
    if (!S.session) return Promise.resolve();
    return api('GET', 'api/me').then(function (res) {
      if (res.status === 401) return needLaunch();
      if (res.data.ok) { S.me = res.data; S.currency = res.data.currency || S.currency; }
      render();
    }).catch(function () { /* offline: keep what we have */ });
  }

  /* ---------- render ---------- */
  function render() {
    var G = window.HorseGame, st = G && G.state(), me = S.me;
    if (me) {
      buildChips();
      el.player.textContent = me.playerId; el.balance.textContent = money(me.balance);
      if (me.returnUrl) { el.back.hidden = false; el.back.href = me.returnUrl; }
    }
    var round = st && st.round, t = G ? G.now() : Date.now(), betting = !!(round && round.phase === 'betting' && t < round.betCloseAt);
    if (round) {
      el.round.textContent = 'RACE ' + round.raceNo;
      if (betting) {
        var left = Math.max(0, round.betCloseAt - t), total = (st.timings && st.timings.bet) || 25000;
        el.timer.textContent = 'BETS CLOSE IN ' + Math.ceil(left / 1000) + 'S';
        el.prog.style.width = (100 * left / total) + '%'; el.prog.className = 'bar-fill' + (left < 5000 ? ' low' : '');
      } else {
        el.timer.textContent = round.phase === 'closed' ? 'BETS CLOSED - OFF SOON' : round.phase === 'racing' ? 'RACE IN PROGRESS' : 'OFFICIAL RESULT';
        el.prog.style.width = '0';
      }
      el.fair.textContent = 'Round commit (SHA-256 of the secret seed): ' + round.commit + (st.reveals && st.reveals.length ? '  |  Last race ' + st.reveals[st.reveals.length - 1].raceNo + ' seed: ' + st.reveals[st.reveals.length - 1].seed : '');
    }
    if (round && round.raceNo !== S.raceNo) {            // a new race has new odds: stakes picked for the old odds are dropped
      if (S.raceNo != null && Object.keys(S.pending).length) { S.pending = {}; say('New race, new odds. Please pick your bets again.', true); }
      S.raceNo = round.raceNo;
    }
    var placed = placedBy(), cells = el.grid.querySelectorAll('.cell'), i, total = 0;
    Object.keys(S.pending).forEach(function (c) { total += S.pending[c]; });
    for (i = 0; i < cells.length; i++) {
      var tl = cells[i], c = tl.dataset.c, p = S.pending[c] || 0, pl = placed[c] || 0;
      tl.disabled = !betting || !S.session || S.busy;
      tl.classList.toggle('on', p > 0 || pl > 0); tl.classList.toggle('pend', p > 0);
      var od = tl.querySelector('.odds'), ov = round && round.odds ? String(round.odds[c]) : '-';
      if (od.textContent !== ov) od.textContent = ov;
      var bt = tl.querySelector('.bt'), txt = short(pl + p);
      if (bt.textContent !== txt) bt.textContent = txt;
      var mn = tl.querySelector('.minus');
      if (p && !mn) { mn = document.createElement('span'); mn.className = 'minus'; mn.textContent = '-'; tl.appendChild(mn); }
      if (!p && mn) mn.remove();
    }
    el.total.textContent = total ? '(' + fmt(total) + ')' : '';
    el.place.disabled = !betting || !total || S.busy || !S.session;
    el.clear.disabled = !total;
    el.rebet.disabled = !betting || !(me && me.last && me.last.bets.length);

    var mine = (me && me.bets) || [];
    el.placed.innerHTML = mine.length ? '<div class="ttl">YOUR BETS - RACE ' + me.raceNo + '</div>' + mine.map(function (b) {
      var p = b.combo.split('-');
      return '<div class="row"><span>' + chip(p[0]) + '-' + chip(p[1]) + ' @ ' + b.odds + '</span><span>' + fmt(b.stake) + ' &rarr; ' + fmt(b.stake * b.odds) + '</span></div>';
    }).join('') : '';
    var last = me && me.last, settled = last && last.bets.every(function (b) { return b.status !== 'open'; });
    if (last && settled) {
      var lp = last.combo.split('-'), won = last.bets.filter(function (b) { return b.status === 'won'; }), sum = won.reduce(function (a, b) { return a + b.payout; }, 0);
      el.last.innerHTML = '<div class="ttl">RESULT - RACE ' + last.raceNo + ' - WINNING PAIR ' + chip(lp[0]) + '-' + chip(lp[1]) + '</div>' +
        (won.length ? '<div class="row won"><span>YOU WON</span><span>+' + fmt(sum) + '</span></div>' : '<div class="row lost"><span>NO WINNING BET</span><span></span></div>');
    } else el.last.innerHTML = '';
  }

  /* ---------- my history (bets of the last races) ---------- */
  function toggleHistory() {
    if (!el.hist.hidden) { el.hist.hidden = true; return; }
    api('GET', 'api/history?limit=15').then(function (res) {
      if (!res.data.ok) { el.hist.textContent = ERRORS[res.data.error] || 'History is not available.'; el.hist.hidden = false; return; }
      var rows = res.data.rounds.map(function (r) {
        var p = r.combo ? r.combo.split('-') : null;
        var refunded = r.bets.every(function (b) { return b.status === 'refunded'; });
        return '<div class="row"><span>RACE ' + r.raceNo + (p ? ' ' + chip(p[0]) + '-' + chip(p[1]) : refunded ? ' (REFUNDED)' : ' (OPEN)') + '</span><span>' + fmt(r.staked) + ' &rarr; ' + fmt(r.paid) + '</span></div>';
      }).join('');
      el.hist.innerHTML = rows || '<div class="row"><span>NO BETS YET</span><span></span></div>'; el.hist.hidden = false;
    }).catch(function () { el.hist.textContent = 'Connection problem.'; el.hist.hidden = false; });
  }

  /* ---------- reality check: every N minutes (set by the platform) the player sees time played and the result so far ---------- */
  function realityCheck() {
    var me = S.me, r = me && me.responsible, G = window.HorseGame;
    if (!r || !r.realityCheckMinutes || !el.rc.hidden || !S.session) return;
    var now = G ? G.now() : Date.now(), every = r.realityCheckMinutes * 60000, last;
    try { last = +sessionStorage.getItem('hr.rc') || r.startedAt; } catch (e) { last = r.startedAt; }
    if (now - last < every) return;
    var mins = Math.round((now - r.startedAt) / 60000), net = r.paid - r.staked;
    el.rcTxt.textContent = 'You have been playing for ' + mins + ' minutes. This session you bet ' + money(r.staked) + ' and won ' + money(r.paid) + ' (' + (net >= 0 ? '+' : '-') + money(Math.abs(net)) + ').';
    el.rcLeave.hidden = !me.returnUrl; el.rc.hidden = false;
  }
  function initReality() {
    el.rcGo.addEventListener('click', function () { try { sessionStorage.setItem('hr.rc', String(window.HorseGame ? window.HorseGame.now() : Date.now())); } catch (e) { /* ignore */ } el.rc.hidden = true; });
    el.rcLeave.addEventListener('click', function () { if (S.me && S.me.returnUrl) location.href = S.me.returnUrl; });
    setInterval(realityCheck, 5000);
  }

  /* ---------- slide-over panel: open / hide from the right edge ---------- */
  var panelOpen = true, wasBetting = null;
  function setPanel(open) {
    panelOpen = open;
    el.bet.classList.toggle('closed', !open); el.tab.classList.toggle('open', open); el.tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    tabLabel();
  }
  // the panel opens by itself when betting opens and hides when betting closes; the tab still toggles it by hand in between
  function autoPanel() {
    if (guest) return;                                               // a visitor without a session: the panel stays open (they can still hide it by hand)
    var G = window.HorseGame, st = G && G.state(), r = st && st.round;
    if (!r) return;
    var betting = r.phase === 'betting' && G.now() < r.betCloseAt;
    if (betting !== wasBetting) { wasBetting = betting; if (panelOpen !== betting) setPanel(betting); }
  }
  function tabLabel() {
    var G = window.HorseGame, st = G && G.state(), r = st && st.round, left = r && r.phase === 'betting' ? Math.ceil((r.betCloseAt - G.now()) / 1000) : 0;
    el.tab.textContent = panelOpen ? 'HIDE \u25B8' : left > 0 ? '\u25C2 BET ' + left + 'S' : '\u25C2 BET';
    el.tab.classList.toggle('attn', !panelOpen && left > 0);
  }
  function initPanel() {
    el.tab.hidden = false; setPanel(panelOpen); initReality(); el.histBtn.addEventListener('click', toggleHistory);
    el.tab.addEventListener('click', function () { setPanel(!panelOpen); });
    // a tap or click outside the open panel closes it (not on the tab itself, nor on the start and reality-check screens)
    document.addEventListener('pointerdown', function (e) {
      if (!panelOpen || guest || e.target.closest('#bet, #betTab, #start, #bReality')) return;
      setPanel(false);
    }, true);
    var x0 = null, y0 = 0;                                           // swipe right on the panel to hide, left from the screen edge to show
    var pt = function (t) { return window.HorseOrient ? window.HorseOrient.point(t) : { x: t.clientX, y: t.clientY, w: window.innerWidth }; };
    document.addEventListener('touchstart', function (e) { var t = pt(e.touches[0]); x0 = t.x; y0 = t.y; }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (x0 === null) return; var t = pt(e.changedTouches[0]), dx = t.x - x0, dy = t.y - y0, edge = x0 > t.w - 40; x0 = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (panelOpen && !guest && dx > 0 && el.bet.contains(e.target)) setPanel(false);
      else if (!panelOpen && dx < 0 && edge) setPanel(true);
    }, { passive: true });
    setInterval(function () { autoPanel(); tabLabel(); }, 250);
  }

  /* ---------- start ---------- */
  function start(st) {
    S.rules = st.rules; S.currency = st.rules.currency;
    el.layout.classList.add('live'); document.body.classList.add('live'); el.bet.hidden = false;
    build(); render(); initPanel();
    var token = qs.get('token');
    if (token) {
      history.replaceState(null, '', location.pathname);                  // never leave the launch token in the address bar
      api('POST', 'api/auth', { token: token, client: qs.get('client') || undefined }).then(function (res) {
        if (res.data.ok) { setGuest(false); S.session = res.data.session; S.currency = res.data.currency || S.currency; try { sessionStorage.setItem('hr.session', S.session); } catch (e) { /* ignore */ } refresh(); }
        else needLaunch(ERRORS[res.data.error] || ERRORS.INVALID_TOKEN);
      }).catch(function () { needLaunch('Cannot reach the game server.'); });
    } else {
      try { S.session = sessionStorage.getItem('hr.session'); } catch (e) { /* ignore */ }
      if (S.session) { setGuest(false); refresh(); } else needLaunch(LOBBY_HINT);
    }
    setInterval(refresh, 1500);
    setInterval(render, 250);
  }

  fetch('api/public', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) { if (st && st.mode === 'live') start(st); }).catch(function () { /* demo / offline */ });
})();
