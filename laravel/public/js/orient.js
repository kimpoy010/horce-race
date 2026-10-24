/*
 * Landscape layout everywhere. A phone held upright shows the same landscape game turned a quarter turn (CSS, see game.css); when the
 * phone is turned to landscape the normal layout takes over. This file also tells the CSS how big the visible screen is and runs the
 * start screen. There is no automatic full screen.
 */
(function () {
  'use strict';
  // CSS needs the height that is really visible (iPhone Safari: 100vh is taller than the screen while the toolbars show)
  var upright = function () { return !!(window.matchMedia && window.matchMedia('(orientation: portrait) and (pointer: coarse)').matches); };
  function fitHeight() {
    var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty('--vh', (h / 100) + 'px');
    document.documentElement.classList.toggle('short', (upright() ? window.innerWidth : h) < 760);      // compact betting panel on a short landscape screen
  }
  // a touch point in the coordinates of the landscape game (turned a quarter turn when the phone is upright)
  window.HorseOrient = {
    upright: upright,
    point: function (t) { return upright() ? { x: t.clientY, y: window.innerWidth - t.clientX, w: window.innerHeight } : { x: t.clientX, y: t.clientY, w: window.innerWidth }; }
  };
  fitHeight();
  window.addEventListener('resize', fitHeight); window.addEventListener('orientationchange', function () { setTimeout(fitHeight, 250); });
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitHeight);
  // start screen: one tap starts the sound (browsers only allow sound after a tap). The game never goes full screen by itself.
  var start = document.getElementById('start');
  if (start && new URLSearchParams(location.search).get('start') !== '0') {
    start.hidden = false;
    var begin = function () { start.hidden = true; };          // the sound starts with the same tap (game.js)
    start.addEventListener('click', begin);
    start.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); begin(); } });
    try { start.focus(); } catch (e) { /* ignore */ }
  }
})();
