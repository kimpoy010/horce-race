/*
 * Controller page. Talks to server.js when available (?api=https://host also works),
 * otherwise runs the Director itself and shares state with the game page of the same
 * browser through localStorage ("local mode").
 */
(function () {
  'use strict';
  var C = window.HorseCore;
  var qs = new URLSearchParams(location.search);
  var $ = function (id) { return document.getElementById(id); };
  var NAMES = { 1: 'White', 2: 'Pink', 3: 'Red', 4: 'Blue', 5: 'Yellow', 6: 'Green' };
  var backend = null, admin = null, plan = [], lastVersion = -1, saveTimer = null, pending = false;

  function chip(n) { return '<span class="chip h' + n + '">' + n + '</span>'; }

  /* ---------- backends ---------- */
  function LocalBackend() {
    var KEY = 'horserace.director', PUB = 'horserace.public', saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY)); } catch (e) { /* fresh */ }
    var d = new C.Director(saved);
    function persist() {
      var now = Date.now();
      localStorage.setItem(KEY, JSON.stringify(d.serialize()));
      localStorage.setItem(PUB, JSON.stringify(d.publicState(now, true)));
    }
    persist();
    setInterval(function () { d.tick(Date.now()); persist(); }, 400);
    return {
      mode: 'local',
      admin: function () { return Promise.resolve(d.adminState(Date.now())); },
      command: function (c) { var r = C.execCommand(d, c, Date.now()); persist(); return Promise.resolve(r); }
    };
  }

  function ServerBackend(base) {
    function key() { return localStorage.getItem('horserace.key') || qs.get('key') || ''; }
    function call(path, opts) {
      opts = opts || {}; opts.headers = { 'x-controller-key': key(), 'content-type': 'application/json' }; opts.cache = 'no-store';
      return fetch(base + path, opts).then(function (r) {
        if (r.status === 401) { var e = new Error('auth'); e.auth = true; throw e; }
        return r.json();
      });
    }
    return {
      mode: 'server',
      admin: function () { return call('/api/admin'); },
      command: function (c) { return call('/api/command', { method: 'POST', body: JSON.stringify(c) }); }
    };
  }

  /* ---------- UI ---------- */
  function buildPad() {
    var pad = $('pad'); pad.innerHTML = '';
    for (var n = 1; n <= 6; n++) {
      var b = document.createElement('button');
      b.className = 'padbtn h' + n; b.dataset.n = n; b.title = NAMES[n]; b.textContent = n;
      b.addEventListener('click', onPad);
      pad.appendChild(b);
    }
  }

  function onPad(ev) {
    var n = +ev.currentTarget.dataset.n, e = plan[admin.index];
    if (!e) return;
    if (e.a === n) { e.a = e.b; e.b = null; }
    else if (e.b === n) e.b = null;
    else if (!e.a) e.a = n;
    else if (!e.b) e.b = n;
    else e.b = n;
    changed(); renderPlanRows(); renderPad();
  }

  function renderPad() {
    var e = plan[admin.index] || C.normEntry();
    [].forEach.call($('pad').children, function (b) {
      var n = +b.dataset.n;
      b.classList.toggle('sel', e.a === n || e.b === n);
      var tag = b.querySelector('.tag'); if (tag) tag.remove();
      if (e.a === n || e.b === n) {
        var t = document.createElement('span'); t.className = 'tag'; t.textContent = e.a === n ? 'A' : 'B'; b.appendChild(t);
      }
    });
    $('padRace').textContent = '(race ' + (admin.index + 1) + ')';
    $('padExact').checked = !!e.exact;
    $('padText').textContent = e.a && e.b
      ? 'Horses ' + e.a + ' and ' + e.b + ' will finish 1st and 2nd' + (e.exact ? ' (' + e.a + ' wins, ' + e.b + ' second).' : ' in random order.')
      : (e.a || e.b) ? 'One horse chosen - the second winner will be random.' : 'Nothing set: this race will be completely random.';
  }

  function selectHTML(val, field, i) {
    var o = '<option value="">random</option>';
    for (var n = 1; n <= 6; n++) o += '<option value="' + n + '"' + (val === n ? ' selected' : '') + '>' + n + ' ' + NAMES[n] + '</option>';
    return '<select data-i="' + i + '" data-f="' + field + '">' + o + '</select>';
  }

  function buildTable() {
    var tb = document.querySelector('#plan tbody'), html = '';
    plan.forEach(function (e, i) {
      html += '<tr data-row="' + i + '"><td>' + (i + 1) + '</td><td>' + selectHTML(e.a, 'a', i) + '</td><td>' + selectHTML(e.b, 'b', i) +
        '</td><td><input type="checkbox" data-i="' + i + '" data-f="exact"' + (e.exact ? ' checked' : '') + '></td>' +
        '<td class="res"></td><td><button data-next="' + i + '">next</button></td></tr>';
    });
    tb.innerHTML = html;
  }

  function renderPlanRows() {
    var rows = document.querySelectorAll('#plan tbody tr');
    [].forEach.call(rows, function (tr, i) {
      var e = plan[i]; if (!e) return;
      tr.querySelector('[data-f=a]').value = e.a || '';
      tr.querySelector('[data-f=b]').value = e.b || '';
      tr.querySelector('[data-f=exact]').checked = !!e.exact;
    });
  }

  function renderMeta() {
    var now = admin.serverNow, c = admin.current, tm = admin.timings;
    var results = {};
    admin.history.forEach(function (h) { results[h.raceNo] = h; });
    [].forEach.call(document.querySelectorAll('#plan tbody tr'), function (tr, i) {
      var h = results[i + 1], running = h && now < h.startAt + tm.race;
      tr.className = i === admin.index ? 'next' : h ? (running ? 'running' : 'done') : '';
      tr.querySelector('.res').innerHTML = h ? (running ? 'running...' : (function (c) { return chip(c[0]) + '-' + chip(c[1]); })(C.combination(h.order))) : '';
    });

    $('nextNo').textContent = admin.index + 1;
    var st = 'Idle - ready to start.';
    if (c) {
      var t = (now - c.startAt) / 1000;
      if (t < 0) st = 'Race ' + c.raceNo + ' starts in ' + Math.ceil(-t) + 's';
      else if (t * 1000 < tm.race) st = 'Race ' + c.raceNo + ' running (' + Math.floor(t) + 's)';
      else if (t * 1000 < tm.race + tm.results) st = 'Showing results of race ' + c.raceNo;
    }
    $('status').textContent = st;
    $('current').textContent = c ? 'Last/current race ' + c.raceNo + ' finishing order: ' + c.order.join(' - ') : '';
    $('start').disabled = admin.busy;
    $('auto').checked = admin.auto;
    $('mode').textContent = backend.mode === 'server' ? 'SERVER MODE' : 'LOCAL MODE (same browser only)';
  }

  /* ---------- plan saving ---------- */
  function changed() {
    pending = true; $('saved').textContent = 'saving...';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      backend.command({ cmd: 'setPlan', plan: plan }).then(function (r) {
        pending = false; if (r.version != null) lastVersion = r.version;
        $('saved').textContent = r.ok ? 'saved' : 'error: ' + r.error;
      }).catch(function () { pending = false; $('saved').textContent = 'save failed'; });
    }, 200);
  }

  document.addEventListener('change', function (ev) {
    var t = ev.target, i = t.dataset && t.dataset.i;
    if (i == null || !plan[i]) return;
    var e = plan[i], f = t.dataset.f;
    if (f === 'exact') e.exact = t.checked; else e[f] = t.value ? +t.value : null;
    if (e.a && e.a === e.b) { if (f === 'a') e.b = null; else e.a = null; }
    changed(); renderPlanRows(); if (+i === admin.index) renderPad();
  });
  document.addEventListener('click', function (ev) {
    var n = ev.target.dataset && ev.target.dataset.next;
    if (n != null) backend.command({ cmd: 'setIndex', index: +n }).then(function () { lastVersion = -1; });
  });

  $('padExact').addEventListener('change', function () { plan[admin.index].exact = this.checked; changed(); renderPlanRows(); renderPad(); });
  $('padClear').addEventListener('click', function () { plan[admin.index] = C.normEntry(); changed(); renderPlanRows(); renderPad(); });
  $('more').addEventListener('click', function () {
    for (var i = 0; i < 10 && plan.length < C.MAX_PLAN; i++) plan.push(C.normEntry());
    changed(); buildTable(); renderPlanRows(); renderMeta();
  });
  $('randomize').addEventListener('click', function () {
    plan.forEach(function (e, i) {
      if (i < admin.index || (e.a && e.b)) return;
      var a = 1 + Math.floor(Math.random() * 6), b; do { b = 1 + Math.floor(Math.random() * 6); } while (b === a);
      e.a = a; e.b = b;
    });
    changed(); renderPlanRows(); renderPad();
  });
  $('start').addEventListener('click', function () { backend.command({ cmd: 'start' }).then(function (r) { if (!r.ok) alert(r.error); refresh(); }); });
  $('auto').addEventListener('change', function () { backend.command({ cmd: 'setAuto', auto: this.checked }); });
  $('reset').addEventListener('click', function () {
    if (confirm('Reset to race 1 and clear the results history?')) backend.command({ cmd: 'reset' }).then(function () { lastVersion = -1; refresh(); });
  });
  $('keySave').addEventListener('click', function () {
    localStorage.setItem('horserace.key', $('keyInput').value); $('keyErr').textContent = ''; refresh();
  });

  /* ---------- loop ---------- */
  function refresh() {
    return backend.admin().then(function (a) {
      $('keyBox').hidden = true; admin = a;
      if (!pending && a.version !== lastVersion) {
        plan = a.plan.map(function (e) { return Object.assign({}, e); });
        lastVersion = a.version; buildTable(); renderPlanRows();
      }
      renderPad(); renderMeta();
    }).catch(function (e) {
      if (e && e.auth) { $('keyBox').hidden = false; $('keyErr').textContent = localStorage.getItem('horserace.key') ? 'Wrong key' : ''; }
      else $('status').textContent = 'Cannot reach server...';
    });
  }

  function init() {
    buildPad();
    var base = (qs.get('api') || '').replace(/\/$/, '');
    if (base) $('openGame').href = 'index.html?api=' + encodeURIComponent(base);
    if (qs.get('mode') === 'local') backend = LocalBackend();
    else {
      fetch((base || '.') + '/api/public', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(); backend = ServerBackend(base || '.'); })
        .catch(function () { backend = LocalBackend(); })
        .then(function () { refresh(); setInterval(refresh, 600); });
      return;
    }
    refresh(); setInterval(refresh, 600);
  }
  init();
})();
