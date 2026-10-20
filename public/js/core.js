/*
 * Horse Race core: constants, deterministic race simulation and the Director
 * (race plan + scheduling). Used by the browser (game / controller) and by
 * server.js, so it must stay free of DOM and Node specific APIs.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HorseCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HORSES = 6;
  var COUNTDOWN_MS = 6000;   // from "start" command to the gun
  var RACE_MS = 26000;       // gun to the end of the racing phase
  var RESULTS_MS = 10000;    // results board
  var REVEAL_MS = 2000;      // finishing order is only published this long before the gun
  var MAX_PLAN = 200;
  var AMPS = [0.024, 0.017, 0.01, 0.005, 0.002]; // sum(amp*k*PI) < 0.8 => progress stays monotonic

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function shuffle(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  /* ---------- race simulation (identical on every client) ---------- */

  var cache = { key: null, race: null };

  // order = horse numbers in finishing order. The finishing order is guaranteed
  // by the finishing *times*; the wobble only changes who leads in between.
  function buildRace(seed, order) {
    var key = seed + ':' + order.join('');
    if (cache.key === key) return cache.race;
    var rnd = mulberry32(seed);
    var t = 19 + rnd() * 2;
    var horses = {}, list = [];
    order.forEach(function (no, i) {
      if (i > 0) t += (i === 1 ? 0.25 + rnd() * 0.45 : 0.3 + rnd() * 0.7) * 0.7;
      var amp = AMPS.map(function (m) { return (rnd() * 2 - 1) * m; });
      var h = { no: no, rank: i + 1, time: t, amp: amp };
      horses[no] = h; list.push(h);
    });
    var race = { horses: horses, list: list, firstTime: list[0].time, secondTime: list[1].time, lastTime: t };
    cache = { key: key, race: race };
    return race;
  }

  // Track progress (0 = gun, 1 = finish line, slightly >1 = run-out) at t seconds.
  function progress(h, t) {
    if (t <= 0) return 0;
    var x = t / h.time;
    if (x >= 1) return 1 + 0.045 * (1 - Math.exp(-(t - h.time) * 1.2));
    var f = x;
    for (var k = 0; k < h.amp.length; k++) f += h.amp[k] * Math.sin((k + 1) * Math.PI * x);
    return f;
  }

  /* ---------- plan helpers ---------- */

  // The winning combination is the pair that finished 1st and 2nd, always written low-high: 1-2 ... 5-6.
  function combination(order) { return order[0] < order[1] ? [order[0], order[1]] : [order[1], order[0]]; }

  function toNo(v) { v = parseInt(v, 10); return v >= 1 && v <= HORSES ? v : null; }

  function normEntry(e) {
    e = e || {};
    var a = toNo(e.a), b = toNo(e.b);
    if (a && a === b) b = null;
    return { a: a, b: b, exact: !!e.exact };
  }

  function resolveOrder(entry, rnd) {
    var a = entry && toNo(entry.a), b = entry && toNo(entry.b);
    if (a === b) b = null;
    var all = [1, 2, 3, 4, 5, 6];
    function other(x) { var p = all.filter(function (n) { return n !== x; }); return p[Math.floor(rnd() * p.length)]; }
    if (a && !b) b = other(a);
    if (b && !a) a = other(b);
    var top = [];
    if (a && b) top = entry.exact ? [a, b] : (rnd() < 0.5 ? [a, b] : [b, a]);
    var rest = shuffle(all.filter(function (n) { return top.indexOf(n) < 0; }), rnd);
    return top.concat(rest);
  }

  /* ---------- Director ---------- */

  function Director(s) {
    s = s || {};
    this.plan = (s.plan || []).slice(0, MAX_PLAN).map(normEntry);
    while (this.plan.length < 20) this.plan.push(normEntry());
    this.index = Math.max(0, s.index | 0);
    this.auto = !!s.auto;
    this.current = s.current || null;
    this.history = s.history || [];
    this.version = s.version | 0;
  }

  Director.prototype.busy = function (now) {
    return !!this.current && now < this.current.startAt + RACE_MS;
  };

  Director.prototype.startRace = function (now) {
    if (this.busy(now)) return { ok: false, error: 'A race is already scheduled or running' };
    var seed = (Math.random() * 4294967296) >>> 0;
    var order = resolveOrder(this.plan[this.index], Math.random);
    this.current = { raceNo: this.index + 1, seed: seed, order: order, startAt: now + COUNTDOWN_MS };
    this.history.push({ raceNo: this.current.raceNo, order: order.slice(), startAt: this.current.startAt });
    if (this.history.length > 100) this.history.shift();
    this.index++;
    while (this.plan.length < this.index + 1 && this.plan.length < MAX_PLAN) this.plan.push(normEntry());
    this.version++;
    return { ok: true, raceNo: this.current.raceNo };
  };

  // Call regularly; starts the next race by itself in auto mode.
  Director.prototype.tick = function (now) {
    if (!this.auto) return false;
    var c = this.current;
    if (c && now < c.startAt + RACE_MS + RESULTS_MS) return false;
    return this.startRace(now).ok;
  };

  Director.prototype.publicState = function (now, revealAll) {
    var c = this.current, pub = {
      serverNow: now,
      nextRaceNo: this.index + 1,
      timings: { countdown: COUNTDOWN_MS, race: RACE_MS, results: RESULTS_MS },
      race: null,
      history: this.history
        .filter(function (h) { return now >= h.startAt + RACE_MS; })
        .slice(-8)
        .map(function (h) { return { raceNo: h.raceNo, order: h.order.slice() }; })
    };
    if (c) {
      pub.race = {
        raceNo: c.raceNo, startAt: c.startAt, seed: c.seed,
        order: revealAll || now >= c.startAt - REVEAL_MS ? c.order.slice() : null
      };
    }
    return pub;
  };

  Director.prototype.adminState = function (now) {
    return {
      serverNow: now, plan: this.plan, index: this.index, auto: this.auto, version: this.version,
      busy: this.busy(now), current: this.current, history: this.history,
      timings: { countdown: COUNTDOWN_MS, race: RACE_MS, results: RESULTS_MS }
    };
  };

  Director.prototype.serialize = function () {
    return { plan: this.plan, index: this.index, auto: this.auto, current: this.current, history: this.history, version: this.version };
  };

  // Executes a controller command. Shared by server.js and the local (no server) controller.
  function execCommand(d, c, now) {
    c = c || {};
    switch (c.cmd) {
      case 'start':
        return d.startRace(now);
      case 'setPlan':
        if (!Array.isArray(c.plan)) return { ok: false, error: 'plan must be an array' };
        d.plan = c.plan.slice(0, MAX_PLAN).map(normEntry);
        while (d.plan.length < 20) d.plan.push(normEntry());
        d.version++;
        return { ok: true, version: d.version };
      case 'setAuto':
        d.auto = !!c.auto;
        return { ok: true };
      case 'setIndex':
        d.index = Math.max(0, Math.min(MAX_PLAN - 1, c.index | 0));
        while (d.plan.length < d.index + 1) d.plan.push(normEntry());
        d.version++;
        return { ok: true, version: d.version };
      case 'reset':
        d.index = 0; d.current = null; d.history = []; d.auto = false; d.version++;
        return { ok: true };
      default:
        return { ok: false, error: 'unknown command' };
    }
  }

  return {
    HORSES: HORSES, COUNTDOWN_MS: COUNTDOWN_MS, RACE_MS: RACE_MS, RESULTS_MS: RESULTS_MS,
    MAX_PLAN: MAX_PLAN, mulberry32: mulberry32, buildRace: buildRace, progress: progress,
    normEntry: normEntry, combination: combination, resolveOrder: resolveOrder, Director: Director, execCommand: execCommand
  };
});
