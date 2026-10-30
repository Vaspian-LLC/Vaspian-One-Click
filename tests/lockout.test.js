// Lockout-safety tests for lib/vaspian-api.js: count how many times the
// client sends a REJECTED credential before it stops. The platform locks an
// extension after 3 failed logins in 30 min, so every scenario must stay at 1.
//
// Plain node, no network: fetch and WebSocket are fakes driven by a fake
// server PIN. Mock PINs only ("good" / "changed").
// Ported from the code-security review harness (fleet/rig/runner).
// Run: node tests/lockout.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaspian-api.js'), 'utf8');

function makeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null) return { ...data };
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Boot a fresh client against a fake server. opts.wsRefuses: REST fine, WS always refused. */
function boot(opts = {}) {
  const server = { pin: 'good', badRest: 0, badWs: 0, goodRest: 0, ws: 0, sockets: [], maxConcurrent: 0, live: 0 };
  const sync = makeStorage();
  const local = makeStorage();
  sync.data.tenant = 'vaspian';
  sync.data.extension = '196';
  local.data.password = 'good';
  const credOk = (user, pass) => user === '196@vaspian.URI' && pass === server.pin;

  async function fetch(url, o) {
    server.live++;
    server.maxConcurrent = Math.max(server.maxConcurrent, server.live);
    await sleep(5);
    server.live--;
    const auth = (o.headers && o.headers.Authorization) || '';
    const [user, pass] = Buffer.from(auth.replace(/^Basic /, ''), 'base64').toString().split(':');
    const res = (status, body) => ({ ok: status < 300, status, headers: { get: () => (status === 401 ? 'Basic realm="x"' : '') }, text: async () => JSON.stringify(body) });
    if (!credOk(user, pass)) { server.badRest++; return res(401, { errorCode: 'BadAuthenticationHeader' }); }
    server.goodRest++;
    const u = new URL(url);
    if (u.pathname === '/api/v1/') return res(200, { _links: { 'v1:extensions': { href: 'https://x/api/v1/tenants/4/extensions' } } });
    if (/subscriptionsets$/.test(u.pathname)) return res(200, { subscriptionSetId: 'set1' });
    if (/myphones/.test(u.pathname)) return res(200, { _links: { self: {} } });
    return res(200, {});
  }

  class FakeWS {
    constructor(url) {
      const u = new URL(url);
      this.readyState = 0;
      server.ws++;
      const ok = !opts.wsRefuses && credOk(decodeURIComponent(u.username), decodeURIComponent(u.password));
      server.sockets.push(this);
      setTimeout(() => {
        if (ok) { this.readyState = 1; if (this.onmessage) this.onmessage({ data: JSON.stringify({ webSocketId: 'ws1' }) }); }
        else { if (!opts.wsRefuses) server.badWs++; this.readyState = 3; if (this.onclose) this.onclose({ code: 1006 }); }
      }, 5);
    }
    send() {}
    close() { this.readyState = 3; }
  }
  FakeWS.OPEN = 1;

  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URL, AbortController,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent,
    crypto: require('crypto').webcrypto,
    fetch, WebSocket: FakeWS,
    chrome: {
      storage: { sync, local, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} }
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  const api = sandbox.OneClick.api;
  api.CONFIG.backoffMs = [30, 30, 30, 30, 30];
  api.CONFIG.keepaliveMs = 1e9;
  return { api, server, local };
}

