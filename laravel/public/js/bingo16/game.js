/* Bingo Pinball 16: the page's logic. The server decides the result (POST /play: 16 balls and 5 jackpot numbers); this shows it: the balls are fired one after another and travel
   along stored paths to the slot the server chose. The plunger changes how the launch looks and which stored path is used; it never changes the result. */
(function () {
  'use strict';
  var T = window.BingoTable16, Api = window.Bingo16Api, Paths = window.Bingo16Paths, Fair = window.Bingo16Fair, Snd = window.BingoSound;
  var $ = function (id) { return document.getElementById(id); };
  var qs = new URLSearchParams(location.search);
  var S = { state: null, stake: 0, steps: [], busy: false, balance: 0, shownBalance: 0, requestId: null, scene: null, sparks: [], pinFlash: {}, caught: [] };
  var ERR = {
    SESSION_EXPIRED: 'Your session has ended. Open the game again from your account.', WRONG_GAME: 'This session belongs to another game.', GAME_NOT_ENABLED: 'This game is not available for your account.',
    GAME_NOT_CONFIGURED: 'This game is not set up yet.', PLAYER_BLOCKED: 'Your account cannot play right now.', BAD_BET: 'That stake is not allowed.', DAILY_LOSS_LIMIT: 'Your daily loss limit would be passed.',
    INSUFFICIENT_FUNDS: 'Not enough balance.', WALLET_REJECTED: 'The wallet refused the stake. Nothing was charged.', WALLET_UNAVAILABLE: 'The wallet did not answer. The play did not happen; any charge is returned.',
    TOO_FAST: 'A moment, please. Wait a few seconds between plays.', TOO_MANY_REQUESTS: 'Another action is still running. Try again.', ROUND_VOID: 'That play did not happen. Nothing was charged.',
    BAD_CLIENT_SEED: 'Seed: 1 to 64 letters, digits, - or _.', ERROR: 'Something went wrong.'
  };
  var el = {};
  ['board', 'card', 'jpRow', 'power', 'pays', 'jackpot', 'sub', 'ballsLeft', 'jpCount', 'msg', 'lastWin', 'balLbl', 'balance', 'stake', 'stakeUp', 'stakeDown', 'play', 'hint', 'banner', 'note', 'gate', 'gateTitle', 'gateText', 'gateLink', 'stage', 'rules', 'fair', 'btnRules', 'btnFair', 'btnSound',
    'rulesPays', 'rulesLimits', 'fairCommit', 'fairClient', 'fairPlays', 'fairNewSeed', 'fairRotate', 'fairOut', 'fairList'].forEach(function (k) { el[k] = $(k); });
  var view = window.Bingo16View.create({ board: el.board, card: el.card, jpRow: el.jpRow, power: el.power, pays: el.pays });

  /* ---------- money ---------- */
  function dec() { return S.state ? S.state.decimals : 2; }
  function fmt(minor) { var d = dec(); return (minor / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function money(minor) { return (S.state && S.state.currency ? S.state.currency + ' ' : '') + fmt(minor); }
  function setBalance(v) { S.shownBalance = v; el.balance.textContent = fmt(v); }
  function setMsg(t) { el.msg.textContent = t; }
  function ballsUi(left, total, k) { el.ballsLeft.textContent = left; if (k) setMsg('Ball ' + k + ' of ' + total); }
  function jpUi(n) { el.jpCount.textContent = n + '/5'; }

  /* ---------- messages ---------- */
  var noteTimer = null;
  function note(msg, ok, ms) {
    clearTimeout(noteTimer);
    if (!msg) { el.note.hidden = true; return; }
    el.note.textContent = msg; el.note.className = 'note' + (ok ? ' ok' : ''); el.note.hidden = false;
    if (ms !== 0) noteTimer = setTimeout(function () { el.note.hidden = true; }, ms || 5000);
  }
  function gate(title, text, link) { el.gateTitle.textContent = title; el.gateText.textContent = text; el.gateLink.hidden = !link; el.gate.hidden = false; }
  function errText(e) { return e && e.network ? 'No connection to the game server.' : (ERR[e && e.error] || ERR.ERROR); }

  /* ---------- stake ---------- */
  function buildSteps(min, max) {
    var out = {}, mult = [1, 2, 5], p = 1, i, v;
    for (; p <= max; p *= 10) for (i = 0; i < 3; i++) { v = mult[i] * p; if (v >= min && v <= max) out[v] = true; }
    out[min] = true; out[max] = true;
    return Object.keys(out).map(Number).sort(function (a, b) { return a - b; });
  }
  function setStake(i) {
    i = Math.max(0, Math.min(S.steps.length - 1, i)); S.stakeIdx = i; S.stake = S.steps[i];
    el.stake.textContent = fmt(S.stake);
    el.stakeDown.disabled = S.busy || i === 0; el.stakeUp.disabled = S.busy || i === S.steps.length - 1;
    try { localStorage.setItem('bp16.stake', String(S.stake)); } catch (e) { /* ignore */ }
  }
  function lockControls(b) { S.busy = b; el.play.disabled = b || !S.state; setStake(S.stakeIdx || 0); }

  /* ---------- the scene ---------- */
  var scene = { paytable: null, lit: {}, jpNums: [], jpLit: {}, lineCells: [], winKey: '', slotCounts: [], ball: null, pull: 0, time: 0 };
  function render(now) {
    scene.time = now; scene.sparks = S.sparks; scene.pinFlash = S.pinFlash; scene.caught = S.caught;
    view.draw(scene);
    var dt = 1 / 60, i;
    S.sparks = S.sparks.filter(function (s) { s.t += dt * 3; return s.t < 1; });
    S.caught = S.caught.filter(function (c) { c.t += dt * 2; return c.t < 1; });
    for (i in S.pinFlash) S.pinFlash[i] -= dt * 6;
    requestAnimationFrame(render);
  }
  function resetBoard() {
    scene.lit = {}; scene.jpNums = []; scene.jpLit = {}; scene.lineCells = []; scene.winKey = ''; scene.slotCounts = []; scene.ball = null; scene.pull = 0;
    ballsUi(16, 16); jpUi(0);
  }
  function nearestPeg(p) {
    var best = -1, bd = 1e9, i, d;
    for (i = 0; i < T.pegs.length; i++) { d = Math.hypot(T.pegs[i].x - p.x, T.pegs[i].y - p.y); if (d < bd) { bd = d; best = i; } }
    return bd < 14 ? best : -1;
  }
  function restOnPlunger(pull) { scene.ball = { x: T.LANE.x, y: T.LANE.startY - 2 + (pull || 0) * 28 }; }

  /* ---------- the plunger ---------- */
  // waits for the player to pull and let go (or for the ball to be launched by itself after a while); resolves with the power 0..1
  function awaitLaunch(auto) {
    return new Promise(function (resolve) {
      var holding = false, t0 = 0, done = false, pull = 0, raf = 0, idleTimer = null;
      function finish(p) {
        if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(idleTimer);
        el.stage.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp);
        scene.pull = 0; el.hint.hidden = true; resolve(p);
      }
      function tick() {
        if (done) return;
        if (holding) { var t = (performance.now() - t0) / 1100; pull = Math.min(1, t); scene.pull = pull; if (Math.random() < 0.25) Snd.sfx.pull(pull); }
        restOnPlunger(pull);                                                                    // the ball rests on the plunger
        raf = requestAnimationFrame(tick);
      }
      function down(ev) {
        if (ev.target.closest && ev.target.closest('button,input,.sheet')) return;
        holding = true; t0 = performance.now(); clearTimeout(idleTimer); ev.preventDefault();
      }
      function up() { if (holding) finish(Math.max(0.12, pull)); }
      function keyDown(ev) { if (ev.code !== 'Space' || ev.repeat || (ev.target.closest && ev.target.closest('input,textarea,button,select'))) return; ev.preventDefault(); if (!holding) { holding = true; t0 = performance.now(); clearTimeout(idleTimer); } }
      function keyUp(ev) { if (ev.code === 'Space') { ev.preventDefault(); up(); } }
      el.stage.addEventListener('pointerdown', down); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp);
      el.hint.hidden = !!auto;
      idleTimer = setTimeout(function () { finish(0.35 + Math.random() * 0.5); }, auto ? 450 : 3500);
      tick();
    });
  }

  /* ---------- one ball ---------- */
  function flyBall(outcome, power, speed) {
    return new Promise(function (resolve) {
      var pick = Paths.pick(outcome, power), frames = pick.frames, dur = Paths.duration(frames), bounces = Paths.bounces(frames), t0 = performance.now(), bi = 0;
      Snd.sfx.launch(power);
      (function step() {
        var t = ((performance.now() - t0) / 1000) * speed;
        if (t >= dur) { scene.ball = null; resolve(); return; }
        var p = Paths.at(frames, t);
        scene.ball = { x: p.x, y: p.y };
        while (bi < bounces.length && bounces[bi] <= t) {
          var pb = Paths.at(frames, bounces[bi]), pi = nearestPeg(pb);
          if (pi >= 0) S.pinFlash[pi] = 1;
          S.sparks.push({ x: pb.x, y: pb.y, dx: Math.random() * 2 - 1, dy: -Math.random(), t: 0 });
          Snd.sfx.tick(); bi++;
        }
        requestAnimationFrame(step);
      })();
    });
  }
  function landBall(outcome) {
    if (outcome > 0) {
      var slot = T.slots[outcome - 1];
      scene.slotCounts[outcome] = (scene.slotCounts[outcome] || 0) + 1;
      scene.lit[outcome - 1] = true;
      S.caught.push({ x: slot.x, y: T.RIM_Y + 24, t: 0 });
      if (scene.jpNums.indexOf(outcome) >= 0 && scene.slotCounts[outcome] >= 2 && !scene.jpLit[outcome]) { scene.jpLit[outcome] = true; jpUi(Object.keys(scene.jpLit).length); Snd.sfx.lit(Object.keys(scene.jpLit).length); }
      Snd.sfx.drop();
    }
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- the whole play, shown ---------- */
  var ROWNAMES = ['Row', 'Row', 'Row', 'Row', 'Column', 'Column', 'Column', 'Column', 'Diagonal', 'Diagonal'];
  function describe(e) {                                       // "Row 5-6-7-8", "Cells 1-4-13-16": the cells that made the pattern, numbered as on the card
    var nums = e.cells.slice().sort(function (a, b) { return a - b; }).filter(function (c, i, a) { return a.indexOf(c) === i; }).map(function (c) { return c + 1; }).join('-');
    return 'Cells ' + nums;
  }
  function showRound(round, opts) {
    opts = opts || {};
    var balls = round.balls, total = balls.length, i = 0;
    resetBoard();
    scene.jpNums = round.jackpotNumbers.slice();
    el.banner.hidden = true;
    function next() {
      if (i >= total) return Promise.resolve();
      var outcome = balls[i++], first = i === 1;
      ballsUi(total - i + 1, total);
      restOnPlunger(0);
      if (first && !opts.fast) setMsg('Hold anywhere to pull, release to fire'); else setMsg('Ball ' + i + ' of ' + total);
      // the player pulls the plunger for the first ball; the rest of the 16 follow by themselves, a little quicker
      return (first && !opts.fast ? awaitLaunch(false) : wait(opts.fast ? 60 : 150).then(function () { return 0.25 + Math.random() * 0.7; })).then(function (power) {
        ballsUi(total - i, total, i);
        return flyBall(outcome, power, opts.fast ? 2.4 : (first ? 1.15 : 1.6));
      }).then(function () { landBall(outcome); return wait(opts.fast ? 40 : 90); }).then(next);
    }
    return next().then(function () {
      var e = Fair.evaluate(balls, round.jackpotNumbers);
      scene.lineCells = round.pattern ? e.cells.map(function (c) { return c; }) : [];
      scene.winKey = round.pattern || '';
      ballsUi(0, total); setMsg('Round over');
      el.lastWin.textContent = fmt(round.payout);
      if (round.jackpot) {
        Snd.sfx.win(5);
        el.banner.className = 'banner top';
        el.banner.innerHTML = '<div class="t">JACKPOT!</div><div class="s">All 5 lit · ' + fmt(round.jackpotPaid) + '</div>' + (round.patternPay > 0 ? '<div class="s">+ ' + round.patternName.toLowerCase() + ' · ' + fmt(round.patternPay) + '</div>' : '') +
          (round.creditPending ? '<div class="s">The win is being sent to your account</div>' : '');
      } else if (round.pattern) {
        Snd.sfx.win(round.multiple >= 15 ? 4 : 3);
        el.banner.className = 'banner';
        el.banner.innerHTML = '<div class="t">' + round.patternName + '</div><div class="s">' + describe(e) + ' · win ' + fmt(round.payout) + '</div>' + (round.creditPending ? '<div class="s">The win is being sent to your account</div>' : '');
      } else {
        Snd.sfx.lose();
        el.banner.className = 'banner lose';
        el.banner.innerHTML = '<div class="t">NO WIN</div><div class="s">' + e.lit.length + ' slots lit · no pattern</div>';
      }
      el.banner.hidden = false;
    });
  }

  /* ---------- playing ---------- */
  function newRequestId() {
    var a = new Uint8Array(12), s = '', i;
    (window.crypto || window.msCrypto).getRandomValues(a);
    for (i = 0; i < a.length; i++) s += ('0' + a[i].toString(16)).slice(-2);
    return 'r' + s;
  }
  // sends the play; when the answer is lost the SAME request id is sent again (the server then returns the play that exists and never debits twice)
  function sendPlay(requestId, tries) {
    return Api.play(S.stake, requestId).catch(function (e) {
      if (e && e.network && tries < 4) { note('Checking your play...', false, 0); return wait(2500).then(function () { return sendPlay(requestId, tries + 1); }); }
      if (e && e.error === 'ROUND_IN_PROGRESS' && tries < 8) return wait(1500).then(function () { return sendPlay(requestId, tries + 1); });
      throw e;
    });
  }
  function play() {
    if (S.busy || !S.state) return;
    Snd.sfx.click(); lockControls(true); note(null); el.banner.hidden = true; setMsg('Placing your stake');
    var before = S.balance;
    S.requestId = S.requestId || newRequestId();
    var rid = S.requestId;
    setBalance(before - S.stake);
    sendPlay(rid, 0).then(function (res) {
      S.requestId = null; note(null);
      S.balance = res.balance;
      return showRound(res.round, { fast: false }).then(function () {
        setBalance(res.balance);
        if (res.round.payout > 0 && res.round.creditPending) setBalance(res.balance + res.round.payout);
        return Api.seen(res.round.id).catch(function () { /* the page will show it again, harmless */ });
      });
    }).catch(function (e) {
      S.requestId = null;
      setBalance(before);
      note(errText(e), false, 7000); Snd.sfx.error();
      if (e && e.error === 'SESSION_EXPIRED') { Api.clearSession(); return viaAccount().then(function () { note('Your session was renewed. Press PLAY again.', true, 6000); }, function () { gate('SESSION ENDED', ERR.SESSION_EXPIRED, true); }); }
      return refresh();
    }).then(function () { lockControls(false); return refresh(); }).catch(function () { lockControls(false); });
  }

  /* ---------- state and recovery ---------- */
  function applyState(st) {
    S.state = st; S.balance = st.balance;
    if (!S.busy) setBalance(st.balance);
    scene.paytable = st.paytable;
    el.balLbl.textContent = 'BALANCE' + (st.currency ? ' ' + st.currency : '');
    el.jackpot.textContent = st.jackpot ? fmt(st.jackpot.amount) : 'NONE';
    el.sub.textContent = '16 balls · 16 slots';
    fillPays(st.paytable);
    var lim = st.limits || {}, min = lim.minBet || 1, max = lim.maxBet || min;
    S.steps = buildSteps(min, max);
    var want = 0; try { want = parseInt(localStorage.getItem('bp16.stake'), 10) || 0; } catch (e) { /* ignore */ }
    var idx = S.steps.indexOf(want); if (idx < 0) { idx = Math.max(0, S.steps.findIndex(function (v) { return v >= Math.max(min, want || min); })); }
    if (S.stakeIdx === undefined || S.stake < min || S.stake > max) setStake(idx); else setStake(S.stakeIdx);
    el.play.disabled = S.busy;
    fillRules(); fillFair();
  }
  function refresh(quiet) {
    return Api.state().then(function (st) { applyState(st); return st; }).catch(function (e) {
      if (quiet) throw e;                                                  // start-up decides what to show (it may renew the session through the account)
      if (e && e.error === 'SESSION_EXPIRED') gate('SESSION ENDED', ERR.SESSION_EXPIRED, true);
      else if (e && e.error === 'GAME_NOT_ENABLED') gate('NOT AVAILABLE', ERR.GAME_NOT_ENABLED, false);
      else if (e && e.error === 'GAME_NOT_CONFIGURED') gate('NOT AVAILABLE', ERR.GAME_NOT_CONFIGURED, false);
      else if (!S.state) gate('NO CONNECTION', errText(e), false);
      throw e;
    });
  }
  // after a reload (or a lost answer): a play that is settled but was never shown is shown now, before a new one is allowed
  function recover(st) {
    if (st.unfinished) { lockControls(true); note('Finishing your last play...', false, 0); return wait(1500).then(refresh).then(recover); }
    if (st.unseen && st.last && st.last.status === 'settled') {
      lockControls(true); note('Your last play is shown again.', true, 4000);
      return showRound(st.last, { fast: true }).then(function () { return Api.seen(st.last.id).catch(function () {}); }).then(function () { lockControls(false); return refresh(); });
    }
    if (st.unseen && st.last && st.last.status === 'void') { note('Your last play did not happen. Nothing was charged.', false, 6000); Api.seen(st.last.id).catch(function () {}); }
    lockControls(false);
    setBalance(S.balance);                                  // (applyState leaves the balance alone while the controls are locked at start-up)
    return Promise.resolve();
  }

  /* ---------- rules and fairness screens ---------- */
  function fillPays(pt) {
    var h = '<div class="pt">PAYS × STAKE</div>';
    pt.pays.forEach(function (p) {
      var on = {}, mini = '', c; (p.cells || []).forEach(function (x) { on[x - 1] = true; });
      for (c = 0; c < 16; c++) mini += '<b' + (on[c] ? ' class="on"' : '') + '></b>';
      h += '<div class="prow" data-key="' + p.key + '"><i class="mini">' + mini + '</i><span class="pn">' + p.name + '</span><span>' + p.multiple + '×</span></div>';
    });
    h += '<div class="note2">BEST PATTERN PAYS. 2 BALLS ON ALL 5 JP NUMBERS WIN THE JACKPOT</div>';
    el.pays.innerHTML = h; el.pays.removeAttribute('data-win');
  }
  function fillRules() {
    var st = S.state; if (!st) return;
    el.rulesPays.innerHTML = st.paytable.pays.map(function (p) { return '<tr><td>' + p.name + '</td><td>x' + p.multiple + '</td></tr>'; }).join('');
    var l = st.limits || {};
    el.rulesLimits.textContent = 'Stake from ' + money(l.minBet || 0) + ' to ' + money(l.maxBet || 0) + '. Published return to player: about ' + st.paytable.rtp + '% (paytable ' + st.paytable.id + ').' +
      (st.jackpot ? ' The jackpot pool now holds ' + money(st.jackpot.amount) + '; ' + (st.jackpot.contributionBp / 100) + '% of every stake is added to it.' : ' The jackpot is not available in your currency.');
  }
  function fillFair() {
    var sd = S.state && S.state.seed; if (!sd) return;
    el.fairCommit.textContent = sd.commit; el.fairClient.textContent = sd.clientSeed; el.fairPlays.textContent = sd.plays + ' of ' + sd.rotatesAfter;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function loadHistory() {
    el.fairList.innerHTML = '<span class="mute">...</span>';
    Api.history(30).then(function (h) {
      if (!h.rounds.length) { el.fairList.innerHTML = '<span class="mute">No plays yet.</span>'; return; }
      el.fairList.innerHTML = h.rounds.map(function (r) {
        return '<div class="item"><span>#' + r.id + '</span><span>' + (r.status === 'void' ? 'VOID' : (r.jackpot ? 'JACKPOT' : (r.patternName || 'NO WIN'))) + '</span><span>' + fmt(r.stake) + ' &rarr; ' + fmt(r.payout) + '</span>' +
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

  function openSheet(name) { el[name].hidden = false; Snd.sfx.click(); if (name === 'fair') { fillFair(); loadHistory(); } }

  /* ---------- wiring ---------- */
  el.stakeUp.addEventListener('click', function () { Snd.sfx.click(); setStake(S.stakeIdx + 1); });
  el.stakeDown.addEventListener('click', function () { Snd.sfx.click(); setStake(S.stakeIdx - 1); });
  el.play.addEventListener('click', play);
  el.btnRules.addEventListener('click', function () { openSheet('rules'); });
  el.btnFair.addEventListener('click', function () { openSheet('fair'); });
  el.btnSound.addEventListener('click', function () {
    var on = !(Snd.isSfx() || Snd.isMusic()); Snd.setSfx(on); Snd.setMusic(on); Snd.unlock(); el.btnSound.classList.toggle('off', !on);
  });
  el.btnSound.classList.toggle('off', !(Snd.isSfx() || Snd.isMusic()));
  document.addEventListener('click', function (ev) {
    var c = ev.target.closest && ev.target.closest('[data-close]'); if (c) { el[c.getAttribute('data-close')].hidden = true; return; }
    var k = ev.target.closest && ev.target.closest('[data-check]'); if (k) check(parseInt(k.getAttribute('data-check'), 10));
  });
  el.fairRotate.addEventListener('click', rotate);
  var startEl = $('start');
  if (startEl) startEl.addEventListener('click', function () { Snd.unlock(); });
  document.addEventListener('pointerdown', function () { Snd.unlock(); }, { once: true });
  if (qs.get('start') === '0') Snd.sfx.click();

  /* ---------- start ---------- */
  // a signed-in player of the operator's own site needs no token: the account gives the page a one-time launch token (a platform's launch link still carries its own)
  function viaAccount() {
    return Api.accountLaunch().then(function (l) { return Api.auth(l.token, l.client); }).then(function (res) { Api.setSession(res.session); applyState(res); return res; });
  }
  function signInGate() { gate('BINGO PINBALL 16', 'Sign in to play.', true); }
  function begin() {
    var token = qs.get('token'), first;
    if (token) {
      history.replaceState(null, '', location.pathname + (qs.get('start') === '0' ? '?start=0' : ''));      // never leave the launch token in the address bar
      first = Api.auth(token, qs.get('client')).then(function (res) { Api.setSession(res.session); applyState(res); return res; });
    } else if (Api.hasSession()) {
      first = refresh(true).catch(function (e) { if (e && e.error === 'SESSION_EXPIRED') { Api.clearSession(); return viaAccount(); } throw e; });      // the saved session ended: a signed-in account starts a new one
    } else {
      first = viaAccount();
    }
    first.then(function () { return Api.state(); }).then(function (st) { applyState(st); return recover(st); }).catch(function (e) {
      if (e && e.noAccount) signInGate();
      else if (e && e.status) {
        if (e.error === 'SESSION_EXPIRED' || e.error === 'INVALID_TOKEN') { Api.clearSession(); gate('SESSION ENDED', e.error === 'INVALID_TOKEN' ? 'This link was already used or has expired. Open the game again from your account.' : ERR.SESSION_EXPIRED, true); }
        else if (e.error === 'GAME_NOT_ENABLED') gate('NOT AVAILABLE', ERR.GAME_NOT_ENABLED, false);
        else gate('NOT AVAILABLE', errText(e), false);
      } else gate('NO CONNECTION', errText(e), false);
    });
  }
  // the design is 390 px wide (a phone): the whole stage is scaled to the window, and it is as tall as the window allows (the pin board takes the spare height)
  function fit() {
    var w = window.innerWidth, h = (window.visualViewport && window.visualViewport.height) || window.innerHeight, sc = Math.min(w / 390, h / 800);
    if (!(sc > 0)) return;
    el.stage.style.setProperty('--s', sc);
    el.stage.style.height = Math.round(h / sc) + 'px';
  }
  var fitSoon = function () { requestAnimationFrame(fit); setTimeout(fit, 300); };
  window.addEventListener('resize', fitSoon); window.addEventListener('orientationchange', fitSoon); if (window.visualViewport) window.visualViewport.addEventListener('resize', fitSoon);
  fitSoon(); fit();
  lockControls(true);
  requestAnimationFrame(render);
  begin();
})();
