/*
 * Fruit Game: the ring of 24 cells, in the units of the page's 366 x 366 ring drawing (7 x 7 cells, only the border is used). One file for three users: the page draws the ring from it, the
 * animation plan walks it, the tests check it against the maths (docs/fruit/verify_play.py). UMD: window.FruitTable, or require() in Node.
 * Cell k (0-23) is the k-th cell clockwise from the top left: 0-6 along the top, 7-11 down the right side, 12-18 along the bottom (right to left), 19-23 up the left side.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FruitTable = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SIZE = 366, CELL = 46, STEP = 50, PAD = 10;
  var SYMBOLS = ['bar', 'seven', 'star', 'watermelon', 'bell', 'lemon', 'orange', 'apple'];     // the order of the eight bets
  // [kind, multiplier] for every cell: the same ring as Rules::RING (weights are the server's business). Kinds: a symbol, 'bar3' (the triple BAR cell), 'bar50' (the single BAR cell), 'free3' (3 free spins), 'light3' (a free spin with 3 lit cells)
  var RING = [['orange', 1], ['bell', 1], ['bar50', 1], ['bar3', 1], ['apple', 1], ['apple', 3], ['lemon', 1], ['watermelon', 1], ['watermelon', 3], ['free3', 1], ['apple', 1], ['orange', 3],
    ['orange', 1], ['bell', 1], ['seven', 3], ['seven', 1], ['apple', 1], ['lemon', 3], ['lemon', 1], ['star', 3], ['star', 1], ['light3', 1], ['apple', 1], ['bell', 3]];

  function colRow(k) {
    if (k <= 6) return { col: k, row: 0 };
    if (k <= 11) return { col: 6, row: k - 6 };
    if (k <= 18) return { col: 18 - k, row: 6 };
    return { col: 0, row: 24 - k };
  }
  var cells = RING.map(function (c, k) {
    var p = colRow(k);
    return { index: k, kind: c[0], mult: c[1], symbol: symbolOf(c[0]), col: p.col, row: p.row, x: PAD + p.col * STEP, y: PAD + p.row * STEP, w: CELL, h: CELL, cx: PAD + p.col * STEP + CELL / 2, cy: PAD + p.row * STEP + CELL / 2 };
  });

  /** the bet symbol a cell belongs to, or 'lucky' */
  function symbolOf(kind) { return kind === 'bar3' || kind === 'bar50' ? 'bar' : (kind === 'free3' || kind === 'light3' ? 'lucky' : kind); }
  /** the centre area inside the ring (5 x 5 cells), where the page shows the win and the bets */
  var CENTER = { x: PAD + STEP, y: PAD + STEP, w: 5 * STEP - 4, h: 5 * STEP - 4 };

  return { SIZE: SIZE, CELL: CELL, STEP: STEP, PAD: PAD, SYMBOLS: SYMBOLS, RING: RING, cells: cells, CENTER: CENTER, symbolOf: symbolOf, next: function (k) { return (k + 1) % 24; } };
});
