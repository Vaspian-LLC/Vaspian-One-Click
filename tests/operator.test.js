// Unit tests for the team view (operator panel):
//   1. lib/vaspian-api.js routes coworker frames to the 'team' bus event only
//      (never 'raw' / 'call' / 'presence', never logged) and drops repeated frames.
//   2. operator.js: capability detection, snapshot + event reduction,
//      coalesced publishing, sign-out clears, no logging of operator data.
// Plain node, no network: fakes only, mock PINs only.
// Run: node tests/operator.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const API_SRC = fs.readFileSync(path.join(ROOT, 'lib', 'vaspian-api.js'), 'utf8');
const OP_SRC = fs.readFileSync(path.join(ROOT, 'operator.js'), 'utf8');
const FIXTURE = (() => {
  // Anonymized live admin capture (fleet/fixture-admin-presence.json) when this repo sits in the fleet tree; else a tiny inline sample.
  const p = path.join(ROOT, '..', '..', 'fixture-admin-presence.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')).presenceStatus; } catch (e) { return null; }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

function makeStorage(name, writes) {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { if (writes) writes.push({ area: name, keys: Object.keys(obj), at: Date.now() }); Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { if (writes) writes.push({ area: name, removed: [].concat(keys) }); for (const k of [].concat(keys)) delete data[k]; }
  };
}

// ------------------------------------------------------ 1. client routing ---
function bootClient() {
  const sync = makeStorage('sync');
  const local = makeStorage('local');
  sync.data.tenant = 'vaspian';
  sync.data.extension = '196';
  local.data.password = 'mockpin-196';
  const logs = [];
  const sockets = [];
  const posts = [];
  async function fetch(url, init = {}) {
    const u = new URL(url);
    if ((init.method || 'GET') === 'POST') posts.push(u.pathname);
    const res = (status, body) => ({ ok: status < 300, status, headers: { get: () => '' }, text: async () => JSON.stringify(body) });
    if (u.pathname === '/api/v1/') return res(200, { _links: { 'v1:extensions': { href: 'https://x/api/v1/tenants/4/extensions' }, 'v1:presenceStatusTenantAccounts': { href: 'https://x/api/v1/presencestatus/tenants/4/extensions' } } });
    if (/subscriptionsets$/.test(u.pathname)) return res(200, { subscriptionSetId: 'set1' });
    return res(200, {});
  }
  class FakeWS {
    constructor() { this.readyState = 0; sockets.push(this); setTimeout(() => { this.readyState = 1; this.onmessage({ data: JSON.stringify({ webSocketId: 'ws1' }) }); }, 5); }
    send() {}
    close() { this.readyState = 3; }
  }
  FakeWS.OPEN = 1;
  const sandbox = {
    console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URL, AbortController,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent,
    crypto: require('crypto').webcrypto, fetch, WebSocket: FakeWS,
    addLog: (level, message, details) => logs.push(JSON.stringify({ level, message, details })),
    chrome: {
      storage: { sync, local, onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} }
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(API_SRC, sandbox);
  const api = sandbox.OneClick.api;
  api.CONFIG.keepaliveMs = 1e9;
  const frame = (obj) => sockets[sockets.length - 1].onmessage({ data: JSON.stringify(obj) });
  return { api, logs, frame, posts };
}

async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) { if (Date.now() - t0 > ms) return false; await sleep(5); }
  return true;
}

