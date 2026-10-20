#!/usr/bin/env node
/*
 * Zero-dependency server: serves /public and exposes the race API.
 *   GET  /api/public   -> public race state (no secrets, safe for every viewer)
 *   GET  /api/admin    -> full state incl. plan            (x-controller-key)
 *   POST /api/command  -> {cmd:'start'|'setPlan'|...}      (x-controller-key)
 *
 *   PORT=8080 CONTROLLER_KEY=secret node server.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Director, execCommand } = require('./public/js/core.js');

const PORT = process.env.PORT || 8080;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data', 'state.json');
const generatedKey = !process.env.CONTROLLER_KEY;
const KEY = process.env.CONTROLLER_KEY || crypto.randomBytes(5).toString('hex');

let director;
try { director = new Director(JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))); }
catch (e) { director = new Director(); }

let lastSaved = '';
function save() {
  const json = JSON.stringify(director.serialize());
  if (json === lastSaved) return;
  lastSaved = json;
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, json);
  } catch (e) { console.error('could not save state:', e.message); }
}

setInterval(() => { director.tick(Date.now()); save(); }, 250);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, x-controller-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function authorized(req) {
  const given = Buffer.from(String(req.headers['x-controller-key'] || ''));
  const want = Buffer.from(KEY);
  return given.length === want.length && crypto.timingSafeEqual(given, want);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 100000) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  if (pathname === '/controller') pathname = '/controller.html';
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const now = Date.now();
    if (url.pathname === '/api/public' && req.method === 'GET') {
      return json(res, 200, director.publicState(now));
    }
    if (!authorized(req)) return json(res, 401, { ok: false, error: 'bad controller key' });
    if (url.pathname === '/api/admin' && req.method === 'GET') {
      return json(res, 200, director.adminState(now));
    }
    if (url.pathname === '/api/command' && req.method === 'POST') {
      try {
        const result = execCommand(director, JSON.parse(await readBody(req) || '{}'), now);
        save();
        return json(res, result.ok ? 200 : 400, result);
      } catch (e) { return json(res, 400, { ok: false, error: 'bad request' }); }
    }
    return json(res, 404, { ok: false, error: 'not found' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  serveStatic(req, res, decodeURIComponent(url.pathname));
}).listen(PORT, () => {
  console.log('Horse Race running on http://localhost:' + PORT);
  console.log('  game       http://localhost:' + PORT + '/');
  console.log('  controller http://localhost:' + PORT + '/controller');
  console.log('  controller key: ' + KEY + (generatedKey ? '  (random - set CONTROLLER_KEY to keep it fixed)' : ''));
});
