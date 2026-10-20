/*
 * Retro Horse Race - HUD, sound and state sync (the 3D scene lives in scene3d.js).
 *
 * Query parameters (for embedding):
 *   ?api=https://host   race server to use (default: same origin, else local mode)
 *   ?mode=local         force local mode (controller in another tab of the same browser)
 *   ?sound=0            hide the sound button
 *   ?hud=0              hide the HTML overlay (top / bottom bars)
 */
(function () {
  'use strict';
  var C = window.HorseCore;
  var qs = new URLSearchParams(location.search);

  var TOTAL = window.Scene3D.TOTAL, START_OFF = [0, 1.4, 0.6, 2.0, 0.9, 1.7];

  /* ================= sound (WebAudio chiptune) ================= */
  var Sound = (function () {
    var ctx = null, on = false;
    function tone(f, at, dur, type, vol) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || 'square'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, at); g.gain.linearRampToValueAtTime(vol || 0.08, at + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      o.connect(g); g.connect(ctx.destination); o.start(at); o.stop(at + dur + 0.05);
    }
    function seq(notes) { var t = ctx.currentTime + 0.02; notes.forEach(function (n) { tone(n[0], t, n[1] * 0.95, 'square', 0.07); t += n[1]; }); }
    return {
      get on() { return on; },
      toggle: function () {
        if (!ctx) { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return false; ctx = new AC(); }
        if (ctx.state === 'suspended') ctx.resume();
        on = !on; return on;
      },
      beep: function () { if (on) tone(660, ctx.currentTime, 0.12, 'square', 0.06); },
      bugle: function () { if (on) seq([[392, .14], [523, .14], [659, .14], [784, .5]]); },
      go: function () { if (on) tone(1046, ctx.currentTime, 0.45, 'square', 0.07); },
      hoof: function () { if (on) tone(70 + Math.random() * 25, ctx.currentTime, 0.07, 'triangle', 0.09); },
      fanfare: function () { if (on) seq([[523, .12], [523, .12], [523, .12], [659, .3], [587, .12], [659, .12], [784, .5]]); }
    };
  })();

  /* ================= state sync ================= */
  var Sync = { mode: null, offset: 0, state: null, online: false };
  function now() { return Date.now() + Sync.offset; }

  function startServerMode(base) {
    Sync.mode = 'server';
    (function poll() {
      var t0 = Date.now();
      fetch(base + '/api/public', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (p) {
          var t1 = Date.now(), off = p.serverNow - (t0 + t1) / 2;
          Sync.offset = Sync.state && Math.abs(off - Sync.offset) < 400 ? Sync.offset * 0.8 + off * 0.2 : off;
          Sync.state = p; Sync.online = true;
        })
        .catch(function () { Sync.online = false; })
        .then(function () { setTimeout(poll, 700); });
    })();
  }

  function startLocalMode() {
    Sync.mode = 'local'; Sync.offset = 0;
    function read() {
      try {
        var raw = localStorage.getItem('horserace.public');
        if (raw) { Sync.state = JSON.parse(raw); Sync.online = true; }
      } catch (e) { Sync.online = false; }
    }
    read();
    window.addEventListener('storage', read);
    setInterval(read, 400);
  }

  function detectMode() {
    var base = (qs.get('api') || '').replace(/\/$/, '');
    if (qs.get('mode') === 'local') return startLocalMode();
    if (base) return startServerMode(base);
    fetch('api/public', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function () { startServerMode('.'); })
      .catch(startLocalMode);
  }

  /* ================= DOM / HUD ================= */
  var $ = function (id) { return document.getElementById(id); };
  var el = { stage: $('stage'), race: $('hRace'), status: $('hStatus'), last: $('hLast'), tote: $('tote'),
    cd: $('countdown'), res: $('results'), hist: $('hHistory'), snd: $('snd'), conn: $('conn') };
  var cache = {};
  function setHTML(node, key, html) { if (cache[key] !== html) { cache[key] = html; node.innerHTML = html; } }
  function chip(n, cls) { return '<span class="chip ' + (cls || '') + ' h' + n + '">' + n + '</span>'; }
  var ORD = ['1ST', '2ND', '3RD', '4TH', '5TH', '6TH'];

  function resize() { el.stage.style.setProperty('--u', (el.stage.clientWidth / 100) + 'px'); }
  window.addEventListener('resize', resize); resize();
  if (window.ResizeObserver) new ResizeObserver(resize).observe(el.stage);

  if (qs.get('sound') === '0') el.snd.style.display = 'none';
  if (qs.get('hud') === '0') document.querySelectorAll('.bar').forEach(function (b) { b.style.display = 'none'; });
  el.snd.addEventListener('click', function () {
    var on = Sound.toggle();
    el.snd.textContent = on ? 'SOUND ON' : 'SOUND OFF'; el.snd.className = on ? 'on' : '';
  });

  // host platform integration
  function emit(type, data) {
    if (window.parent === window) return;
    var msg = { source: 'horse-race', type: type };
    for (var k in data) msg[k] = data[k];
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }
  window.addEventListener('message', function (ev) {
    var m = ev.data;
    if (m && m.target === 'horse-race' && m.type === 'setSound' && !!m.on !== Sound.on) el.snd.click();
  });

  /* ================= main loop ================= */
  var webgl = true;
  try { window.Scene3D.init(document.getElementById('screen'), document.getElementById('mini')); }
  catch (e) { console.error('Scene3D init failed', e); webgl = false; document.getElementById('nogl').hidden = false; }
  var fired = {}, firedRace = null, lastHoof = 0, camT = 0, camKey = null;

  function once(key, cond, fn, lateness) {
    if (fired[key] || !cond) return;
    fired[key] = true;
    if (lateness < 1.5) fn();
  }

  function frame() {
    var nowMs = now(), st = Sync.state, race = st && st.race, T = (st && st.timings) || { race: C.RACE_MS, results: C.RESULTS_MS };
    var phase = 'idle', t = -999, rc = null;
    if (race) {
      t = (nowMs - race.startAt) / 1000;
      phase = t < 0 ? 'countdown' : t * 1000 < T.race ? 'racing' : t * 1000 < T.race + T.results ? 'results' : 'idle';
      if (race.order && phase !== 'idle') rc = C.buildRace(race.seed, race.order);
      if (!rc && (phase === 'racing' || phase === 'results')) phase = 'sync';
    }
    if (!st) phase = 'connecting';

    var rk = race ? race.seed + ':' + race.startAt : null;
    if (rk !== firedRace) { firedRace = rk; fired = {}; }
    if (race && (phase !== 'idle')) {
      once('cd', phase === 'countdown', function () { emit('countdown', { raceNo: race.raceNo }); Sound.bugle(); }, 0);
      [3, 2, 1].forEach(function (n) { once('b' + n, t >= -n && t < 0, Sound.beep, t + n); });
      once('go', t >= 0 && rc, function () { Sound.go(); emit('start', { raceNo: race.raceNo }); }, t);
      if (rc) {
        once('fin', t >= rc.firstTime, Sound.fanfare, t - rc.firstTime);
        once('res', t * 1000 >= T.race, function () {
          emit('result', { raceNo: race.raceNo, order: race.order, combination: [race.order[0], race.order[1]] });
        }, t - T.race / 1000);
      }
    }

    // ---- scene ----
    var tt = phase === 'racing' || phase === 'results' ? t : 0, items = [], live = [];
    for (var no = 1; no <= C.HORSES; no++) {
      var u = 0, standing = true, h = rc && rc.horses[no];
      if (h) {
        u = C.progress(h, tt);
        standing = tt <= 0 || u - C.progress(h, tt - 0.1) < 0.0004;
        live.push({ no: no, u: u, done: tt >= h.time, time: h.time });
      }
      // staggered start that closes up over the first ~25 m
      items.push({ no: no, u: u - START_OFF[no - 1] / TOTAL * Math.max(0, 1 - u / 0.08), standing: standing });
    }
    // camera follows the pack (leader-weighted) round the track and stops at the finish line
    var uc = 0;
    if (live.length) {
      var lead = 0, sum = 0;
      live.forEach(function (l) { lead = Math.max(lead, l.u); sum += l.u; });
      uc = Math.min(1, (lead + sum / live.length) / 2);
    }
    var perf = performance.now(), dt = Math.min(0.1, (perf - (camT || perf)) / 1000); camT = perf;
    var snap = camKey !== rk; camKey = rk;
    if (webgl) window.Scene3D.frame(items, uc, dt, snap);
    if (phase === 'racing' && nowMs - lastHoof > 170) { lastHoof = nowMs; Sound.hoof(); }

    // ---- HUD ----
    var raceNo = race && phase !== 'idle' ? race.raceNo : (st ? st.nextRaceNo : '--');
    setHTML(el.race, 'race', 'RACE ' + (raceNo < 10 ? '0' + raceNo : raceNo));
    var status = { connecting: 'CONNECTING...', idle: 'WAITING FOR NEXT RACE', sync: 'SYNCING...', results: 'OFFICIAL RESULT',
      countdown: 'POST TIME ' + Math.ceil(-t) + 's', racing: t < 1.5 ? "THEY'RE OFF!" : 'RACE IN PROGRESS' }[phase];
    setHTML(el.status, 'status', status);

    var hist = (st && st.history) || [];
    var lastRes = hist[hist.length - 1];
    setHTML(el.last, 'last', lastRes ? 'LAST ' + chip(lastRes.order[0]) + chip(lastRes.order[1]) : '');
    setHTML(el.hist, 'hist', hist.slice(-6).reverse().map(function (r) {
      return '<span class="item">R' + r.raceNo + ' ' + chip(r.order[0]) + chip(r.order[1]) + '</span>';
    }).join(''));
    el.conn.textContent = Sync.online ? 'LIVE' : 'OFFLINE'; el.conn.className = 'conn' + (Sync.online ? '' : ' off');

    var tote = '';
    if (phase === 'racing' && rc && t < rc.secondTime + 1.5) {
      live.sort(function (a, b) { return (b.done - a.done) || (a.done ? a.time - b.time : b.u - a.u); });
      tote = live.map(function (l, i) { return '<span class="rank">' + ORD[i] + chip(l.no) + '</span>'; }).join('');
    } else if ((phase === 'racing' || phase === 'results') && rc) {
      tote = '<span class="label">WINNING COMBINATION</span>' + chip(race.order[0], 'big') + chip(race.order[1], 'big');
    } else if (phase === 'countdown') {
      tote = '<span class="label blink">HORSES AT THE GATE</span>';
    } else if (phase === 'idle') {
      tote = '<span class="label blink">NEXT: RACE ' + (st ? st.nextRaceNo : '--') + '</span>';
    } else tote = '<span class="label">' + status + '</span>';
    setHTML(el.tote, 'tote', tote);

    var showCd = phase === 'countdown' && t > -6 && t < 0 || (phase === 'racing' && t < 1.2);
    el.cd.hidden = !showCd;
    if (showCd) {
      var txt = t < 0 ? String(Math.ceil(-t)) : 'GO!';
      setHTML(el.cd, 'cd', txt); el.cd.className = 'countdown' + (t < 0 ? '' : ' go');
    }

    el.res.hidden = phase !== 'results';
    if (phase === 'results' && race.order) {
      setHTML(el.res, 'res', '<div class="title">RACE ' + race.raceNo + ' RESULT</div>' +
        '<div class="combo">' + chip(race.order[0], 'big') + '<span>-</span>' + chip(race.order[1], 'big') + '</div>' +
        '<div class="grid">' + race.order.map(function (n, i) { return '<div class="cell">' + ORD[i] + chip(n) + '</div>'; }).join('') + '</div>');
    }
    requestAnimationFrame(frame);
  }

  detectMode();
  requestAnimationFrame(frame);
})();