async function clientTests() {
  const { api, logs, frame, posts } = bootClient();
  await until(() => api.getStatus().state === 'connected');
  check('client: admin session detected from the root link', api.getSession().isAdmin === true, api.getSession());
  const seen = { team: [], raw: 0, call: 0, presence: 0 };
  api.on('team', (f) => seen.team.push(f));
  api.on('raw', () => seen.raw++);
  api.on('call', () => seen.call++);
  api.on('presence', () => seen.presence++);
  logs.length = 0;
  const coworker = { callId: '1007-0-1-2:203@4', observedParty: '203@4', event: 'offer', from: '3155550199', callingName: 'SECRET CALLER', to: '203@4', timestamp: '2026-10-30T10:00:00.000-04:00', subscriptionSetId: 'set1' };
  frame(coworker);
  frame({ observedParty: '205@4', event: 'dndOn', version: 'v1', timestamp: '2026-10-30T10:00:01.000-04:00', subscriptionSetId: 'set1' });
  check('client: coworker frames go to "team" only', seen.team.length === 2 && seen.raw === 0 && seen.call === 0 && seen.presence === 0, seen);
  check('client: coworker frames are never logged', !logs.some((l) => /3155550199|SECRET|203@4|205@4/.test(l)), logs);
  // Without a wildcard subscription nothing is dropped (regular users unchanged).
  const plain = { callId: '1007-0-8-8:196@4', observedParty: '196@4', event: 'offer', from: '3155694033', to: '196@4', timestamp: '2026-10-30T09:00:00.000-04:00', subscriptionSetId: 'set1' };
  frame(plain); frame(plain);
  check('client: without a wildcard subscription identical frames are all delivered', seen.call === 2, seen);
  seen.call = 0; seen.raw = 0;
  await api.subscribe('call', 'ALL_USERS');
  // Own frame, delivered twice (self + wildcard subscription), then a ring group's second offer (1 ms later).
  const own = { callId: '1007-0-9-9:196@4', observedParty: '196@4', event: 'offer', from: '3155694033', to: '196@4', callingName: 'CHRIS A', timestamp: '2026-10-30T10:00:02.000-04:00', subscriptionSetId: 'set1' };
  frame(own);
  frame({ ...own, subscriptionSetId: 'set2' });
  check('client: an identical own frame within the window is delivered once', seen.call === 1 && seen.raw === 1, seen);
  frame({ ...own, timestamp: '2026-10-30T10:00:02.001-04:00' });
  check('client: a ring group second offer (different timestamp) still passes', seen.call === 2, seen);
  check('client: own frames are not sent to "team"', seen.team.length === 2, seen.team.length);
  frame({ observedParty: 'PL3@4', event: 'busy', parkLocationNumber: '3', timestamp: 't' });
  check('client: park slot frames keep their normal path', seen.team.length === 2 && seen.raw === 3, seen);
  // Fail closed while a wildcard is on: no observedParty -> callId suffix, and no observer at all -> team.
  logs.length = 0;
  frame({ callId: '1007-0-5-5:203@4', event: 'offer', from: '3155550100', callingName: 'SECRETNAME', to: '203@4', timestamp: 't5' });
  frame({ event: 'dndOn', timestamp: 't6' });
  check('client: with a wildcard on, a frame without observedParty about a coworker (or nobody) goes to "team" only',
    seen.team.length === 4 && seen.raw === 3 && seen.call === 2 && !logs.some((l) => /SECRETNAME|3155550100/.test(l)), { team: seen.team.length, raw: seen.raw, call: seen.call, logs });
  frame({ callId: '1007-0-6-6:196@4', event: 'offer', from: '3155694033', to: '196@4', timestamp: 't7' });
  check('client: with a wildcard on, an own frame without observedParty (callId suffix is me) keeps the normal path', seen.call === 3 && seen.team.length === 4, seen);
  await api.unsubscribe('call', 'ALL_USERS');
  // Call control is refused for a call observed by someone else (admins can see coworkers' callIds).
  const p0 = posts.length;
  const refused = await api.callControl('1007-0-1-78:205@4', 'hangupCall');
  const refused2 = await api.callControl('1007-0-1-79:196@4', 'transfer', { otherCallId: '1007-0-1-80:205@4' });
  const refused3 = await api.callControl('1007-0-1-81:196@5', 'hangupCall');
  check('client: callControl refuses a coworker\'s callId (also as otherCallId, and another tenant) and sends nothing',
    !refused.ok && refused.errorClass === 'invalid' && !refused2.ok && !refused3.ok && posts.length === p0, { refused, posts: posts.slice(p0) });
  const own1 = await api.callControl('1007-0-1-82:196@4', 'hangupCall');
  const own2 = await api.callControl('consult-1234', 'transfer', { otherCallId: '1007-0-1-82:196@4' });
  check('client: callControl still sends for my own callId and for a callId without an observer (makeCall consult)', own1.ok && own2.ok && posts.length === p0 + 2, posts.slice(p0));
}

