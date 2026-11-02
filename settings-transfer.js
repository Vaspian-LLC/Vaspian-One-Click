// Settings transfer (service worker): export the company-wide setup to a
// JSON file, and import such a file on another person's One Click.
//
// File format (fleet/briefs/CONTRACT-settings-file.md):
//   { type: 'vaspian-one-click-settings', version: 1, exportedAt, exportedFrom,
//     includesSecrets, tenant?, tenantId?, settings: { <allowlisted keys> } }
// `tenant` / `tenantId` describe where the file came from (for the
// different-company warning) and are never applied.
//
// Messages (extension pages only, content scripts are refused):
//   settings:export        {includeSecrets} -> {ok, text, filename, count, includesSecrets}
//   settings:importPreview {text} -> {ok, summary:[{key,label,from,to,secret}], skipped:[{key,label,reason}], warnings, tenantMismatch}
//   settings:import        {text} -> {ok, applied:[key], skipped, warnings, tenantMismatch}
// tenantMismatch (additive) is true when the file is from another company;
// the same news is also the first entry in warnings.
//
// Rules: an allowlist, never a denylist. Values are validated with crm.js's
// own saveUserSettings (dry run) wherever it covers the key. A setting locked
// by Chrome managed policy is never overwritten. The login (tenant,
// extension, PIN) is never touched. Secret values are never logged, never
// shown in a preview, and stay in sync storage where the diagnostics
// scrubber already hides them.

