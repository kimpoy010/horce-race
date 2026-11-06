/*
 * Bingo Pinball 16: the picture, in the style of the design. The pin board is an SVG drawn straight from the board of table.js (the same units the ball paths were computed on,
 * so a ball can only be where the physics put it); the card is a 4 x 4 grid; the five jackpot numbers are a row of boxes.
 * window.Bingo16View.create(parts) -> { draw(scene) }. draw() is cheap: it only touches what changed.
 *
 * scene: { paytable, lit:{cellIndex:true}, jpNums:[5 numbers], jpLit:{number:true}, lineCells:[cell...], winKey:'fullline'|..., slotCounts:[n per slot, index 1-16],
 *          ball:{x,y}|null, pull:0..1, sparks:[{x,y,dx,dy,t}], pinFlash:{index:t}, caught:[{x,y,t}], time:ms }
 */
(function () {
  'use strict';
  var T = window.BingoTable16, NS = 'http://www.w3.org/2000/svg';
  var C = { gold: '#FFC23D', cyan: '#4FD1E8', wall: '#2A3670', peg: '#7F8CC0', slot: '#1B2550', slotLine: '#A9B6E6', ball: '#D7DEEE', ballLine: '#8A96B8' };

  function svg(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag), k;
    for (k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function create(parts) {
    var board = parts.board, card = parts.card, jpRow = parts.jpRow, power = parts.power, pays = parts.pays, i, j;
    board.setAttribute('viewBox', '0 0 600 520'); board.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg('path', { d: 'M 592 510 V 60 Q 592 14 546 14 H 54 Q 8 14 8 60 V 510', fill: 'none', stroke: C.wall, 'stroke-width': 4 }, board);
    svg('line', { x1: 540, y1: 70, x2: 540, y2: 510, stroke: C.wall, 'stroke-width': 4 }, board);
    var arrows = svg('g', { fill: 'none', stroke: '#1E2A5E', 'stroke-width': 3, 'stroke-linecap': 'round' }, board);            // chevrons up the plunger lane
    for (i = 0; i < 6; i++) svg('path', { d: 'M 556 ' + (110 + i * 55 + 8) + ' L 566 ' + (110 + i * 55) + ' L 576 ' + (110 + i * 55 + 8) }, arrows);
    var pegs = [];
    for (i = 0; i < T.pegs.length; i++) pegs.push(svg('circle', { cx: T.pegs[i].x, cy: T.pegs[i].y, r: 3, fill: C.peg }, board));
    // the 16 slots, each with its number under it
    for (i = 0; i < 16; i++) {
      var s = T.slots[i];
      svg('rect', { x: s.xl, y: T.RIM_Y, width: 22, height: 52, rx: 3, fill: C.slot, stroke: C.slotLine, 'stroke-width': 2 }, board);
      var tx = svg('text', { x: s.x, y: 494, 'text-anchor': 'middle', 'font-family': "'Press Start 2P', monospace", 'font-size': 8, fill: C.slotLine }, board); tx.textContent = s.n;
    }
    // the catch tray under the slots: a ball that falls through a gap between two slots rolls into it (a miss); it fills with one dot per missed ball
    svg('rect', { x: 14, y: 500, width: 516, height: 16, rx: 8, fill: '#0F1535', stroke: C.wall, 'stroke-width': 2 }, board);
    var cap = svg('text', { x: 26, y: 512, 'font-family': "'Press Start 2P', monospace", 'font-size': 7, fill: C.peg }, board); cap.textContent = 'MISSED';
    var missDots = [], missText = svg('text', { x: 518, y: 512, 'text-anchor': 'end', 'font-family': "'Press Start 2P', monospace", 'font-size': 7, fill: C.gold, visibility: 'hidden' }, board);
    for (i = 0; i < 16; i++) missDots.push(svg('circle', { cx: 100 + i * 24, cy: 508, r: 5, fill: C.ball, stroke: C.ballLine, 'stroke-width': 1, visibility: 'hidden' }, board));
    // balls resting in the slots (up to three show, stacked), and how many when there are more
    var rest = [], count = [];
    for (i = 0; i < 16; i++) {
      rest.push([]);
      for (j = 0; j < 3; j++) rest[i].push(svg('circle', { cx: T.slots[i].x, cy: 462 - 15 * j, r: 7, fill: C.ball, stroke: C.ballLine, 'stroke-width': 1.5, visibility: 'hidden' }, board));
      count.push(svg('text', { x: T.slots[i].x, y: 410, 'text-anchor': 'middle', 'font-family': "'Press Start 2P', monospace", 'font-size': 8, fill: C.gold, visibility: 'hidden' }, board));
    }
    // the plunger: a gold block on its spring in the lane
    var spring = svg('g', { stroke: C.peg, 'stroke-width': 2 }, board), springLines = [];
    for (i = 0; i < 4; i++) springLines.push(svg('line', { x1: 556, y1: 0, x2: 576, y2: 3 }, spring));
    var knob = svg('rect', { x: 554, y: 462, width: 24, height: 10, rx: 2, fill: C.gold }, board);
    // effects and the ball with its short trail
    var rings = [], sparks = [], trail = [];
    for (i = 0; i < 3; i++) rings.push(svg('circle', { r: 0, fill: 'none', stroke: C.gold, 'stroke-width': 2, opacity: 0 }, board));
    for (i = 0; i < 14; i++) sparks.push(svg('circle', { r: 2, fill: '#fff', opacity: 0 }, board));
    for (i = 0; i < 3; i++) trail.push(svg('circle', { r: 6, fill: C.ball, opacity: 0 }, board));
    var ball = svg('circle', { r: 7, fill: C.ball, stroke: C.ballLine, 'stroke-width': 1.5, visibility: 'hidden' }, board);
    var hist = [];

    var jpCells = [];
    if (jpRow) { jpRow.textContent = ''; for (i = 0; i < 5; i++) { var jc = document.createElement('div'); jc.className = 'hcell'; jc.textContent = '-'; jpRow.appendChild(jc); jpCells.push(jc); } }
    var cells = [], built = false, last = {};
    function buildCard() { card.textContent = ''; cells = []; for (var k = 0; k < 16; k++) { var c = document.createElement('div'); c.className = 'cell'; c.textContent = k + 1; card.appendChild(c); cells.push(c); } built = true; last = {}; }

    function draw(scene) {
      if (!built) buildCard();
      var time = scene.time || 0, k, p;
      var jpSet = {}; (scene.jpNums || []).forEach(function (n) { jpSet[n] = true; });
      var lineSet = {}; (scene.lineCells || []).forEach(function (c) { lineSet[c] = true; });
      var flash = Math.floor(time / 160) % 2 === 0;
      for (k = 0; k < 16; k++) {
        var st = (scene.lit && scene.lit[k] ? (lineSet[k] && flash ? 'win' : 'on') : '') + (jpSet[k + 1] ? ' jp' : '');
        if (last['c' + k] !== st) { cells[k].className = 'cell' + (st ? ' ' + st : ''); last['c' + k] = st; }
      }
      var nums = (scene.jpNums || []).slice().sort(function (a, b) { return a - b; });
      for (k = 0; k < 5; k++) {
        var v = nums[k] != null ? String(nums[k]) : '-', lit = nums[k] != null && scene.jpLit && scene.jpLit[nums[k]], key = v + (lit ? 'L' : '');
        if (jpCells[k] && last['j' + k] !== key) { jpCells[k].textContent = v; jpCells[k].className = 'hcell' + (v === '-' ? '' : ' on') + (lit ? ' lit' : ''); last['j' + k] = key; }
      }
      if (pays && pays.getAttribute('data-win') !== (scene.winKey || '')) {                                  // the page rebuilds the panel after a play: the attribute is removed then
        var rowsEl = pays.querySelectorAll('[data-key]');
        for (k = 0; k < rowsEl.length; k++) rowsEl[k].classList.toggle('won', rowsEl[k].getAttribute('data-key') === scene.winKey);
        pays.setAttribute('data-win', scene.winKey || '');
      }
      for (k = 1; k <= 16; k++) {                                                                            // balls resting in the slots
        var n = (scene.slotCounts && scene.slotCounts[k]) || 0;
        if (last['s' + k] !== n) {
          for (j = 0; j < 3; j++) rest[k - 1][j].setAttribute('visibility', n > j ? 'visible' : 'hidden');
          count[k - 1].setAttribute('visibility', n > 3 ? 'visible' : 'hidden'); count[k - 1].textContent = '×' + n;
          last['s' + k] = n;
        }
      }
      var ms = scene.missed || 0;
      if (last.miss !== ms) { for (j = 0; j < 16; j++) missDots[j].setAttribute('visibility', ms > j ? 'visible' : 'hidden'); missText.setAttribute('visibility', ms ? 'visible' : 'hidden'); missText.textContent = '×' + ms; last.miss = ms; }
      var pf = scene.pinFlash || {};
      for (k = 0; k < pegs.length; k++) {
        var hot = pf[k] > 0;
        if (last['p' + k] !== hot) { pegs[k].setAttribute('fill', hot ? '#fff' : C.peg); pegs[k].setAttribute('r', hot ? 5 : 3); last['p' + k] = hot; }
      }
      var pull = scene.pull || 0, kneeY = 462 + pull * 28;
      knob.setAttribute('y', kneeY);
      for (k = 0; k < springLines.length; k++) { var sy = kneeY + 14 + k * 8 - pull * k * 2; springLines[k].setAttribute('y1', Math.min(sy, 506)); springLines[k].setAttribute('y2', Math.min(sy, 506) + 3); }
      if (power) power.style.width = Math.round(pull * 100) + '%';
      if (scene.ball) {
        ball.setAttribute('cx', scene.ball.x); ball.setAttribute('cy', scene.ball.y); ball.setAttribute('visibility', scene.ball.y > 498 ? 'hidden' : 'visible');     // below the slots it drops into the tray
        if (!hist.length || Math.hypot(hist[hist.length - 1].x - scene.ball.x, hist[hist.length - 1].y - scene.ball.y) > 14) { hist.push({ x: scene.ball.x, y: scene.ball.y }); if (hist.length > 3) hist.shift(); }
      } else { ball.setAttribute('visibility', 'hidden'); hist.length = 0; }
      for (k = 0; k < trail.length; k++) {
        p = hist[hist.length - 1 - (trail.length - k)];
        if (p && scene.ball) { trail[k].setAttribute('cx', p.x); trail[k].setAttribute('cy', p.y); trail[k].setAttribute('opacity', [0.2, 0.35, 0.55][k]); } else trail[k].setAttribute('opacity', 0);
      }
      (scene.caught || []).forEach(function (c, idx) { var r = rings[idx % rings.length]; r.setAttribute('cx', c.x); r.setAttribute('cy', c.y); r.setAttribute('r', 10 + c.t * 22); r.setAttribute('opacity', Math.max(0, 1 - c.t)); });
      for (k = (scene.caught || []).length; k < rings.length; k++) rings[k].setAttribute('opacity', 0);
      (scene.sparks || []).slice(0, sparks.length).forEach(function (s, idx) { var e = sparks[idx]; e.setAttribute('cx', s.x + s.dx * s.t * 24); e.setAttribute('cy', s.y + s.dy * s.t * 24 + s.t * s.t * 16); e.setAttribute('opacity', Math.max(0, 1 - s.t)); });
      for (k = (scene.sparks || []).length; k < sparks.length; k++) sparks[k].setAttribute('opacity', 0);
    }
    return { draw: draw };
  }

  window.Bingo16View = { create: create };
})();
