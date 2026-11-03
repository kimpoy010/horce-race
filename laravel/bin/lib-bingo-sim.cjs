'use strict';
/*
 * Bingo Pinball: a small deterministic ball simulation on the table of public/js/bingo/table.js. Used offline (bin/bingo-paths.cjs) to build the library of
 * ball paths the page replays. The page never simulates: the result of a play is decided by the server before the first ball is launched, and the page
 * only picks a stored path that ends in the hole the server chose.
 */

const DT = 1 / 240;
const STEPS_PER_FRAME = 240 / 20;            // a keyframe every 50 ms (the table's FPS is 20)
const E_WALL = 0.42;                          // bounciness of walls and pins
const E_PIN = 0.5;
const MAX_STEPS = 240 * 16;                   // a ball that has not found a hole after 16 seconds is dropped from the library
const CAPTURE_SPEED = 70;                     // slower than this over a hole: it falls in (px/s)

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** buckets of 12 x 12 px so that a step only looks at the pins, holes and walls that are near the ball */
const CELL = 12;
function prepare(T) {
  if (T._sim) return T._sim;
  const key = (x, y) => Math.floor(x / CELL) * 1000 + Math.floor(y / CELL);
  const near = (list, pos, reach) => {
    const m = new Map();
    list.forEach((it, i) => {
      const [x0, y0, x1, y1] = pos(it);
      for (let cx = Math.floor((x0 - reach) / CELL); cx <= Math.floor((x1 + reach) / CELL); cx++) {
        for (let cy = Math.floor((y0 - reach) / CELL); cy <= Math.floor((y1 + reach) / CELL); cy++) {
          const k = cx * 1000 + cy;
          if (!m.has(k)) m.set(k, []);
          m.get(k).push(it);
        }
      }
    });
    return m;
  };
  T._sim = {
    pins: near(T.pins, (p) => [p.x, p.y, p.x, p.y], T.BALL_R + 2.5),
    holes: near(T.holes, (h) => [h.x, h.y, h.x, h.y], T.HOLE_R * 1.7 + 1),
    walls: near(T.walls, (w) => [Math.min(w[0], w[2]), Math.min(w[1], w[3]), Math.max(w[0], w[2]), Math.max(w[1], w[3])], T.BALL_R + 1),
    key
  };
  return T._sim;
}

/** a ball against a line segment: pushes the ball out and reflects its velocity */
function hitSegment(b, s, r, e) {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((b.x - x1) * dx + (b.y - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + t * dx, qy = y1 + t * dy;
  let nx = b.x - qx, ny = b.y - qy;
  const d = Math.hypot(nx, ny);
  if (d >= r || d === 0) return false;
  nx /= d; ny /= d;
  b.x = qx + nx * r; b.y = qy + ny * r;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) {
    b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
    const tx = -ny, ty = nx, vt = b.vx * tx + b.vy * ty;          // a little friction along the surface
    b.vx -= 0.04 * vt * tx; b.vy -= 0.04 * vt * ty;
    return Math.abs(vn);
  }
  return 0;
}

function hitPin(b, p, r, e) {
  const nx0 = b.x - p.x, ny0 = b.y - p.y;
  const d = Math.hypot(nx0, ny0), min = r + p.r;
  if (d >= min || d === 0) return 0;
  const nx = nx0 / d, ny = ny0 / d;
  b.x = p.x + nx * min; b.y = p.y + ny * min;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; return Math.abs(vn); }
  return 0;
}

/**
 * One ball. power 0..1 is how hard the plunger was pulled; `jitter` is a small random sideways speed in the lane.
 * @return {{ok:boolean, hole?:number, frames?:number[][], reason?:string}} frames are [x, y] at 20 per second (the last ones settle into the hole)
 */
function simulate(T, power, jitter) {
  const b = { x: T.LANE.x, y: T.LANE.startY, vx: jitter, vy: -(T.V_MIN + power * (T.V_MAX - T.V_MIN)) };
  const r = T.BALL_R;
  const S = prepare(T);
  const frames = [[b.x, b.y]];
  for (let step = 1; step <= MAX_STEPS; step++) {
    b.vy += T.GRAVITY * DT;
    b.x += b.vx * DT; b.y += b.vy * DT;
    const k = S.key(b.x, b.y);
    const ws = S.walls.get(k);
    if (ws) for (const w of ws) hitSegment(b, w, r, E_WALL);
    const ps = S.pins.get(k);
    if (ps) for (const p of ps) hitPin(b, p, r, E_PIN);
    const speed = Math.hypot(b.vx, b.vy);
    const hs = S.holes.get(k);
    if (hs) for (const h of hs) {
      const dx = h.x - b.x, dy = h.y - b.y, d = Math.hypot(dx, dy);
      if (d < T.HOLE_R) {
        if (d < T.HOLE_R * 0.5 || speed < CAPTURE_SPEED) {
          for (let k = 1; k <= 3; k++) frames.push([b.x + dx * (k / 3), b.y + dy * (k / 3)]);      // the ball drops in: it settles on the centre of the hole
          return { ok: true, hole: h.n, frames };
        }
      } else if (d < T.HOLE_R * 1.7 && speed < 110) {                         // a slow ball is drawn towards a hole it rolls past
        b.vx += dx / d * 260 * DT; b.vy += dy / d * 260 * DT;
      }
    }
    if (step % STEPS_PER_FRAME === 0) frames.push([b.x, b.y]);
    if (b.y > T.FIELD.b + 12 && b.x < T.LANE.l - 2) return { ok: false, reason: 'drained' };
    if (b.y > T.LANE.startY + 14) return { ok: false, reason: 'fell back' };
  }
  return { ok: false, reason: 'stuck' };
}

module.exports = { simulate, mulberry32, DT, STEPS_PER_FRAME };
