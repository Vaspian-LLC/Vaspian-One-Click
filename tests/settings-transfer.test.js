// Unit tests for settings-transfer.js: export uses the allowlist, access keys
// in or out per the option, round trip into a clean profile, locked keys
// skipped, bad files refused, unknown keys warned about, no secret in the
// preview, the logs or diagnostics, and content scripts refused.
// Each "profile" is its own vm sandbox (lib/phone.js, lib/vaspian-api.js,
// screenpop.js, crm.js, settings-transfer.js) with a minimal chrome.* stub.
// Run: node tests/settings-transfer.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function makeStorage() {
  const data = {};
  return {
    data,
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

function profile() {
  const sync = makeStorage();
  const local = makeStorage();
  const listeners = [];
  const logs = [];
  const consoleLines = [];
  const quiet = { log: (...a) => consoleLines.push(a.join(' ')), warn: (...a) => consoleLines.push(a.join(' ')), error: (...a) => consoleLines.push(a.join(' ')), info() {}, debug() {} };
  const sandbox = {
    console: quiet, setTimeout, clearTimeout, setInterval, clearInterval, TextEncoder, URL, AbortController,
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'), unescape, encodeURIComponent,
    crypto: require('crypto').webcrypto,
    navigator: { userAgent: 'unit-test' },
    fetch: async () => { throw new Error('network disabled in unit test'); },
    WebSocket: class { constructor() { throw new Error('no sockets in unit test'); } },
    addLog: (level, message, details) => { logs.push({ level, message, details }); },
    chrome: {
      storage: { sync, local, session: makeStorage(), managed: makeStorage(), onChanged: { addListener() {} } },
      alarms: { create() {}, clear() {}, onAlarm: { addListener() {} } },
      runtime: {
        id: 'unitext', onMessage: { addListener(fn) { listeners.push(fn); } }, getPlatformInfo() {},
        getManifest: () => ({ name: 'Vaspian One Click', version: '2.0.0' })
      },
      tabs: { async create() { return { id: 1 }; }, async get() { throw new Error('none'); }, async update() {} },
      windows: { async update() {} }
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  for (const f of ['lib/phone.js', 'lib/vaspian-api.js', 'screenpop.js', 'crm.js', 'settings-transfer.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
  }
  const send = (msg, sender = { id: 'unitext', url: 'chrome-extension://unitext/popup.html' }) => new Promise((resolve) => {
    for (const fn of listeners) {
      let answered = false;
      const r = fn(msg, sender, (res) => { answered = true; resolve(res); });
      if (r === true || answered) return;
    }
    resolve(undefined);
  });
  return { sandbox, sync, local, logs, consoleLines, send, crm: sandbox.OneClick.crm, xfer: sandbox.OneClick.settingsTransfer };
}

let failed = 0;
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
  if (!ok) failed++;
};
const truthy = (label, v, extra) => eq(label + (v ? '' : ` ${JSON.stringify(extra === undefined ? v : extra)}`), !!v, true);

const KEY = 'zk_live_5f3a9c2e7b1d4e8f';
const ADMIN = {
  // company-wide
  screenPopEnabled: true, screenPopCrm: 'zoho', screenPopTrigger: 'offer', screenPopInternal: false,
  crmZohoKey: KEY, crmZohoCrmOrg: '316075032', crmWrapUpEnabled: true, crmDispositions: ['Sale', 'No sale', 'Callback'],
  dialPrefix: '9', clickToCallEnabled: true, clickToCallDisabledSites: ['crm.example.com', 'desk.zoho.com'],
  // personal / device / login: must never leave
  tenant: 'acme', extension: '196', password: '4321', isLoggedIn: true, useSidebar: true, debugLogging: true,
  crmZohoBaseUrl: 'https://zoho-screenpop.vaspian.me/'
};
const PERSONAL = ['tenant', 'extension', 'password', 'isLoggedIn', 'useSidebar', 'debugLogging', 'crmZohoBaseUrl'];
const LOCAL = { password: '4321', callHistory: [{ phoneNumber: '3155550100', timestamp: 'x' }], logs: [{ message: 'hi' }], apiGuard: { fp: 'abc' }, callcardDeviceCaps: { 'device:1': ['holdCall'] }, ringPhone: { phoneId: 'p1' } };

(async () => {
  // ------------------------------------------------------------ export ---
  const a = profile();
  await a.sync.set(ADMIN);
  await a.local.set(LOCAL);

  let r = await a.send({ action: 'settings:export', includeSecrets: true });
  truthy('export ok', r && r.ok, r);
  let file = JSON.parse(r.text);
  eq('file type and version', [file.type, file.version, file.exportedFrom, file.includesSecrets], ['vaspian-one-click-settings', 1, '2.0.0', true]);
  eq('file names the company it came from (not applied)', file.tenant, 'acme');
  truthy('exportedAt is an ISO date', /^\d{4}-\d\d-\d\dT/.test(file.exportedAt));
  truthy('file name is vaspian-one-click-settings-<tenant>-<YYYY-MM-DD>.json', /^vaspian-one-click-settings-acme-\d{4}-\d\d-\d\d\.json$/.test(r.filename), r.filename);
  const keys = Object.keys(file.settings);
  truthy('only allowlisted keys are exported', keys.every((k) => k in a.xfer.ALLOWLIST), keys);
  truthy('no personal, device or login key is exported', PERSONAL.every((k) => !(k in file.settings)), keys);
  truthy('nothing local (PIN, history, logs, caps, guard, phone) is in the file', !/4321|callHistory|apiGuard|callcardDeviceCaps|ringPhone|phoneId|"hi"/.test(r.text));
  eq('the access key is in the file when included', file.settings.crmZohoKey, KEY);
  truthy('every allowlist entry says why', Object.values(a.xfer.ALLOWLIST).every((d) => d.why && d.label));

  r = await a.send({ action: 'settings:export', includeSecrets: false });
  file = JSON.parse(r.text);
  eq('without access keys: includesSecrets false', file.includesSecrets, false);
  truthy('without access keys: no key anywhere in the file', !r.text.includes(KEY) && !('crmZohoKey' in file.settings));

  // A custom URL carrying a key is a secret too.
  const c = profile();
  await c.sync.set({ screenPopEnabled: true, screenPopCrm: 'custom', screenPopUrl: 'https://crm.example.com/pop?phone={phone10}&token=s3cr3tT0ken' });
  r = await c.send({ action: 'settings:export', includeSecrets: false });
  file = JSON.parse(r.text);
  truthy('without access keys: a custom URL with a token is left out, with a warning', !r.text.includes('s3cr3tT0ken') && r.warnings.length === 1, r);
  r = await c.send({ action: 'settings:export', includeSecrets: true });
  eq('with access keys: the custom URL goes and includesSecrets is true', JSON.parse(r.text).includesSecrets, true);
  truthy('export never logs a secret value', !a.logs.concat(c.logs).some((l) => JSON.stringify(l).includes(KEY) || JSON.stringify(l).includes('s3cr3tT0ken')));

  // --------------------------------------------------------- round trip ---
  const exported = (await a.send({ action: 'settings:export', includeSecrets: true })).text;
  const b = profile();
  await b.sync.set({ tenant: 'acme', extension: '205', isLoggedIn: true });
  await b.local.set({ password: '9876' });
  const preview = await b.send({ action: 'settings:importPreview', text: exported });
  truthy('preview ok', preview && preview.ok, preview);
  eq('preview writes nothing', Object.keys(b.sync.data).sort(), ['extension', 'isLoggedIn', 'tenant']);
  const zoho = preview.summary.find((x) => x.key === 'crmZohoKey');
  eq('preview masks the access key', [zoho && zoho.from, zoho && zoho.to, zoho && zoho.secret], ['Not set', '••••••', true]);
  truthy('the access key never appears in the preview', !JSON.stringify(preview).includes(KEY));
  truthy('preview shows readable values', preview.summary.some((x) => x.key === 'dialPrefix' && x.from === '8' && x.to === '9')
    && preview.summary.some((x) => x.key === 'screenPopCrm' && x.to === 'Zoho Desk'), preview.summary);
  eq('same company: no warning', preview.warnings, []);

  const done = await b.send({ action: 'settings:import', text: exported });
  truthy('import ok', done && done.ok, done);
  eq('applied = the changed keys', done.applied.sort(), preview.summary.map((x) => x.key).sort());
  const ea = await a.crm.effectiveSettings();
  const eb = await b.crm.effectiveSettings();
  for (const k of ['tenant']) { delete ea[k]; delete eb[k]; }
  eq('round trip: equal effective settings', eb, ea);
  eq('round trip: click to call sites equal', b.sync.data.clickToCallDisabledSites, ADMIN.clickToCallDisabledSites);
  eq('the login is untouched', [b.sync.data.tenant, b.sync.data.extension, b.sync.data.isLoggedIn, b.local.data.password], ['acme', '205', true, '9876']);
  truthy('import logs key names but no values', b.logs.some((l) => /imported \d+ settings/.test(l.message)) && !JSON.stringify(b.logs).includes(KEY), b.logs);
  truthy('nothing printed a secret to the console', !a.consoleLines.concat(b.consoleLines).some((l) => l.includes(KEY)));

  const again = await b.send({ action: 'settings:importPreview', text: exported });
  eq('importing the same file again changes nothing', again.summary, []);

  // Diagnostics redaction keeps working for an imported key.
  const diag = await b.crm.diagnostics();
  truthy('diagnostics hides the imported access key', !JSON.stringify(diag).includes(KEY));

  // ------------------------------------------------------ locked keys ---
  const d = profile();
  await d.sync.set({ tenant: 'acme', dialPrefix: '8' });
  await d.crm._setManagedForTest({ crmPreset: 'securecrm', dialPrefix: '8', wrapUpEnabled: false, locked: { crm: true, dialPrefix: true } });
  const lp = await d.send({ action: 'settings:importPreview', text: exported });
  const skippedKeys = lp.skipped.filter((s) => s.reason === 'locked').map((s) => s.key).sort();
  // crm.js locks a key when its group is locked and policy sets a value for it.
  eq('locked keys are skipped with reason locked', skippedKeys, ['dialPrefix', 'screenPopCrm']);
  truthy('locked keys are not in the summary', !lp.summary.some((x) => skippedKeys.includes(x.key)));
  truthy('skipped entries carry a label', lp.skipped.every((s) => s.label));
  const li = await d.send({ action: 'settings:import', text: exported });
  eq('import skips them too', li.skipped.filter((s) => s.reason === 'locked').map((s) => s.key).sort(), skippedKeys);
  const ed = await d.crm.effectiveSettings();
  eq('locked values still win after import', [ed.screenPopCrm, ed.dialPrefix, d.sync.data.dialPrefix, d.sync.data.screenPopCrm], ['securecrm', '8', '8', undefined]);
  eq('unlocked values were applied', [ed.screenPopTrigger, ed.crmWrapUpEnabled], ['offer', true]);

  // An unlocked IT default counts as the current value (no phantom change).
  const m = profile();
  await m.crm._setManagedForTest({ dialPrefix: '9', wrapUpEnabled: true });
  const mp = await m.send({ action: 'settings:importPreview', text: exported });
  truthy('an unlocked IT default that matches the file is not listed as a change', !mp.summary.some((x) => x.key === 'dialPrefix' || x.key === 'crmWrapUpEnabled'), mp.summary);

  // ---------------------------------------------------------- bad files ---
  const e = profile();
  const err = async (text) => (await e.send({ action: 'settings:importPreview', text }));
  const env = (o) => JSON.stringify({ type: 'vaspian-one-click-settings', version: 1, includesSecrets: false, settings: {}, ...o });
  for (const [label, text, re] of [
    ['empty text', '', /empty/],
    ['not JSON', '{nope', /isn.t a One Click settings file/],
    ['wrong type', env({ type: 'something-else' }), /isn.t a One Click settings file/],
    ['diagnostics file', JSON.stringify({ kind: 'vaspian-one-click-diagnostics' }), /isn.t a One Click settings file/],
    ['version 0', env({ version: 0 }), /isn.t a One Click settings file/],
    ['version as text', env({ version: '1' }), /isn.t a One Click settings file/],
    ['newer version', env({ version: 2 }), /newer version.*Update One Click/],
    ['settings not an object', env({ settings: [1, 2] }), /isn.t a One Click settings file/],
    ['over 256 KB', env({ settings: { crmDispositions: ['x'.repeat(270 * 1024)] } }), /too big/]
  ]) {
    const x = await err(text);
    truthy(`refused: ${label}`, x && x.ok === false && re.test(x.error), x);
    const y = await e.send({ action: 'settings:import', text });
    truthy(`import refused too: ${label}`, y && y.ok === false);
  }
  eq('bad files wrote nothing', Object.keys(e.sync.data), []);

  // --------------------------------------------- unknown and bad values ---
  const f = profile();
  const odd = env({
    settings: {
      futureThing: 1, anotherOne: 'x', tenant: 'evil', extension: '999', password: '1111',
      dialPrefix: '7', screenPopCrm: 'notacrm', screenPopEnabled: 'yes', clickToCallDisabledSites: ['ok.example.com', '<script>'],
      crmDispositions: ['  A  ', 'B', 'A'], crmZohoKey: 'leaked-key-xyz', clickToCallEnabled: false
    }
  });
  const fp = await f.send({ action: 'settings:importPreview', text: odd });
  truthy('unknown keys give one warning with the count', fp.warnings.some((w) => /^2 settings in this file aren.t supported/.test(w)), fp.warnings);
  truthy('sign-in details are ignored with a warning', fp.warnings.some((w) => /Sign-in details/.test(w)), fp.warnings);
  truthy('a key in a file that says it has none is ignored with a warning', fp.warnings.some((w) => /no access keys/.test(w)) && !JSON.stringify(fp).includes('leaked-key-xyz'), fp);
  eq('invalid values are skipped with reason invalid', fp.skipped.map((s) => [s.key, s.reason]).sort(),
    [['clickToCallDisabledSites', 'invalid'], ['dialPrefix', 'invalid'], ['screenPopCrm', 'invalid'], ['screenPopEnabled', 'invalid']]);
  eq('valid values are cleaned by crm.js (dispositions trimmed, deduped)', fp.summary.map((x) => [x.key, x.to]), [['crmDispositions', 'A, B'], ['clickToCallEnabled', 'Off']]);
  await f.send({ action: 'settings:import', text: odd });
  eq('import wrote only the valid allowlisted keys', Object.keys(f.sync.data).sort(), ['clickToCallEnabled', 'crmDispositions']);
  truthy('unknown key values are never echoed', !JSON.stringify(fp).includes('evil') && !JSON.stringify(fp).includes('1111'));

  // ------------------------------------------------------ other company ---
  const g = profile();
  await g.sync.set({ tenant: 'globex' });
  const gp = await g.send({ action: 'settings:importPreview', text: exported });
  truthy('different company: a clear warning first', /different company \(acme\).*globex/.test(gp.warnings[0] || ''), gp.warnings);
  eq('different company: tenantMismatch flag (the UI keys on it, not on the wording)', [gp.tenantMismatch, preview.tenantMismatch], [true, false]);
  g.sandbox.OneClick.api.getSession = () => ({ tenantId: '4' });
  const sameId = JSON.stringify({ ...JSON.parse(exported), tenant: '7169612115', tenantId: '4' });
  eq('same tenant id, other name (main number vs web name): no warning', (await g.send({ action: 'settings:importPreview', text: sameId })).warnings.filter((w) => /different company/.test(w)), []);
  const otherId = JSON.stringify({ ...JSON.parse(exported), tenant: 'globex', tenantId: '9' });
  truthy('same name, other tenant id: warning', (await g.send({ action: 'settings:importPreview', text: otherId })).warnings.some((w) => /different company/.test(w)));
  eq('preview returns fileTenant (the file\'s company, for the sign-in prefill)', [preview.fileTenant, gp.fileTenant], ['acme', 'acme']);
  eq('fileTenant is trimmed, and null when the file has none or it is not text', [
    (await g.send({ action: 'settings:importPreview', text: JSON.stringify({ ...JSON.parse(exported), tenant: '  7169612115 ' }) })).fileTenant,
    (await g.send({ action: 'settings:importPreview', text: env({}) })).fileTenant,
    (await g.send({ action: 'settings:importPreview', text: env({ tenant: 42 }) })).fileTenant
  ], ['7169612115', null, null]);
  truthy('fileTenant is never applied as a setting', g.sync.data.tenant === 'globex' && (await g.send({ action: 'settings:import', text: otherId })).applied.every((k) => k !== 'tenant') && g.sync.data.tenant === 'globex');
  const h = profile();
  eq('signed out (onboarding): no tenant warning', (await h.send({ action: 'settings:importPreview', text: exported })).warnings, []);

  const z = profile();
  const noKeyFile = (await a.send({ action: 'settings:export', includeSecrets: false })).text;
  truthy('Zoho Desk without a key: tells the importer to ask the admin', (await z.send({ action: 'settings:importPreview', text: noKeyFile })).warnings.some((w) => /no Zoho Desk access key/.test(w)));

  // --------------------------------------------------- content scripts ---
  for (const action of ['settings:export', 'settings:importPreview', 'settings:import']) {
    const res = await b.send({ action, text: exported, includeSecrets: true }, { id: 'unitext', url: 'https://evil.example.com/page', tab: { id: 3 } });
    eq(`content script refused: ${action}`, res, { ok: false, error: 'not allowed' });
    const other = await b.send({ action, text: exported }, { id: 'otherext', url: 'chrome-extension://otherext/x.html' });
    eq(`another extension refused: ${action}`, other, { ok: false, error: 'not allowed' });
  }
  eq('other actions are not answered (onboarding relies on this)', await b.send({ action: 'settings:nope' }), undefined);

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