async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(5); }
  return true;
}
const bad = (s) => s.badRest + s.badWs;
function dropSocket(server) {
  const ws = server.sockets[server.sockets.length - 1];
  ws.readyState = 3;
  ws.onclose({ code: 1006 });
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

(async () => {
  {
    // The 1-minute presence poll pair right after a server-side PIN change.
    const { api, server } = boot();
    await until(() => api.getStatus().state === 'connected');
    server.pin = 'changed';
    await Promise.all([api.getPresence(), api.getMyPhones({ force: true })]);
    check('two parallel GETs after a server-side PIN change send the bad PIN once', bad(server) === 1, server);
  }
  {
    // Any burst: queued requests must not go out after the 401.
    const { api, server } = boot();
    await until(() => api.getStatus().state === 'connected');
    server.pin = 'changed';
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => api.request('GET', `x/${i}`)));
    check('a burst of 5 after a PIN change sends the bad PIN once; the rest are refused locally',
      bad(server) === 1 && rs.filter((r) => r.errorClass === 'stopped').length === 4, { bad: bad(server), classes: rs.map((r) => r.errorClass) });
  }
  {
    // With a good PIN a burst still runs concurrently (max 3) after one probe.
    const { api, server } = boot();
    await until(() => api.getStatus().state === 'connected');
    server.maxConcurrent = 0;
    await sleep(20);
    const rs = await Promise.all([1, 2, 3, 4, 5, 6].map((i) => api.request('GET', `y/${i}`)));
    check('good PIN: burst succeeds, concurrency 3 kept after the probe', rs.every((r) => r.ok) && server.maxConcurrent === 3, { max: server.maxConcurrent });
  }
  {
    // Socket drop after a server-side PIN change, then any REST call (no Reconnect).
    const { api, server } = boot();
    await until(() => api.getStatus().state === 'connected');
    server.pin = 'changed';
    dropSocket(server);
    await until(() => api.getStatus().state === 'error');
    await api.getMyPhones({ force: true });
    const st = api.getStatus();
    check('socket drop after a PIN change: REST re-check stops on the first 401, WS never retried with it',
      bad(server) === 1 && server.badWs === 0 && st.reason === 'auth', { bad: bad(server), ws: server.badWs, reason: st.reason });
    // ...then the user presses Reconnect: refused, nothing sent.
    const r = await api.reconnect();
    await sleep(100);
    check('Reconnect after the auth stop is refused and sends nothing', r.refused === 'auth' && bad(server) === 1, { r, bad: bad(server) });
  }
  {
    // Status keeps the identity while retrying after a normal drop.
    const { api, server } = boot();
    await until(() => api.getStatus().state === 'connected');
    let sessions = 0;
    api.on('session', () => sessions++);
    dropSocket(server);
    await until(() => api.getStatus().state === 'retrying');
    const st = api.getStatus();
    check('retrying status keeps account and extension', st.extension === '196' && st.account === '196@4', st);
    await until(() => api.getStatus().state === 'connected');
    check('reconnect re-checks REST but emits no new session for the same identity', sessions === 0, { sessions });
  }
  {
    // WS refused while REST accepts the PIN: stop after 2, Reconnect = exactly one more handshake.
    const { api, server } = boot({ wsRefuses: true });
    await until(() => api.getStatus().reason === 'ws_rejected');
    const before = server.ws;
    await api.reconnect();
    await until(() => api.getStatus().reason === 'ws_rejected');
    await sleep(100);
    check('ws_rejected: 2 handshakes, then one per Reconnect press', before === 2 && server.ws === 3 && server.badRest === 0, { before, after: server.ws });
  }
  {
    // X-Tone fallback rejected the PIN: same stop as a REST 401.
    const { api, server } = boot();
    await until(() => api.getStatus().state === 'connected');
    await api.markAuthRejected('X-Tone login rejected');
    const r = await api.request('GET', 'z');
    check('markAuthRejected stops REST locally and reports auth', r.errorClass === 'stopped' && (await api.isAuthStopped()) && api.getStatus().reason === 'auth' && server.badRest === 0, r);
    await api.credentialsSaved();
    await until(() => api.getStatus().state === 'connected');
    check('saving credentials again clears the stop', !(await api.isAuthStopped()) && api.getStatus().state === 'connected', api.getStatus());
  }
  {
    // dialPrefix: '' is a valid value, missing defaults to 8.
    const b = boot();
    check('dialPrefix defaults to 8', (await b.api.dialPrefix()) === '8');
  }

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})();
