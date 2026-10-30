// Unit tests for crm.js (Track C): preset URL building, history built from
// replayed captured events (inbound / ring group / outbound / missed /
// answered elsewhere / click merge), managed settings applied and locked,
// wrap-up storage, and a diagnostics export with no secrets in it.
// Events: tests/fixtures/crm-events.jsonl = fleet/captured-events.jsonl (live, ext 188)
// with the caller number and name replaced. Loads lib/vaspian-api.js, screenpop.js and crm.js in one vm sandbox with a
// minimal chrome.* stub (no network).
// Run: node tests/crm.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeStorage() {
  const data = {};
  const listeners = [];
  return {
    data,
    listeners,
    async get(keys) {
      if (keys === null || keys === undefined) return JSON.parse(JSON.stringify(data));
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k]));
      return out;
    },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}
const sync = makeStorage();
const local = makeStorage();
const session = makeStorage();
const managed = makeStorage();
const messageListeners = [];
const logs = [];
const opened = [];
const sandbox = {
  console, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URL, AbortController,
  btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent,
  crypto: require('crypto').webcrypto,
  navigator: { userAgent: 'unit-test' },
  fetch: async () => { throw new Error('network disabled in unit test'); },
  WebSocket: class { constructor() { throw new Error('no sockets in unit test'); } },
  addLog: (level, message) => { logs.push({ timestamp: new Date().toISOString(), level, message }); },
  chrome: {
    storage: { sync, local, session, managed, onChanged: { addListener() {} } },
    alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
    runtime: {
      id: 'unitext', onMessage: { addListener(fn) { messageListeners.push(fn); } }, getPlatformInfo() {},
      getManifest: () => ({ name: 'Vaspian One Click', version: '2.0.0' })
    },
    tabs: { async create(o) { opened.push(o.url); return { id: 1, windowId: 1 }; }, async get() { throw new Error('none'); }, async update() {} },
    windows: { async update() {} }
  }
};
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ['lib/vaspian-api.js', 'screenpop.js', 'crm.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
const api = sandbox.OneClick.api;
const crm = sandbox.OneClick.crm;

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const truthy = (label, v, extra) => eq(label + (v ? '' : ` ${JSON.stringify(extra === undefined ? v : extra)}`), !!v, true);

/** Send a message the way a popup would (sender = extension page). */
function message(msg) {
  return new Promise((resolve) => {
    for (const fn of messageListeners) {
      const r = fn(msg, { id: 'unitext', url: 'chrome-extension://unitext/popup.html' }, resolve);
      if (r === true) return;
    }
    resolve(undefined);
  });
}

/**
 * Normalize a captured frame like lib/vaspian-api.js does (ARCHITECTURE.md §4)
 * for ext `self`: parties, direction from the first event, duplicate offers.
 */
function normalizer(selfExt) {
  const memo = new Map();
  const party = (raw) => api.normalizeParty(raw, { selfExt, tenantId: '4' });
  return (raw) => {
    let m = memo.get(raw.callId);
    const isNew = !m;
    const from = party(raw.from);
    if (!m) {
      let direction = 'unknown';
      if (raw.event === 'offer' || raw.event === 'ringing') direction = 'inbound';
      else if (raw.event === 'dial' || raw.event === 'ringback') direction = 'outbound';
      else if (from) direction = from.isSelf ? 'outbound' : 'inbound';
      m = { direction, offers: 0 };
      memo.set(raw.callId, m);
    }
    if (raw.event === 'offer') m.offers++;
    const ev = {
      kind: 'call', type: raw.event, callId: raw.callId, smdrCallId: raw.smdrCallId || null, from, to: party(raw.to),
      answeringParty: party(raw.answeringParty), callingName: raw.callingName || '', dialedDigits: raw.dialedDigits || '',
      direction: m.direction, isNew, isDuplicate: raw.event === 'offer' && m.offers > 1, endReason: raw.endReason || null,
      callDurationMs: api.durationMs(raw.callDuration), timestamp: raw.timestamp, raw
    };
    if (raw.event === 'end') memo.delete(raw.callId);
    return ev;
  };
}

const captured = fs.readFileSync(path.join(__dirname, 'fixtures', 'crm-events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SMDR = { outbound: '1007-0-1793318237661-12303338', inbound: '1007-0-1793318850213-12303728', ringgroup: '1007-0-1793319101615-12303894' };
async function replay(name, norm = normalizer('188')) {
  for (const raw of captured.filter((e) => e.smdrCallId === SMDR[name])) await crm.trackCall(norm(raw));
}
const history = async () => (await local.get(['callHistory'])).callHistory || [];
const pick = (r) => ({ phoneNumber: r.phoneNumber, direction: r.direction, status: r.status, durationSec: r.durationSec, name: r.name, smdrCallId: r.smdrCallId });

(async () => {
  // ---------------------------------------------------------------- presets
  const call = { from: '13155550142', name: 'PAT CALLER' };
  const url = (s) => { const t = crm.templateFor(s); return t ? crm.buildUrl(t, call) : null; };
  eq('preset simplicity', url({ screenPopCrm: 'simplicity' }), 'https://app.simplicitycollect.com/dialer/update.aspx?dialer=true&phone=3155550142');
  eq('preset zoho default base, no key', url({ screenPopCrm: 'zoho' }), 'https://zoho-screenpop.vaspian.me/?phone=%2B13155550142');
  eq('preset zoho with key (encoded)', url({ screenPopCrm: 'zoho', crmZohoKey: 'ab c&d' }), 'https://zoho-screenpop.vaspian.me/?phone=%2B13155550142&key=ab%20c%26d');
  eq('preset zoho custom base with query', url({ screenPopCrm: 'zoho', crmZohoBaseUrl: 'https://pop.example.com/z?org=1', crmZohoKey: 'k1' }), 'https://pop.example.com/z?org=1&phone=%2B13155550142&key=k1');
  eq('preset zoho bad base -> null', url({ screenPopCrm: 'zoho', crmZohoBaseUrl: 'javascript:alert(1)' }), null);
  eq('preset securecrm default', url({ screenPopCrm: 'securecrm' }), 'https://www.securecrm.io/dialer2.php?phone=3155550142');
  eq('preset securecrm custom base', url({ screenPopCrm: 'securecrm', crmSecureCrmBaseUrl: 'https://crm.example.com/dialer2.php' }), 'https://crm.example.com/dialer2.php?phone=3155550142');
  eq('preset custom tokens', url({ screenPopCrm: 'custom', screenPopUrl: 'https://crm.example.com/s?p={phone10}&e={e164}&raw={phone}&n={name}' }),
    'https://crm.example.com/s?p=3155550142&e=%2B13155550142&raw=13155550142&n=PAT%20CALLER');
  eq('preset custom javascript: refused', url({ screenPopCrm: 'custom', screenPopUrl: 'javascript:alert({phone10})' }), null);
  eq('preset custom empty refused', url({ screenPopCrm: 'custom', screenPopUrl: '' }), null);
  eq('preset custom token in host ok', !!crm.templateFor({ screenPopCrm: 'custom', screenPopUrl: 'https://{name}.example.com/?p={phone10}' }), true);
  eq('name with & is encoded', crm.buildUrl('https://x.test/?n={name}', { from: '3155550142', name: 'A&B=C' }), 'https://x.test/?n=A%26B%3DC');
  eq('internal caller: no phone10', crm.buildUrl('https://x.test/?p={phone10}', { from: '197' }), 'https://x.test/?p=');
  eq('redactUrl hides key', crm.redactUrl('https://z.test/?phone=%2B1&key=SECRET1&x=1'), 'https://z.test/?phone=%2B1&key=[hidden]&x=1');
  const pv = crm.preview({ screenPopCrm: 'zoho', crmZohoKey: 'SECRET2' }, '3155550100');
  eq('preview masks the key', pv, { ok: true, url: 'https://zoho-screenpop.vaspian.me/?phone=%2B13155550100&key=[hidden]', preset: 'zoho' });
  eq('preview custom without URL explains', crm.preview({ screenPopCrm: 'custom', screenPopUrl: '' }, '').error, 'Enter the URL to open');
  eq('preview needs a 10-digit number', crm.preview({ screenPopCrm: 'simplicity' }, '197').ok, false);

  // screen pop end to end through screenpop.js (Zoho preset, key never logged)
  await sync.set({ screenPopEnabled: true, screenPopCrm: 'zoho', crmZohoKey: 'POPKEY9', screenPopTrigger: 'answer' });
  const r = await message({ action: 'screenPopTest', phoneNumber: '3155550142' });
  eq('screenPopTest opens the Zoho URL', [r && r.success, opened[0]], [true, 'https://zoho-screenpop.vaspian.me/?phone=%2B13155550142&key=POPKEY9']);
  eq('key not in logs or screenPopLast', JSON.stringify(logs).includes('POPKEY9') || JSON.stringify(local.data.screenPopLast).includes('POPKEY9'), false);
  await sync.remove(['screenPopEnabled', 'screenPopCrm', 'crmZohoKey', 'screenPopTrigger']);

  // ---------------------------------------------------------------- history
  await local.set({ callHistory: [] });
  await replay('inbound');
  let h = await history();
  eq('inbound answered -> one record', h.map(pick), [{ phoneNumber: '3155550142', direction: 'inbound', status: 'answered', durationSec: 6, name: 'PAT CALLER', smdrCallId: SMDR.inbound }]);
  eq('inbound record keeps v1 fields', [typeof h[0].timestamp, h[0].note], ['string', '']);

  await replay('ringgroup');
  h = await history();
  eq('ring group (offer twice) -> one more record', h.length, 2);
  eq('ring group answered', pick(h[0]), { phoneNumber: '3155550142', direction: 'inbound', status: 'answered', durationSec: 6, name: 'PAT CALLER', smdrCallId: SMDR.ringgroup });

  await replay('outbound');
  h = await history();
  eq('outbound answered (11-digit -> 10)', pick(h[0]), { phoneNumber: '3155550142', direction: 'outbound', status: 'answered', durationSec: 6, name: '', smdrCallId: SMDR.outbound });

  await replay('outbound');
  eq('replaying the same smdrCallId is not duplicated', (await history()).length, 3);

  // Missed: offer, ringing, end, never answered.
  const norm = normalizer('196');
  const ts = new Date().toISOString();
  const missed = [
    { event: 'offer', callId: 'm1:196@4', smdrCallId: 'smdr-missed', from: '7165550111', to: '196@4', callingName: 'ACME CO', timestamp: ts },
    { event: 'ringing', callId: 'm1:196@4', smdrCallId: 'smdr-missed', timestamp: ts },
    { event: 'end', callId: 'm1:196@4', smdrCallId: 'smdr-missed', from: '7165550111', to: '196@4', callDuration: 'PT12S', endReason: 'Normal Clearing', timestamp: ts }
  ];
  for (const raw of missed) await crm.trackCall(norm(raw));
  h = await history();
  eq('missed inbound', pick(h[0]), { phoneNumber: '7165550111', direction: 'inbound', status: 'missed', durationSec: 0, name: 'ACME CO', smdrCallId: 'smdr-missed' });

  // Ring group answered by a coworker: not a missed call.
  for (const raw of [
    { event: 'offer', callId: 'e1:196@4', smdrCallId: 'smdr-else', from: '7165550122', to: '196@4', timestamp: ts },
    { event: 'answer', callId: 'e1:196@4', smdrCallId: 'smdr-else', answeringParty: '197@4', timestamp: ts },
    { event: 'end', callId: 'e1:196@4', smdrCallId: 'smdr-else', from: '7165550122', to: '196@4', callDuration: 'PT30S', timestamp: ts }
  ]) await crm.trackCall(norm(raw));
  h = await history();
  eq('answered by a coworker', [h[0].status, h[0].answeredBy, h[0].durationSec], ['answered_elsewhere', '197', 0]);

  // Outbound not answered.
  for (const raw of [
    { event: 'dial', callId: 'o2:196@4', smdrCallId: 'smdr-noans', from: '196@4', to: '197', dialedDigits: '197', timestamp: ts },
    { event: 'ringback', callId: 'o2:196@4', smdrCallId: 'smdr-noans', timestamp: ts },
    { event: 'end', callId: 'o2:196@4', smdrCallId: 'smdr-noans', from: '196@4', to: '197', callDuration: 'PT9S', timestamp: ts }
  ]) await crm.trackCall(norm(raw));
  h = await history();
  eq('outbound to ext 197, no answer', pick(h[0]), { phoneNumber: '197', direction: 'outbound', status: 'no_answer', durationSec: 0, name: '', smdrCallId: 'smdr-noans' });

  // Click-to-dial record (background.js addToCallHistory) merges with the call's events.
  const clickTs = new Date(Date.now() - 1000).toISOString();
  await local.set({ callHistory: [{ phoneNumber: '3155550100', timestamp: clickTs, note: 'from the dialer' }, ...(await history())] });
  for (const raw of [
    { event: 'dial', callId: 'c3:196@4', smdrCallId: 'smdr-click', from: '196@4', to: '83155550100', dialedDigits: '83155550100', timestamp: ts },
    { event: 'answer', callId: 'c3:196@4', smdrCallId: 'smdr-click', answeringParty: '83155550100', timestamp: ts },
    { event: 'end', callId: 'c3:196@4', smdrCallId: 'smdr-click', callDuration: 'PT1M5S', timestamp: ts }
  ]) await crm.trackCall(norm(raw));
  h = await history();
  const merged = h.filter((x) => x.smdrCallId === 'smdr-click' || x.timestamp === clickTs);
  eq('click + events -> one record, click timestamp and note kept', merged.map((x) => [x.timestamp === clickTs, x.note, x.direction, x.status, x.durationSec, x.source]),
    [[true, 'from the dialer', 'outbound', 'answered', 65, 'click+event']]);

  // An event that starts with 'end' (worker restarted mid-call) is still recorded, neutrally.
  for (const raw of [{ event: 'end', callId: 'z9:196@4', smdrCallId: 'smdr-orphan', from: '7165550199', to: '196@4', callDuration: 'PT3S', timestamp: ts }]) await crm.trackCall(norm(raw));
  eq('orphan end -> status ended (not missed)', (await history())[0].status, 'ended');

  // ---------------------------------------------------------------- wrap-up
  const q = (await local.get(['crmWrapUp'])).crmWrapUp || [];
  eq('answered calls queue a wrap-up, missed/no-answer do not', q.map((x) => x.key), ['smdr-click', SMDR.outbound, SMDR.ringgroup, SMDR.inbound]);
  const saved = await message({ action: 'crm:wrapUpSave', key: SMDR.inbound, disposition: 'Resolved', note: 'Paid in full' });
  const notes = (await local.get(['crmCallNotes'])).crmCallNotes;
  const rec = (await history()).find((x) => x.smdrCallId === SMDR.inbound);
  eq('wrap-up saved by smdrCallId and mirrored onto history', [saved.ok, notes[SMDR.inbound].disposition, notes[SMDR.inbound].note, rec.disposition, rec.note],
    [true, 'Resolved', 'Paid in full', 'Resolved', 'Paid in full']);
  eq('wrap-up leaves the queue', ((await local.get(['crmWrapUp'])).crmWrapUp || []).some((x) => x.key === SMDR.inbound), false);
  await sync.set({ crmWrapUpEnabled: false });
  for (const raw of captured.filter((e) => e.smdrCallId === SMDR.inbound)) {
    const copy = JSON.parse(JSON.stringify(raw).replaceAll(SMDR.inbound, 'smdr-nowrap'));
    await crm.trackCall(normalizer('188')(copy));
  }
  eq('wrap-up off: nothing queued', ((await local.get(['crmWrapUp'])).crmWrapUp || []).some((x) => x.key === 'smdr-nowrap'), false);
  await sync.remove(['crmWrapUpEnabled']);

  // ---------------------------------------------------------------- managed
  await sync.set({ screenPopCrm: 'custom', screenPopUrl: 'https://crm.example.com/?p={phone10}', screenPopTrigger: 'offer', crmDispositions: ['Mine'] });
  await crm._setManagedForTest({
    tenant: 'acme', dialPrefix: '9', crmPreset: 'zoho', zohoKey: 'MANAGEDKEY7', screenPopEnabled: true, screenPopTrigger: 'answer',
    dispositions: ['Sale', 'No sale'], wrapUpEnabled: true, bogus: 1, locked: { crm: true, dialPrefix: true, tenant: true }
  });
  let eff = await crm.effectiveSettings();
  eq('locked managed CRM wins over the user', [eff.screenPopCrm, eff.crmZohoKey, eff.dialPrefix, eff.tenant], ['zoho', 'MANAGEDKEY7', '9', 'acme']);
  eq('unlocked managed values are defaults: user value kept', [eff.screenPopTrigger, eff.crmDispositions], ['offer', ['Mine']]);
  eq('unlocked managed default used when the user has none', eff.screenPopEnabled, true);
  const ui = await message({ action: 'crm:getSettings' });
  eq('UI sees locks, never the managed key', [ui.locked.includes('screenPopCrm'), ui.locked.includes('crmZohoKey'), ui.values.crmZohoKey, ui.zohoKeyManaged, ui.locked.includes('screenPopTrigger')],
    [true, true, '', true, false]);
  const sv = await message({ action: 'crm:saveSettings', values: { screenPopCrm: 'custom', screenPopTrigger: 'answer', dialPrefix: '8' } });
  eff = await crm.effectiveSettings();
  eq('saving a locked field is refused, unlocked one saved', [sv.refused.sort(), eff.screenPopCrm, eff.screenPopTrigger, sync.data.dialPrefix], [['dialPrefix', 'screenPopCrm'], 'zoho', 'answer', undefined]);
  const prev = await message({ action: 'crm:preview', values: { screenPopCrm: 'custom' }, phone: '3155550100' });
  eq('preview ignores overrides of locked fields and masks the managed key', prev.url, 'https://zoho-screenpop.vaspian.me/?phone=%2B13155550100&key=[hidden]');
  eq('crmPolicy published without the key', [local.data.crmPolicy.active, JSON.stringify(local.data.crmPolicy).includes('MANAGEDKEY7')], [true, false]);
  await crm._setManagedForTest({ crmPreset: 'nonsense', dialPrefix: '7', dispositions: 'x', screenPopEnabled: 'yes' });
  eq('invalid managed values are ignored', (await crm.policy()).managedKeys, []);
  await crm._setManagedForTest(null);
  managed.data.crmPreset = 'securecrm';
  eq('real chrome.storage.managed is read', (await crm.policy()).values.screenPopCrm, 'securecrm');
  delete managed.data.crmPreset;
  eq('bad base URL is refused on save', (await crm.saveUserSettings({ crmZohoBaseUrl: 'ftp://x' })).refused, ['crmZohoBaseUrl']);

  // ------------------------------------------------------------ diagnostics
  const PIN = 'Unit-PIN-4821';
  await local.set({ password: PIN });
  await sync.set({ tenant: 'vaspian', extension: '196', crmZohoKey: 'USERKEY55' });
  const b64 = Buffer.from(`196@vaspian.URI:${PIN}`).toString('base64');
  logs.push({ timestamp: ts, level: 'info', message: `WebSocket wss://196%40vaspian.URI:${encodeURIComponent(PIN)}@xtone.buf.vaspian.net/api/ws failed` });
  logs.push({ timestamp: ts, level: 'info', message: `Authorization: Basic ${b64}`, details: { pin: PIN, url: 'https://zoho-screenpop.vaspian.me/?phone=%2B1&key=USERKEY55' } });
  await local.set({ logs, apiGuard: { fp: 'deadbeefcafef00d', stopped: null, wsRejections: 0 } });
  await crm._setManagedForTest({ zohoKey: 'MANAGEDKEY7', locked: { crm: true } });
  const d = await message({ action: 'crm:diagnostics' });
  if (!d || !d.ok) console.log('diagnostics returned', d);
  const text = JSON.stringify(d.report);
  for (const [label, secret] of [['PIN', PIN], ['URL-encoded PIN', encodeURIComponent(PIN)], ['Basic token', b64], ['Basic token (no padding)', b64.replace(/=+$/, '')],
    ['user Zoho key', 'USERKEY55'], ['managed Zoho key', 'MANAGEDKEY7'], ['guard fingerprint', 'deadbeefcafef00d']]) {
    eq(`diagnostics has no ${label}`, text.includes(secret), false);
  }
  eq('diagnostics has no credentialed URL', /wss?:\/\/[^/\s"]+:[^/\s"]+@/.test(text), false);
  eq('diagnostics has no password key', /"password"/.test(text), false);
  truthy('diagnostics has version, settings, status, logs, events', d.ok && d.report.extension.version === '2.0.0' && d.report.settings.stored.tenant === 'vaspian'
    && d.report.recentLogs.length > 0 && d.report.recentEvents.length > 0 && 'status' in d.report.connection && d.report.managedPolicy.active, d.report && Object.keys(d.report));

  // ---------------------------------------------------------- cleared history
  eq('content scripts cannot call crm:*', await new Promise((resolve) => {
    for (const fn of messageListeners) if (fn({ action: 'crm:diagnostics' }, { id: 'unitext', url: 'https://evil.example/', tab: { id: 3 } }, resolve) !== undefined) return;
    resolve('no handler');
  }).then((x) => x && x.ok), false);

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