(function () {
  'use strict';

  const TYPE = 'vaspian-one-click-settings';
  const VERSION = 1;
  const MAX_BYTES = 256 * 1024;
  const MASK = '••••••';
  const MAX_SITES = 200;

  /**
   * The allowlist: the company-wide settings a file may carry. Everything
   * else (PIN, extension, tenant, login state, history, logs, device caps,
   * status caches, apiGuard, the chosen phone, personal toggles) never leaves
   * the device. `via` says which validator applies.
   */
  const ALLOWLIST = {
    // Screen pop: where the company's caller records live.
    screenPopEnabled: { label: 'Screen pop', via: 'crm', why: 'The company decides whether calls open its CRM.' },
    screenPopCrm: { label: 'Screen pop destination', via: 'crm', why: 'One CRM per company.' },
    screenPopUrl: { label: 'Custom screen pop address', via: 'crm', why: 'The company CRM page; may carry a key, so treated as secret when it does.' },
    screenPopTrigger: { label: 'Open screen pop', via: 'crm', why: 'A team workflow choice (on ring or on answer).' },
    screenPopInternal: { label: 'Screen pop for coworkers', via: 'crm', why: 'A team workflow choice.' },
    crmZohoKey: { label: 'Zoho Desk access key', via: 'crm', secret: true, why: 'Shared company key; the whole point of the file. Only with "Include access keys".' },
    crmZohoCrmOrg: { label: 'Zoho CRM org ID', via: 'crm', why: 'Identifies the company\'s Zoho CRM.' },
    crmSecureCrmBaseUrl: { label: 'SecureCRM address', via: 'crm', why: 'The company\'s SecureCRM dialer address.' },
    // Wrap-up: the company's call outcomes.
    crmWrapUpEnabled: { label: 'After-call wrap-up', via: 'crm', why: 'The company decides whether calls get an outcome.' },
    crmDispositions: { label: 'Call outcomes', via: 'crm', why: 'The company\'s list of outcomes, the same for everyone.' },
    // Calling.
    dialPrefix: { label: 'Outside line prefix', via: 'dialPrefix', why: 'Set by the company\'s phone system, the same for everyone.' },
    clickToCallEnabled: { label: 'Click to call on web pages', via: 'bool', why: 'A company default for web pages.' },
    clickToCallDisabledSites: { label: 'Sites where click to call is off', via: 'sites', why: 'Company sites (like the CRM) that dial on their own.' }
  };
  // Deliberately left out, with the reason:
  //   tenant, extension, password, isLoggedIn: the login, personal.
  //   crmZohoBaseUrl: Vaspian's service address, set by default or policy; never shown to agents.
  //   useSidebar, debugLogging, operatorEnabled, missed-call alerts (a per-device permission),
  //   team favorites, ringPhone (device-specific): personal or per-device.
  //   Everything in chrome.storage.local/session: history, logs, caches, guard state.
  const KEYS = Object.keys(ALLOWLIST);

  /** Plain sentences for the user. The UI module has its own copy object. */
  const MSG = {
    empty: 'This file is empty. Choose the settings file your admin sent you.',
    tooBig: 'This file is too big to be a One Click settings file. Choose the .json file your admin sent you.',
    notJson: 'This isn’t a One Click settings file. Choose the .json file your admin exported.',
    newer: 'This settings file is from a newer version of One Click. Update One Click, then try again.',
    unknownKeys: (n) => `${n === 1 ? '1 setting in this file isn’t' : `${n} settings in this file aren’t`} supported and will be ignored.`,
    loginIgnored: 'Sign-in details in the file were ignored. Everyone signs in with their own extension and PIN.',
    secretIgnored: 'The file says it has no access keys, so the access key in it was ignored.',
    noKey: 'This file has no Zoho Desk access key. Ask your admin for it, or enter it in Screen pop.',
    urlKeyLeftOut: 'The custom screen pop address has an access key in it, so it was left out. Turn on Include access keys to share it.',
    otherTenant: (file, mine) => `This file is from a different company (${file}). You’re signed in to ${mine}. Check with your admin before importing.`
  };

  /** addLog lives in background.js (classic worker global). Never pass values here. */
  function log(level, message) {
    try { addLog(level, `Settings transfer: ${message}`); } catch (e) { /* unit tests */ } // eslint-disable-line no-undef
  }

  const crm = () => self.OneClick.crm;

  /** Normalize a click-to-call site the way popup.js addDisabledSite does. */
  function cleanSite(v) {
    if (typeof v !== 'string') return null;
    const site = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/$/, '');
    return /^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(site) && /[a-z0-9]/.test(site) ? site : null;
  }

  /** Locked managed keys, and the user's stored values for the allowlist. */
  async function current() {
    const [stored, p, eff] = await Promise.all([chrome.storage.sync.get([...KEYS, 'tenant']), crm().policy(), crm().effectiveSettings()]);
    return { stored, eff, locked: p.locked, managed: p.managedKeys };
  }

  /** What a setting is now, for the preview: crm.js's effective value (IT defaults included), else stored, else built-in. */
  function effectiveOf(key, stored, eff) {
    if (eff && key in eff) return eff[key];
    if (stored[key] !== undefined) return stored[key];
    if (key === 'clickToCallEnabled') return true;
    if (key === 'clickToCallDisabledSites') return [];
    return crm().DEFAULTS[key];
  }

  function display(key, v) {
    const def = ALLOWLIST[key];
    if (def && def.secret) return v ? MASK : 'Not set';
    if (typeof v === 'boolean') return v ? 'On' : 'Off';
    if (key === 'dialPrefix') return v === '' ? 'None' : String(v);
    if (key === 'screenPopCrm') { const p = crm().PRESETS[v]; return p ? p.label : String(v); }
    if (key === 'screenPopTrigger') return v === 'offer' ? 'When it rings' : 'When I answer';
    if (Array.isArray(v)) return v.length ? v.join(', ') : 'None';
    if (v === undefined || v === null || v === '') return 'Not set';
    const s = String(v);
    // Addresses can carry keys: mask them like the screen pop preview does.
    return /^https?:/i.test(s) ? crm().redactUrl(s).replaceAll('[hidden]', MASK) : s;
  }

  /** The file's value has the same JSON type as the built-in default. */
  const sameType = (v, def) => (Array.isArray(def) ? Array.isArray(v) : typeof v === typeof def && v !== null);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // ---------------------------------------------------------------- export ---
  async function exportFile({ includeSecrets = true } = {}) {
    const { stored } = await current();
    const settings = {};
    const warnings = [];
    for (const k of KEYS) {
      if (stored[k] === undefined) continue; // unset = the default on both sides
      if (ALLOWLIST[k].secret && (!includeSecrets || !stored[k])) continue;
      if (k === 'screenPopUrl' && !includeSecrets && crm().redactUrl(stored[k]) !== String(stored[k])) { warnings.push(MSG.urlKeyLeftOut); continue; }
      settings[k] = stored[k];
    }
    const secrets = 'crmZohoKey' in settings || ('screenPopUrl' in settings && crm().redactUrl(settings.screenPopUrl) !== String(settings.screenPopUrl));
    let version = null;
    try { version = chrome.runtime.getManifest().version; } catch (e) { /* unit tests */ }
    const session = self.OneClick.api && self.OneClick.api.getSession ? self.OneClick.api.getSession() : null;
    const tenant = String(stored.tenant || '').trim();
    const file = {
      type: TYPE,
      version: VERSION,
      exportedAt: new Date().toISOString(),
      exportedFrom: version,
      includesSecrets: !!(includeSecrets && secrets),
      ...(tenant ? { tenant } : {}),
      ...(session && session.tenantId ? { tenantId: String(session.tenantId) } : {}),
      settings
    };
    const day = new Date().toISOString().slice(0, 10);
    const slug = (tenant || 'company').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'company';
    log('info', `exported ${Object.keys(settings).length} settings (access keys ${file.includesSecrets ? 'included' : 'left out'})`);
    return { ok: true, text: JSON.stringify(file, null, 2), filename: `vaspian-one-click-settings-${slug}-${day}.json`, count: Object.keys(settings).length, includesSecrets: file.includesSecrets, warnings };
  }

  // ---------------------------------------------------------------- import ---
  /** Parse and check the envelope. @returns {{file}|{error}} */
  function parse(text) {
    if (typeof text !== 'string' || !text.trim()) return { error: MSG.empty };
    if (new TextEncoder().encode(text).length > MAX_BYTES) return { error: MSG.tooBig };
    let file;
    try { file = JSON.parse(text); } catch (e) { return { error: MSG.notJson }; }
    if (!file || typeof file !== 'object' || Array.isArray(file) || file.type !== TYPE) return { error: MSG.notJson };
    if (!Number.isInteger(file.version) || file.version < 1) return { error: MSG.notJson };
    if (file.version > VERSION) return { error: MSG.newer };
    if (!file.settings || typeof file.settings !== 'object' || Array.isArray(file.settings)) return { error: MSG.notJson };
    return { file };
  }

  /**
   * Work out what an import would do, without writing anything.
   * @returns {{ok:true, writes:object, summary, skipped, warnings}|{ok:false, error}}
   */
  async function plan(text) {
    const { file, error } = parse(text);
    if (error) return { ok: false, error };
    const { stored, eff, locked, managed } = await current();
    const warnings = [];
    const skipped = [];
    const candidates = {};
    let unknown = 0;
    let login = false;

    for (const [k, v] of Object.entries(file.settings)) {
      const def = Object.prototype.hasOwnProperty.call(ALLOWLIST, k) ? ALLOWLIST[k] : null;
      if (!def) {
        if (/^(tenant|extension|password|pin|isLoggedIn)$/i.test(k)) login = true; else unknown++;
        continue;
      }
      if (def.secret && file.includesSecrets !== true) { if (v) warnings.push(MSG.secretIgnored); continue; }
      if (locked.includes(k)) { skipped.push({ key: k, label: def.label, reason: 'locked' }); continue; }
      if (def.via === 'crm' && !sameType(v, crm().DEFAULTS[k])) { skipped.push({ key: k, label: def.label, reason: 'invalid' }); continue; }
      candidates[k] = v;
    }
    if (login) warnings.push(MSG.loginIgnored);
    if (unknown) warnings.push(MSG.unknownKeys(unknown));

    // Validate: crm keys with crm.js's own validator (dry run).
    const writes = {};
    const crmVals = Object.fromEntries(Object.entries(candidates).filter(([k]) => ALLOWLIST[k].via === 'crm'));
    if (Object.keys(crmVals).length) {
      const r = await crm().saveUserSettings(crmVals, { dryRun: true });
      for (const k of r.refused) skipped.push({ key: k, label: ALLOWLIST[k] ? ALLOWLIST[k].label : k, reason: locked.includes(k) ? 'locked' : 'invalid' });
      Object.assign(writes, r.values || {});
    }
    for (const [k, v] of Object.entries(candidates)) {
      const via = ALLOWLIST[k].via;
      const bad = () => skipped.push({ key: k, label: ALLOWLIST[k].label, reason: 'invalid' });
      if (via === 'dialPrefix') { if (['', '8', '9'].includes(v)) writes[k] = v; else bad(); }
      else if (via === 'bool') { if (typeof v === 'boolean') writes[k] = v; else bad(); }
      else if (via === 'sites') {
        if (!Array.isArray(v) || v.length > MAX_SITES) { bad(); continue; }
        const sites = v.map(cleanSite);
        if (sites.some((s) => s === null)) { bad(); continue; }
        writes[k] = [...new Set(sites)];
      }
    }

    // Only real changes go in the summary (and get written).
    const summary = [];
    for (const k of KEYS) {
      if (!(k in writes)) continue;
      const before = effectiveOf(k, stored, eff);
      if (same(before, writes[k])) { delete writes[k]; continue; }
      summary.push({ key: k, label: ALLOWLIST[k].label, from: display(k, before), to: display(k, writes[k]), secret: !!ALLOWLIST[k].secret });
    }

    const preset = writes.screenPopCrm || effectiveOf('screenPopCrm', stored, eff);
    const enabled = 'screenPopEnabled' in writes ? writes.screenPopEnabled : effectiveOf('screenPopEnabled', stored, eff);
    if (preset === 'zoho' && enabled && file.includesSecrets !== true && !stored.crmZohoKey && !managed.includes('crmZohoKey')) warnings.push(MSG.noKey);

    // Different company? Compare the numeric tenant id when both sides have
    // it (web name vs main number are the same company), else the names.
    const session = self.OneClick.api && self.OneClick.api.getSession ? self.OneClick.api.getSession() : null;
    const mine = String(stored.tenant || '').trim();
    const fileTenant = typeof file.tenant === 'string' ? file.tenant.trim().slice(0, 100) : '';
    const fileTid = file.tenantId == null ? '' : String(file.tenantId);
    let tenantMismatch = false;
    if (mine && (fileTenant || fileTid)) {
      const differs = session && session.tenantId && fileTid
        ? String(session.tenantId) !== fileTid
        : fileTenant && fileTenant.toLowerCase() !== mine.toLowerCase();
      if (differs) { tenantMismatch = true; warnings.unshift(MSG.otherTenant(fileTenant || `#${fileTid}`, mine)); }
    }

    return { ok: true, writes, summary, skipped, warnings: [...new Set(warnings)], tenantMismatch };
  }

  async function importPreview(text) {
    const p = await plan(text);
    if (!p.ok) return p;
    return { ok: true, summary: p.summary, skipped: p.skipped, warnings: p.warnings, tenantMismatch: p.tenantMismatch };
  }

  async function importFile(text) {
    // Re-plan from the file itself: never trust an earlier preview.
    const p = await plan(text);
    if (!p.ok) { log('warning', 'import refused: not a valid settings file'); return p; }
    const applied = Object.keys(p.writes);
    if (applied.length) await chrome.storage.sync.set(p.writes);
    log('info', `imported ${applied.length} settings (${applied.join(', ') || 'none'}); skipped ${p.skipped.length}`);
    return { ok: true, applied, skipped: p.skipped, warnings: p.warnings, tenantMismatch: p.tenantMismatch };
  }

  // ---------------------------------------------------------------- wiring ---
  const handlers = {
    'settings:export': (r) => exportFile({ includeSecrets: r.includeSecrets !== false }),
    'settings:importPreview': (r) => importPreview(r.text),
    'settings:import': (r) => importFile(r.text)
  };

  /** Only extension pages (popup, side panel, welcome tab), never content scripts. */
  function fromExtensionPage(sender) {
    if (!sender) return false;
    if (sender.id && sender.id !== chrome.runtime.id) return false;
    return typeof sender.url === 'string' && sender.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  }

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const h = request && handlers[request.action];
    if (!h) return undefined;
    if (!fromExtensionPage(sender)) {
      sendResponse({ ok: false, error: 'not allowed' });
      return false;
    }
    Promise.resolve().then(() => h(request))
      .then((res) => sendResponse(res))
      .catch((e) => { log('error', `${request.action} failed`); sendResponse({ ok: false, error: 'Something went wrong. Try again, or ask your admin for a new file.' }); });
    return true;
  });

  self.OneClick.settingsTransfer = {
    TYPE, VERSION, MAX_BYTES, ALLOWLIST,
    exportFile, importPreview, importFile
  };
})();
