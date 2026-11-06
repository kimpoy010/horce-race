/*
 * Fruit Ring: the picture of the ring. An SVG of 24 tiles round a 5 x 5 centre; draw(scene) only touches what changed.
 * window.FruitView.create(svgElement) -> { draw(scene), centerBox }
 *   scene: { lights: [cell...]        the running light(s), bright
 *            lit: {cell: true}         cells that stay lit (the stops of this spin)
 *            wins: {cell: true}        cells whose symbol was bet on and paid: gold frame
 *            bets: {symbol: credits}   a small number on the cells of a symbol that has a bet, optional
 *            flash: cell|null          the Lucky cell that flashes
 *            time: ms }
 */
(function () {
  'use strict';
  var T = window.FruitTable, A = window.FruitArt, NS = 'http://www.w3.org/2000/svg';
  var C = { tile: '#1B2550', line: '#2A3670', gold: '#FFC23D', cyan: '#4FD1E8', lucky3: '#3A1F58', lucky1: '#0E3A52', light: '#FFF3B0' };

  function el(tag, attrs, parent) { var e = document.createElementNS(NS, tag), k; for (k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; }

  function create(svg) {
    svg.setAttribute('viewBox', '0 0 ' + T.SIZE + ' ' + T.SIZE); svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    var tiles = [], glows = [], frames = [], badges = [];
    T.cells.forEach(function (c) {
      var lucky = T.symbolOf(c.kind) === 'lucky';
      var g = el('g', {}, svg);
      el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 7, fill: c.kind === 'free3' ? C.lucky3 : (c.kind === 'light3' ? C.lucky1 : C.tile), stroke: C.line, 'stroke-width': 2 }, g);
      var art = el('g', { transform: 'translate(' + (c.x + 3) + ' ' + (c.y + 3) + ') scale(' + ((c.w - 6) / 48) + ')' }, g);
      art.innerHTML = A.art(c.kind, c.mult);
      glows.push(el('rect', { x: c.x, y: c.y, width: c.w, height: c.h, rx: 7, fill: C.light, opacity: 0 }, g));
      frames.push(el('rect', { x: c.x - 1, y: c.y - 1, width: c.w + 2, height: c.h + 2, rx: 8, fill: 'none', stroke: C.gold, 'stroke-width': 4, opacity: 0 }, g));
      badges.push(el('text', { x: c.x + c.w - 4, y: c.y + 10, 'text-anchor': 'end', 'font-family': "'Press Start 2P', monospace", 'font-size': 8, fill: C.gold, opacity: 0 }, g));
      tiles.push(g);
    });
    var last = {};
    function draw(scene) {
      var lights = {}, k, c;
      (scene.lights || []).forEach(function (x) { lights[x] = true; });
      var pulse = 0.5 + 0.5 * Math.sin((scene.time || 0) / 110);
      for (k = 0; k < 24; k++) {
        c = T.cells[k];
        var on = lights[k] ? 1 : 0, lit = scene.lit && scene.lit[k] ? 1 : 0, flashing = scene.flash === k ? 1 : 0;
        var op = on ? 0.85 : (flashing ? 0.25 + 0.6 * pulse : (lit ? 0.38 : 0));
        var key = op.toFixed(2);
        if (last['g' + k] !== key) { glows[k].setAttribute('opacity', key); last['g' + k] = key; }
        var w = scene.wins && scene.wins[k] ? 1 : 0;
        if (last['f' + k] !== w) { frames[k].setAttribute('opacity', w ? 1 : 0); last['f' + k] = w; }
        var b = scene.bets && scene.bets[c.symbol] ? scene.bets[c.symbol] : 0;
        if (last['b' + k] !== b) { badges[k].textContent = b ? String(b) : ''; badges[k].setAttribute('opacity', b ? 1 : 0); last['b' + k] = b; }
      }
    }
    return { draw: draw, centerBox: T.CENTER };
  }
  window.FruitView = { create: create };
})();
