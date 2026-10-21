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
    prog: $('bProg'), pay: $('bPay'), info: $('bInfo'), msg: $('bMsg'), grid: $('bGrid'), legend: $('bLegend'), chips: $('bChips'), clear: $('bClear'), rebet: $('bRebet'),
    place: $('bPlace'), total: $('bTotal'), placed: $('bPlaced'), last: $('bLast'), fair: $('bFair'), back: $('bBack'), tab: $('betTab') };

  var ERRORS = {
    BETTING_CLOSED: 'Betting is closed for this race.', INSUFFICIENT_FUNDS: 'Not enough balance for that bet.',
    MAX_BET_EXCEEDED: 'That is above the maximum bet for one combination.', MAX_ROUND_STAKE_EXCEEDED: 'That is above the maximum total bet for one race.',
    BAD_BET: 'That bet is not allowed (check the minimum and maximum).', TOO_MANY_REQUESTS: 'Slow down a little and try again.',
    WALLET_UNAVAILABLE: 'The wallet is not responding. Your balance was not changed, please try again.', WALLET_REJECTED: 'The wallet rejected the bet.',
    SESSION_EXPIRED: 'Your session has expired. Please open the game again from the lobby.', INVALID_TOKEN: 'This launch link is invalid or has expired. Please open the game again from the lobby.'
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(minor) { return (minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
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
  }

  /* ---------- build ---------- */
  function short(minor) { return minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2); }

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
    var base = r.minBet, vals = [1, 5, 10, 50, 100, 500].map(function (m) { return m * base; }).filter(function (v) { return v <= r.maxBet; });
    S.chip = vals[0];
    el.chips.innerHTML = vals.map(function (v, i) { return '<button type="button" class="chipbtn' + (i ? '' : ' sel') + '" data-v="' + v + '">' + fmt(v) + '</button>'; }).join('');
    el.pay.textContent = 'ANY ORDER - A WINNING PAIR PAYS STAKE x ODDS (STAKE INCLUDED). THE ODDS ARE SHUFFLED EVERY RACE.';

    el.grid.addEventListener('click', function (ev) {
      var minus = ev.target.closest('.minus'), t = ev.target.closest('.cell'); if (!t || t.disabled) return;
      var c = t.dataset.c, cur = S.pending[c] || 0, placed = placedBy()[c] || 0;
      if (minus) { cur = Math.max(0, cur - S.chip); } else { cur = Math.min(cur + S.chip, S.rules.maxBet - placed); }
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
      S.pending = {}; l.bets.forEach(function (b2) { S.pending[b2.combo] = Math.min((S.pending[b2.combo] || 0) + b2.stake, S.rules.maxBet); }); render();
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
    var lowSet = {}; if (round && round.cheapPairs && round.cheapRtp < round.rtp - 0.0005) round.cheapPairs.forEach(function (c) { lowSet[c] = true; });
    if (round && round.rtp) {
      el.info.textContent = 'RTP ' + (round.rtp * 100).toFixed(1) + '%' + 
        (Object.keys(lowSet).length ? ' - THE 3 CELLS MARKED \u25BE (LOWEST ODDS) RETURN ' + (round.cheapRtp * 100).toFixed(1) + '%' : '');
    }
    for (i = 0; i < cells.length; i++) {
      var tl = cells[i], c = tl.dataset.c, p = S.pending[c] || 0, pl = placed[c] || 0;
      tl.disabled = !betting || !S.session || S.busy;
      tl.classList.toggle('on', p > 0 || pl > 0); tl.classList.toggle('pend', p > 0); tl.classList.toggle('low', !!lowSet[c]);
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

  /* ---------- slide-over panel: open / hide from the right edge ---------- */
  var panelOpen = true;
  try { if (localStorage.getItem('hr.panel') === '0') panelOpen = false; } catch (e) { /* ignore */ }
  function setPanel(open) {
    panelOpen = open;
    el.bet.classList.toggle('closed', !open); el.tab.classList.toggle('open', open); el.tab.setAttribute('aria-expanded', open ? 'true' : 'false');
    try { localStorage.setItem('hr.panel', open ? '1' : '0'); } catch (e) { /* ignore */ }
    tabLabel();
  }
  function tabLabel() {
    var G = window.HorseGame, st = G && G.state(), r = st && st.round, left = r && r.phase === 'betting' ? Math.ceil((r.betCloseAt - G.now()) / 1000) : 0;
    el.tab.textContent = panelOpen ? 'HIDE \u25B8' : left > 0 ? '\u25C2 BET ' + left + 'S' : '\u25C2 BET';
  }
  function initPanel() {
    el.tab.hidden = false; setPanel(panelOpen);
    el.tab.addEventListener('click', function () { setPanel(!panelOpen); });
    var x0 = null, y0 = 0;                                           // swipe right on the panel to hide, left from the screen edge to show
    document.addEventListener('touchstart', function (e) { var t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; }, { passive: true });
    document.addEventListener('touchend', function (e) {
      if (x0 === null) return; var t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0, edge = x0 > window.innerWidth - 40; x0 = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (panelOpen && dx > 0 && el.bet.contains(e.target)) setPanel(false);
      else if (!panelOpen && dx < 0 && edge) setPanel(true);
    }, { passive: true });
    setInterval(tabLabel, 500);
  }

  /* ---------- start ---------- */
  function start(st) {
    S.rules = st.rules; S.currency = st.rules.currency;
    el.layout.classList.add('live'); document.body.classList.add('live'); el.bet.hidden = false;
    build(); render(); initPanel();
    var token = qs.get('token');
    if (token) {
      history.replaceState(null, '', location.pathname);                  // never leave the launch token in the address bar
      api('POST', 'api/auth', { token: token }).then(function (res) {
        if (res.data.ok) { S.session = res.data.session; S.currency = res.data.currency || S.currency; try { sessionStorage.setItem('hr.session', S.session); } catch (e) { /* ignore */ } refresh(); }
        else needLaunch(ERRORS[res.data.error] || ERRORS.INVALID_TOKEN);
      }).catch(function () { needLaunch('Cannot reach the game server.'); });
    } else {
      try { S.session = sessionStorage.getItem('hr.session'); } catch (e) { /* ignore */ }
      if (S.session) refresh(); else needLaunch('Open this game from the lobby to place bets. You can still watch the races.');
    }
    setInterval(refresh, 1500);
    setInterval(render, 250);
  }

  fetch('api/public', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (st) { if (st && st.mode === 'live') start(st); }).catch(function () { /* demo / offline */ });
})();
