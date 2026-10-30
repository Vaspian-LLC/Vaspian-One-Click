// Unit tests for presence.js (Track B "status"): pure helpers plus the
// toggle flows against a fake self.OneClick.api (no network, no browser).
// Run: node tests/status.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeStorage() {
  const data = {};
  return {
    data,
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

/** A fake client: records requests, answers from `routes`, and exposes the bus. */
function fakeApi() {
  const handlers = {};
  const requests = [];
  const routes = [];
  const api = {
    requests, routes,
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => {}; },
    emit(name, payload) { for (const fn of handlers[name] || []) fn(payload); },
    getStatus: () => ({ state: 'connected', reason: null }),
    getSession: () => ({ account: '196@4', tenantId: '4', extension: '196', isAdmin: false, links: {} }),
    ensureSession: async () => ({ ok: true }),
    isConnected: () => true,
    async request(method, p, opts = {}) {
      requests.push({ method, path: p, body: opts.body });
      for (const r of routes) if (r.method === method && r.test(p)) return r.reply(p, opts.body);
      return { ok: false, status: 404, errorClass: 'notFound' };
    },
    async getPresence() { return api.request('GET', 'presencestatus/tenants/4/extensions/196'); },
    async getMyPhones() { return { ok: true, phones: [{ phoneId: '1' }] }; },
    async getActiveCalls() { return { ok: true, calls: [] }; },
    async makeCall(to) { requests.push({ method: 'POST', path: 'calls', body: { request: 'makeCall', to } }); return { ok: true, status: 201, callId: 'consult-1' }; },
    async callControl(callId, callRequest, extra) { requests.push({ method: 'POST', path: `calls/${callId}`, body: { callRequest, ...extra } }); return { ok: true, status: 200 }; },
    subscribe() { return Promise.resolve({ ok: true }); },
    unsubscribe() { return Promise.resolve({ ok: true }); },
    normalizeParty(raw, ctx = {}) {
      if (!raw) return null;
      const s = String(raw); const ext = s.split('@')[0];
      const internal = /^\d{1,6}$/.test(ext);
      return { raw: s, ext: internal ? ext : null, digits: ext, number: internal ? null : ext.slice(-10), isInternal: internal, isSelf: internal && ext === ctx.selfExt, display: ext };
    },
    sameParty(a, b) { return String(a).split('@')[0] === String(b).split('@')[0]; },
    dialString(n, prefix) { const d = String(n).replace(/\D/g, ''); return d.length <= 6 ? d : `${prefix || ''}${d}`; },
    async dialPrefix() { return '8'; }
  };
  return api;
}

