// Unit tests for lib/vaspian-api.js pure helpers, loaded with a minimal
// chrome.* stub (no network: fetch and WebSocket are stubbed to fail loudly).
// Run: node tests/vaspian-api.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

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
const sync = makeStorage();
const local = makeStorage();
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URL, AbortController,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent,
  crypto: require('crypto').webcrypto,
  fetch: async () => { throw new Error('network disabled in unit test'); },
  WebSocket: class { constructor() { throw new Error('no sockets in unit test'); } },
  chrome: {
    storage: { sync, local, onChanged: { addListener() {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener() {} }, getPlatformInfo() {} }
  }
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaspian-api.js'), 'utf8'), sandbox);
const api = sandbox.OneClick.api;

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};

(async () => {
  // normalizeParty
  const n = (raw) => { const p = api.normalizeParty(raw, { selfExt: '196' }); return p && { ext: p.ext, number: p.number, internal: p.isInternal, self: p.isSelf }; };
  eq('party 196@4 is self ext', n('196@4'), { ext: '196', number: null, internal: true, self: true });
  eq('party 196 is self ext', n('196'), { ext: '196', number: null, internal: true, self: true });
  eq('party 197 is internal, not self', n('197'), { ext: '197', number: null, internal: true, self: false });
  eq('party 11-digit', n('13155694033'), { ext: null, number: '3155694033', internal: false, self: false });
  eq('party 10-digit', n('3155694033'), { ext: null, number: '3155694033', internal: false, self: false });
  eq('party formatted', n('+1 (315) 569-4033'), { ext: null, number: '3155694033', internal: false, self: false });
  eq('party empty', n(''), null);
  eq('sameParty 196 vs 196@4', api.sameParty('196', '196@4'), true);
  eq('sameParty 10 vs 11 digit', api.sameParty('3155694033', '13155694033'), true);
  eq('sameParty 196 vs 197', api.sameParty('196', '197@4'), false);

  // durations
  eq('PT6.3S', api.durationMs('PT6.3S'), 6300);
  eq('PT1M2.5S', api.durationMs('PT1M2.5S'), 62500);
  eq('no duration', api.durationMs(undefined), null);

  // dialString: prefix only external numbers
  eq('dial ext 197 with prefix 8', api.dialString('197', '8'), '197');
  eq('dial 10-digit with prefix 8', api.dialString('(315) 555-0100', '8'), '83155550100');
  eq('dial 11-digit no prefix', api.dialString('13155550100', ''), '13155550100');
  eq('dial garbage', api.dialString('abc', '8'), '');

  // error classification
  eq('401 -> auth', api.classifyError(401, 'BadAuthenticationHeader'), 'auth');
  eq('400 device', api.classifyError(400, 'RequestNotValidForSpecifiedDevice'), 'device');
  eq('400 invalid', api.classifyError(400, 'InvalidRequest'), 'invalid');
  eq('403 forbidden', api.classifyError(403, 'FrameworkForbidden'), 'forbidden');
  eq('404 restricted -> forbidden', api.classifyError(404, 'RestrictedDataAccessAttempt'), 'forbidden');
  eq('404 not found', api.classifyError(404, 'ResourceNotFound'), 'notFound');
  eq('409 state', api.classifyError(409, 'RequestNotValidForCallState'), 'state');
  eq('503 busy', api.classifyError(503), 'busy');

  // usernames
  eq('username web name', api.usernameFor('vaspian', '196'), '196@vaspian.URI');
  eq('username DID', api.usernameFor('+1 716-961-2115', '196'), '196@7169612115.DID');

  // PIN migration
  await sync.set({ tenant: 'vaspian', extension: '196', password: 'unit-test-pin' });
  const creds = await api.getCredentials();
  eq('migration: credentials complete', creds.complete, true);
  eq('migration: PIN removed from sync', 'password' in sync.data, false);
  eq('migration: PIN in local', local.data.password === 'unit-test-pin', true);
  await sync.set({ password: '' });
  await api.migratePin();
  eq('migration: empty sync PIN never overwrites local', local.data.password === 'unit-test-pin', true);
  eq('migration: empty sync PIN removed', 'password' in sync.data, false);

  // event bus
  const seen = [];
  const un = api.on('x', (p) => seen.push(p));
  api.on('*', (name) => seen.push(`*${name}`));
  api.on('x', () => { throw new Error('handler error is contained'); });
  api.emit('x', 1);
  un();
  api.emit('x', 2);
  eq('bus: on/off/wildcard, throwing handler contained', seen, [1, '*x', '*x']);

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})();
