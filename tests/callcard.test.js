// Unit tests for calls.js (Track A "callcard"): the call state machine,
// missed-call detection, resync, controls and capability memory.
// Loads lib/vaspian-api.js and calls.js in a vm with chrome.* stubs; no network.
// Run: node tests/callcard.test.js
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
      for (const k of [].concat(keys)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) { for (const [k, v] of Object.entries(obj)) data[k] = JSON.parse(JSON.stringify(v)); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}
const sync = makeStorage();
const local = makeStorage();
const session = makeStorage();
const listeners = { message: [], command: [], menu: [], installed: [] };
const notifications = [];
let granted = false;
const sandbox = {
  console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URL, AbortController,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent, decodeURIComponent,
  crypto: require('crypto').webcrypto,
  fetch: async () => { throw new Error('network disabled in unit test'); },
  WebSocket: class { constructor() { throw new Error('no sockets in unit test'); } },
  chrome: {
    storage: { sync, local, session, onChanged: { addListener() {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: { onMessage: { addListener(f) { listeners.message.push(f); } }, onInstalled: { addListener(f) { listeners.installed.push(f); } }, getPlatformInfo() {}, lastError: null },
    commands: { onCommand: { addListener(f) { listeners.command.push(f); } } },
    contextMenus: { create(o, cb) { (sandbox.menus = sandbox.menus || []).push(o); if (cb) cb(); }, onClicked: { addListener(f) { listeners.menu.push(f); } } },
    permissions: { async contains() { return granted; }, onAdded: { addListener() {} } },
    tabs: { async query() { return [{ id: 7 }]; }, async sendMessage() { return null; } }
  }
};
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'lib', 'vaspian-api.js'), 'utf8'), sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'calls.js'), 'utf8'), sandbox);
const api = sandbox.OneClick.api;
const calls = sandbox.OneClick.calls;

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Build a CallEvent the way lib/vaspian-api.js normalizes it (observed account 196@4). */
const memo = new Map();
function ev(raw) {
  raw = { observedParty: '196@4', ...raw };
  const ctx = { selfExt: '196' };
  let m = memo.get(raw.callId);
  const isNew = !m;
  if (!m) {
    let direction = 'unknown';
    if (raw.event === 'offer' || raw.event === 'ringing') direction = 'inbound';
    else if (raw.event === 'dial' || raw.event === 'ringback') direction = 'outbound';
    m = { direction, offers: 0 };
    memo.set(raw.callId, m);
  }
  if (raw.event === 'offer') m.offers++;
  const out = {
    kind: 'call', type: raw.event, callId: raw.callId, smdrCallId: raw.smdrCallId || null, observedParty: raw.observedParty,
    from: api.normalizeParty(raw.from, ctx), to: api.normalizeParty(raw.to, ctx),
    answeringParty: api.normalizeParty(raw.answeringParty, ctx), endingParty: null,
    callingName: raw.callingName || '', dialedDigits: raw.dialedDigits || '', direction: m.direction, isNew,
    isDuplicate: raw.event === 'offer' && m.offers > 1, endReason: raw.endReason || null, callDurationMs: null,
    deviceId: raw.ringingDeviceId || raw.answeringDeviceId || null, timestamp: new Date().toISOString(), raw
  };
  if (raw.event === 'end') memo.delete(raw.callId);
  return out;
}

