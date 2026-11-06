/* Bingo Pinball: the client of the server's API (/api/games/bingo-pinball, see docs/bingo/API.md). Every call answers with the data or throws {status, error} (a refusal
   of the server) or {network: true} (no answer in time). The session id is kept for the tab only. */
(function () {
  'use strict';
  var BASE = '/api/games/bingo-pinball', KEY = 'bp.session', session = null;
  try { session = sessionStorage.getItem(KEY); } catch (e) { /* no storage: the session lives for this page only */ }

  function request(method, path, body, timeout) {
    return new Promise(function (resolve, reject) {
      var finished = false, ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { if (finished) return; finished = true; if (ctl) ctl.abort(); reject({ network: true, timeout: true }); }, timeout || 12000);
      var opts = { method: method, cache: 'no-store', headers: {} };
      if (session) opts.headers.Authorization = 'Bearer ' + session;
      if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
      if (ctl) opts.signal = ctl.signal;
      fetch(BASE + path, opts).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) {
          if (finished) return; finished = true; clearTimeout(timer);
          if (d && d.ok) resolve(d); else reject({ status: r.status, error: (d && d.error) || 'ERROR' });
        });
      }).catch(function () { if (finished) return; finished = true; clearTimeout(timer); reject({ network: true }); });
    });
  }

  /* A player who is signed in to the operator's own site (the cookie of /account) needs no launch token typed or passed: the page asks the account for a one-time token itself.
     Rejects {noAccount: true} when there is no signed-in account here (then the game is only reachable through a platform's launch link). */
  function accountLaunch() {
    var opts = { credentials: 'same-origin', cache: 'no-store' };
    return fetch('/player/api/me', opts).then(function (r) {
      if (r.status !== 200) throw { noAccount: true };
      return r.json();
    }).then(function (me) {
      return fetch('/player/api/launch', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'X-CSRF-Token': me.csrf, 'Content-Type': 'application/json' }, body: '{}' });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (r.status === 200 && d.token) return { token: d.token, client: d.client }; throw { noAccount: true }; });
    }, function (e) { throw e && e.noAccount ? e : { network: true }; });
  }

  window.BingoApi = {
    accountLaunch: accountLaunch,
    hasSession: function () { return !!session; },
    setSession: function (s) { session = s; try { sessionStorage.setItem(KEY, s); } catch (e) { /* ignore */ } },
    clearSession: function () { session = null; try { sessionStorage.removeItem(KEY); } catch (e) { /* ignore */ } },
    auth: function (token, client) { return request('POST', '/auth', { token: token, client: client || undefined }); },
    state: function () { return request('GET', '/state'); },
    play: function (stake, requestId) { return request('POST', '/play', { stake: stake, requestId: requestId }, 15000); },
    round: function (id) { return request('GET', '/round/' + id); },
    history: function (limit) { return request('GET', '/history?limit=' + (limit || 30)); },
    seen: function (id) { return request('POST', '/round/' + id + '/seen', {}); },
    rotate: function (clientSeed) { return request('POST', '/seed/rotate', clientSeed ? { clientSeed: clientSeed } : {}); },
    proof: function (id) { return request('GET', '/proof/' + id); }
  };
})();
