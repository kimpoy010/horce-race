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
  var btn = document.getElementById('fsBtn');
  if (btn) btn.addEventListener('click', fullscreen);
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  if (coarse) document.addEventListener('pointerdown', function once() { document.removeEventListener('pointerdown', once); if (!locked) fullscreen(); }, { once: true });
})();
