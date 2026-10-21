/*
 * Landscape only. In portrait on touch devices a "rotate your device" screen covers the game (CSS). Where the browser
 * allows it (Android Chrome, installed web apps) the first tap also goes full screen and locks the orientation.
 * iOS Safari cannot lock the orientation, so there the cover screen is the only way to keep players in landscape.
 */
(function () {
  'use strict';
  // CSS needs the height that is really visible (iPhone Safari: 100vh is taller than the screen while the toolbars show)
  function fitHeight() {
    var h = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
    document.documentElement.style.setProperty('--vh', (h / 100) + 'px');
  }
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
  var btn = document.getElementById('fsBtn');
  if (btn) btn.addEventListener('click', fullscreen);
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse) document.addEventListener('pointerdown', function once() { document.removeEventListener('pointerdown', once); if (!locked) fullscreen(); }, { once: true });
})();