// ------------------------------------------------------------ 2. engine ---
function fakeApi({ isAdmin = true, connected = true, ext = '196' } = {}) {
  const handlers = {};
  const requests = [];
  const subs = [];
  const unsubs = [];
  const api = {
    requests, subs, unsubs,
    session: { account: `${ext}@4`, tenantId: '4', extension: ext, isAdmin, links: {} },
    status: { state: connected ? 'connected' : 'retrying', reason: null },
    connected,
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => {}; },
    emit(name, payload) { for (const fn of handlers[name] || []) fn(payload); },
    getStatus: () => api.status,
    getSession: () => api.session,
    isConnected: () => api.connected,
    snapshot: [],
    snapshotStatus: 200,
    async request(method, p) {
      requests.push({ method, path: p });
      await sleep(2);
      if (p.startsWith('presencestatus/tenants/4/extensions')) {
        if (api.snapshotStatus !== 200) return { ok: false, status: api.snapshotStatus, errorClass: 'forbidden' };
        return { ok: true, status: 200, body: { _embedded: { presenceStatus: api.snapshot } } };
      }
      if (p.startsWith('tenants/4/extensions?extensionType=groupExt')) {
        return { ok: true, status: 200, body: { _embedded: { extension: [{ extension: '626', name: 'Front Desk', extensionType: 'groupExt' }, { extension: '690', name: 'Support Line', extensionType: 'groupExt' }] } } };
      }
      if (p.startsWith('tenants/4/extensions?extensionType=acdExt')) {
        return { ok: true, status: 200, body: { _embedded: { extension: [{ extension: '700', name: 'Customer Care', extensionType: 'acdExt' }] } } };
      }
      return { ok: false, status: 404, errorClass: 'notFound' };
    },
    async subscribe(kind, acct) { subs.push(`${kind}|${acct}`); return api.subResult || { ok: true, status: 200 }; },
    async unsubscribe(kind, acct) { unsubs.push(`${kind}|${acct}`); return { ok: true }; }
  };
  return api;
}

function bootEngine(apiOpts = {}, { enabled } = {}) {
  const writes = [];
  const local = makeStorage('local', writes);
  const session = makeStorage('session', writes);
  const sync = makeStorage('sync', writes);
  if (enabled === false) local.data.operatorEnabled = false;
  local.data.statusDirectory = {
    at: Date.now(), tenantId: '4',
    users: [
      { ext: '197', name: 'OneClick TestB' }, { ext: '201', name: 'Avery Adams' }, { ext: '202', name: 'Blake Brooks' },
      { ext: '203', name: 'Carmen Castillo' }, { ext: '204', name: 'Dana Dawson' }, { ext: '205', name: 'Elena Evans' }
    ]
  };
  const logs = [];
  const listeners = { changed: [], alarm: [], connect: [], message: [] };
  const api = fakeApi(apiOpts);
  const sandbox = {
    console, setTimeout, clearTimeout, Date, Promise, Map, Set, JSON, Object, Array, String, Math,
    addLog: (level, message, details) => logs.push(JSON.stringify({ level, message, details })),
    chrome: {
      storage: { local, session, sync, onChanged: { addListener: (fn) => listeners.changed.push(fn) } },
      alarms: { create() {}, clear: async () => true, onAlarm: { addListener: (fn) => listeners.alarm.push(fn) } },
      runtime: {
        id: 'ext', getURL: (p) => `chrome-extension://ext/${p}`,
        onConnect: { addListener: (fn) => listeners.connect.push(fn) },
        onMessage: { addListener: (fn) => listeners.message.push(fn) }
      },
      tabs: { create: async () => ({}) }
    }
  };
  sandbox.self = sandbox;
  sandbox.OneClick = { api };
  vm.createContext(sandbox);
  vm.runInContext(OP_SRC, sandbox);
  const op = sandbox.OneClick.operator;
  const setLocal = async (obj) => {
    const changes = {};
    for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: local.data[k], newValue: v }; local.data[k] = v; }
    for (const fn of listeners.changed) fn(changes, 'local');
  };
  const send = (action, extra = {}, sender = { id: 'ext', url: 'chrome-extension://ext/operator.html' }) => new Promise((resolve) => {
    for (const fn of listeners.message) { const r = fn({ action, ...extra }, sender, resolve); if (r === true || r === false) return; }
    resolve(undefined);
  });
  return { api, op, local, session, sync, writes, logs, listeners, setLocal, send };
}

