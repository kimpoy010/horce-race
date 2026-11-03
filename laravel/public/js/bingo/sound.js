/* Bingo Pinball: the sound, all made in the browser (no files, nothing to license): a few short effects and a small chiptune loop. Browsers only start sound after a tap:
   unlock() is called by the start screen. The choice of sound and music is remembered. */
(function () {
  'use strict';
  var ctx = null, master = null, sfxOn = true, musicOn = true, musicTimer = null, step = 0, nextAt = 0;
  try { var s = JSON.parse(localStorage.getItem('bp.sound') || '{}'); sfxOn = s.sfx !== false; musicOn = s.music !== false; } catch (e) { /* defaults */ }
  function save() { try { localStorage.setItem('bp.sound', JSON.stringify({ sfx: sfxOn, music: musicOn })); } catch (e) { /* ignore */ } }

  function ensure() {
    if (ctx) return ctx;
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC(); master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    return ctx;
  }
  function tone(freq, dur, type, vol, when, slideTo, bus) {
    if (!ctx) return;
    var t = (when || ctx.currentTime), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.2, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(bus || master); o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, when, low) {
    if (!ctx) return;
    var t = when || ctx.currentTime, n = Math.floor(ctx.sampleRate * dur), buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0), i;
    for (i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var src = ctx.createBufferSource(), g = ctx.createGain(), f = ctx.createBiquadFilter();
    src.buffer = buf; f.type = 'lowpass'; f.frequency.value = low || 2400; g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(master); src.start(t);
  }
  function fx(fn) { return function () { if (sfxOn && ctx) fn.apply(null, arguments); }; }

  var sfx = {
    click: fx(function () { tone(900, 0.05, 'square', 0.12); }),
    pull: fx(function (p) { tone(120 + p * 140, 0.06, 'sawtooth', 0.07); }),                                    // the spring creaks while it is pulled
    launch: fx(function (p) { noise(0.12, 0.35, 0, 1800); tone(90, 0.18, 'triangle', 0.4, 0, 45); tone(300 + p * 500, 0.22, 'square', 0.1, 0.02, 120); }),
    tick: fx(function () { tone(1500 + Math.random() * 900, 0.04, 'square', 0.1); }),
    drop: fx(function () { var t = ctx.currentTime; tone(880, 0.07, 'square', 0.16, t); tone(660, 0.07, 'square', 0.16, t + 0.07); tone(440, 0.12, 'square', 0.16, t + 0.14); noise(0.08, 0.2, t + 0.2, 900); }),
    lit: fx(function (n) { var t = ctx.currentTime; tone(520 + n * 90, 0.09, 'triangle', 0.2, t); tone(780 + n * 90, 0.12, 'triangle', 0.2, t + 0.08); }),
    win: fx(function (size) {                                                                                      // size 3, 4 or 5 lit cells in the line
      var t = ctx.currentTime, notes = size >= 5 ? [523, 659, 784, 1047, 784, 1047, 1319, 1568] : size === 4 ? [523, 659, 784, 1047, 1319] : [523, 659, 784, 1047];
      notes.forEach(function (f, i) { tone(f, 0.16, 'square', 0.17, t + i * 0.1); tone(f / 2, 0.16, 'triangle', 0.15, t + i * 0.1); });
    }),
    lose: fx(function () { var t = ctx.currentTime; tone(330, 0.16, 'triangle', 0.18, t); tone(262, 0.28, 'triangle', 0.18, t + 0.16); }),
    error: fx(function () { tone(180, 0.2, 'sawtooth', 0.14); })
  };

  // a small original loop: a bass line and a lead, 8th notes at about 128 bpm
  var LEAD = [659, 784, 880, 784, 659, 587, 523, 587, 659, 784, 1047, 988, 880, 784, 659, 0, 523, 659, 784, 659, 523, 494, 440, 494, 523, 587, 659, 587, 523, 392, 523, 0];
  var BASS = [131, 0, 196, 0, 220, 0, 196, 0, 131, 0, 196, 0, 220, 0, 196, 0, 110, 0, 165, 0, 196, 0, 165, 0, 131, 0, 196, 0, 98, 0, 131, 0];
  function schedule() {
    if (!ctx || !musicOn) return;
    var dur = 60 / 128 / 2;
    while (nextAt < ctx.currentTime + 0.35) {
      var i = step % LEAD.length;
      if (LEAD[i]) tone(LEAD[i], dur * 0.9, 'square', 0.035, nextAt);
      if (BASS[i]) tone(BASS[i], dur * 1.8, 'triangle', 0.07, nextAt);
      nextAt += dur; step++;
    }
  }
  function startMusic() {
    if (!ctx || !musicOn || musicTimer) return;
    nextAt = ctx.currentTime + 0.05;
    musicTimer = setInterval(schedule, 120);
  }
  function stopMusic() { if (musicTimer) { clearInterval(musicTimer); musicTimer = null; } }

  window.BingoSound = {
    unlock: function () { var c = ensure(); if (!c) return; if (c.state === 'suspended') c.resume(); startMusic(); },
    sfx: sfx,
    isSfx: function () { return sfxOn; }, isMusic: function () { return musicOn; },
    setSfx: function (on) { sfxOn = !!on; save(); },
    setMusic: function (on) { musicOn = !!on; save(); if (musicOn) startMusic(); else stopMusic(); }
  };
})();
