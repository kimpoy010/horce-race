'use strict';
/*
 * Bingo Pinball 16: a small deterministic ball simulation on the board of public/js/bingo16/table.js. Used offline (bin/bingo16-paths.cjs) to build the library of ball
 * paths the page replays. The page never simulates: the server decides where each ball ends (a slot, or OUT) before the first ball is launched, and the page only
 * picks a stored path that ends there.
 */
const DT = 1 / 480;
const STEPS_PER_FRAME = 480 / 30;             // a keyframe every 1/30 s (the board's FPS)
const E_WALL = 0.45;
const E_PEG = 0.55;
const MAX_STEPS = 480 * 9;                    // a shot that has not finished after 9 seconds is dropped

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

const CELL = 24;
function prepare(T) {
  if (T._sim) return T._sim;
  const buckets = (list, box, reach) => {
    const m = new Map();
    for (const it of list) {
      const [x0, y0, x1, y1] = box(it);
      for (let cx = Math.floor((x0 - reach) / CELL); cx <= Math.floor((x1 + reach) / CELL); cx++) for (let cy = Math.floor((y0 - reach) / CELL); cy <= Math.floor((y1 + reach) / CELL); cy++) {
        const k = cx * 1000 + cy;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(it);
      }
    }
    return m;
  };
  T._sim = {
    pegs: buckets(T.pegs, (p) => [p.x, p.y, p.x, p.y], T.BALL_R + T.PEG_R + 1),
    walls: buckets(T.walls, (w) => [Math.min(w[0], w[2]), Math.min(w[1], w[3]), Math.max(w[0], w[2]), Math.max(w[1], w[3])], T.BALL_R + 1),
    key: (x, y) => Math.floor(x / CELL) * 1000 + Math.floor(y / CELL)
  };
  return T._sim;
}

function hitSegment(b, s, r, e) {
  const [x1, y1, x2, y2] = s;
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((b.x - x1) * dx + (b.y - y1) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = x1 + t * dx, qy = y1 + t * dy;
  let nx = b.x - qx, ny = b.y - qy;
  const d = Math.hypot(nx, ny);
  if (d >= r || d === 0) return;
  nx /= d; ny /= d;
  b.x = qx + nx * r; b.y = qy + ny * r;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) {
    b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny;
    const tx = -ny, ty = nx, vt = b.vx * tx + b.vy * ty;
    b.vx -= 0.03 * vt * tx; b.vy -= 0.03 * vt * ty;
  }
}

function hitPeg(b, p, r, e) {
  const nx0 = b.x - p.x, ny0 = b.y - p.y, d = Math.hypot(nx0, ny0), min = r + p.r;
  if (d >= min || d === 0) return -1;
  const nx = nx0 / d, ny = ny0 / d;
  b.x = p.x + nx * min; b.y = p.y + ny * min;
  const vn = b.vx * nx + b.vy * ny;
  if (vn < 0) { b.vx -= (1 + e) * vn * nx; b.vy -= (1 + e) * vn * ny; }
  return 1;
}

/**
 * One ball. power 0..1 is how hard the plunger was pulled; `jitter` a small random sideways speed in the lane.
 * @return {{ok:boolean, slot?:number, frames?:number[][], reason?:string}} slot 1..16, or 0 when the ball drained OUT between the slots; frames are [x, y] at FPS per second
 */
function simulate(T, power, jitter) {
  const b = { x: T.LANE.x, y: T.LANE.startY, vx: jitter, vy: -(T.V_MIN + power * (T.V_MAX - T.V_MIN)) };
  const r = T.BALL_R, S = prepare(T), frames = [[b.x, b.y]];
  let outcome = null;
  for (let step = 1; step <= MAX_STEPS; step++) {
    b.vy += T.GRAVITY * DT;
    b.x += b.vx * DT; b.y += b.vy * DT;
    const k = S.key(b.x, b.y);
    const ws = S.walls.get(k);
    if (ws) for (const w of ws) hitSegment(b, w, r, E_WALL);
    const ps = S.pegs.get(k);
    if (ps) for (const p of ps) hitPeg(b, p, r, E_PEG);
    if (outcome === null && b.y > T.RIM_Y + 8 && b.x < T.LANE.l - 4) {            // below the rim: inside a slot, or between two slots (OUT)
      const s = T.slots.find((q) => b.x > q.xl + 2 && b.x < q.xr - 2);
      outcome = s ? s.n : 0;
      if (s) {                                                                    // the ball settles in the slot
        for (let f = 1; f <= 3; f++) frames.push([b.x + (s.x - b.x) * f / 3, b.y + (T.SLOT_BOTTOM - 12 - b.y) * f / 3]);
        return { ok: true, slot: s.n, frames };
      }
    }
    if (step % STEPS_PER_FRAME === 0) frames.push([b.x, b.y]);
    if (outcome === 0 && b.y > T.OUT_Y) { frames.push([b.x, b.y]); return { ok: true, slot: 0, frames }; }       // drained out of the bottom
    if (b.y > T.LANE.startY + 30 && b.x > T.LANE.l) return { ok: false, reason: 'fell back' };
  }
  return { ok: false, reason: 'stuck' };
}

module.exports = { simulate, mulberry32, DT, STEPS_PER_FRAME };
