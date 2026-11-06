/*
 * Fruit Game: the pictures, drawn for this project as flat vector shapes (no outside artwork). Every symbol is an SVG fragment on a 48 x 48 grid; art(kind, mult) gives the
 * fragment for a ring cell, and defs() the <defs> to put in the ring's <svg>. window.FruitArt, or require() in Node.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FruitArt = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var F = "font-family=\"'Press Start 2P', monospace\"";
  var leaf = '<path d="M25 12c0-5 4-8 9-9 0 5-4 9-9 9z" fill="#4CAF50"/><path d="M24 14v-4" stroke="#6B4423" stroke-width="2" stroke-linecap="round"/>';
  var SYM = {
    apple: '<path d="M24 15c-8-5-17 0-17 11 0 10 6 18 12 18 2 0 3-1 5-1s3 1 5 1c6 0 12-8 12-18 0-11-9-16-17-11z" fill="#E5392F"/><path d="M13 24c0-5 3-8 6-9" stroke="#FF8A7A" stroke-width="3" fill="none" stroke-linecap="round"/>' + leaf,
    orange: '<circle cx="24" cy="27" r="16" fill="#FF8A1F"/><path d="M14 24c1-5 4-8 8-9" stroke="#FFC27A" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="18" cy="32" r="1.4" fill="#E36A00"/><circle cx="27" cy="35" r="1.4" fill="#E36A00"/><circle cx="31" cy="27" r="1.4" fill="#E36A00"/>' + leaf,
    lemon: '<path d="M4 27c0-9 9-15 20-15s20 6 20 15-9 14-20 14S4 36 4 27z" fill="#F7E04A" transform="rotate(-18 24 27)"/><path d="M4 27l-3-2m3 2l-1 4" stroke="#C9B21F" stroke-width="2" stroke-linecap="round" transform="rotate(-18 24 27)"/><path d="M13 22c3-4 8-6 13-6" stroke="#FFF6A6" stroke-width="3" fill="none" stroke-linecap="round"/>',
    watermelon: '<path d="M4 18a20 20 0 0 0 40 0z" fill="#2E9E4F"/><path d="M9 18a15 15 0 0 0 30 0z" fill="#E94B5B"/><ellipse cx="17" cy="24" rx="1.6" ry="2.6" fill="#2B1B1B"/><ellipse cx="24" cy="29" rx="1.6" ry="2.6" fill="#2B1B1B"/><ellipse cx="31" cy="24" rx="1.6" ry="2.6" fill="#2B1B1B"/><path d="M4 18h40" stroke="#BFF0C8" stroke-width="2"/>',
    bell: '<path d="M24 7c-7 0-12 6-12 14v8l-5 7h34l-5-7v-8c0-8-5-14-12-14z" fill="#F5B82E"/><path d="M17 20c0-5 3-9 7-10" stroke="#FFE08A" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="24" cy="41" r="4" fill="#C98A0B"/><path d="M24 7l-6-4 4 6zM24 7l6-4-4 6z" fill="#E5392F"/><circle cx="24" cy="8" r="2.5" fill="#B71C1C"/>',
    star: '<path d="M24 4l6 13 14 2-10 10 3 14-13-7-13 7 3-14L4 19l14-2z" fill="#FFD23F" stroke="#C98A0B" stroke-width="2" stroke-linejoin="round"/><path d="M24 12l3 7" stroke="#FFF0A8" stroke-width="3" stroke-linecap="round"/>',
    seven: '<path d="M9 9h31v8L26 41h-10l13-23H9z" fill="#E3262E" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/><path d="M13 13h22" stroke="#FF8A7A" stroke-width="3" stroke-linecap="round"/>'
  };
  function plate(y, h) { return '<rect x="5" y="' + y + '" width="38" height="' + h + '" rx="3" fill="#15152B" stroke="#FFC23D" stroke-width="2"/>'; }
  SYM.bar3 = plate(5, 11) + plate(18.5, 11) + plate(32, 11) + ['10.5', '24', '37.5'].map(function (y) { return '<text x="24" y="' + y + '" text-anchor="middle" dominant-baseline="central" font-size="7" fill="#FFC23D" ' + F + '>BAR</text>'; }).join('');
  SYM.bar50 = plate(13, 22) + '<text x="24" y="24.5" text-anchor="middle" dominant-baseline="central" font-size="10" fill="#FFC23D" ' + F + '>BAR</text>';
  // the two Lucky cells: a starburst with the promise written on it
  var burst = '<path d="M24 2l4 8 8-4-2 9 9 2-7 6 7 6-9 2 2 9-8-4-4 8-4-8-8 4 2-9-9-2 7-6-7-6 9-2-2-9 8 4z" fill="#FFC23D"/>';
  function luckyPlate(fill, ink, word) {
    return burst.replace('#FFC23D', ink) + '<rect x="7" y="9" width="34" height="30" rx="6" fill="' + fill + '"/>'
      + '<text x="24" y="15.5" text-anchor="middle" dominant-baseline="central" font-size="5" fill="#fff" ' + F + '>LUCKY</text>'
      + '<text x="24" y="25" text-anchor="middle" dominant-baseline="central" font-size="13" fill="' + ink + '" ' + F + '>3</text>'
      + '<text x="24" y="34" text-anchor="middle" dominant-baseline="central" font-size="5" fill="#fff" ' + F + '>' + word + '</text>';
  }
  SYM.free3 = luckyPlate('#7A3AA0', '#FFC23D', 'SPINS');
  SYM.light3 = luckyPlate('#0E4A63', '#4FD1E8', 'LIGHTS');

  var BADGE = '<rect x="26" y="30" width="21" height="16" rx="4" fill="#FFC23D" stroke="#15152B" stroke-width="2"/><text x="36.5" y="38.5" text-anchor="middle" dominant-baseline="central" font-size="8" fill="#15152B" ' + F + '>×3</text>';

  /** the picture of a ring cell: kind as in FruitTable.RING, mult 1 or 3 (a x3 cell wears a badge) */
  function art(kind, mult) { return (SYM[kind] || '') + (mult === 3 ? BADGE : ''); }
  /** the picture of a bet symbol (bar uses the triple plate) for the bet buttons and the pay table */
  function symbol(name) { return SYM[name === 'bar' ? 'bar3' : name] || ''; }

  return { art: art, symbol: symbol, kinds: Object.keys(SYM) };
});
