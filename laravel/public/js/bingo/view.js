/*
 * Bingo Pinball: the picture, in the style of the design (flat vector look: navy panels, round pegs, rounded slots, gold and cyan). The pin board is an SVG drawn straight from the
 * flat table of table.js (the same coordinates the ball paths were computed on, so a ball can only be where the physics put it); the card is a grid of cells.
 * window.BingoView.create(parts) -> { draw(scene) }. draw() is cheap: it only touches what changed.
 *
 * scene: { paytable:{pays,card}, filled:{holeNo:true}, lit:{cell:true}, lineCells:[cell...], winLit:3|4|5|0, ball:{x,y}|null (table coordinates), landed:[holeNo...],
 *          pull:0..1, sparks:[{x,y,dx,dy,t}], pinFlash:{index:t}, caught:[{x,y,t}], time:ms }
 */
(function () {
  'use strict';
  var T = window.BingoTable, NS = 'http://www.w3.org/2000/svg';
  var C = { gold: '#FFC23D', cyan: '#4FD1E8', wall: '#2A3670', peg: '#7F8CC0', slot: '#1B2550', slotLine: '#A9B6E6', ball: '#D7DEEE', ballLine: '#8A96B8', text: '#A9B6E6', win: '#7CE38B' };

  function svg(tag, attrs, parent) {
    var e = document.createElementNS(NS, tag), k;
    for (k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function create(parts) {
    var board = parts.board, card = parts.card, holeRow = parts.holeRow, power = parts.power, pays = parts.pays;
    var i;
    /* ---------- the board ---------- */
    board.setAttribute('viewBox', '124 1 184 178');
    board.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    var walls = svg('g', { fill: 'none', stroke: C.wall, 'stroke-width': 2.2, 'stroke-linecap': 'round' }, board);
    for (i = 0; i < T.walls.length; i++) svg('line', { x1: T.walls[i][0], y1: T.walls[i][1], x2: T.walls[i][2], y2: T.walls[i][3] }, walls);
    var arrows = svg('g', { fill: 'none', stroke: '#1E2A5E', 'stroke-width': 1.2, 'stroke-linecap': 'round' }, board);      // chevrons up the plunger lane
    for (i = 0; i < 6; i++) svg('path', { d: 'M ' + (T.LANE.x - 2.4) + ' ' + (62 + i * 16 + 2.2) + ' L ' + T.LANE.x + ' ' + (62 + i * 16) + ' L ' + (T.LANE.x + 2.4) + ' ' + (62 + i * 16 + 2.2) }, arrows);
    var pins = [];
    for (i = 0; i < T.pins.length; i++) pins.push(svg('circle', { cx: T.pins[i].x, cy: T.pins[i].y, r: 1.7, fill: C.peg }, board));
    var holes = {};
    for (i = 0; i < T.holes.length; i++) {
      var h = T.holes[i], gh = svg('g', { transform: 'translate(' + h.x + ' ' + h.y + ')' }, board);
      svg('rect', { x: -5, y: -5, width: 10, height: 10, rx: 2.2, fill: C.slot, stroke: C.slotLine, 'stroke-width': 0.9 }, gh);
      var tx = svg('text', { x: 0, y: 1.6, 'text-anchor': 'middle', 'font-family': "'Press Start 2P', monospace", 'font-size': 4.3, fill: C.text }, gh); tx.textContent = h.n;
      var ballIn = svg('circle', { cx: 0, cy: 0, r: 3.5, fill: C.ball, stroke: C.ballLine, 'stroke-width': 0.7, visibility: 'hidden' }, gh);
      holes[h.n] = { ball: ballIn, label: tx, on: false };
    }
    // the plunger in its lane: rod, spring, gold knob
    var spring = svg('g', { stroke: C.peg, 'stroke-width': 1, 'stroke-linecap': 'round' }, board), springLines = [];
    for (i = 0; i < 4; i++) springLines.push(svg('line', { x1: T.LANE.x - 4, y1: 0, x2: T.LANE.x + 4, y2: 1.2 }, spring));
    var knob = svg('rect', { x: T.LANE.x - 4.5, y: 0, width: 9, height: 3.6, rx: 1, fill: C.gold }, board);
    // effects: rings where a ball dropped in, sparks, the ball with its short trail
    var rings = [], sparks = [], trail = [];
    for (i = 0; i < 3; i++) rings.push(svg('circle', { r: 0, fill: 'none', stroke: C.gold, 'stroke-width': 0.9, opacity: 0 }, board));
    for (i = 0; i < 14; i++) sparks.push(svg('circle', { r: 0.8, fill: '#fff', opacity: 0 }, board));
    for (i = 0; i < 3; i++) trail.push(svg('circle', { r: T.BALL_R, fill: C.ball, opacity: 0 }, board));
    var ball = svg('circle', { r: T.BALL_R + 0.3, fill: C.ball, stroke: C.ballLine, 'stroke-width': 0.8, visibility: 'hidden' }, board);
    var hist = [];

    /* ---------- the holes drawn so far (the row under the title) ---------- */
    var rowCells = [];
    if (holeRow) while (holeRow.firstChild) holeRow.removeChild(holeRow.firstChild);
    for (i = 0; holeRow && i < 5; i++) { var rc = document.createElement('div'); rc.className = 'hcell'; rc.textContent = '-'; holeRow.appendChild(rc); rowCells.push(rc); }

    /* ---------- the card ---------- */
    var cells = [], builtFor = null, last = {};
    function buildCard(pt) {
      card.textContent = ''; cells = [];
      for (var k = 0; k < 25; k++) { var c = document.createElement('div'); c.className = 'cell'; c.textContent = pt.card[k]; card.appendChild(c); cells.push(c); }
      builtFor = pt.id; last = {};
    }

    function draw(scene) {
      var pt = scene.paytable;
      if (pt && builtFor !== pt.id) buildCard(pt);
      var time = scene.time || 0, k, p;
      // the card
      var lineSet = {}; (scene.lineCells || []).forEach(function (c) { lineSet[c] = true; });
      var flash = Math.floor(time / 160) % 2 === 0;
      for (k = 0; k < cells.length; k++) {
        var st = scene.lit && scene.lit[k] ? (lineSet[k] ? (flash ? 'win' : 'on') : 'on') : '';
        if (last['c' + k] !== st) { cells[k].className = 'cell' + (st ? ' ' + st : ''); last['c' + k] = st; }
      }
      // the holes drawn so far
      for (k = 0; k < rowCells.length; k++) {
        var v = scene.landed && scene.landed[k] != null ? String(scene.landed[k]) : '-';
        if (last['r' + k] !== v) { rowCells[k].textContent = v; rowCells[k].className = 'hcell' + (v === '-' ? '' : ' on'); last['r' + k] = v; }
      }
      // the paytable row that was won
      if (pays && pays.getAttribute('data-win') !== String(scene.winLit || 0)) {          // (the page rebuilds the panel after a play: the attribute is removed then)
        var rowsEl = pays.querySelectorAll('[data-lit]');
        for (k = 0; k < rowsEl.length; k++) rowsEl[k].classList.toggle('won', +rowsEl[k].getAttribute('data-lit') === scene.winLit);
        pays.setAttribute('data-win', scene.winLit || 0);
      }
      // balls sitting in holes
      for (var n in holes) {
        var on = !!(scene.filled && scene.filled[n]);
        if (holes[n].on !== on) { holes[n].on = on; holes[n].ball.setAttribute('visibility', on ? 'visible' : 'hidden'); holes[n].label.setAttribute('fill', on ? C.gold : C.text); }
      }
      // pins that were just hit
      var pf = scene.pinFlash || {};
      for (k = 0; k < pins.length; k++) {
        var hot = pf[k] > 0;
        if (last['p' + k] !== hot) { pins[k].setAttribute('fill', hot ? '#fff' : C.peg); pins[k].setAttribute('r', hot ? 2.6 : 1.7); last['p' + k] = hot; }
      }
      // the plunger
      var pull = scene.pull || 0, kneeY = T.LANE.startY + 7 + pull * 7;
      knob.setAttribute('y', kneeY - 3.6);
      for (k = 0; k < springLines.length; k++) { var sy = kneeY + 3 + k * 3.2 - pull * k * 0.9; springLines[k].setAttribute('y1', sy); springLines[k].setAttribute('y2', sy + 1.2); }
      if (power) power.style.width = Math.round(pull * 100) + '%';
      // the ball and its trail
      if (scene.ball) {
        ball.setAttribute('cx', scene.ball.x); ball.setAttribute('cy', scene.ball.y); ball.setAttribute('visibility', 'visible');
        if (!hist.length || Math.hypot(hist[hist.length - 1].x - scene.ball.x, hist[hist.length - 1].y - scene.ball.y) > 3.2) { hist.push({ x: scene.ball.x, y: scene.ball.y }); if (hist.length > 3) hist.shift(); }
      } else { ball.setAttribute('visibility', 'hidden'); hist.length = 0; }
      for (k = 0; k < trail.length; k++) {
        p = hist[hist.length - 1 - (trail.length - k)];         // the oldest first, fainter and fainter
        if (p && scene.ball) { trail[k].setAttribute('cx', p.x); trail[k].setAttribute('cy', p.y); trail[k].setAttribute('opacity', [0.2, 0.35, 0.55][k]); } else trail[k].setAttribute('opacity', 0);
      }
      (scene.caught || []).forEach(function (c, idx) { var r = rings[idx % rings.length]; r.setAttribute('cx', c.x); r.setAttribute('cy', c.y); r.setAttribute('r', 5 + c.t * 9); r.setAttribute('opacity', Math.max(0, 1 - c.t)); });
      for (k = (scene.caught || []).length; k < rings.length; k++) rings[k].setAttribute('opacity', 0);
      (scene.sparks || []).slice(0, sparks.length).forEach(function (s, idx) { var e = sparks[idx]; e.setAttribute('cx', s.x + s.dx * s.t * 8); e.setAttribute('cy', s.y + s.dy * s.t * 8 + s.t * s.t * 6); e.setAttribute('opacity', Math.max(0, 1 - s.t)); });
      for (k = (scene.sparks || []).length; k < sparks.length; k++) sparks[k].setAttribute('opacity', 0);
    }
    return { draw: draw };
  }

  window.BingoView = { create: create };
})();