const local = makeStorage();
const sync = makeStorage();
const badge = {};
const api = fakeApi();
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Promise,
  addLog: () => {},
  chrome: {
    storage: { local, sync, onChanged: { addListener() {} } },
    alarms: { create() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener() {} } },
    commands: { onCommand: { addListener(fn) { sandbox.__command = fn; } } },
    action: {
      setBadgeText: (o) => { badge.text = o.text; },
      setBadgeBackgroundColor: (o) => { badge.color = o.color; },
      setBadgeTextColor: () => {},
      setTitle: (o) => { badge.title = o.title; }
    }
  }
};
sandbox.self = sandbox;
sandbox.OneClick = { api, dial: async (n) => ({ via: '3pcc', destination: n }) };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'presence.js'), 'utf8'), sandbox);
const presence = sandbox.OneClick.presence;
const H = presence.helpers;

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---------------------------------------------------------------- names
  eq('name "Last, First" flips', H.formatName('TestA, OneClick').display, 'OneClick TestA');
  eq('name prefers first/last fields', H.formatName('X, Y', 'Jane', 'Doe').display, 'Jane Doe');
  eq('name without comma passes through', H.formatName('Front Desk').display, 'Front Desk');
  eq('initials two words', H.initials('Jane Doe'), 'JD');
  eq('initials one word', H.initials('Reception'), 'R');
  eq('initials apostrophe', H.initials("Owen O'Brien"), 'OB');
  eq('initials digits', H.initials('197'), '#');

  // --------------------------------------------------------------- search
  const people = [
    { ext: '197', name: 'OneClick TestB' }, { ext: '201', name: 'Blake Brooks' }, { ext: '210', name: 'Keiko Kim' },
    { ext: '219', name: 'Tara Turner' }, { number: '3155550142', name: 'Acme Answering Service' }
  ];
  const names = (r) => r.map((x) => x.name);
  eq('search by first-name prefix', names(H.searchDirectory(people, 'ke')), ['Keiko Kim']);
  eq('search by last name', names(H.searchDirectory(people, 'turner')), ['Tara Turner']);
  eq('search two words', names(H.searchDirectory(people, 'blake br')), ['Blake Brooks']);
  eq('search exact extension first', names(H.searchDirectory(people, '210')), ['Keiko Kim']);
  eq('search extension substring', names(H.searchDirectory(people, '21')).sort(), ['Keiko Kim', 'Tara Turner']);
  eq('search contact number', names(H.searchDirectory(people, '555-0142')), ['Acme Answering Service']);
  eq('search no match', H.searchDirectory(people, 'zzz').length, 0);
  eq('search empty returns all', H.searchDirectory(people, '  ').length, people.length);

  // ---------------------------------------------------------- groupStatus
  const groups = [{ extension: '626' }, { extension: '627' }];
  eq('groupStatus keeps known groups, drops monitoring residue', H.trustedGroupStatus({ 626: 'groupJoined', 627: 'groupLeft', 196: 'groupLeft' }, groups), { 626: true, 627: false });
  eq('groupStatus missing', H.trustedGroupStatus(undefined, groups), {});

  // ------------------------------------------------------- status derive
  const base = { ready: true, calls: {}, dnd: false, availability: 'available', callStatus: 'idle' };
  const ok = { state: 'connected' };
  const k = (s, c = ok) => H.deriveStatus({ ...base, ...s }, c).key;
  eq('available', k({}), 'available');
  eq('dnd', k({ dnd: true }), 'dnd');
  eq('no device beats dnd', k({ dnd: true, availability: 'unavailable' }), 'nodevice');
  eq('on call beats no device and dnd', k({ dnd: true, availability: 'unavailable', callStatus: 'busy' }), 'oncall');
  eq('ringing beats on call', k({ calls: { a: { phase: 'active' }, b: { phase: 'ringing' } } }), 'ringing');
  eq('connection error beats everything', k({ calls: { a: { phase: 'ringing' } } }, { state: 'error', reason: 'auth' }), 'offline');
  eq('signed out', k({ ready: false }, { state: 'off', reason: 'no_credentials' }), 'signedout');
  eq('retrying before first snapshot = offline', k({ ready: false }, { state: 'retrying' }), 'offline');
  eq('retrying after a snapshot keeps the last state', k({ dnd: true }, { state: 'retrying' }), 'dnd');
  const v = H.deriveStatus({ ...base, dnd: true }, ok);
  eq('dnd badge text/color', [v.text, v.color], ['DND', '#dc2626']);
  eq('available has no badge text', H.deriveStatus(base, ok).text, '');
  const m = H.deriveStatus({ ...base, missedUnseen: 3 }, ok);
  eq('missed calls: count badge, pill still Available', [m.key, m.text, m.label, /3 missed calls/.test(m.title)], ['missed', '3', 'Available', true]);
  eq('missed calls: 12 -> 9+', H.deriveStatus({ ...base, missedUnseen: 12 }, ok).text, '9+');
  eq('missed calls: DND badge wins, title still counts them', [H.deriveStatus({ ...base, dnd: true, missedUnseen: 2 }, ok).text, /2 missed/.test(H.deriveStatus({ ...base, dnd: true, missedUnseen: 2 }, ok).title)], ['DND', true]);
  {
    const f = H.deriveStatus({ ...base, forward: { active: true, targetName: 'Jane' } }, ok);
    eq('forwarding all calls: pill says so (never Available)', [f.key, f.label, f.text, /Forwarding to Jane/.test(f.title)], ['forward', 'Forwarding to Jane', 'FWD', true]);
    const fd = H.deriveStatus({ ...base, dnd: true, forward: { active: true, targetName: 'Jane' } }, ok);
    eq('DND beats forwarding; title still mentions it', [fd.key, /forwarding to Jane/.test(fd.title)], ['dnd', true]);
  }

  // ------------------------------------------------------------- parsers
  const member = { loggedIn: false, _embedded: { callGroup: { callGroupId: 69759, extension: '626', name: 'OneClick Test Group', callGroupType: 'ringGroup' } }, _links: { self: { href: '/api/v1/tenants/4/callinggroups/69759/members/196' } } };
  const g = H.parseGroup(member, '4', '196');
  eq('parseGroup', [g.callGroupId, g.extension, g.loggedIn, g.path], ['69759', '626', false, 'tenants/4/callinggroups/69759/members/196']);
  // Live shape (captured 2026-10-29): callGroup and extension are ONE-ELEMENT ARRAYS,
  // and item.extension is the member's own extension, never the group's.
  const live = {
    _links: { self: { href: '/api/v1/tenants/4/callinggroups/69759/members/196' } },
    extension: '196', loggedIn: true, monitorAllowed: false, twinningEnabled: false,
    _embedded: {
      callGroup: [{ _links: { self: { href: '/api/v1/tenants/4/callinggroups/69759' } }, callGroupId: 69759, callGroupType: 'BroadcastGroup', extension: '626', name: 'OneClick Test Group' }],
      extension: [{ accountId: '196@4', extension: '196', extensionType: 'userExt', name: 'TestA, OneClick' }]
    }
  };
  const gl = H.parseGroup(live, '4', '196');
  eq('parseGroup live array shape', [gl.callGroupId, gl.extension, gl.name, gl.loggedIn, gl.type], ['69759', '626', 'OneClick Test Group', true, 'BroadcastGroup']);
  eq('parseGroup never takes the member ext as the group ext', H.parseGroup({ extension: '196', loggedIn: true, callGroupId: 7 }, '4', '196').extension, null);
  const g2 = H.parseGroup({ loggedIn: true, callGroupId: 5, name: 'Flat' }, '4', '196');
  eq('parseGroup flat shape builds the member path', [g2.callGroupId, g2.path], ['5', 'tenants/4/callinggroups/5/members/196']);
  eq('parseGroup rejects foreign href', H.parseGroup({ ...member, _links: { self: { href: 'https://evil.test/x' } } }, '4', '196').path, 'tenants/4/callinggroups/69759/members/196');
  eq('parseForward off', H.parseForward({ active: false }), { active: false, type: null, target: null, targetName: null });
  eq('parseForward coworker', H.parseForward({ active: true, callForwardTargetType: 'coworker', targetNumber: '197', _embedded: { extension: { name: 'TestB, OneClick' } } }),
    { active: true, type: 'coworker', target: '197', targetName: 'OneClick TestB' });
  eq('parsePark', H.parsePark({ accountId: 'PL3@4', status: 'busy' }).number, '3');
  eq('parsePark event shape', H.parsePark({ observedParty: 'PL7@4', event: 'idle' }), { number: '7', accountId: 'PL7@4', status: 'idle', parkedName: null, parkedNumber: null, parkedBy: null });
  eq('halItems embedded array', H.halItems({ _embedded: { x: [1, 2] } }), [1, 2]);
  eq('halItems empty collection', H.halItems({ _links: {} }), []);
  eq('relPath', H.relPath('/api/v1/tenants/4/extensions?page=2'), 'tenants/4/extensions?page=2');

  // ------------------------------------------------------- toggle flows
  presence.CONFIG.eventFallbackMs = 300;
  const pres = { availability: 'available', callStatus: 'idle', dndStatus: 'dndOff', acdAvailability: 'signedOutAcd', groupStatus: { 626: 'groupJoined', 196: 'groupLeft' } };
  api.routes.push(
    { method: 'GET', test: (p) => p.startsWith('presencestatus/tenants/4/extensions/196'), reply: () => ({ ok: true, status: 200, body: pres }) },
    { method: 'GET', test: (p) => p.endsWith('/callforward'), reply: () => ({ ok: true, status: 200, body: { active: false } }) },
    { method: 'GET', test: (p) => p.includes('/callinggroups?expand=item'), reply: () => ({ ok: true, status: 200, body: { _embedded: { callGroupMember: [member] } } }) },
    { method: 'GET', test: (p) => p.includes('parklocations'), reply: () => ({ ok: true, status: 200, body: { _embedded: { p: [{ accountId: 'PL1@4', parkLocationNumber: '1', status: 'idle' }] } } }) },
    { method: 'GET', test: (p) => p.includes('/extensions?'), reply: () => ({ ok: true, status: 200, body: { _embedded: { extension: [{ extension: '197', name: 'TestB, OneClick', extensionType: 'userExt' }, { extension: '196', name: 'TestA, OneClick', extensionType: 'userExt' }] } } }) },
    { method: 'GET', test: (p) => p.includes('externalcontacts'), reply: () => ({ ok: true, status: 200, body: { _links: {} } }) },
    { method: 'PUT', test: () => true, reply: (p, body) => ({ ok: true, status: 200, body }) },
    { method: 'POST', test: (p) => p === 'calls', reply: () => ({ ok: true, status: 201, body: {} }) }
  );
  await presence.refresh();
  let st = presence.getState();
  eq('refresh: groupStatus applied, residue ignored', st.groups.map((x) => [x.extension, x.loggedIn]), [['626', true]]);
  eq('refresh: presence fields', [st.ready, st.dnd, st.acd, st.availability], [true, false, false, 'available']);
  await sleep(50);
  eq('directory excludes self, flips names', (local.data.statusDirectory || {}).users.map((u) => u.name), ['OneClick TestB']);
  eq('coworker presence never requested', api.requests.some((r) => /presencestatus\/tenants\/4\/extensions\/(?!196)/.test(r.path)), false);

  api.requests.length = 0;
  await presence.setDnd(true);
  eq('DND: PUT dnd {active:true}', api.requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body]), [['tenants/4/users/196/dnd', { active: true }]]);
  eq('DND: pending until the event, state unchanged', [presence.getState().pending.dnd, presence.getState().dnd], [true, false]);
  api.emit('presence', { type: 'dndOn', account: '196@4' });
  eq('DND: event flips state and clears pending', [presence.getState().dnd, !!presence.getState().pending.dnd], [true, false]);
  await sleep(40);
  eq('badge shows DND', [badge.text, badge.color], ['DND', '#dc2626']);

  api.requests.length = 0;
  sandbox.__command('toggle-dnd');
  await sleep(10);
  eq('toggle-dnd command sends active:false', api.requests.filter((r) => r.method === 'PUT').map((r) => r.body), [{ active: false }]);
  await sleep(400);
  eq('no event: PUT result applied after the fallback delay', [presence.getState().dnd, !!presence.getState().pending.dnd], [false, false]);

  api.requests.length = 0;
  await presence.setAcd(true);
  eq('ACD: PUT loginacd', api.requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body]), [['tenants/4/users/196/loginacd', { active: true }]]);
  api.emit('presence', { type: 'signedInAcd', account: '196@4' });
  eq('ACD: event applied', presence.getState().acd, true);

  api.requests.length = 0;
  await presence.setGroup('69759', false);
  eq('group: PUT member path {loggedIn:false}', api.requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body]), [['tenants/4/callinggroups/69759/members/196', { loggedIn: false }]]);
  api.emit('presence', { type: 'leftGroup', account: '196@4', groupLeft: '626' });
  eq('group: leftGroup keyed by group extension applied', presence.getState().groups[0].loggedIn, false);
  api.emit('presence', { type: 'joinedGroup', account: '196@4', groupJoined: '626' });
  eq('group: external joinedGroup applied', presence.getState().groups[0].loggedIn, true);
  api.emit('presence', { type: 'dndOn', account: '197@4' });
  eq('presence for another account ignored', presence.getState().dnd, false);

  api.requests.length = 0;
  await presence.setForward(true, '197');
  eq('forward to coworker', api.requests.find((r) => r.method === 'PUT').body, { active: true, callForwardTargetType: 'coworker', targetNumber: '197' });
  api.requests.length = 0;
  await presence.setForward(true, '(315) 555-0100');
  eq('forward to external number', api.requests.find((r) => r.method === 'PUT').body, { active: true, callForwardTargetType: 'external', targetNumber: '3155550100' });
  eq('forward to self refused locally', (await presence.setForward(true, '196')).ok, false);
  eq('forward bad number refused locally', (await presence.setForward(true, '12345678')).ok, false);
  api.requests.length = 0;
  await presence.setForward(false);
  eq('forward off', api.requests.find((r) => r.method === 'PUT').body, { active: false });

  // Forbidden -> disabled with a readable reason, never retried.
  api.routes.unshift({ method: 'PUT', test: (p) => p.endsWith('/dnd'), reply: () => ({ ok: false, status: 404, errorCode: 'RestrictedDataAccessAttempt', errorClass: 'forbidden' }) });
  const r = await presence.setDnd(true);
  eq('forbidden DND: disabled with reason', [r.ok, /isn’t available for your account/.test(presence.getState().disabled.dnd || '')], [false, true]);
  api.routes.shift();

  // Park: busy/idle events, retrieve request.
  api.emit('parklocation', { type: 'busy', parkLocationNumber: '1', accountId: 'PL1@4', raw: { parkedPartyName: 'CHRIS A' } });
  eq('park busy event', [presence.getState().park[0].status, presence.getState().park[0].parkedName], ['busy', 'CHRIS A']);
  api.requests.length = 0;
  await presence.retrievePark('1');
  eq('retrieveParkedCall body', api.requests.find((x) => x.path === 'calls').body, { request: 'retrieveParkedCall', from: '196@4', featureData: '1' });
  api.emit('parklocation', { type: 'idle', parkLocationNumber: '1', accountId: 'PL1@4', raw: {} });
  eq('park idle event clears the slot', [presence.getState().park[0].status, presence.getState().park[0].parkedName], ['idle', null]);

  // Calls + attended transfer fallback (no Track A transfer()).
  api.emit('call', { type: 'offer', callId: 'c1', direction: 'inbound', from: api.normalizeParty('197'), isNew: true, callingName: 'OneClick TestB', timestamp: new Date().toISOString() });
  await sleep(40);
  eq('ringing call -> RING badge', badge.text, 'RING');
  api.emit('call', { type: 'answer', callId: 'c1', direction: 'inbound', from: api.normalizeParty('197'), timestamp: new Date().toISOString() });
  eq('answered call is the active call', presence.activeCall(), { callId: 'c1', phase: 'active' });
  await sleep(20);
  eq('recent records the coworker', (local.data.statusRecent || [])[0].ext, '197');
  api.requests.length = 0;
  const t1 = await presence.transfer('210', 'Keiko Kim');
  eq('transfer: consult makeCall to 210', [t1.ok, api.requests[0].body], [true, { request: 'makeCall', to: '210' }]);
  const t2 = await presence.completeTransfer();
  eq('transfer: POST transfer on consult call with otherCallId', [t2.ok, api.requests[1].path, api.requests[1].body], [true, 'calls/consult-1', { callRequest: 'transfer', otherCallId: 'c1' }]);
  sandbox.OneClick.calls = { transfer: async (to) => ({ ok: true, message: `delegated ${to}` }) };
  eq('transfer delegates to Track A when it exposes transfer()', (await presence.transfer('210')).message, 'delegated 210');
  // Track A's real surface (fleet/wt/callcard calls.js): getStore() + startTransfer(callId, target, mode).
  const started = [];
  sandbox.OneClick.calls = {
    getStore: () => ({ calls: { a1: { callId: 'a1', state: 'connected', consultFor: null }, b1: { callId: 'b1', state: 'ringback', consultFor: 'a1' } } }),
    startTransfer: async (callId, target, mode) => { started.push([callId, target, mode]); return { ok: true }; }
  };
  eq('active call comes from Track A store', presence.activeCall(), { callId: 'a1', phase: 'active' });
  const t3 = await presence.transfer('219', 'Tara Turner');
  eq('transfer delegates to Track A startTransfer(callId, target, consult)', [t3.ok, started], [true, [['a1', '219', 'consult']]]);
  delete sandbox.OneClick.calls;
  api.emit('call', { type: 'end', callId: 'c1', timestamp: new Date().toISOString() });
  eq('end clears the call', presence.activeCall(), null);

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})();
