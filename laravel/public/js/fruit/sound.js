/* Fruit Ring: a few short original sounds (WebAudio). Nothing plays before the first tap. window.FruitSound */
(function () {
  'use strict';
  var ctx = null, on = true;
  try { on = JSON.parse(localStorage.getItem('fr.sound') || '{}').on !== false; } catch (e) { /* default on */ }
  function ensure() { if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; } } return ctx; }
  function tone(f, d, type, vol, at, to) {
    var c = ensure(); if (!c || !on) return;
    var t = at === undefined ? c.currentTime : at, o = c.createOscillator(), g = c.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(f, t); if (to) o.frequency.linearRampToValueAtTime(to, t + d);
    g.gain.setValueAtTime(vol || 0.12, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(c.destination); o.start(t); o.stop(t + d + 0.02);
  }
  window.FruitSound = {
    unlock: function () { var c = ensure(); if (c && c.state === 'suspended') c.resume(); },
    isOn: function () { return on; },
    setOn: function (v) { on = !!v; try { localStorage.setItem('fr.sound', JSON.stringify({ on: on })); } catch (e) { /* ignore */ } },
    click: function () { tone(900, 0.05, 'square', 0.1); },
    tick: function (slow) { tone(slow ? 700 : 1300 + Math.random() * 300, 0.035, 'square', 0.07); },
    land: function () { var c = ensure(); if (!c) return; var t = c.currentTime; tone(520, 0.1, 'triangle', 0.2, t); tone(780, 0.14, 'triangle', 0.2, t + 0.09); },
    lucky: function () { var c = ensure(); if (!c) return; var t = c.currentTime; [523, 659, 784, 1047, 1319].forEach(function (f, i) { tone(f, 0.14, 'square', 0.12, t + i * 0.08); }); },
    win: function (big) { var c = ensure(); if (!c) return; var t = c.currentTime; (big ? [523, 659, 784, 1047, 784, 1047, 1319] : [523, 659, 784, 1047]).forEach(function (f, i) { tone(f, 0.16, 'square', 0.15, t + i * 0.1); tone(f / 2, 0.16, 'triangle', 0.12, t + i * 0.1); }); },
    lose: function () { var c = ensure(); if (!c) return; var t = c.currentTime; tone(330, 0.16, 'triangle', 0.16, t); tone(262, 0.28, 'triangle', 0.16, t + 0.16); },
    error: function () { tone(180, 0.2, 'sawtooth', 0.12); }
  };
})();
