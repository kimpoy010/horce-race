/* Bingo Pinball: the page's logic. The server decides the result (POST /play); this shows it: five balls, one at a time, travel along stored paths to the holes the server
   chose. The plunger changes how the launch looks and which stored path is used; it never changes the result. */
(function () {
  'use strict';
  var T = window.BingoTable, Api = window.BingoApi, Paths = window.BingoPaths, Fair = window.BingoFair, Snd = window.BingoSound;
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
  ['screen', 'balance', 'stake', 'stakeUp', 'stakeDown', 'play', 'hint', 'banner', 'note', 'gate', 'gateTitle', 'gateText', 'gateLink', 'stage', 'rules', 'fair', 'btnRules', 'btnFair', 'btnSound',
    'rulesPays', 'rulesLimits', 'fairCommit', 'fairClient', 'fairPlays', 'fairNewSeed', 'fairRotate', 'fairOut', 'fairList', 'ctl'].forEach(function (k) { el[k] = $(k); });
  var art = window.BingoArt.create(el.screen);

  /* ---------- money ---------- */
  function dec() { return S.state ? S.state.decimals : 2; }
  function fmt(minor) { var d = dec(); return (minor / Math.pow(10, d)).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function money(minor) { return (S.state && S.state.currency ? S.state.currency + ' ' : '') + fmt(minor); }
  function setBalance(v) { S.shownBalance = v; el.balance.textContent = money(v); }

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
    try { localStorage.setItem('bp.stake', String(S.stake)); } catch (e) { /* ignore */ }
  }
  function lockControls(b) { S.busy = b; el.play.disabled = b || !S.state; setStake(S.stakeIdx || 0); }

  /* ---------- the scene ---------- */
  var scene = { paytable: null, filled: {}, lit: {}, lineCells: [], ball: null, balls: { left: 5, total: 5 }, pull: 0, hint: false, time: 0 };
  function render(now) {
    scene.time = now; scene.sparks = S.sparks; scene.pinFlash = S.pinFlash; scene.caught = S.caught;
    art.draw(scene);
    var dt = 1 / 60, i;
    S.sparks = S.sparks.filter(function (s) { s.t += dt * 3; return s.t < 1; });
    S.caught = S.caught.filter(function (c) { c.t += dt * 2; return c.t < 1; });
    for (i in S.pinFlash) S.pinFlash[i] -= dt * 6;
    requestAnimationFrame(render);
  }
  function resetBoard(keepLit) {
    scene.filled = {}; scene.ball = null; scene.balls = { left: 5, total: 5 }; scene.pull = 0; scene.hint = false;
    if (!keepLit) { scene.lit = {}; scene.lineCells = []; }
  }
  function nearestPin(p) {
    var best = -1, bd = 1e9, i, d;
    for (i = 0; i < T.pins.length; i++) { d = Math.hypot(T.pins[i].x - p.x, T.pins[i].y - p.y); if (d < bd) { bd = d; best = i; } }
    return bd < 7 ? best : -1;
  }

  /* ---------- the plunger ---------- */
  // waits for the player to pull and let go (or for the ball to be launched by itself after a while); resolves with the power 0..1
  function awaitLaunch(auto) {
    return new Promise(function (resolve) {
      var holding = false, t0 = 0, done = false, pull = 0, raf = 0, idleTimer = null;
      function finish(p) {
        if (done) return; done = true; cancelAnimationFrame(raf); clearTimeout(idleTimer);
        el.stage.removeEventListener('pointerdown', down); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        scene.pull = 0; scene.hint = false; el.hint.hidden = true; resolve(p);
      }
      function tick() {
        if (done) return;
        if (holding) { var t = (performance.now() - t0) / 1100; pull = Math.min(1, t); scene.pull = pull; if (Math.random() < 0.25) Snd.sfx.pull(pull); }
        scene.ball = { x: T.LANE.x, y: T.LANE.startY + 2 + Math.round(pull * 7) };          // the ball rests on the plunger
        raf = requestAnimationFrame(tick);
      }
      function inLane(ev) { var r = el.stage.getBoundingClientRect(), p = window.HorseOrient ? window.HorseOrient.point(ev) : { x: ev.clientX, y: ev.clientY }; return p; }
      function down(ev) {
        if (ev.target.closest && ev.target.closest('button,input,.sheet')) return;
        holding = true; t0 = performance.now(); clearTimeout(idleTimer); ev.preventDefault();
      }
      function up() { if (holding) finish(Math.max(0.12, pull)); }
      el.stage.addEventListener('pointerdown', down); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
      scene.hint = !auto; el.hint.hidden = !!auto;
      idleTimer = setTimeout(function () { finish(0.35 + Math.random() * 0.5); }, auto ? 450 : 3500);
      tick();
    });
  }

  /* ---------- one ball ---------- */
  function flyBall(hole, power, fast) {
    return new Promise(function (resolve) {
      var pick = Paths.pick(hole, power), frames = pick.frames, dur = Paths.duration(frames), bounces = Paths.bounces(frames), t0 = performance.now(), bi = 0, speed = fast ? 1.8 : 1;
      Snd.sfx.launch(power);
      (function step() {
        var t = ((performance.now() - t0) / 1000) * speed;
        if (t >= dur) { scene.ball = null; resolve(); return; }
        var p = Paths.at(frames, t);
        scene.ball = { x: p.x, y: p.y };
        while (bi < bounces.length && bounces[bi] <= t) {
          var pb = Paths.at(frames, bounces[bi]), pi = nearestPin(pb);
          if (pi >= 0) S.pinFlash[pi] = 1;
          S.sparks.push({ x: pb.x, y: pb.y, dx: Math.random() * 2 - 1, dy: -Math.random(), t: 0 });
          Snd.sfx.tick(); bi++;
        }
        requestAnimationFrame(step);
      })();
    });
  }
  function catchBall(n, card) {
    var h = T.holes[n - 1], idx = card.indexOf(n);
    scene.filled[n] = true; S.caught.push({ x: h.x, y: h.y, t: 0 });
    if (idx >= 0) scene.lit[idx] = true;
    Snd.sfx.drop(); setTimeout(function () { Snd.sfx.lit(Object.keys(scene.filled).length); }, 220);
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* ---------- the whole play, shown ---------- */
  function showRound(round, opts) {
    opts = opts || {};
    var card = S.state.paytable.card, holes = round.holes, i = 0;
    resetBoard(false);
    el.banner.hidden = true;
    function next() {
      if (i >= holes.length) return Promise.resolve();
      scene.balls = { left: holes.length - i, total: holes.length };
      var n = holes[i++];
      return (opts.fast ? Promise.resolve(0.3 + Math.random() * 0.6) : awaitLaunch(false)).then(function (power) {
        scene.balls = { left: holes.length - i, total: holes.length };
        return flyBall(n, power, opts.fast);
      }).then(function () { catchBall(n, card); return wait(opts.fast ? 250 : 550); }).then(next);
    }
    return next().then(function () {
      var e = Fair.evaluate(card, holes);
      scene.lineCells = round.payout > 0 ? e.lineCells : [];
      if (round.payout > 0) {
        Snd.sfx.win(round.bestLit);
        el.banner.className = 'banner';
        el.banner.innerHTML = '<div class="mid">BINGO!</div><div class="big">+' + fmt(round.payout) + '</div><div class="sm">' + (round.bestLineName || 'LINE') + ' - ' + round.bestLit + ' LIT - x' + round.multiple + '</div>' +
          (round.creditPending ? '<div class="sm">THE WIN IS BEING SENT TO YOUR ACCOUNT</div>' : '');
      } else {
        Snd.sfx.lose();
        el.banner.className = 'banner lose';
        el.banner.innerHTML = '<div class="big">NO WIN</div><div class="sm">' + e.lit + ' LIT IN YOUR BEST LINE. 3 ARE NEEDED.</div>';
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
    Snd.sfx.click(); lockControls(true); note(null); el.banner.hidden = true;
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
    var lim = st.limits || {}, min = lim.minBet || 1, max = lim.maxBet || min;
    S.steps = buildSteps(min, max);
    var want = 0; try { want = parseInt(localStorage.getItem('bp.stake'), 10) || 0; } catch (e) { /* ignore */ }
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
  function fillRules() {
    var st = S.state; if (!st) return;
    var rows = [], p = st.paytable.pays, k;
    for (k = 3; k <= 5; k++) rows.push('<tr><td>' + k + ' LIT IN A LINE</td><td>x' + (p[k] || 0) + '</td></tr>');
    el.rulesPays.innerHTML = rows.join('');
    var l = st.limits || {};
    el.rulesLimits.textContent = 'Stake from ' + money(l.minBet || 0) + ' to ' + money(l.maxBet || 0) + '. Published return to player: ' + (st.paytable.rtp != null ? st.paytable.rtp + '%' : '-') + ' (version ' + st.paytable.version + ').';
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
        return '<div class="item"><span>#' + r.id + '</span><span>' + (r.status === 'void' ? 'VOID' : 'HOLES ' + (r.holes || []).join(' ')) + '</span><span>' + fmt(r.stake) + ' &rarr; ' + fmt(r.payout) + '</span>' +
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
  function signInGate() { gate('BINGO PINBALL', 'Sign in to play.', true); }
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
  lockControls(true);
  requestAnimationFrame(render);
  begin();
})();
