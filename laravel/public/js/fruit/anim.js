/*
 * Fruit Ring: the plan of the light. The server has already decided where every spin ends (a list of rounds, each a list of cells: [[stop]], or [[stop],[a],[b],[c]] for 3 free spins,
 * or [[stop],[a,b,c]] for a free spin with 3 lit cells). This turns that into a timed list of events the page plays: a light runs round the ring, slows down, and stops exactly on the cell
 * the server chose. Nothing here decides a result; the number of laps and the speeds are only for show. window.FruitAnim, or require() in Node.
 *
 * plan(rounds, opts) -> { events: [{at, type: 'run'|'land'|'lucky'|'round', lights: [cells], round: n}], duration }
 *   run   the light(s) stand on `lights` from `at` (ms) until the next event      land   the round has ended: `lights` are the lit cells      lucky   the Lucky cell flashes
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FruitAnim = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var N = 24;
  function mod(a) { return ((a % N) + N) % N; }

  var FAST = 42, SLOW = 330;                               // ms per cell at full speed and for the last cell

  /** the cells a light visits to go from `from` to `to` with `laps` extra turns; the speed falls away towards the end */
  function run(from, to, laps, t0, speed) {
    var K = mod(to - from) + N * laps, out = [], t = t0, i, p;
    if (K === 0) K = N;
    for (i = 1; i <= K; i++) {
      p = i / K;
      t += (FAST + (SLOW - FAST) * Math.pow(p, 4)) / (speed || 1);
      out.push({ at: Math.round(t), cell: mod(from + i) });
    }
    return out;
  }

  function plan(rounds, opts) {
    opts = opts || {};
    var rnd = opts.random || Math.random, speed = opts.speed || 1, ev = [], t = 0, cursor = opts.start || 0, i, j, r, steps;
    for (i = 0; i < rounds.length; i++) {
      r = rounds[i];
      if (r.length === 1) {
        steps = run(cursor, r[0], i === 0 ? 2 + Math.floor(rnd() * 2) : 1, t, speed);
        steps.forEach(function (s) { ev.push({ at: s.at, type: 'run', lights: [s.cell], round: i }); });
        t = steps[steps.length - 1].at;
        cursor = r[0];
      } else {                                              // three lights run together and stop on three cells: every light takes the same number of steps
        var K = N + Math.floor(rnd() * N), starts = r.map(function (c) { return mod(c - K); });
        for (j = 1; j <= K; j++) {
          var p = j / K;
          t += (FAST + (SLOW - FAST) * Math.pow(p, 4)) / speed;
          ev.push({ at: Math.round(t), type: 'run', lights: starts.map(function (s) { return mod(s + j); }), round: i });
        }
        cursor = r[r.length - 1];
      }
      t += 380 / speed;
      ev.push({ at: Math.round(t), type: 'land', lights: r.slice(), round: i });
      if (i === 0 && rounds.length > 1) {                    // the stop was a Lucky cell: it flashes before the free spins start
        t += 900 / speed;
        ev.push({ at: Math.round(t), type: 'lucky', lights: r.slice(), round: i });
      } else if (i < rounds.length - 1) {
        t += 450 / speed;
        ev.push({ at: Math.round(t), type: 'round', lights: r.slice(), round: i });
      }
    }
    return { events: ev, duration: ev.length ? ev[ev.length - 1].at : 0 };
  }

  /** the lights at time `ms` of a plan (the last event that has started); [] before the first */
  function at(p, ms) {
    var lo = 0, hi = p.events.length - 1, best = null;
    while (lo <= hi) { var mid = (lo + hi) >> 1; if (p.events[mid].at <= ms) { best = p.events[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best;
  }

  return { plan: plan, at: at, run: run, FAST: FAST, SLOW: SLOW };
});
