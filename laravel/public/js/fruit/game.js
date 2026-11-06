/* Fruit Game: the page's logic. The server decides the result (POST /play: the rounds of the spin; POST /round/{id}/double: the double-up number); this shows it: a light runs round
   the ring and stops on the cells the server chose. Nothing here decides a result. */
(function () {
  'use strict';
  var T = window.FruitTable, A = window.FruitArt, Anim = window.FruitAnim, Api = window.FruitApi, Fair = window.FruitFair, Snd = window.FruitSound;
  var $ = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var S = { take: 0, bonusBase: 0, shown: 0, sc: 1, state: null, bets: {}, credit: 0, creditIdx: 0, steps: [], busy: false, balance: 0, requestId: null, round: null, cursor: 0, lobby: '', history: [] };
  var ERR = {
    SESSION_EXPIRED: 'Your session has ended. Open the game again from your account.', WRONG_GAME: 'This session belongs to another game.', GAME_NOT_ENABLED: 'This game is not available for your account.',
    GAME_NOT_CONFIGURED: 'This game is not set up yet.', PLAYER_BLOCKED: 'Your account cannot play right now.', BAD_BET: 'That bet is not allowed.', DAILY_LOSS_LIMIT: 'Your daily loss limit would be passed.',
    INSUFFICIENT_FUNDS: 'Not enough balance.', WALLET_REJECTED: 'The wallet refused the stake. Nothing was charged.', WALLET_UNAVAILABLE: 'The wallet did not answer. The spin did not happen; any charge is returned.',
    TOO_FAST: 'A moment, please. Wait a second between spins.', TOO_MANY_REQUESTS: 'Another action is still running. Try again.', ROUND_VOID: 'That spin did not happen. Nothing was charged.',
    NOT_OPEN: 'That win was already collected.', NO_DOUBLE: 'This win cannot be doubled any more.', ROUND_OPEN: 'Collect your win first.', BAD_CLIENT_SEED: 'Seed: 1 to 64 letters, digits, - or _.', ERROR: 'Something went wrong.'
  };
  var el = {};
  ['ring', 'center', 'cLabel', 'cValue', 'cSub', 'cBtns', 'btnSmall', 'btnBig', 'btnCollect', 'bets', 'balance', 'total', 'lastWin', 'creditVal', 'creditDown', 'creditUp', 'btnClear', 'btnRepeat',
    'btnRules', 'btnFair', 'btnSound', 'btnHelp', 'btnLeft', 'btnRight', 'bonus', 'balLbl', 'dBonus', 'tour', 'tourHole', 'tourText', 'tourArrow', 'tourSkip', 'btnLobby', 'play', 'banner', 'note', 'gate', 'gateTitle', 'gateText', 'gateLink', 'stage', 'rules', 'fair', 'rulesPays', 'rulesLimits',
    'fairCommit', 'fairClient', 'fairPlays', 'fairNewSeed', 'fairRotate', 'fairOut', 'fairList'].forEach(function (k) { el[k] = $(k); });
  var view = window.FruitView.create(el.ring);
  var scene = { lights: [], lit: {}, wins: {}, bets: {}, flash: null, time: 0 };

  /* ---------- money and texts ---------- */
  function dec() { return S.state ? S.state.decimals : 2; }
  function fmt(minor) { var d = dec(); return (minor / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function money(minor) { return (S.state && S.state.currency ? S.state.currency + ' ' : '') + fmt(minor); }
  // CREDIT shows the balance (and the part of the win the player has moved over with the arrows); BONUS-WIN shows the win that is still in hand
  function showMoney() { el.balance.textContent = fmt(S.shown + S.take); el.bonus.textContent = fmt(Math.max(0, S.bonusBase - S.take)); }
  function setBalance(v) { S.shown = v; showMoney(); }
  function setBonus(v) { S.bonusBase = v; showMoney(); }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function setCenter(label, value, sub, cls) { S.msgHold = label !== 'BET'; el.cLabel.textContent = label; el.cValue.textContent = value; el.cSub.textContent = sub || ''; el.center.className = 'center' + (cls ? ' ' + cls : ''); }
  var noteTimer = null;
  function note(msg, ok, ms) {
    clearTimeout(noteTimer);
    if (!msg) { el.note.hidden = true; return; }
    el.note.textContent = msg; el.note.className = 'note' + (ok ? ' ok' : ''); el.note.hidden = false;
    if (ms !== 0) noteTimer = setTimeout(function () { el.note.hidden = true; }, ms || 5000);
  }
  function gate(title, text, link) { el.gateTitle.textContent = title; el.gateText.textContent = text; el.gateLink.hidden = !link; el.gate.hidden = false; }
  function errText(e) { return e && e.network ? 'No connection to the game server.' : (ERR[e && e.error] || ERR.ERROR); }

  /* ---------- the scene ---------- */
  function render(now) {
    scene.time = now;
    scene.bets = S.bets;
    view.draw(scene);
    requestAnimationFrame(render);
  }
  function symbolOf(cell) { return T.cells[cell].symbol; }
  function cellPay(cell) { var p = S.state && S.state.paytable.ring[cell]; return p ? p.pay : 0; }
  /** credits won by the cells of one round on the bets of this spin */
  function roundWin(cells, bets) { var t = 0; cells.forEach(function (c) { t += (bets[symbolOf(c)] || 0) * cellPay(c); }); return t; }

  /* ---------- bets ---------- */
  function credits() { var n = 0; T.SYMBOLS.forEach(function (s) { n += S.bets[s] || 0; }); return n; }
  function stake() { return credits() * S.credit; }
  function betsUi() {
    if (!el.bets.children.length) return;
    T.SYMBOLS.forEach(function (s) {
      var b = $('bet-' + s), n = S.bets[s] || 0;
      b.classList.toggle('on', n > 0); b.querySelector('.n').textContent = n ? n : '';
      b.disabled = S.busy;
    });
    el.total.textContent = fmt(stake());
    if (!S.busy && !S.round && !S.msgHold) setCenter('BET', fmt(stake()), credits() ? credits() + ' credits' : 'Choose your fruits and press START');
    el.btnClear.disabled = S.busy || !credits(); el.btnRepeat.disabled = S.busy || !S.lastBets;
    el.play.disabled = S.busy || !S.state || (!credits() && !S.round);
    try { localStorage.setItem('fr.bets', JSON.stringify(S.bets)); } catch (e) { /* ignore */ }
  }
  function buildBets() {
    el.bets.innerHTML = '';
    T.SYMBOLS.forEach(function (s) {
      var b = document.createElement('button'); b.type = 'button'; b.className = 'bet'; b.id = 'bet-' + s; b.setAttribute('aria-label', 'Bet on ' + s);
      b.innerHTML = '<svg viewBox="0 0 48 48">' + A.symbol(s) + '</svg><span class="pay">×' + ((S.state && S.state.paytable.pays[s]) || '') + '</span><span class="n"></span>';
      var timer = null, held = false;
      b.addEventListener('pointerdown', function () { held = false; clearTimeout(timer); timer = setTimeout(function () { held = true; if (!S.busy) { S.bets[s] = 0; S.msgHold = false; Snd.click(); betsUi(); } }, 550); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) { b.addEventListener(ev, function () { clearTimeout(timer); }); });
      b.addEventListener('click', function () { if (held) { held = false; return; } addBet(s); });
      el.bets.appendChild(b);
    });
  }
  function addBet(s) {
    if (S.busy || !S.state) return;
    var lim = S.state.limits, n = S.bets[s] || 0;
    if (S.round) { note('Collect your win first, or press START to collect it and spin again.', false, 3500); return; }
    if (n >= lim.maxCreditsPerSymbol || credits() >= lim.maxCredits) { note('That is the most you can bet on ' + (n >= lim.maxCreditsPerSymbol ? 'one fruit' : 'the ring') + '.', false, 2500); return; }
    if ((credits() + 1) * S.credit > lim.maxBet) { note('The most you can bet is ' + money(lim.maxBet) + '.', false, 2500); return; }
    S.bets[s] = n + 1; S.msgHold = false; Snd.click(); betsUi();
  }
  function buildSteps(min, max) {
    var out = {}, mult = [1, 2, 5], p = 1, i, v, lo = Math.max(1, Math.floor(min / 10));
    for (; p <= max; p *= 10) for (i = 0; i < 3; i++) { v = mult[i] * p; if (v >= lo && v <= max) out[v] = true; }
    out[Math.max(1, min)] = true;
    return Object.keys(out).map(Number).sort(function (a, b) { return a - b; });
  }
  function setCredit(i) {
    i = Math.max(0, Math.min(S.steps.length - 1, i)); S.creditIdx = i; S.credit = S.steps[i];
    el.creditVal.textContent = fmt(S.credit);
    el.creditDown.disabled = S.busy || i === 0; el.creditUp.disabled = S.busy || i === S.steps.length - 1;
    try { localStorage.setItem('fr.credit', String(S.credit)); } catch (e) { /* ignore */ }
    betsUi();
  }
  function lockControls(b) { S.busy = b; el.btnCollect.disabled = b; setCredit(S.creditIdx || 0); controlsUi(); }
  /** the arrows and SMALL / BIG work only while a win is in hand and can be doubled */
  function controlsUi() {
    var r = S.round, can = !!(r && r.canDouble) && !S.busy, max = r ? r.held - S.credit : 0;
    el.btnSmall.disabled = el.btnBig.disabled = !can;
    el.btnRight.disabled = !can || S.take + S.credit > max;
    el.btnLeft.disabled = !can || S.take <= 0;
  }
  function stepTake(dir) {
    var r = S.round; if (!r || !r.canDouble || S.busy) return false;
    var max = Math.max(0, r.held - S.credit), t = Math.max(0, Math.min(max, S.take + dir * S.credit));
    if (t === S.take) return false;
    S.take = t; Snd.click(); showMoney(); controlsUi();
    setCenter('WIN', fmt(r.held - S.take), S.take ? fmt(S.take) + ' moved to your credit' : 'Double ' + (r.doubles.length + 1) + ' of 3?', 'good');
    return true;
  }

  /* ---------- the spin ---------- */
  function newRequestId() {
    var a = new Uint8Array(12), s = '', i;
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return 'r' + s;
  }
  // sends the spin; when the answer is lost the SAME request id is sent again (the server then returns the spin that exists and never debits twice)
  function sendPlay(bets, credit, requestId, tries) {
    return Api.play(bets, credit, requestId).catch(function (e) {
      if (e && e.network && tries < 4) { note('Checking your spin...', false, 0); return wait(2500).then(function () { return sendPlay(bets, credit, requestId, tries + 1); }); }
      if (e && e.error === 'ROUND_IN_PROGRESS' && tries < 8) return wait(1500).then(function () { return sendPlay(bets, credit, requestId, tries + 1); });
      throw e;
    });
  }
  /** plays the light of a spin on the ring; resolves when it has stopped on the last cell */
  function showSpin(round, fast) {
    return new Promise(function (resolve) {
      var plan = Anim.plan(round.rounds, { start: S.cursor, speed: fast ? 3 : 1 }), t0 = performance.now(), idx = 0, lastRound = -1, running = 0, lastCell = -1, kind = '';
      scene.wins = {}; scene.lit = {}; scene.flash = null; S.take = 0; setBonus(0);
      (function frame() {
        var now = performance.now() - t0;
        while (idx < plan.events.length && plan.events[idx].at <= now) {
          var e = plan.events[idx++];
          if (e.round !== lastRound) {
            lastRound = e.round; scene.lit = {}; scene.flash = null;
            if (e.round > 0) setCenter(kind === 'free3' ? 'FREE SPIN ' + e.round + ' OF 3' : 'FREE SPIN', fmt(running * S.credit), e.lights.length > 1 ? '3 lights' : '', 'roll');
          }
          if (e.type === 'run') { scene.lights = e.lights; if (!fast && e.lights.length === 1 && e.lights[0] !== lastCell) { Snd.tick(false); } lastCell = e.lights[0]; }
          else if (e.type === 'land') {
            scene.lights = []; scene.lit = {};
            e.lights.forEach(function (c) { scene.lit[c] = true; if (cellPay(c) > 0 && (round.bets[symbolOf(c)] || 0) > 0) scene.wins[c] = true; });
            var w = roundWin(e.lights, round.bets); running += w; setBonus(running * S.credit);
            if (e.round === 0 && T.cells[e.lights[0]].symbol === 'lucky') { kind = T.cells[e.lights[0]].kind; Snd.lucky(); setCenter('LUCKY!', kind === 'free3' ? '3 SPINS' : '3 LIGHTS', 'free spins on your bets', 'good'); }
            else { if (w > 0) Snd.land(); setCenter(e.round > 0 ? 'FREE SPIN' : 'SPIN', running ? fmt(running * S.credit) : '', running ? 'you win' : '', running ? 'good' : ''); }
          } else if (e.type === 'lucky') { scene.flash = e.lights[0]; }
        }
        if (now >= plan.duration + 350) { scene.lights = []; scene.flash = null; S.cursor = round.rounds[round.rounds.length - 1].slice(-1)[0]; resolve(); return; }
        requestAnimationFrame(frame);
      })();
    });
  }
  function winSymbols(round) { var o = {}; T.SYMBOLS.forEach(function (s) { if ((round.bets[s] || 0) > 0 && round.payouts[s] > 0) o[s] = true; }); return o; }
  function markWinners(round) { var w = winSymbols(round); T.SYMBOLS.forEach(function (s) { $('bet-' + s).classList.toggle('won', !!w[s]); }); }
  function clearWinners() { T.SYMBOLS.forEach(function (s) { $('bet-' + s).classList.remove('won'); }); }

  function start() {
    if (S.busy || !S.state) return;
    if (S.round) return collect().then(function () { if (credits()) start(); });          // a win is still held: it is collected before the next spin
    var lim = S.state.limits, st = stake();
    if (!credits()) { note('Bet on at least one fruit.', false, 2500); return; }
    if (st < lim.minBet) { note('The smallest bet is ' + money(lim.minBet) + '. Add credits or raise the credit value.', false, 4000); return; }
    if (st > lim.maxBet) { note('The biggest bet is ' + money(lim.maxBet) + '.', false, 4000); return; }
    Snd.click(); lockControls(true); note(null); el.banner.hidden = true; clearWinners();
    var before = S.balance, bets = {}, rid;
    T.SYMBOLS.forEach(function (s) { if (S.bets[s]) bets[s] = S.bets[s]; });
    S.requestId = S.requestId || newRequestId(); rid = S.requestId;
    setCenter('SPIN', fmt(st), 'placing your bet'); setBalance(before - st);
    sendPlay(bets, S.credit, rid, 0).then(function (res) {
      S.requestId = null; note(null); S.balance = res.balance; setBalance(res.balance);
      S.lastBets = bets;
      return showSpin(res.round, false).then(function () { return afterSpin(res.round, res); });
    }).catch(function (e) {
      S.requestId = null; setBalance(before); setCenter('BET', fmt(stake()), 'Choose your fruits and press START');
      note(errText(e), false, 7000); Snd.error();
      if (e && e.error === 'SESSION_EXPIRED') { Api.clearSession(); return viaAccount().then(function () { note('Your session was renewed. Press START again.', true, 6000); }, function () { gate('SESSION ENDED', ERR.SESSION_EXPIRED, true); }); }
      return refresh();
    }).then(function () { lockControls(false); }).catch(function () { lockControls(false); });
  }
  function afterSpin(round, res) {
    markWinners(round);
    if (round.status === 'open') { S.round = round; showOpen(round); return Promise.resolve(); }
    Snd.lose(); setCenter('NO WIN', '', 'Try again', 'bad');
    return Api.seen(round.id).catch(function () { /* shown again later, harmless */ });
  }

  /* ---------- a win in hand: double up or collect ---------- */
  function showOpen(round) {
    var n = round.doubles.length;
    S.take = 0; setBonus(round.held);
    setCenter('WIN', fmt(round.held), round.canDouble ? 'Double ' + (n + 1) + ' of 3?  Small 1-7 or Big 8-14' : 'Collect your win', n ? 'good' : '');
    el.cBtns.hidden = false;
    el.btnCollect.textContent = 'COLLECT ' + fmt(round.held);
    el.play.textContent = 'START'; betsUi(); controlsUi();
    if (n === 0) Snd.win(round.held >= 10 * S.credit * Math.max(1, credits()));
  }
  function hideOpen() { el.cBtns.hidden = true; S.round = null; S.take = 0; setBonus(0); betsUi(); controlsUi(); }
  function settleBalance(res) { S.balance = res.balance; S.take = 0; setBalance(res.balance + (res.round.creditPendingAmount || 0)); }

  function collect() {
    if (S.busy || !S.round) return Promise.resolve();
    var round = S.round; S.take = 0; lockControls(true); Snd.click();
    return Api.collect(round.id).then(function (res) {
      settleBalance(res); el.lastWin.textContent = fmt(res.round.payout); hideOpen();
      setCenter('COLLECTED', fmt(res.round.payout), 'added to your balance', 'good'); Snd.win(false);
      return Api.seen(res.round.id).catch(function () {});
    }).catch(function (e) { note(errText(e), false, 5000); Snd.error(); return refresh().then(function (st) { return recover(st); }); }).then(function () { lockControls(false); });
  }

  function double(side) {
    if (S.busy || !S.round || !S.round.canDouble) return;
    var round = S.round, take = S.take; lockControls(true); el.cBtns.hidden = true; Snd.click();
    var req = Api.double(round.id, side, round.doubles.length, take);
    var rollEnd = performance.now() + 1100, label = side === 'small' ? 'SMALL' : 'BIG';
    setCenter(label + '?', '-', 'the number is coming', 'roll');
    (function roll() { if (performance.now() < rollEnd) { el.cValue.textContent = String(1 + Math.floor(Math.random() * 14)); Snd.tick(true); setTimeout(roll, 75); } })();
    return Promise.all([req, wait(1150)]).then(function (a) {
      var res = a[0], r = res.round, d = r.doubles[r.doubles.length - 1];
      S.round = r.status === 'open' ? r : null;
      settleBalance(res); setBonus(r.status === 'open' ? r.held : 0);
      setCenter(d.won ? 'RIGHT!' : 'WRONG', String(d.number), (d.side === 'small' ? 'Small' : 'Big') + (d.won ? ' · your win doubles' : ' · the win is lost'), d.won ? 'good' : 'bad');
      if (d.won) Snd.land(); else Snd.lose();
      if (r.status === 'open') return wait(900).then(function () { S.round = r; showOpen(r); });
      el.lastWin.textContent = fmt(r.payout); el.cBtns.hidden = true; S.round = null; betsUi(); controlsUi();
      return wait(900).then(function () {
        if (r.payout > 0) { setCenter('COLLECTED', fmt(r.payout), '3 in a row, paid to your balance', 'good'); Snd.win(true); } else setCenter('NO WIN', '', 'Try again', 'bad');
        return Api.seen(r.id).catch(function () {});
      });
    }).catch(function (e) {
      note(errText(e), false, 6000); Snd.error();
      return refresh().then(function (st) { return recover(st); });
    }).then(function () { lockControls(false); });
  }

  /* ---------- state and recovery ---------- */
  function applyState(st) {
    S.state = st; S.balance = st.balance;
    if (!S.busy) setBalance(st.balance);
    el.balLbl.textContent = 'CREDIT' + (st.currency ? ' ' + st.currency : '');
    var lim = st.limits || {}, min = lim.minBet || 1, max = lim.maxBet || min;
    if (!el.bets.children.length) buildBets();
    else T.SYMBOLS.forEach(function (s) { $('bet-' + s).querySelector('.pay').textContent = '×' + st.paytable.pays[s]; });
    S.steps = buildSteps(min, max);
    var want = 0; try { want = parseInt(localStorage.getItem('fr.credit'), 10) || 0; } catch (e) { /* ignore */ }
    var idx = S.steps.indexOf(want);
    if (idx < 0) idx = Math.max(0, S.steps.findIndex(function (v) { return v >= Math.max(min, 1); }));
    if (!S.credit || S.steps.indexOf(S.credit) < 0) setCredit(idx); else setCredit(S.creditIdx);
    fillRules(); fillFair();
  }
  function refresh(quiet) {
    return Api.state().then(function (st) { applyState(st); return st; }).catch(function (e) {
      if (quiet) throw e;
      if (e && e.error === 'SESSION_EXPIRED') gate('SESSION ENDED', ERR.SESSION_EXPIRED, true);
      else if (e && e.error === 'GAME_NOT_ENABLED') gate('NOT AVAILABLE', ERR.GAME_NOT_ENABLED, false);
      else if (e && e.error === 'GAME_NOT_CONFIGURED') gate('NOT AVAILABLE', ERR.GAME_NOT_CONFIGURED, false);
      else if (!S.state) gate('NO CONNECTION', errText(e), false);
      throw e;
    });
  }
  // after a reload or a lost answer: a win still held is shown again (the player can double or collect it); a spin that never finished is waited for
  function recover(st) {
    if (st.unfinished) { lockControls(true); note('Finishing your last spin...', false, 0); return wait(1500).then(refresh).then(recover); }
    if (st.open && st.last && st.last.status === 'open') {
      S.round = st.last; note(null);
      scene.lit = {}; scene.wins = {};
      st.last.rounds[st.last.rounds.length - 1].forEach(function (c) { scene.lit[c] = true; });
      S.cursor = st.last.rounds[st.last.rounds.length - 1].slice(-1)[0];
      Object.keys(st.last.bets || {}).forEach(function (s) { S.bets[s] = st.last.bets[s]; });
      showOpen(st.last); markWinners(st.last);
    } else {
      if (S.round) hideOpen();
      if (st.unseen && st.last && st.last.status === 'void') { note('Your last spin did not happen. Nothing was charged.', false, 6000); Api.seen(st.last.id).catch(function () {}); }
      if (st.last && st.last.status === 'settled') el.lastWin.textContent = fmt(st.last.payout);
    }
    lockControls(false); setBalance(S.balance);
    return Promise.resolve();
  }

  /* ---------- rules and fairness screens ---------- */
  function fillRules() {
    var st = S.state; if (!st) return;
    var pays = st.paytable.pays, rows = '';
    T.SYMBOLS.forEach(function (s) { rows += '<tr><td><svg viewBox="0 0 48 48">' + A.symbol(s) + '</svg>' + s.toUpperCase() + '</td><td>×' + pays[s] + '</td></tr>'; });
    rows += '<tr><td>BAR single plate</td><td>×' + st.paytable.bar50 + '</td></tr>';
    el.rulesPays.innerHTML = rows;
    var l = st.limits || {};
    el.rulesLimits.textContent = 'Stake from ' + money(l.minBet || 0) + ' to ' + money(l.maxBet || 0) + ', up to ' + l.maxCreditsPerSymbol + ' credits on a fruit and ' + l.maxCredits + ' in all. Published return to player: about ' + st.paytable.rtp + '% (paytable ' + st.paytable.id + '). The double-up is an even chance and does not change it.';
  }
  function fillFair() {
    var sd = S.state && S.state.seed; if (!sd) return;
    el.fairCommit.textContent = sd.commit; el.fairClient.textContent = sd.clientSeed; el.fairPlays.textContent = sd.plays + ' of ' + sd.rotatesAfter;
  }
  function loadHistory() {
    el.fairList.innerHTML = '<span class="mute">...</span>';
    Api.history(30).then(function (h) {
      if (!h.rounds.length) { el.fairList.innerHTML = '<span class="mute">No plays yet.</span>'; return; }
      el.fairList.innerHTML = h.rounds.map(function (r) {
        return '<div class="item"><span>#' + r.id + '</span><span>' + (r.status === 'void' ? 'VOID' : (r.doubles.length ? r.doubles.length + ' DOUBLE' + (r.doubles.length > 1 ? 'S' : '') : (r.payout ? 'WIN' : 'NO WIN'))) + '</span><span>' + fmt(r.stake) + ' &rarr; ' + fmt(r.payout) + '</span>' +
          (r.status === 'settled' ? '<span class="r"><button type="button" data-check="' + r.id + '">CHECK</button></span>' : '') + '</div>';
      }).join('');
      S.history = h.rounds;
    }).catch(function (e) { el.fairList.innerHTML = '<span class="bad">' + esc(errText(e)) + '</span>'; });
  }
  function check(id) {
    var r = (S.history || []).filter(function (x) { return x.id === id; })[0];
    el.fairOut.innerHTML = '<div class="box mute">Checking play #' + id + '...</div>';
    Api.proof(id).then(function (p) {
      return Fair.verify(r, p.proof).then(function (v) {
        el.fairOut.innerHTML = '<div class="box ' + (v.ok ? 'ok' : 'bad') + '"><b>PLAY #' + id + ': ' + (v.ok ? 'CHECKED, THE RESULT IS FAIR' : 'DOES NOT MATCH') + '</b><br>' +
          (v.problems.length ? esc(v.problems.join('; ')) + '<br>' : '') + 'server seed ' + esc(p.proof.serverSeed) + '<br>commit ' + esc(p.proof.commit) + '<br>client seed ' + esc(p.proof.clientSeed) + ' nonce ' + p.proof.nonce + '</div>';
      });
    }).catch(function (e) {
      el.fairOut.innerHTML = '<div class="box ' + (e && e.error === 'SEED_NOT_REVEALED' ? 'mute' : 'bad') + '">' +
        (e && e.error === 'SEED_NOT_REVEALED' ? 'The server seed of this play is still secret. Start a new seed to reveal it, then check again.' : esc(errText(e))) + '</div>';
    });
  }
  function rotate() {
    var seed = el.fairNewSeed.value.trim();
    el.fairRotate.disabled = true;
    Api.rotate(seed || null).then(function (res) {
      el.fairNewSeed.value = ''; fillFair();
      el.fairOut.innerHTML = '<div class="box ok">New seed started. The old server seed was revealed: ' + esc(res.revealed.serverSeed) + '</div>';
      return refresh().then(loadHistory);
    }).catch(function (e) { el.fairOut.innerHTML = '<div class="box bad">' + esc(errText(e)) + '</div>'; }).then(function () { el.fairRotate.disabled = false; });
  }
  function openSheet(name) { el[name].hidden = false; Snd.click(); if (name === 'fair') { fillFair(); loadHistory(); } }

  /* ---------- the way back to the lobby ---------- */
  function lobbyUi() {
    var u = S.lobby || '';
    if (u && !/^(https?:\/\/|\/(?!\/))/i.test(u)) u = '';
    el.btnLobby.hidden = !u; if (u) el.btnLobby.setAttribute('href', u);
  }
  function lobbyProbe() {
    fetch('/player/api/me', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { if (r.status === 200 && !S.lobby) { S.lobby = '/account'; lobbyUi(); } }, function () { /* ignore */ });
  }

  /* ---------- the help tour: what to tap, step by step (shown the first time, HELP shows it again, "click to skip" ends it) ---------- */
  var TOUR = [
    { to: ['bets'], text: 'Tap the fruits to bet', arrow: 'down' },
    { to: ['play'], text: 'Tap START to play', arrow: 'down' },
    { to: ['dBonus'], text: 'You win coins: they wait in BONUS-WIN', arrow: 'up' },
    { to: ['btnLeft', 'btnRight'], text: 'Tap the left / right arrow to move part of your win to CREDIT. That part is safe.', arrow: 'down' },
    { to: ['btnSmall', 'btnBig'], text: 'Tap SMALL (1-7) or BIG (8-14) to double what is left in BONUS-WIN', arrow: 'down' },
    { to: ['dBonus'], text: 'Right: you win x2. Wrong: all the win in BONUS-WIN is lost.', arrow: 'up' }
  ];
  var tourAt = -1;
  function tourShow() {
    var st = TOUR[tourAt], fr = $('frame').getBoundingClientRect(), sc = S.sc || 1, x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9;
    st.to.forEach(function (id) { var r = $(id).getBoundingClientRect(); x1 = Math.min(x1, r.left); y1 = Math.min(y1, r.top); x2 = Math.max(x2, r.right); y2 = Math.max(y2, r.bottom); });
    var x = (x1 - fr.left) / sc - 4, y = (y1 - fr.top) / sc - 4, w = (x2 - x1) / sc + 8, h = (y2 - y1) / sc + 8, H = fr.height / sc;
    el.tourHole.style.cssText = 'left:' + x + 'px;top:' + y + 'px;width:' + w + 'px;height:' + h + 'px';
    el.tourText.textContent = st.text;
    el.tourArrow.textContent = st.arrow === 'down' ? '\u25BC' : '\u25B2';
    var cx = x + w / 2 - 20;
    el.tourArrow.style.left = Math.max(6, Math.min(390 - 80, cx)) + 'px';
    if (st.arrow === 'down') { el.tourArrow.style.top = (y - 38) + 'px'; el.tourText.style.top = Math.max(40, y - 38 - 90) + 'px'; }
    else { el.tourArrow.style.top = (y + h + 4) + 'px'; el.tourText.style.top = (y + h + 42) + 'px'; }
  }
  function tourEnd() { el.tour.hidden = true; tourAt = -1; try { localStorage.setItem('fr.tour', '1'); } catch (e) { /* ignore */ } }
  function startTour(force) {
    if (!force) { try { if (localStorage.getItem('fr.tour')) return; } catch (e) { /* ignore */ } }
    if (!S.state || !el.gate.hidden) return;
    var st = $('start');
    if (st && !st.hidden && getComputedStyle(st).display !== 'none') { setTimeout(function () { startTour(force); }, 400); return; }       // wait for the tap-to-play screen to go
    tourAt = 0; el.tour.hidden = false; tourShow();
  }
  el.tour.addEventListener('click', function (ev) {
    if (ev.target === el.tourSkip) return tourEnd();
    tourAt++; if (tourAt >= TOUR.length) return tourEnd();
    tourShow();
  });

  /* ---------- wiring ---------- */
  el.creditUp.addEventListener('click', function () { S.msgHold = false; Snd.click(); setCredit(S.creditIdx + 1); });
  el.creditDown.addEventListener('click', function () { S.msgHold = false; Snd.click(); setCredit(S.creditIdx - 1); });
  el.btnClear.addEventListener('click', function () { S.bets = {}; S.msgHold = false; Snd.click(); betsUi(); });
  el.btnRepeat.addEventListener('click', function () { if (S.busy || S.round || !S.lastBets) return; S.bets = JSON.parse(JSON.stringify(S.lastBets)); S.msgHold = false; Snd.click(); betsUi(); });
  el.play.addEventListener('click', start);
  function hold(btn, dir) {
    var t1 = null, t2 = null, fired = false;
    function stop() { clearTimeout(t1); clearInterval(t2); }
    btn.addEventListener('pointerdown', function (ev) { ev.preventDefault(); fired = false; stepTake(dir); t1 = setTimeout(function () { t2 = setInterval(function () { if (!stepTake(dir)) stop(); }, 90); }, 420); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (e) { btn.addEventListener(e, stop); });
  }
  hold(el.btnRight, 1); hold(el.btnLeft, -1);
  el.btnSmall.addEventListener('click', function () { double('small'); });
  el.btnBig.addEventListener('click', function () { double('big'); });
  el.btnCollect.addEventListener('click', collect);
  el.btnRules.addEventListener('click', function () { openSheet('rules'); });
  el.btnFair.addEventListener('click', function () { openSheet('fair'); });
  el.btnHelp.addEventListener('click', function () { startTour(true); });
  el.btnSound.addEventListener('click', function () { Snd.setOn(!Snd.isOn()); Snd.unlock(); el.btnSound.classList.toggle('off', !Snd.isOn()); });
  el.btnSound.classList.toggle('off', !Snd.isOn());
  document.addEventListener('click', function (ev) {
    var c = ev.target.closest && ev.target.closest('[data-close]'); if (c) { el[c.getAttribute('data-close')].hidden = true; return; }
    var k = ev.target.closest && ev.target.closest('[data-check]'); if (k) check(parseInt(k.getAttribute('data-check'), 10));
  });
  el.fairRotate.addEventListener('click', rotate);
  var startEl = $('start');
  if (startEl) startEl.addEventListener('click', function () { Snd.unlock(); });
  document.addEventListener('pointerdown', function () { Snd.unlock(); }, { once: true });
  try { S.bets = JSON.parse(localStorage.getItem('fr.bets') || '{}') || {}; } catch (e) { S.bets = {}; }
  T.SYMBOLS.forEach(function (s) { if (!(S.bets[s] > 0)) delete S.bets[s]; });
  lobbyProbe();

  /* ---------- start ---------- */
  // a signed-in player of the operator's own site needs no token: the account gives the page a one-time launch token (a platform's launch link still carries its own)
  function viaAccount() {
    return Api.accountLaunch().then(function (l) { return Api.auth(l.token, l.client); }).then(function (res) { S.lobby = res.returnUrl || '/account'; lobbyUi(); Api.setSession(res.session); applyState(res); return res; });
  }
  function begin() {
    var token = qs.get('token'), first;
    if (token) {
      history.replaceState(null, '', location.pathname + (qs.get('start') === '0' ? '?start=0' : ''));      // never leave the launch token in the address bar
      first = Api.auth(token, qs.get('client')).then(function (res) { S.lobby = res.returnUrl || S.lobby || ''; lobbyUi(); Api.setSession(res.session); applyState(res); return res; });
    } else if (Api.hasSession()) {
      first = refresh(true).catch(function (e) { if (e && e.error === 'SESSION_EXPIRED') { Api.clearSession(); return viaAccount(); } throw e; });
    } else {
      first = viaAccount();
    }
    first.then(function () { return Api.state(); }).then(function (st) { applyState(st); return recover(st); }).then(function () { setTimeout(function () { startTour(false); }, 500); }).catch(function (e) {
      if (e && e.noAccount) gate('FRUIT GAME', 'Sign in to play.', true);
      else if (e && e.status) {
        if (e.error === 'SESSION_EXPIRED' || e.error === 'INVALID_TOKEN') { Api.clearSession(); gate('SESSION ENDED', e.error === 'INVALID_TOKEN' ? 'This link was already used or has expired. Open the game again from your account.' : ERR.SESSION_EXPIRED, true); }
        else gate('NOT AVAILABLE', errText(e), false);
      } else gate('NO CONNECTION', errText(e), false);
    });
  }
  // the design is 390 px wide (a phone): the whole stage is scaled to the window
  function fit() {
    var w = window.innerWidth, h = (window.visualViewport && window.visualViewport.height) || window.innerHeight, sc = Math.min(w / 390, h / 760);
    if (!(sc > 0)) return;
    S.sc = sc; el.stage.style.setProperty('--s', sc);
    el.stage.style.height = Math.round(h / sc) + 'px';
  }
  var fitSoon = function () { requestAnimationFrame(fit); setTimeout(fit, 300); };
  window.addEventListener('resize', fitSoon); window.addEventListener('orientationchange', fitSoon); if (window.visualViewport) window.visualViewport.addEventListener('resize', fitSoon);
  fitSoon(); fit();
  lockControls(true);
  requestAnimationFrame(render);
  begin();
})();
