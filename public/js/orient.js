/*
 * Landscape layout everywhere. A phone held upright shows the same landscape game turned a quarter turn (CSS, see game.css); when the
 * phone is turned to landscape the normal layout takes over. Where the browser allows it (Android Chrome, installed web apps) the
 * first tap also goes full screen and locks the orientation to landscape. This file also tells the CSS how big the visible screen is.
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
  var locked = false;
  function lock() {
    try {
      if (screen.orientation && screen.orientation.lock) return screen.orientation.lock('landscape').then(function () { locked = true; }, function () {});
    } catch (e) { /* not supported */ }
  }
  function fullscreen() {
    var el = document.documentElement, req = el.requestFullscreen || el.webkitRequestFullscreen;
    try { if (req && !document.fullscreenElement) return Promise.resolve(req.call(el)).then(lock, lock); } catch (e) { /* ignore */ }
    return lock();
  }
  // start screen: one tap (browsers only allow full screen, landscape lock and sound after a tap) starts all three
  var start = document.getElementById('start');
  if (start && new URLSearchParams(location.search).get('start') !== '0') {
    var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    var standalone = navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches);
    var tip = document.getElementById('startTip'); if (tip && ios && !standalone) tip.hidden = false;
    start.hidden = false;
    var begin = function () { if (start.hidden) return; start.hidden = true; if (!standalone) fullscreen(); };   // the sound starts with the same tap (game.js)
    start.addEventListener('click', begin);
    start.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); begin(); } });
    try { start.focus(); } catch (e) { /* ignore */ }
  }
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse) document.addEventListener('pointerdown', function once() { document.removeEventListener('pointerdown', once); if (!locked) fullscreen(); }, { once: true });
})();