(async () => {
  const S = () => calls.newStore();

  // inbound lifecycle
  {
    const st = S();
    const id = 'in-1:196@4';
    let r = calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4', callingName: 'CHRIS A', dialedDigits: '196' }), 1000);
    eq('inbound offer -> ringing card with caller', [st.calls[id].state, st.calls[id].direction, st.calls[id].remote.display, st.calls[id].name, r.effects.map((e) => e.type)],
      ['ringing', 'inbound', '(315) 569-4033', 'CHRIS A', ['new']]);
    calls.reduce(st, ev({ event: 'ringing', callId: id, ringingDeviceId: '111' }), 1100);
    calls.reduce(st, ev({ event: 'ringing', callId: id, ringingDeviceId: '222' }), 1150);
    eq('ringing collects devices', st.calls[id].devices, ['111', '222']);
    r = calls.reduce(st, ev({ event: 'answer', callId: id, answeringParty: '196@4', answeringDeviceId: '111' }), 2000);
    eq('answer by self -> connected, answeredAt stamped on receipt', [st.calls[id].state, st.calls[id].answeredAt, st.calls[id].answerDeviceId, st.calls[id].answeredBy], ['connected', 2000, '111', 'self']);
    r = calls.reduce(st, ev({ event: 'end', callId: id, from: '3155694033', to: '196@4', endReason: 'Normal Clearing' }), 9000);
    eq('end after answer -> ended, not missed', [st.calls[id].state, st.calls[id].missed, r.effects.map((e) => e.type)], ['ended', false, ['ended']]);
    eq('late event after end is ignored', calls.reduce(st, ev({ event: 'ringing', callId: id }), 9100).changed, false);
    eq('prune keeps a fresh ended card', calls.prune(st, 9000 + 1000), false);
    eq('prune drops it after the linger time', [calls.prune(st, 9000 + 7000), Object.keys(st.calls).length], [true, 0]);
  }

  // duplicate offer (ring group)
  {
    const st = S();
    const id = 'rg-1:196@4';
    const a = calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4', callingName: 'CHRIS A' }), 1);
    const b = calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4', callingName: 'CHRIS A' }), 2);
    eq('duplicate offer: one card, one "new" effect', [Object.keys(st.calls).length, a.effects.length, b.effects.length], [1, 1, 0]);
  }

  // missed
  {
    const st = S();
    const id = 'm-1:196@4';
    calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4', callingName: 'CHRIS A' }), 1);
    calls.reduce(st, ev({ event: 'ringing', callId: id, ringingDeviceId: '1' }), 2);
    const r = calls.reduce(st, ev({ event: 'end', callId: id, endReason: 'Normal Clearing' }), 3);
    eq('offer -> end without answer = missed', [st.calls[id].missed, r.effects.map((e) => e.type)], [true, ['missed', 'ended']]);
  }
  {
    const st = S();
    const id = 'm-2:196@4';
    calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4' }), 1);
    const r = calls.reduce(st, ev({ event: 'answer', callId: id, answeringParty: '197@4' }), 2);
    calls.reduce(st, ev({ event: 'end', callId: id }), 3);
    eq('ring group answered by a coworker: ended, not missed', [st.calls[id].state, st.calls[id].missed, st.calls[id].answeredBy, r.effects.map((e) => e.type)], ['ended', false, 'other', ['ended']]);
  }
  {
    const st = S();
    const id = 'm-3:196@4';
    calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4' }), 1);
    st.calls[id].deflected = true;
    calls.reduce(st, ev({ event: 'end', callId: id }), 3);
    eq('sent to voicemail by the user: not missed', st.calls[id].missed, false);
  }
  {
    const st = S();
    const id = 'm-4:196@4';
    calls.reduce(st, ev({ event: 'ringing', callId: id, from: '196@4', to: '197', ringingDeviceId: '5' }), 1);
    calls.reduce(st, ev({ event: 'end', callId: id }), 3);
    eq('3PCC makeCall ringing our own phone first: outbound, never missed', [st.calls[id].direction, st.calls[id].missed], ['outbound', false]);
  }

  // outbound
  {
    const st = S();
    const id = 'out-1:196@4';
    calls.reduce(st, ev({ event: 'dial', callId: id, from: '196@4', to: '13155694033', dialedDigits: '13155694033' }), 1);
    eq('dial -> outbound dialing to the number', [st.calls[id].state, st.calls[id].direction, st.calls[id].remote.display], ['dialing', 'outbound', '(315) 569-4033']);
    calls.reduce(st, ev({ event: 'ringback', callId: id }), 2);
    eq('ringback', st.calls[id].state, 'ringback');
    calls.reduce(st, ev({ event: 'answer', callId: id, answeringParty: '13155694033' }), 5);
    eq('answer by far end -> connected', [st.calls[id].state, st.calls[id].answeredAt], ['connected', 5]);
    calls.reduce(st, ev({ event: 'end', callId: id }), 9);
    eq('outbound unanswered/ended never missed', st.calls[id].missed, false);
  }
  {
    const st = S();
    const id = 'out-2:196@4';
    calls.reduce(st, ev({ event: 'dial', callId: id, from: '196@4', to: '197' }), 1);
    eq('outbound to an extension shows Ext.', st.calls[id].remote.display, 'Ext. 197');
  }

  // hold / held / resume
  {
    const st = S();
    const id = 'h-1:196@4';
    calls.reduce(st, ev({ event: 'offer', callId: id, from: '197@4', to: '196@4' }), 1);
    calls.reduce(st, ev({ event: 'answer', callId: id, answeringParty: '196@4' }), 2);
    calls.reduce(st, ev({ event: 'hold', callId: id, holdingParty: '196@4', heldParty: '197@4' }), 3);
    eq('hold by us -> held', [st.calls[id].state, st.calls[id].heldAt], ['held', 3]);
    calls.reduce(st, ev({ event: 'resume', callId: id, resumingParty: '196@4', heldParty: '197@4' }), 4);
    eq('resume -> connected', st.calls[id].state, 'connected');
    calls.reduce(st, ev({ event: 'held', callId: id, holdingParty: '197@4', heldParty: '196@4' }), 5);
    eq('held (other side held us) -> remoteHold, still connected', [st.calls[id].state, st.calls[id].remoteHold], ['connected', true]);
    calls.reduce(st, ev({ event: 'resumed', callId: id, resumingParty: '197@4', heldParty: '196@4' }), 6);
    eq('resumed -> remoteHold cleared', st.calls[id].remoteHold, false);
    calls.reduce(st, ev({ event: 'park', callId: id, parkLocationId: '3' }), 7);
    eq('park -> parked at slot', [st.calls[id].state, st.calls[id].parkedAt], ['parked', '3']);
  }

  // events after a reconnect (client forgot its memory: isNew again, direction recomputed)
  {
    const st = S();
    const id = 'rc-1:196@4';
    calls.reduce(st, ev({ event: 'offer', callId: id, from: '3155694033', to: '196@4' }), 1);
    calls.reduce(st, ev({ event: 'answer', callId: id, answeringParty: '196@4' }), 2);
    memo.clear();
    const r = calls.reduce(st, ev({ event: 'hold', callId: id, holdingParty: '196@4' }), 3);
    eq('mid-call event after reconnect updates the existing card (no new card)', [Object.keys(st.calls).length, st.calls[id].direction, st.calls[id].state, r.effects.length], [1, 'inbound', 'held', 0]);
    const r2 = calls.reduce(st, ev({ event: 'end', callId: 'unknown-1:196@4' }), 4);
    eq('end for a call we never saw shows nothing', [r2.changed, Object.keys(st.calls).length], [false, 1]);
  }

  // resync
  {
    const st = S();
    calls.reduce(st, ev({ event: 'offer', callId: 'old:196@4', from: '3155694033', to: '196@4' }), 100);
    calls.reduce(st, ev({ event: 'offer', callId: 'fresh:196@4', from: '3155694034', to: '196@4' }), 600);
    const changed = calls.resync(st, [{ callId: 'gone-unknown:196@4', from: '196@4', to: '197' }], 500, 700);
    eq('resync: ends a stale call, keeps one with events after the request, adds an unknown active call',
      [changed, st.calls['old:196@4'].state, st.calls['old:196@4'].missed, st.calls['fresh:196@4'].state, st.calls['gone-unknown:196@4'].state, st.calls['gone-unknown:196@4'].direction],
      [true, 'ended', false, 'ringing', 'connected', 'outbound']);
    eq('stateFromActive maps callState', ['ringing', 'held', 'connected', undefined].map((s) => calls.stateFromActive({ callState: s })), ['ringing', 'held', 'connected', 'connected']);
  }

  // cleanNumber
  eq('cleanNumber', ['(315) 569-4033', 'tel:+13155694033', '197', 'call me maybe', '', '555-0100 x22', '1'].map(calls.cleanNumber),
    ['3155694033', '13155694033', '197', '', '', '5550100', '']);

  // ------- runtime: controls, capability memory, missed list, commands
  await sleep(20); // hydration
  const posted = [];
  const errors = {};
  api.callControl = async (callId, callRequest, extra = {}) => {
    posted.push({ callId, callRequest, ...extra });
    if (errors[callRequest]) return { ok: false, status: 400, errorClass: 'device', errorCode: 'RequestNotValidForSpecifiedDevice' };
    return { ok: true, status: 200 };
  };
  let made = 0;
  api.makeCall = async (to) => { made++; return { ok: true, status: 201, callId: `consult-${made}:196@4`, to }; };
  api.getMyPhones = async () => ({ ok: true, phones: [{ phoneId: 42, phoneModelName: 'Generic SIP', defaultC2CPhone: true }] });
  api.getActiveCalls = async () => ({ ok: true, calls: [] });
  sandbox.OneClick.dial = async (n) => ({ via: '3pcc', destination: n });

  const send = (msg) => new Promise((resolve) => {
    for (const f of listeners.message) { const keep = f(msg, {}, resolve); if (keep === true) return; }
    resolve('unhandled');
  });

  api.emit('call', ev({ event: 'offer', callId: 'rt-1:196@4', from: '3155694033', to: '196@4', callingName: 'CHRIS A' }));
  api.emit('call', ev({ event: 'ringing', callId: 'rt-1:196@4', ringingDeviceId: '42' }));
  await sleep(20);
  eq('published to session storage', (session.data.callcardCalls.calls || []).map((c) => c.state), ['ringing']);

  errors.answerCall = true;
  let r = await send({ action: 'callcard:control', callId: 'rt-1:196@4', control: 'answer' });
  eq('answer on a basic SIP phone -> unsupported, remembered for the device', [r.ok, r.unsupported, !!local.data.callcardDeviceCaps['device:42'].answerCall, posted.map((p) => p.callRequest)],
    [false, true, true, ['answerCall']]);
  r = await send({ action: 'callcard:control', callId: 'rt-1:196@4', control: 'answer' });
  eq('second answer is refused locally (no request sent)', [r.unsupported, posted.length], [true, 1]);
  r = await onCmd('answer');
  eq('answer shortcut also respects the device memory', [r.unsupported, posted.length], [true, 1]);

  r = await send({ action: 'callcard:control', callId: 'rt-1:196@4', control: 'voicemail' });
  eq('voicemail -> deflectCall', [r.ok, posted[posted.length - 1].callRequest], [true, 'deflectCall']);
  api.emit('call', ev({ event: 'end', callId: 'rt-1:196@4' }));
  await sleep(30);
  eq('deflected call is not missed', (local.data.callcardMissed || []).length, 0);

  // connected call: hold/resume/park/hangup + transfer
  api.emit('call', ev({ event: 'offer', callId: 'rt-2:196@4', from: '3155694033', to: '196@4' }));
  api.emit('call', ev({ event: 'answer', callId: 'rt-2:196@4', answeringParty: '196@4', answeringDeviceId: '42' }));
  await sleep(10);
  posted.length = 0;
  await send({ action: 'callcard:control', callId: 'rt-2:196@4', control: 'hold' });
  eq('hold -> holdCall, optimistic held', [posted[0].callRequest, calls.getStore().calls['rt-2:196@4'].state], ['holdCall', 'held']);
  await send({ action: 'callcard:control', callId: 'rt-2:196@4', control: 'resume' });
  await send({ action: 'callcard:control', callId: 'rt-2:196@4', control: 'park', featureData: '3' });
  eq('resume -> resumeHeldCall; park -> parkCall featureData', posted.slice(1).map((p) => [p.callRequest, p.featureData || null]), [['resumeHeldCall', null], ['parkCall', '3']]);
  posted.length = 0;
  r = await send({ action: 'callcard:transfer', callId: 'rt-2:196@4', target: '197', mode: 'consult' });
  eq('transfer (consult): hold A, makeCall B, link', [r.ok, posted.map((p) => p.callRequest), calls.getStore().calls['rt-2:196@4'].consultCallId, calls.getStore().calls['consult-1:196@4'].consultFor],
    [true, ['holdCall'], 'consult-1:196@4', 'rt-2:196@4']);
  r = await send({ action: 'callcard:completeTransfer', callId: 'rt-2:196@4' });
  eq('complete transfer -> transfer on B with otherCallId A', [r.ok, posted[1]], [true, { callId: 'consult-1:196@4', callRequest: 'transfer', otherCallId: 'rt-2:196@4' }]);
  api.emit('call', ev({ event: 'end', callId: 'rt-2:196@4' }));

  // transfer now: never posts transfer until the target leg rings; on timeout falls back to consult
  calls.TIMING.autoCompleteMs = 600;
  api.emit('call', ev({ event: 'offer', callId: 'rt-4:196@4', from: '3155694033', to: '196@4' }));
  api.emit('call', ev({ event: 'answer', callId: 'rt-4:196@4', answeringParty: '196@4', answeringDeviceId: '42' }));
  await sleep(10);
  posted.length = 0;
  r = await send({ action: 'callcard:transfer', callId: 'rt-4:196@4', target: '197', mode: 'now' });
  await sleep(1100);
  const a4 = calls.getStore().calls['rt-4:196@4'];
  eq('transfer now without ringback: no transfer posted, falls back to consult', [r.ok, posted.map((p) => p.callRequest), a4.transferMode, a4.transferStalled], [true, ['holdCall'], 'consult', true]);
  await send({ action: 'callcard:cancelTransfer', callId: 'rt-4:196@4' });
  eq('cancel transfer hangs up the consult leg and resumes', posted.slice(1).map((p) => p.callRequest), ['hangupCall', 'resumeHeldCall']);
  posted.length = 0;
  r = await send({ action: 'callcard:transfer', callId: 'rt-4:196@4', target: '198', mode: 'now' });
  const b4 = calls.getStore().calls['rt-4:196@4'].consultCallId;
  api.emit('call', ev({ event: 'ringback', callId: b4 }));
  await sleep(400);
  eq('transfer now completes on ringback', posted.slice(-1)[0], { callId: b4, callRequest: 'transfer', otherCallId: 'rt-4:196@4' });
  api.emit('call', ev({ event: 'end', callId: 'rt-4:196@4' }));

  // missed + call back
  api.emit('call', ev({ event: 'offer', callId: 'rt-3:196@4', from: '3155694033', to: '196@4', callingName: 'CHRIS A' }));
  api.emit('call', ev({ event: 'end', callId: 'rt-3:196@4' }));
  await sleep(30);
  eq('missed list + unseen count', [(local.data.callcardMissed || []).map((m) => [m.number, m.name]), local.data.callcardMissedUnseen], [[['3155694033', 'CHRIS A']], 1]);
  r = await send({ action: 'callcard:callBack', id: local.data.callcardMissed[0].id });
  eq('call back dials and removes the entry', [r.success, r.result.destination, local.data.callcardMissed.length], [true, '3155694033', 0]);

  // context menu
  r = await listenersMenu({ menuItemId: 'callcard-call-selection', selectionText: ' (315) 555-0100 ' });
  eq('context menu dials the selected number', [r.success, r.result && r.result.destination], [true, '3155550100']);
  r = await listenersMenu({ menuItemId: 'callcard-call-selection', selectionText: 'not a number' });
  eq('context menu refuses non-numbers', r.success, false);
  listeners.installed.forEach((f) => f({ reason: 'install' }));
  eq('context menus created', (sandbox.menus || []).map((m) => m.id), ['callcard-call-selection', 'callcard-call-link']);
  eq('messages for other tracks are not answered', await send({ action: 'status:whatever' }), 'unhandled');

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);

  function onCmd(name) { return calls.onCommand(name); }
  function listenersMenu(info) { return calls.onMenuClick(info); }
})();