const ts = () => new Date().toISOString();
const pres = (ext, event, extra = {}) => ({ observedParty: `${ext}@4`, event, version: 'v1', timestamp: ts(), ...extra });
const callEv = (ext, event, callId, extra = {}) => ({ callId: `${callId}:${ext}@4`, observedParty: `${ext}@4`, event, version: 'v1', timestamp: ts(), ...extra });

async function engineTests() {
  // Capability detection: a regular user makes no requests and subscribes nothing.
  {
    const e = bootEngine({ isAdmin: false });
    await sleep(30);
    e.api.emit('session', e.api.session);
    e.api.emit('connected', {});
    await sleep(30);
    check('engine: regular user makes no team requests and no subscriptions', e.api.requests.length === 0 && e.api.subs.length === 0, { req: e.api.requests, subs: e.api.subs });
    const r = await e.send('operator:get');
    check('engine: regular user sees phase not_admin and no data', r.state.phase === 'not_admin' && r.state.people.length === 0, r.state);
    check('engine: nothing written to session storage for a regular user', !('operatorState' in e.session.data), Object.keys(e.session.data));
  }

  // Admin: wildcard subscriptions, one tenant GET, names from the directory.
  const e = bootEngine({ isAdmin: true });
  e.api.snapshot = [
    { accountId: '196@4', availability: 'available', callStatus: 'idle', dndStatus: 'dndOff', acdAvailability: 'signedOutAcd', groupStatus: {} },
    { accountId: '201@4', availability: 'available', callStatus: 'idle', dndStatus: 'dndOff', acdAvailability: 'signedInAcd', groupStatus: { 626: 'groupJoined', 9999: 'groupLeft' } },
    { accountId: '202@4', availability: 'unavailable', callStatus: 'idle', dndStatus: 'dndOff', acdAvailability: 'signedOutAcd', groupStatus: { 626: 'groupLeft' } },
    { accountId: '203@4', availability: 'available', callStatus: 'busy', dndStatus: 'dndOff', acdAvailability: 'signedOutAcd', groupStatus: {} },
    { accountId: '204@4', availability: 'available', callStatus: 'idle', dndStatus: 'dndOn', acdAvailability: 'signedOutAcd', groupStatus: {} },
    { accountId: '205@4', availability: 'available', callStatus: 'idle', dndStatus: 'dndOff', acdAvailability: 'signedOutAcd', groupStatus: { 690: 'groupJoined' } },
    { accountId: '701@4', availability: 'available', callStatus: 'idle', dndStatus: 'dndOff', acdAvailability: 'signedOutAcd', groupStatus: {} }, // AA/ACD-like user-shaped, not in the directory
    { accountId: '626@4', callStatus: 'idle', groupPresenceState: 'InOffice', groupPresenceStateOverride: 'false' },
    { accountId: '690@4', callStatus: 'idle', groupPresenceState: '', groupPresenceStateOverride: 'false' }
  ];
  await sleep(30);
  await until(() => e.op.getState().phase === 'live', 2000);
  const subs = [...e.api.subs].sort();
  check('engine: admin subscribes the four wildcards once', JSON.stringify(subs) === JSON.stringify(['call|ALL_ACD_EXTENSIONS', 'call|ALL_CALL_GROUP_EXTENSIONS', 'call|ALL_USERS', 'presence|ALL_USERS']), subs);
  const tenantGets = e.api.requests.filter((r) => r.path.startsWith('presencestatus/'));
  check('engine: exactly one tenant presence GET and no per-extension GETs', tenantGets.length === 1 && tenantGets[0].path === 'presencestatus/tenants/4/extensions', e.api.requests);
  let st = e.op.getState();
  const by = (ext) => st.people.find((p) => p.ext === ext);
  check('engine: only directory users are shown (self, AA/ACD-like and groups left out)', st.people.map((p) => p.ext).sort().join(',') === '197,201,202,203,204,205', st.people.map((p) => p.ext));
  check('engine: states from the snapshot', by('201').state === 'available' && by('202').state === 'nophone' && by('203').state === 'oncall' && by('204').state === 'dnd', st.people.map((p) => `${p.ext}:${p.state}`));
  check('engine: snapshot states have no invented timer', st.people.every((p) => p.since === null), st.people.map((p) => p.since));
  check('engine: busy from the snapshot has no invented call party', by('203').call === null, by('203'));
  check('engine: queue sign-in and known groups only (monitoring residue ignored)', by('201').inQueue && JSON.stringify(by('201').groups) === '["626"]', by('201'));
  const fd = st.groups.find((g) => g.ext === '626');
  check('engine: group members joined / total', fd && fd.joined === 1 && fd.members === 2 && fd.name === 'Front Desk', st.groups);
  check('engine: counts', st.counts.available === 3 && st.counts.oncall === 1 && st.counts.dnd === 1 && st.counts.nophone === 1 && st.counts.total === 6, st.counts);

  // Event reduction.
  e.api.emit('team', callEv('201', 'offer', 'c1', { from: '3155550142', callingName: 'ACME ANSWERING', to: '201@4' }));
  e.api.emit('team', callEv('201', 'ringing', 'c1'));
  st = e.op.getState();
  check('engine: inbound offer -> ringing with caller name (Title Case) and number', by('201').state === 'ringing' && by('201').call.otherName === 'Acme Answering' && by('201').call.otherNumber === '3155550142' && by('201').since > 0, by('201'));
  e.api.emit('team', callEv('201', 'answer', 'c1', { answeringParty: '201@4' }));
  st = e.op.getState();
  check('engine: answer -> on a call, timer from the answer', by('201').state === 'oncall' && by('201').call.phase === 'connected' && by('201').call.direction === 'inbound', by('201'));
  e.api.emit('team', callEv('201', 'hold', 'c1', { holdingParty: '201@4' }));
  st = e.op.getState();
  check('engine: hold -> on hold', by('201').state === 'onhold', by('201'));
  e.api.emit('team', callEv('201', 'resume', 'c1'));
  st = e.op.getState();
  check('engine: resume -> on a call', by('201').state === 'oncall', by('201'));
  e.api.emit('team', callEv('201', 'end', 'c1', { callDuration: 'PT20S' }));
  st = e.op.getState();
  check('engine: end -> available again', by('201').state === 'available' && by('201').call === null, by('201'));
  // Outbound to a coworker: name from the directory.
  e.api.emit('team', callEv('205', 'dial', 'c2', { from: '205@4', to: '202', dialedDigits: '202' }));
  st = e.op.getState();
  check('engine: dial -> calling out, other party named from the directory', by('205').state === 'oncall' && by('205').call.phase === 'dialing' && by('205').call.otherName === 'Blake Brooks', by('205'));
  e.api.emit('team', callEv('205', 'answer', 'c2', { answeringParty: '202' }));
  st = e.op.getState();
  check('engine: outbound answered -> connected', by('205').call.phase === 'connected' && by('205').call.direction === 'outbound', by('205'));
  // Ring group call answered by someone else: drops off the member who did not answer.
  e.api.emit('team', callEv('204', 'offer', 'c3', { from: '3155550100', to: '204@4' }));
  e.api.emit('team', callEv('204', 'answer', 'c3', { answeringParty: '201@4' }));
  st = e.op.getState();
  check('engine: group call answered by a coworker leaves the other member', by('204').state === 'dnd' && by('204').call === null, by('204'));
  // 3PCC callee: first event is answer.
  e.api.emit('team', callEv('202', 'answer', 'c4', { from: '197@4', answeringParty: '202@4' }));
  st = e.op.getState();
  check('engine: unknown call starting with answer counts as a call', by('202').state === 'oncall' && by('202').call.otherExt === '197', by('202'));
  e.api.emit('team', pres('202', 'idle'));
  st = e.op.getState();
  check('engine: presence idle clears calls whose end was missed', by('202').call === null && by('202').state === 'nophone', by('202'));
  // Presence.
  e.api.emit('team', pres('204', 'dndOff'));
  e.api.emit('team', pres('203', 'idle'));
  e.api.emit('team', pres('203', 'signedInAcd'));
  e.api.emit('team', pres('205', 'leftGroup', { groupLeft: '690' }));
  st = e.op.getState();
  check('engine: dndOff / idle / signedInAcd / leftGroup', by('204').state === 'available' && by('203').state === 'available' && by('203').inQueue && by('205').groups.length === 0, st.people);
  // Group / queue calls (ALL_CALL_GROUP_EXTENSIONS): waiting list.
  e.api.emit('team', callEv('690', 'offer', 'g1', { from: '7165550123', callingName: 'IT DESK', to: '690@4' }));
  st = e.op.getState();
  const sl = st.groups.find((g) => g.ext === '690');
  check('engine: a group call waits in the group, not as a person', sl && sl.waiting.length === 1 && sl.waiting[0].name === 'It Desk' && !by('690'), st.groups);
  e.api.emit('team', callEv('690', 'answer', 'g1', { answeringParty: '205@4' }));
  st = e.op.getState();
  check('engine: answered group call leaves the waiting list', st.groups.find((g) => g.ext === '690').waiting.length === 0, st.groups);
  // Own frames never become a tile.
  e.api.emit('team', callEv('196', 'offer', 'me', { from: '3155550000' }));
  st = e.op.getState();
  check('engine: own extension never appears in the team list', !by('196'), st.people.map((p) => p.ext));

  // Coalescing: a burst of 200 frames publishes a handful of times, not 200.
  await sleep(300);
  const before = e.writes.filter((w) => w.area === 'session').length;
  for (let i = 0; i < 200; i++) e.api.emit('team', pres(String(201 + (i % 5)), i % 2 ? 'dndOn' : 'dndOff'));
  await sleep(600);
  const n = e.writes.filter((w) => w.area === 'session').length - before;
  check('engine: 200 updates in a burst are coalesced (<= 4 writes / s)', n >= 1 && n <= 3, { writes: n });
  const ws = e.writes.filter((w) => w.area === 'session' && w.keys).map((w) => w.at);
  const minGap = Math.min(...ws.slice(1).map((t, i) => t - ws[i]));
  check('engine: session writes are at least ~250 ms apart', ws.length < 2 || minGap >= 240, { minGap });
  check('engine: operator data never goes to sync or local storage', !e.writes.some((w) => (w.area === 'sync' || w.area === 'local') && (w.keys || []).some((k) => /^operatorState/.test(k))) && !Object.keys(e.sync.data).length, e.writes.filter((w) => w.area !== 'session'));

  // Ports: only extension pages; content scripts are refused.
  const posted = [];
  let disconnected = false;
  const port = (url) => ({ name: 'operator', sender: { id: 'ext', url }, postMessage: (m) => posted.push(m), disconnect: () => { disconnected = true; }, onDisconnect: { addListener() {} } });
  for (const fn of e.listeners.connect) fn(port('https://evil.example/page'));
  check('engine: a content script port is disconnected and gets nothing', disconnected && posted.length === 0, { disconnected, posted: posted.length });
  for (const fn of e.listeners.connect) fn(port('chrome-extension://ext/operator.html'));
  check('engine: an extension page port gets a snapshot', posted.length === 1 && posted[0].type === 'snapshot' && posted[0].state.people.length === 6, posted[0] && posted[0].type);
  e.api.emit('team', pres('201', 'dndOn'));
  await sleep(350);
  const delta = posted.find((m) => m.type === 'delta' && m.people.some((p) => p.ext === '201'));
  check('engine: deltas carry only the changed people', !!delta && delta.people.length === 1, posted.map((m) => m.type));
  const refused = await e.send('operator:get', {}, { id: 'ext', url: 'https://evil.example/' });
  check('engine: operator:get from a web page is refused', refused && refused.ok === false && !refused.state, refused);

  // Resync: buffered frames during the GET are applied on top of the snapshot.
  e.api.snapshot = e.api.snapshot.map((x) => (x.accountId === '205@4' ? { ...x, callStatus: 'idle', dndStatus: 'dndOn' } : x));
  const p = e.op.resync('test');
  e.api.emit('team', pres('205', 'dndOff'));
  await p;
  st = e.op.getState();
  check('engine: an update that arrives during a resync wins over the snapshot', by('205').state === 'available' && by('205').dnd === false, by('205'));
  check('engine: resync uses one tenant GET', e.api.requests.filter((r) => r.path.startsWith('presencestatus/')).length === 2, e.api.requests.length);

  // No logging of operator data, ever.
  const leaks = e.logs.filter((l) => /Avery|Blake|Carmen|Dana|Elena|Acme|It Desk|IT DESK|3155550142|7165550123|3155550100|20[1-5]|690|626/.test(l));
  check('engine: no names, numbers or extensions of coworkers in the log', leaks.length === 0, leaks);

  // Toggle off: unsubscribe + clear.
  await e.setLocal({ operatorEnabled: false });
  await sleep(30);
  check('engine: turning the toggle off unsubscribes the wildcards and clears session storage', e.api.unsubs.length === 4 && !('operatorState' in e.session.data) && e.op.getState().phase === 'disabled' && e.op.getState().people.length === 0, { unsubs: e.api.unsubs, keys: Object.keys(e.session.data) });
  check('engine: open pages are told to clear', posted.some((m) => m.type === 'cleared'), posted.map((m) => m.type));
  await e.setLocal({ operatorEnabled: true });
  await until(() => e.op.getState().phase === 'live', 2000);
  check('engine: turning it back on resubscribes and reloads', e.op.getState().people.length === 6 && e.api.subs.length === 8, { subs: e.api.subs.length });

  // Sign-out clears everything.
  e.api.session = null;
  e.api.emit('credentials', { complete: false, extension: null });
  await sleep(30);
  check('engine: sign-out clears memory and session storage and unsubscribes', !('operatorState' in e.session.data) && e.op.getState().people.length === 0 && e.op.isActive() === false && e.api.unsubs.length === 8, { keys: Object.keys(e.session.data), unsubs: e.api.unsubs.length });

  // PIN rejected clears too.
  {
    const f = bootEngine({ isAdmin: true });
    f.api.snapshot = e.api.snapshot;
    await until(() => f.op.getState().phase === 'live', 2000);
    f.api.emit('auth-failed', { reason: 'auth' });
    await sleep(30);
    check('engine: a rejected PIN clears the team view', !('operatorState' in f.session.data) && !f.op.isActive(), Object.keys(f.session.data));
  }
  // The server refuses the wildcard (not really an admin): stop, no snapshot.
  {
    const f = bootEngine({ isAdmin: true });
    f.api.subResult = { ok: false, status: 404, errorClass: 'forbidden', errorCode: 'RestrictedDataAccessAttempt' };
    await sleep(60);
    check('engine: a refused wildcard subscription stops the feature without a tenant GET', !f.op.isActive() && !f.api.requests.some((r) => r.path.startsWith('presencestatus/')) && f.op.getState().phase === 'not_admin', { req: f.api.requests, phase: f.op.getState().phase });
  }
  // Disabled by preference: admin, but nothing requested.
  {
    const f = bootEngine({ isAdmin: true }, { enabled: false });
    await sleep(40);
    check('engine: admin with the toggle off makes no team requests', f.api.subs.length === 0 && f.api.requests.length === 0 && f.op.getState().phase === 'disabled', f.api.requests);
  }
  // Live fixture shape (anonymized admin capture): parses, groups split out.
  if (FIXTURE) {
    const h = bootEngine({ isAdmin: true }).op.helpers;
    const model = h.newModel('188');
    const userExts = FIXTURE.filter((x) => x.availability !== undefined).map((x) => x.accountId.split('@')[0]);
    const named = userExts.slice(0, Math.max(1, userExts.length - 4)); // a few user-shaped accounts are not in the directory (ACD / AA)
    named.forEach((x) => model.userDir.set(x, `Person ${x}`));
    const n = h.applySnapshot(model, FIXTURE, Date.now());
    const people = h.visiblePeople(model);
    check('engine: live fixture shape parses (all accounts seen, groups kept out of people)', n === FIXTURE.length && people.length === named.length && model.groupish.size === FIXTURE.length - userExts.length, { n, people: people.length, groupish: model.groupish.size });
  }
}

(async () => {
  await clientTests();
  await engineTests();
  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})();
