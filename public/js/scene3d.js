/*
 * Low-resolution 3D scene (Three.js) for the horse race. The WebGL canvas is rendered at a tiny
 * resolution and scaled up with nearest-neighbour filtering => chunky "pixelated 3D" look.
 *
 * World units ~ metres, x/z is the ground plane, y is up. The track is a "U" lying on its side opening
 * to the left: the top straight runs +x, the curve is on the right, the bottom straight runs -x.
 */
(function () {
  'use strict';
  var T = window.THREE;

  var LANES = 6, LW = 2.4, R_IN = 14, R_OUT = R_IN + LW * LANES, RMID = R_IN + LW * LANES / 2;
  var XL = 0, XR = 110, S = XR - XL, ARC = Math.PI * RMID, TOTAL = 2 * S + ARC;
  var RW = 320, RH = 180;      // render resolution
  var CAM_DIST = 42, CAM_H = 8, CAM_FOV = 21;

  // position/tangent/outward-normal at progress u on a ring of radius r (r = lane radius)
  function frameAt(u, r) {
    var d = u * TOTAL, th;
    if (d < S) return { x: XL + d, z: -r, tx: 1, tz: 0, nx: 0, nz: -1 };
    if (d < S + ARC) {
      th = (d - S) / RMID;
      return { x: XR + r * Math.sin(th), z: -r * Math.cos(th), tx: Math.cos(th), tz: Math.sin(th), nx: Math.sin(th), nz: -Math.cos(th) };
    }
    return { x: XR - (d - S - ARC), z: r, tx: -1, tz: 0, nx: 0, nz: 1 };
  }
  function laneR(lane) { return R_IN + LW * (lane + 0.5); }

  /* ---------- helpers ---------- */
  function canvasTex(w, h, draw, repeat) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new T.CanvasTexture(c);
    t.colorSpace = T.SRGBColorSpace; t.magFilter = T.NearestFilter; t.minFilter = T.NearestFilter; t.generateMipmaps = false;
    if (repeat) { t.wrapS = t.wrapT = T.RepeatWrapping; }
    return t;
  }
  function speckle(base, dark, light) {
    return function (g, w, h) {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      for (var i = 0; i < w * h * 0.12; i++) {
        g.fillStyle = Math.random() < 0.6 ? dark : light; g.fillRect((Math.random() * w) | 0, (Math.random() * h) | 0, 1, 1);
      }
    };
  }

  // flat strip along the track (horizontal) or a vertical wall, between radii/heights
  function ribbon(r0, r1, y0, y1, uA, uB, mat, uvScale) {
    var n = Math.max(2, Math.ceil((uB - uA) * TOTAL / 1.5)), pos = [], uv = [], idx = [];
    for (var i = 0; i <= n; i++) {
      var u = uA + (uB - uA) * i / n, a = frameAt(u, r0), b = frameAt(u, r1), d = u * TOTAL / (uvScale || 16);
      pos.push(a.x, y0, a.z, b.x, y1, b.z);
      uv.push(d, 0, d, Math.abs(r1 - r0 + y1 - y0) / (uvScale || 16));
      if (i < n) { var k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new T.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    return new T.Mesh(geo, mat);
  }

  /* ---------- horse model (blocky, outlined) ---------- */
  var PAL = {
    1: { coat: 0xffffff, shade: 0xc9ccd8, wrap: 0x1030e0, silk: 0xe01818, cap: 0xe01818, cloth: '#ffe010' },
    2: { coat: 0xff7ee6, shade: 0xc848b4, wrap: 0x2040e0, silk: 0x2040e0, cap: 0xffe83a, cloth: '#ffe010' },
    3: { coat: 0xff3a3a, shade: 0xb82020, wrap: 0xffffff, silk: 0x2f9bff, cap: 0xffffff, cloth: '#ffe010' },
    4: { coat: 0x3a68f0, shade: 0x1c3aa8, wrap: 0xffe83a, silk: 0xffe83a, cap: 0xe01818, cloth: '#ffe010' },
    5: { coat: 0xffe83a, shade: 0xc4aa14, wrap: 0xa444dc, silk: 0xa444dc, cap: 0xffffff, cloth: '#ffffff' },
    6: { coat: 0x30b070, shade: 0x187848, wrap: 0xff7eb6, silk: 0xff7eb6, cap: 0xffffff, cloth: '#ffe010' }
  };
  var edgeMat = new T.LineBasicMaterial({ color: 0x000000 });
  var boxGeoCache = {};
  function boxGeo(w, h, d) {
    var k = w + ',' + h + ',' + d;
    if (!boxGeoCache[k]) boxGeoCache[k] = { g: new T.BoxGeometry(w, h, d), e: new T.EdgesGeometry(new T.BoxGeometry(w, h, d)) };
    return boxGeoCache[k];
  }
  function lam(c) { return new T.MeshLambertMaterial({ color: c, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }); }
  function part(parent, w, h, d, mat, x, y, z, noEdge) {
    var bg = boxGeo(w, h, d), m = new T.Mesh(bg.g, mat);
    m.position.set(x || 0, y || 0, z || 0);
    if (!noEdge) m.add(new T.LineSegments(bg.e, edgeMat));
    parent.add(m); return m;
  }
  function pivot(parent, x, y, z, rz) {
    var g = new T.Group(); g.position.set(x, y, z); g.rotation.z = rz || 0; parent.add(g); return g;
  }
  function numberTex(no, bg) {
    return canvasTex(32, 32, function (g, w, h) {
      g.fillStyle = bg; g.fillRect(0, 0, w, h);
      g.fillStyle = '#000'; g.font = 'bold 26px "Courier New", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(no), w / 2, h / 2 + 2);
    });
  }

  function buildHorse(no) {
    var p = PAL[no], root = new T.Group(), h = new T.Group(); root.add(h);
    var coat = lam(p.coat), shade = lam(p.shade), wrap = lam(p.wrap), silk = lam(p.silk), cap = lam(p.cap);
    var skin = lam(0xf0b080), dark = lam(0x2a2a2a), white = lam(0xffffff), black = new T.MeshBasicMaterial({ color: 0 });
    var o = { root: root, body: h, legs: [], no: no };

    part(h, 2.4, 1.0, 0.9, coat, 0, 1.95, 0);
    part(h, 2.3, 0.14, 0.8, shade, 0, 1.45, 0, true);
    // legs: [x, z, phase offset, isBack]
    [[0.95, 0.3, 0, 0], [0.95, -0.3, 0.55, 0], [-0.95, 0.3, Math.PI, 1], [-0.95, -0.3, Math.PI + 0.55, 1]].forEach(function (L) {
      var m = L[2] === 0 || L[2] === Math.PI ? coat : shade;
      var hip = pivot(h, L[0], 1.5, L[1]);
      part(hip, 0.32, 0.75, 0.32, m, 0, -0.375, 0);
      var knee = pivot(hip, 0, -0.75, 0);
      part(knee, 0.26, 0.75, 0.26, m, 0, -0.375, 0);
      part(knee, 0.34, 0.38, 0.34, wrap, 0, -0.5, 0);
      part(knee, 0.36, 0.14, 0.36, dark, 0, -0.76, 0);
      o.legs.push({ hip: hip, knee: knee, off: L[2], back: L[3] });
    });
    // neck + head
    var neck = pivot(h, 1.1, 2.3, 0, -0.75);
    part(neck, 0.58, 1.25, 0.5, coat, 0, 0.55, 0);
    part(neck, 0.16, 1.15, 0.12, shade, -0.34, 0.55, 0);
    var head = pivot(neck, 0, 1.15, 0, 0.5);
    part(head, 1.0, 0.46, 0.42, coat, 0.4, 0, 0);
    part(head, 0.34, 0.4, 0.38, shade, 0.95, -0.04, 0);
    part(head, 0.12, 0.3, 0.1, coat, 0.0, 0.34, 0.15); part(head, 0.12, 0.3, 0.1, coat, 0.0, 0.34, -0.15);
    part(head, 0.1, 0.1, 0.46, wrap, 0.25, 0.02, 0, true);
    part(head, 0.14, 0.34, 0.44, wrap, 0.78, -0.02, 0, true);
    part(head, 0.1, 0.1, 0.1, black, 0.55, 0.1, 0.22, true); part(head, 0.1, 0.1, 0.1, black, 0.55, 0.1, -0.22, true);
    o.neck = neck; o.head = head;
    // tail
    var tail = pivot(h, -1.2, 2.35, 0, -0.8);
    part(tail, 0.24, 1.2, 0.34, coat, 0, -0.55, 0);
    part(tail, 0.2, 0.5, 0.3, shade, 0, -1.05, 0);
    o.tail = tail;
    // saddle cloth with number on both sides
    var nm = new T.MeshLambertMaterial({ map: numberTex(no, p.cloth) }), cm = lam(new T.Color(p.cloth).getHex());
    var cloth = new T.Mesh(new T.BoxGeometry(0.95, 0.9, 1.02), [cm, cm, cm, cm, nm, nm]);
    cloth.position.set(0.1, 1.98, 0); cloth.add(new T.LineSegments(new T.EdgesGeometry(cloth.geometry), edgeMat)); h.add(cloth);
    // jockey
    var j = pivot(h, -0.15, 2.45, 0);
    part(j, 0.95, 0.38, 0.8, white, 0, 0.22, 0);
    var torso = pivot(j, 0.05, 0.3, 0, -0.95);
    part(torso, 0.58, 0.9, 0.6, silk, 0, 0.45, 0);
    part(j, 0.36, 0.34, 0.36, skin, 0.95, 1.25, 0);
    part(j, 0.42, 0.24, 0.42, cap, 0.95, 1.5, 0); part(j, 0.26, 0.07, 0.34, cap, 1.2, 1.42, 0, true);
    [0.34, -0.34].forEach(function (z) {
      var arm = pivot(j, 0.55, 1.0, z, -0.85);
      part(arm, 0.2, 0.75, 0.2, silk, 0, -0.35, 0);
      part(j, 0.2, 0.5, 0.2, dark, 0.2, -0.28, z * 1.5);
    });
    return o;
  }

  /* ---------- scene ---------- */
  var sun, renderer, scene, camera, horses = {}, puffs = [], miniCtx, cam = { pos: new T.Vector3(), look: new T.Vector3(), ready: false };

  function buildWorld() {
    scene.background = new T.Color(0x78c8ff);
    scene.add(new T.AmbientLight(0xffffff, 2.3));
    sun = new T.DirectionalLight(0xffffff, 2.0); scene.add(sun, sun.target);

    // grass
    var gt = canvasTex(32, 32, speckle('#3dbb5f', '#34a653', '#4ccd6e'), true); gt.repeat.set(60, 60);
    var grass = new T.Mesh(new T.PlaneGeometry(900, 900), new T.MeshBasicMaterial({ map: gt }));
    grass.rotation.x = -Math.PI / 2; grass.position.set(XR / 2, -0.12, 0); scene.add(grass);

    // track
    var dt = canvasTex(32, 32, speckle('#b9925a', '#a47e49', '#c9a46c'), true);
    var dirt = new T.MeshBasicMaterial({ map: dt, side: T.DoubleSide });
    scene.add(ribbon(R_IN, R_OUT, 0.04, 0.04, -0.07, 1.07, dirt, 8));
    // rails
    var railMat = new T.MeshBasicMaterial({ color: 0xf4ead6, side: T.DoubleSide });
    [R_IN - 0.4, R_OUT + 0.4].forEach(function (r) {
      scene.add(ribbon(r, r, 0.85, 1.1, -0.07, 1.07, railMat));
      scene.add(ribbon(r, r, 0.35, 0.5, -0.07, 1.07, railMat));
    });
    var postGeo = new T.BoxGeometry(0.2, 1.15, 0.2), postN = Math.ceil(1.14 * TOTAL / 3) * 2;
    var posts = new T.InstancedMesh(postGeo, new T.MeshBasicMaterial({ color: 0xd9cdb4 }), postN), dm = new T.Object3D(), pi = 0;
    [R_IN - 0.4, R_OUT + 0.4].forEach(function (r) {
      for (var u = -0.07; u <= 1.07 && pi < postN; u += 3 / TOTAL) { var f = frameAt(u, r); dm.position.set(f.x, 0.57, f.z); dm.updateMatrix(); posts.setMatrixAt(pi++, dm.matrix); }
    });
    posts.count = pi; scene.add(posts);

    // hedges and flower beds outside the outer rail
    var bushBase = lam(0x1b7236), bushTop = lam(0x2ea44e), bloom = lam(0xf08a24);
    var beds = canvasTex(16, 8, function (g) {
      g.fillStyle = '#2a4a9a'; g.fillRect(0, 5, 16, 3);
      for (var i = 0; i < 16; i += 2) { g.fillStyle = i % 4 ? '#f0602a' : '#ffa23c'; g.fillRect(i, 0, 2, 6); }
    });
    var bedMat = new T.MeshLambertMaterial({ map: beds });
    var items = [], k = 0;
    for (var u2 = -0.06; u2 <= 1.06; u2 += 2.6 / TOTAL, k++) items.push({ u: u2, bush: k % 2 === 0 });
    var nb = items.filter(function (i) { return i.bush; }).length, nf = items.length - nb;
    var iBase = new T.InstancedMesh(new T.BoxGeometry(2.2, 1.3, 1.5), bushBase, nb);
    var iTop = new T.InstancedMesh(new T.BoxGeometry(1.8, 0.6, 1.2), bushTop, nb);
    var iBloom = new T.InstancedMesh(new T.BoxGeometry(0.4, 0.4, 0.4), bloom, nb * 2);
    var iBed = new T.InstancedMesh(new T.BoxGeometry(2.4, 0.9, 1.1), bedMat, nf);
    var a = 0, b = 0, c = 0;
    function put(mesh, i, f, y, ox, oz) {
      var yaw = -Math.atan2(f.tz, f.tx), bx = f.x + f.nx * 2.2, bz = f.z + f.nz * 2.2;
      dm.position.set(bx + ox * Math.cos(yaw) + oz * Math.sin(yaw), y, bz - ox * Math.sin(yaw) + oz * Math.cos(yaw));
      dm.rotation.set(0, yaw, 0); dm.updateMatrix(); mesh.setMatrixAt(i, dm.matrix);
    }
    items.forEach(function (it) {
      var f = frameAt(it.u, R_OUT);
      if (it.bush) { put(iBase, a, f, 0.65, 0, 0); put(iTop, a, f, 1.5, 0, 0); put(iBloom, c++, f, 1.2, 0.5, 0.7); put(iBloom, c++, f, 1.0, -0.5, -0.7); a++; }
      else put(iBed, b++, f, 0.45, 0, 0);
    });
    [iBase, iTop, iBloom, iBed].forEach(function (m) { scene.add(m); });

    // starting gate (top straight, left) and finish line (bottom straight, left)
    var gateMat = new T.MeshBasicMaterial({ color: 0x9a9aa8 });
    for (var l = 0; l <= LANES; l++) {
      var gz = -(R_IN + l * LW);
      [0.95, 1.9].forEach(function (gy) { var div = new T.Mesh(new T.BoxGeometry(5.4, 0.1, 0.1), gateMat); div.position.set(XL - 2.0, gy, gz); scene.add(div); });
    }
    for (var l2 = 0; l2 <= LANES; l2++) {
      var bp = new T.Mesh(new T.BoxGeometry(0.2, 2.2, 0.2), gateMat); bp.position.set(XL - 4.6, 1.2, -(R_IN + l2 * LW)); scene.add(bp);
    }

    var chk = canvasTex(2, 12, function (g) { for (var y = 0; y < 12; y++) for (var x = 0; x < 2; x++) { g.fillStyle = (x + y) % 2 ? '#000' : '#fff'; g.fillRect(x, y, 1, 1); } });
    var fl = new T.Mesh(new T.PlaneGeometry(1.2, R_OUT - R_IN), new T.MeshBasicMaterial({ map: chk }));
    fl.rotation.x = -Math.PI / 2; fl.rotation.z = 0; fl.position.set(XL, 0.08, (R_IN + R_OUT) / 2); scene.add(fl);
    var poleMat = new T.MeshBasicMaterial({ color: 0xe03030 });
    [R_IN - 0.9, R_OUT + 0.9].forEach(function (z) { var pl = new T.Mesh(new T.BoxGeometry(0.4, 5, 0.4), poleMat); pl.position.set(XL, 2.5, z); scene.add(pl); });

    // trees + clouds on the horizon
    var trunk = new T.MeshBasicMaterial({ color: 0x6b4a2a }), leaf = new T.MeshBasicMaterial({ color: 0x1f8f45 }), leaf2 = new T.MeshBasicMaterial({ color: 0x2fb35a });
    for (var i = 0; i < 90; i++) {
      var ang = Math.random() * Math.PI * 2, rad = 85 + Math.random() * 70, tx = XR / 2 + Math.cos(ang) * rad * 1.5, tz = Math.sin(ang) * rad, hh = 4 + Math.random() * 4;
      var t1 = new T.Mesh(new T.BoxGeometry(0.9, hh, 0.9), trunk); t1.position.set(tx, hh / 2, tz); scene.add(t1);
      var t2 = new T.Mesh(new T.BoxGeometry(4.5, 3.5, 4.5), i % 2 ? leaf : leaf2); t2.position.set(tx, hh + 1.2, tz); scene.add(t2);
    }
    var cloudMat = new T.MeshBasicMaterial({ color: 0xffffff });
    for (var q = 0; q < 14; q++) {
      var cl = new T.Mesh(new T.BoxGeometry(14 + Math.random() * 12, 3, 5), cloudMat);
      cl.position.set(-120 + Math.random() * 380, 38 + Math.random() * 14, -150 + Math.random() * 300); scene.add(cl);
    }
  }

  function init(canvas, mini) {
    renderer = new T.WebGLRenderer({ canvas: canvas, antialias: false, powerPreference: 'low-power' });
    renderer.setPixelRatio(1); renderer.setSize(RW, RH, false);
    scene = new T.Scene();
    camera = new T.PerspectiveCamera(CAM_FOV, RW / RH, 6, 600);
    buildWorld();
    for (var no = 1; no <= 6; no++) { horses[no] = buildHorse(no); scene.add(horses[no].root); }
    var pm = new T.MeshBasicMaterial({ color: 0xd9b886 }), pg = new T.BoxGeometry(0.4, 0.4, 0.4);
    for (var i = 0; i < 80; i++) { var m = new T.Mesh(pg, pm); m.visible = false; scene.add(m); puffs.push({ mesh: m, life: 0 }); }
    if (mini) miniCtx = mini.getContext('2d');
  }

  var puffIdx = 0;
  function spawnPuff(x, z, tx, tz) {
    var p = puffs[puffIdx++ % puffs.length];
    p.life = 0.55; p.mesh.visible = true;
    p.mesh.position.set(x - tx * 2.3 + (Math.random() - 0.5) * 0.8, 0.25, z - tz * 2.3 + (Math.random() - 0.5) * 0.8);
  }

  // items: [{no, u, standing, last}]  uc: camera progress  snap: jump camera  dt: seconds
  function frame(items, uc, dt, snap) {
    items.forEach(function (it) {
      var o = horses[it.no], f = frameAt(it.u, laneR(it.no - 1));
      o.root.position.set(f.x, 0, f.z);
      o.root.rotation.y = -Math.atan2(f.tz, f.tx);
      var ph = it.u * TOTAL / 6.2 * Math.PI * 2, run = it.standing ? 0 : 1;
      o.legs.forEach(function (L) {
        var s = Math.sin(ph + L.off);
        L.hip.rotation.z = run * s * 0.8;
        L.knee.rotation.z = run * -(0.55 + 0.55 * Math.sin(ph + L.off + 1.7)) * (L.back ? 0.9 : 1);
      });
      o.body.position.y = run * 0.14 * Math.abs(Math.sin(ph));
      o.body.rotation.z = run * 0.05 * Math.sin(ph);
      o.neck.rotation.z = -0.75 + run * 0.08 * Math.sin(ph + 1);
      o.tail.rotation.z = -0.8 - run * 0.18 * Math.sin(ph * 0.5 + 0.7);
      if (run) {
        var step = Math.floor(it.u * TOTAL / 2.2);
        if (o.lastStep != null && step !== o.lastStep && Math.random() < 0.8) spawnPuff(f.x, f.z, f.tx, f.tz);
        o.lastStep = step;
      }
    });
    puffs.forEach(function (p) {
      if (p.life <= 0) return;
      p.life -= dt; var k = Math.max(0, p.life / 0.55);
      p.mesh.scale.setScalar(0.25 + 0.6 * k); p.mesh.position.y += dt * 1.2;
      if (p.life <= 0) p.mesh.visible = false;
    });

    // camera: on the infield side of the pack, looking across the track at it
    var P = frameAt(uc, RMID);
    var tp = new T.Vector3(P.x - P.nx * CAM_DIST, CAM_H, P.z - P.nz * CAM_DIST);
    var tl = new T.Vector3(P.x + P.tx * 2.5, 2.0, P.z + P.tz * 2.5);
    if (snap || !cam.ready) { cam.pos.copy(tp); cam.look.copy(tl); cam.ready = true; }
    else { var k = 1 - Math.exp(-dt * 3.5); cam.pos.lerp(tp, k); cam.look.lerp(tl, k); }
    camera.position.copy(cam.pos); camera.lookAt(cam.look);
    sun.position.set(cam.pos.x - 10, cam.pos.y + 22, cam.pos.z + 4); sun.target.position.copy(cam.look);
    renderer.render(scene, camera);
    drawMini(items);
  }

  function drawMini(items) {
    if (!miniCtx) return;
    var g = miniCtx, w = g.canvas.width, h = g.canvas.height, sc = (w - 8) / (XR + R_OUT + 4), ox = 4 + 10 * sc, oy = h / 2;
    g.clearRect(0, 0, w, h);
    g.fillStyle = 'rgba(8,20,40,.72)'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#8a7048';
    for (var u = -0.04; u <= 1.04; u += 0.005) { var f = frameAt(u, RMID); g.fillRect(Math.round(ox + f.x * sc) - 1, Math.round(oy + f.z * sc) - 1, 3, 3); }
    var fin = frameAt(1, RMID); g.fillStyle = '#fff'; g.fillRect(Math.round(ox + fin.x * sc), Math.round(oy + fin.z * sc) - 3, 1, 7);
    items.forEach(function (it) {
      var f = frameAt(it.u, RMID); g.fillStyle = '#' + ('000000' + PAL[it.no].coat.toString(16)).slice(-6);
      g.fillRect(Math.round(ox + f.x * sc) - 1, Math.round(oy + f.z * sc) - 1, 3, 3);
    });
  }

  window.Scene3D = { init: init, frame: frame, TOTAL: TOTAL, frameAt: frameAt };
})();
