// Track C "crm" (service worker): CRM presets, call history built from
// events, after-call wrap-up (dispositions + notes), managed settings and the
// diagnostics export.
//
// Pieces (all inside this IIFE, public surface on self.OneClick.crm):
//   - PRESETS / templateFor / buildUrl: the screen pop URL for Simplicity
//     Collect, Zoho Desk (our zoho-screenpop worker), SecureCRM or a custom
//     template with {phone10} {e164} {phone} {name}. screenpop.js asks
//     effectiveSettings() and templateFor() at pop time.
//   - Effective settings: chrome.storage.managed (IT policy) over the user's
//     chrome.storage.sync values. A managed value is a default the user can
//     change, unless its group is locked (managed `locked.<group>`), then it
//     wins and the UI renders it read-only.
//   - History: every call event on the bus updates an in-flight record (kept
//     in chrome.storage.session so a worker restart does not lose it); on the
//     last 'end' it is written into the existing callHistory list with
//     direction, status, durationSec, name, smdrCallId. An outbound call
//     placed from One Click merges into the click record dial() just added.
//   - Wrap-up: answered calls queue a disposition/note prompt
//     (local.crmWrapUp); answers are stored in local.crmCallNotes keyed by
//     smdrCallId and mirrored onto the history record.
//   - Diagnostics: one JSON for support. Never contains the PIN, the WS URL,
//     Basic tokens or the Zoho key (scrubbed, then verified by tests).
//
// Storage keys owned here: sync crmZohoBaseUrl, crmZohoKey,
// crmSecureCrmBaseUrl, crmWrapUpEnabled, crmDispositions; local crmWrapUp,
// crmCallNotes, crmPolicy; session crmInflight. Foundation keys read:
// screenPop*, callHistory, tenant, dialPrefix.

(function () {
  'use strict';
  const api = self.OneClick.api;

  /** addLog lives in background.js (classic worker global). */
  function log(level, message) {
    try { addLog(level, `CRM: ${message}`); } catch (e) { /* not loaded (unit tests) */ } // eslint-disable-line no-undef
  }

  // ------------------------------------------------------------- presets ---
  const DEFAULT_ZOHO_BASE = 'https://zoho-screenpop.vaspian.me/';
  const DEFAULT_SECURECRM_BASE = 'https://www.securecrm.io/dialer2.php';

  /**
   * Screen pop presets. `fields` are the per-preset settings the UI shows.
   * Zoho Desk goes through Vaspian's zoho-screenpop worker (it looks the caller
   * up and redirects to the contact, or to a new ticket), which wants
   * ?phone=+1NXXNXXXXXX&key=<shared key>. SecureCRM's dialer takes the bare
   * 10-digit number, which One Click already has, so no worker is needed.
   */
  const PRESETS = {
    simplicity: {
      label: 'Simplicity Collect',
      description: 'Opens the account in the Simplicity Collect dialer.',
      template: 'https://app.simplicitycollect.com/dialer/update.aspx?dialer=true&phone={phone10}',
      fields: []
    },
    zoho: {
      label: 'Zoho Desk',
      description: 'Opens the matching Zoho Desk contact, or a new ticket when there is no match.',
      fields: ['crmZohoBaseUrl', 'crmZohoKey']
    },
    securecrm: {
      label: 'SecureCRM',
      description: 'Opens the caller in the SecureCRM dialer.',
      fields: ['crmSecureCrmBaseUrl']
    },
    custom: {
      label: 'Custom URL',
      description: 'Any web page. Use {phone10}, {e164}, {phone} or {name} in the URL.',
      fields: ['screenPopUrl']
    }
  };

  const DEFAULT_DISPOSITIONS = ['Resolved', 'Follow-up needed', 'Left voicemail', 'Wrong number', 'Not interested'];

  /** Built-in defaults for every effective setting. */
  const DEFAULTS = {
    screenPopEnabled: false,
    screenPopCrm: 'simplicity',
    screenPopUrl: '',
    screenPopTrigger: 'answer',
    crmZohoBaseUrl: DEFAULT_ZOHO_BASE,
    crmZohoKey: '',
    crmSecureCrmBaseUrl: DEFAULT_SECURECRM_BASE,
    crmWrapUpEnabled: true,
    crmDispositions: DEFAULT_DISPOSITIONS,
    tenant: '',
    dialPrefix: '8'
  };
  const USER_KEYS = Object.keys(DEFAULTS);

  /** managed_schema.json property -> effective setting key, and its lock group. */
  const MANAGED_MAP = {
    tenant: { key: 'tenant', group: 'tenant' },
    dialPrefix: { key: 'dialPrefix', group: 'dialPrefix' },
    screenPopEnabled: { key: 'screenPopEnabled', group: 'screenPop' },
    screenPopTrigger: { key: 'screenPopTrigger', group: 'screenPop' },
    crmPreset: { key: 'screenPopCrm', group: 'crm' },
    crmCustomUrl: { key: 'screenPopUrl', group: 'crm' },
    zohoBaseUrl: { key: 'crmZohoBaseUrl', group: 'crm' },
    zohoKey: { key: 'crmZohoKey', group: 'crm' },
    secureCrmBaseUrl: { key: 'crmSecureCrmBaseUrl', group: 'crm' },
    wrapUpEnabled: { key: 'crmWrapUpEnabled', group: 'wrapUp' },
    dispositions: { key: 'crmDispositions', group: 'wrapUp' }
  };
  const LOCK_GROUPS = ['tenant', 'dialPrefix', 'screenPop', 'crm', 'wrapUp'];

  /** @returns {URL|null} an http(s) URL, or null. */
  function httpUrl(s) {
    try {
      const u = new URL(String(s || '').trim());
      return u.protocol === 'https:' || u.protocol === 'http:' ? u : null;
    } catch (e) { return null; }
  }

  /** Append query parameters (already containing {tokens}) to a base URL. */
  function withQuery(base, query) {
    const u = httpUrl(base);
    if (!u) return null;
    const s = u.toString();
    const sep = s.includes('?') ? (/[?&]$/.test(s) ? '' : '&') : '?';
    return `${s}${sep}${query}`;
  }

  /**
   * The URL template (with {tokens}) for a settings object, or null when the
   * preset is not usable (bad base URL, empty or non-http custom template).
   * @param {object} s effective settings
   */
  function templateFor(s) {
    const crm = (s && s.screenPopCrm) || 'simplicity';
    if (crm === 'simplicity') return PRESETS.simplicity.template;
    if (crm === 'zoho') {
      const key = String(s.crmZohoKey || '').trim();
      return withQuery(s.crmZohoBaseUrl || DEFAULT_ZOHO_BASE, `phone={e164}${key ? `&key=${encodeURIComponent(key)}` : ''}`);
    }
    if (crm === 'securecrm') return withQuery(s.crmSecureCrmBaseUrl || DEFAULT_SECURECRM_BASE, 'phone={phone10}');
    if (crm === 'custom') {
      const t = String(s.screenPopUrl || '').trim();
      // Check the scheme with the tokens filled in, so {tokens} in the host still parse.
      return t && httpUrl(t.replace(/\{(phone10|e164|phone|name)\}/g, '0')) ? t : null;
    }
    return null;
  }

  /** Last 10 digits of a North American number; '' for internal callers. */
  function phone10Of(number) {
    const p = api.normalizeParty(number, { selfExt: '' });
    return p && p.number ? p.number : '';
  }

  /**
   * Fill a template. {phone10} is digits, {e164} is %2B1NXXNXXXXXX, {phone}
   * and {name} are URL-encoded as received. Same tokens as v1.2 screen pop.
   * @param {string} template
   * @param {{from: string, name?: string}} call
   */
  function buildUrl(template, call) {
    const phone10 = phone10Of(call.from);
    return String(template)
      .replaceAll('{phone10}', phone10)
      .replaceAll('{e164}', phone10 ? encodeURIComponent(`+1${phone10}`) : '')
      .replaceAll('{phone}', encodeURIComponent(call.from || ''))
      .replaceAll('{name}', encodeURIComponent(call.name || ''));
  }

  /** Hide shared keys in a URL before it is logged, stored or shown. */
  function redactUrl(url) {
    return String(url || '').replace(/([?&](?:key|token|secret|apikey|api_key|password|pin)=)[^&#\s"'<>]*/gi, '$1[hidden]');
  }

  /**
   * Preview for the settings UI: the URL a call from `phone` would open.
   * @returns {{ok:boolean, url?:string, error?:string, preset:string}}
   */
  function preview(s, phone, name) {
    const preset = s.screenPopCrm || 'simplicity';
    const template = templateFor(s);
    if (!template) {
      const error = preset === 'custom'
        ? (String(s.screenPopUrl || '').trim() ? 'The URL must start with https:// or http://' : 'Enter the URL to open')
        : 'Enter a valid https:// address';
      return { ok: false, error, preset };
    }
    const from = phone || '3155550100';
    if (!phone10Of(from)) return { ok: false, error: 'Use a 10-digit phone number to preview', preset };
    // Mask shared keys: the preview is on screen (and in screenshots).
    return { ok: true, url: redactUrl(buildUrl(template, { from, name: name || '' })).replaceAll('[hidden]', '\u2022\u2022\u2022\u2022\u2022\u2022'), preset };
  }

  /**
   * The CRM page for a caller, with the effective (managed-aware) settings.
   * Used by the call card's "Open in ..." button. The URL can carry a shared
   * key, so callers must open it from the service worker and never store it
   * or hand it to a page. Returns null when screen pop is off, the preset is
   * unusable or the caller has no 10-digit number.
   * @param {{from: string, name?: string}} call
   * @returns {Promise<{url: string, label: string, preset: string}|null>}
   */
  async function urlFor(call) {
    const s = await effectiveSettings();
    if (!s.screenPopEnabled || !call || !phone10Of(call.from)) return null;
    const template = templateFor(s);
    if (!template) return null;
    const url = buildUrl(template, { from: call.from, name: call.name || '' });
    if (!httpUrl(url)) return null;
    const preset = s.screenPopCrm;
    const label = preset === 'simplicity' ? 'Simplicity' : preset === 'custom' ? 'CRM' : PRESETS[preset].label;
    return { url, label, preset };
  }

  // ---------------------------------------------------- managed settings ---
  let managedOverride = null; // test seam: set only from the service worker

  // chrome.storage.managed.get() can stay pending for minutes right after
  // the browser starts (seen in the rig on Chromium 131 while the policy
  // service loads). Screen pop, wrap-up and dialing all read settings through
  // here, so never wait on it for long: keep the last answer in memory, give a
  // slow read MANAGED_WAIT_MS, then carry on with what we have. When the slow
  // read lands it refreshes the cache and republishes the policy.
  let managedWaitMs = 1500;
  let managedCache = null;     // last successful read
  let managedPending = null;   // the read in flight, shared by concurrent callers
  let managedSlowLogged = false;
  let managedTimedOut = false; // the pending read already used up its wait
  const MANAGED_CACHE_KEY = 'crmManagedCache'; // non-secret copy for cold starts

  /** The managed object without secrets (the Zoho key), safe for chrome.storage.local. */
  function managedForCache(m) {
    const out = { ...(m || {}) };
    delete out.zohoKey;
    return out;
  }

  function fetchManaged() {
    if (managedPending) return managedPending;
    managedPending = (async () => {
      try {
        const m = chrome.storage.managed ? ((await chrome.storage.managed.get(null)) || {}) : {};
        const changed = JSON.stringify(m) !== JSON.stringify(managedCache || {});
        managedCache = m;
        chrome.storage.local.set({ [MANAGED_CACHE_KEY]: managedForCache(m) }).catch(() => {});
        if (changed) publishPolicy().catch(() => {});
        return m;
      } catch (e) {
        return managedCache || {};
      } finally {
        managedPending = null;
        managedTimedOut = false;
      }
    })();
    return managedPending;
  }

  async function readManaged() {
    if (managedOverride) return managedOverride;
    // A read that already timed out is still hanging: don't make every caller wait again.
    if (managedPending && managedTimedOut) return managedCache || {};
    const read = fetchManaged();
    let timer = null;
    const slow = new Promise((resolve) => { timer = setTimeout(() => resolve(null), managedWaitMs); });
    const m = await Promise.race([read, slow]);
    clearTimeout(timer);
    if (m) return m;
    if (managedPending) managedTimedOut = true;
    if (!managedCache && !managedSlowLogged) { managedSlowLogged = true; log('warning', 'managed policy not readable yet; using user settings until it loads'); }
    return managedCache || {};
  }

  /** Validate one managed value against the schema's intent; undefined = ignore. */
  function cleanManaged(prop, v) {
    if (v === undefined || v === null) return undefined;
    switch (prop) {
      case 'screenPopEnabled': case 'wrapUpEnabled': return typeof v === 'boolean' ? v : undefined;
      case 'screenPopTrigger': return v === 'answer' || v === 'offer' ? v : undefined;
      case 'crmPreset': return PRESETS[v] ? v : undefined;
      case 'dialPrefix': return ['', '8', '9'].includes(String(v)) ? String(v) : undefined;
      case 'dispositions':
        return Array.isArray(v) ? v.map((d) => String(d).trim()).filter(Boolean).slice(0, 30) : undefined;
      default: return typeof v === 'string' ? v.trim() : undefined;
    }
  }

  /**
   * Managed policy, normalized: values keyed by effective setting key, and the
   * set of locked effective keys.
   */
  async function policy() {
    const m = await readManaged();
    const values = {};
    const managedKeys = [];
    for (const [prop, { key }] of Object.entries(MANAGED_MAP)) {
      const v = cleanManaged(prop, m[prop]);
      if (v !== undefined) { values[key] = v; managedKeys.push(key); }
    }
    const lockedGroups = LOCK_GROUPS.filter((g) => m.locked && m.locked[g] === true);
    const locked = Object.values(MANAGED_MAP)
      .filter(({ key, group }) => lockedGroups.includes(group) && key in values)
      .map(({ key }) => key);
    return { values, managedKeys, locked, lockedGroups, active: managedKeys.length > 0 };
  }

  /**
   * Effective settings: locked managed > user (sync) > managed default > built-in.
   * screenpop.js calls this (instead of reading sync) when crm.js is loaded.
   */
  async function effectiveSettings() {
    const [user, p] = await Promise.all([chrome.storage.sync.get(USER_KEYS), policy()]);
    const out = {};
    for (const k of USER_KEYS) {
      if (p.locked.includes(k)) out[k] = p.values[k];
      else if (user[k] !== undefined && !(k === 'crmDispositions' && !Array.isArray(user[k]))) out[k] = user[k];
      else if (k in p.values) out[k] = p.values[k];
      else out[k] = DEFAULTS[k];
    }
    if (!PRESETS[out.screenPopCrm]) out.screenPopCrm = 'simplicity';
    return out;
  }

  /** What the settings UI renders. The managed Zoho key never leaves the worker. */
  async function settingsForUi() {
    const [values, p, user] = await Promise.all([effectiveSettings(), policy(), chrome.storage.sync.get(['crmZohoKey'])]);
    // A managed key is never sent to the page, locked or not. Unlocked, the
    // user may still type their own key, which then wins.
    const zohoKeyManaged = p.managedKeys.includes('crmZohoKey') && (p.locked.includes('crmZohoKey') || !user.crmZohoKey);
    if (zohoKeyManaged) values.crmZohoKey = '';
    return {
      values, zohoKeyManaged, zohoKeySet: !!values.crmZohoKey || zohoKeyManaged,
      managed: p.managedKeys, locked: p.locked, policyActive: p.active,
      presets: Object.fromEntries(Object.entries(PRESETS).map(([id, x]) => [id, { label: x.label, description: x.description, fields: x.fields }])),
      defaults: { crmZohoBaseUrl: DEFAULT_ZOHO_BASE, crmSecureCrmBaseUrl: DEFAULT_SECURECRM_BASE, crmDispositions: DEFAULT_DISPOSITIONS }
    };
  }

  /** Publish a non-secret summary so UIs re-render when the policy changes. */
  async function publishPolicy() {
    const p = await policy();
    await chrome.storage.local.set({ crmPolicy: { managed: p.managedKeys, locked: p.locked, active: p.active, at: new Date().toISOString() } });
    return p;
  }

  /**
   * Save user settings from the UI. Locked keys and unknown keys are dropped;
   * URLs are checked. Returns the fields that were refused.
   */
  async function saveUserSettings(values) {
    const p = await policy();
    const out = {};
    const refused = [];
    for (const [k, v] of Object.entries(values || {})) {
      if (!USER_KEYS.includes(k) || k === 'tenant' || k === 'dialPrefix') { refused.push(k); continue; }
      if (p.locked.includes(k)) { refused.push(k); continue; }
      if (k === 'screenPopEnabled' || k === 'crmWrapUpEnabled') out[k] = !!v;
      else if (k === 'screenPopCrm') { if (PRESETS[v]) out[k] = v; else refused.push(k); }
      else if (k === 'screenPopTrigger') { if (v === 'answer' || v === 'offer') out[k] = v; else refused.push(k); }
      else if (k === 'crmDispositions') {
        if (Array.isArray(v)) out[k] = [...new Set(v.map((d) => String(d).trim().slice(0, 40)).filter(Boolean))].slice(0, 30);
        else refused.push(k);
      } else if (k === 'crmZohoBaseUrl' || k === 'crmSecureCrmBaseUrl') {
        const t = String(v || '').trim();
        if (!t || httpUrl(t)) out[k] = t; else refused.push(k);
      } else out[k] = String(v || '').trim();
    }
    // An empty base URL means "use the default".
    for (const k of ['crmZohoBaseUrl', 'crmSecureCrmBaseUrl']) if (out[k] === '') out[k] = DEFAULTS[k];
    if (Object.keys(out).length) await chrome.storage.sync.set(out);
    return { ok: refused.length === 0, refused };
  }

  // ------------------------------------------------------- call history ---
  const INFLIGHT_KEY = 'crmInflight';
  const MAX_HISTORY = 500;
  const CLICK_MERGE_MS = 120 * 1000;
  const STALE_MS = 6 * 60 * 60 * 1000;
  let inflight = {}; // key (smdrCallId || callId) -> record being built
  let restored = null;
  const recentEvents = []; // diagnostics ring buffer (summaries, no raw frames)

  function restoreInflight() {
    if (!restored) {
      restored = (async () => {
        try {
          const r = chrome.storage.session ? await chrome.storage.session.get([INFLIGHT_KEY]) : {};
          const saved = r[INFLIGHT_KEY] || {};
          const now = Date.now();
          for (const [k, v] of Object.entries(saved)) if (now - Date.parse(v.startedAt) < STALE_MS) inflight[k] = { ...v, ...inflight[k] };
        } catch (e) { /* session storage unavailable */ }
      })();
    }
    return restored;
  }
  async function persistInflight() {
    try { if (chrome.storage.session) await chrome.storage.session.set({ [INFLIGHT_KEY]: inflight }); } catch (e) { /* ignore */ }
  }

  // All read-modify-writes of callHistory from this module run one at a time.
  let historyChain = Promise.resolve();
  function withHistory(fn) {
    const next = historyChain.then(async () => {
      const { callHistory } = await chrome.storage.local.get(['callHistory']);
      const list = Array.isArray(callHistory) ? callHistory : [];
      const out = await fn(list);
      if (out) await chrome.storage.local.set({ callHistory: out.slice(0, MAX_HISTORY) });
      return out;
    });
    historyChain = next.catch((e) => log('error', `history update failed: ${e.message}`));
    return next;
  }

  /** The number to store and redial: 10-digit NANP, else the extension or digits. */
  function partyNumber(p) {
    if (!p) return '';
    return p.number || p.ext || p.digits || String(p.raw || '');
  }

  /**
   * Outbound parties can carry the dial prefix (8 or 9) in front of the
   * number ('83155550100', '813155550100'). An 11-digit number starting with
   * 8 or 9 is never valid NANP, so strip the prefix to get the real number.
   */
  function dialedParty(p) {
    if (!p || p.number || p.isInternal) return p;
    const m = String(p.digits || '').match(/^[89](1?\d{10})$/);
    if (!m) return p;
    const q = api.normalizeParty(m[1]);
    return q && q.number ? q : p;
  }

  function summarize(ev) {
    const d = (p) => (p ? p.display || p.raw : null);
    return {
      at: ev.timestamp, kind: ev.kind, type: ev.type, callId: ev.callId || null, smdrCallId: ev.smdrCallId || null,
      direction: ev.direction || null, from: d(ev.from), to: d(ev.to), answeringParty: d(ev.answeringParty),
      isDuplicate: !!ev.isDuplicate, endReason: ev.endReason || null, callDurationMs: ev.callDurationMs == null ? null : ev.callDurationMs
    };
  }
  function remember(entry) {
    recentEvents.push(entry);
    if (recentEvents.length > 50) recentEvents.splice(0, recentEvents.length - 50);
  }

  /** Status of a finished record. */
  function statusOf(rec) {
    if (rec.direction === 'outbound') return rec.answered ? 'answered' : 'no_answer';
    if (rec.answered) return 'answered';
    if (rec.answeredElsewhere) return 'answered_elsewhere';
    return rec.sawStart ? 'missed' : 'ended';
  }

  /**
   * Fold one normalized call event into the in-flight record.
   * @param {object} ev CallEvent (ARCHITECTURE.md §4)
   */
  async function trackCall(ev) {
    await restoreInflight();
    remember(summarize(ev));
    const key = ev.smdrCallId || ev.callId;
    if (!key) return;
    let rec = inflight[key];
    if (!rec) {
      rec = inflight[key] = {
        key, smdrCallId: ev.smdrCallId || null, callIds: [], direction: ev.direction === 'outbound' ? 'outbound' : 'inbound',
        party: null, name: '', startedAt: new Date().toISOString(), // local clock, like click records answered: false, answeredAt: null,
        answeredElsewhere: null, sawStart: ev.type !== 'end'
      };
    }
    if (ev.callId && !rec.callIds.includes(ev.callId) && ev.type !== 'end') rec.callIds.push(ev.callId);
    const other = rec.direction === 'outbound'
      ? dialedParty(ev.to && !ev.to.isSelf ? ev.to : (ev.dialedDigits ? api.normalizeParty(ev.dialedDigits) : null))
      : (ev.from && !ev.from.isSelf ? ev.from : null);
    if (other && !rec.party) rec.party = { raw: other.raw, number: other.number, ext: other.ext, digits: other.digits, isInternal: other.isInternal };
    if (ev.callingName && rec.direction === 'inbound' && !rec.name) rec.name = ev.callingName;

    if (ev.type === 'answer') {
      const by = ev.answeringParty;
      if (rec.direction === 'outbound' || !by || by.isSelf) {
        rec.answered = true;
        rec.answeredAt = rec.answeredAt || new Date().toISOString();
      } else {
        rec.answeredElsewhere = by.display || by.raw;
      }
    }

    if (ev.type === 'end') {
      rec.callIds = rec.callIds.filter((id) => id !== ev.callId);
      if (ev.callDurationMs != null && rec.answered) rec.talkMs = Math.max(rec.talkMs || 0, ev.callDurationMs);
      rec.endedAt = new Date().toISOString();
      rec.endReason = ev.endReason || null;
      rec.lastCallId = ev.callId;
      if (rec.callIds.length === 0) {
        delete inflight[key];
        await persistInflight();
        await finalize(rec);
        return;
      }
    }
    await persistInflight();
  }

  /** Turn a finished in-flight record into a history entry (and a wrap-up prompt). */
  async function finalize(rec) {
    const status = statusOf(rec);
    let durationSec = 0;
    if (rec.answered) {
      const ms = rec.talkMs != null ? rec.talkMs : Math.max(0, Date.parse(rec.endedAt) - Date.parse(rec.answeredAt || rec.endedAt));
      durationSec = Math.round(ms / 1000);
    }
    const phoneNumber = partyNumber(rec.party);
    if (!phoneNumber) { log('info', `call ${rec.key} ended with no other party; not added to history`); return; }
    const entry = {
      phoneNumber, timestamp: new Date(Date.parse(rec.startedAt) || Date.now()).toISOString(), note: '',
      direction: rec.direction, status, durationSec, name: rec.name || '', smdrCallId: rec.smdrCallId || null,
      callId: rec.lastCallId || null, endedAt: rec.endedAt, source: 'event'
    };
    if (rec.answeredElsewhere) entry.answeredBy = rec.answeredElsewhere;

    let merged = false;
    await withHistory((list) => {
      if (entry.smdrCallId && list.some((r) => r.smdrCallId === entry.smdrCallId)) return null; // already recorded
      if (entry.direction === 'outbound') {
        const t = Date.parse(entry.timestamp);
        const i = list.findIndex((r) => r.source !== 'event' && !r.smdrCallId
          && Math.abs(Date.parse(r.timestamp) - t) < CLICK_MERGE_MS && api.sameParty(r.phoneNumber, entry.phoneNumber));
        if (i !== -1) {
          // Keep the click's timestamp and note (the note editor keys on them).
          list[i] = { ...list[i], ...entry, timestamp: list[i].timestamp, note: list[i].note || '', source: 'click+event' };
          merged = true;
          return list;
        }
      }
      while (list.some((r) => r.timestamp === entry.timestamp)) entry.timestamp = new Date(Date.parse(entry.timestamp) + 1).toISOString();
      list.unshift(entry);
      return list;
    });
    log('info', `history: ${entry.direction} ${status} ${phoneNumber} (${durationSec}s)${merged ? ', merged with the click' : ''}`);

    const s = await effectiveSettings();
    if (s.crmWrapUpEnabled && status === 'answered') await queueWrapUp(entry);
  }

  /** On reconnect, close records for calls the server no longer has. */
  async function reconcile() {
    await restoreInflight();
    const keys = Object.keys(inflight);
    if (!keys.length) return;
    const r = await api.getActiveCalls();
    if (!r.ok) return;
    const live = new Set(r.calls.map((c) => c.callId).filter(Boolean));
    for (const k of keys) {
      const rec = inflight[k];
      if (rec.callIds.some((id) => live.has(id))) continue;
      delete inflight[k];
      rec.endedAt = rec.endedAt || new Date().toISOString();
      await finalize(rec);
    }
    await persistInflight();
  }

  // ------------------------------------------------------------ wrap-up ---
  const WRAPUP_KEY = 'crmWrapUp';
  const NOTES_KEY = 'crmCallNotes';

  async function queueWrapUp(entry) {
    const { [WRAPUP_KEY]: q } = await chrome.storage.local.get([WRAPUP_KEY]);
    const list = (Array.isArray(q) ? q : []).filter((x) => x.key !== (entry.smdrCallId || entry.callId));
    list.unshift({
      key: entry.smdrCallId || entry.callId, smdrCallId: entry.smdrCallId, phoneNumber: entry.phoneNumber, name: entry.name,
      direction: entry.direction, status: entry.status, durationSec: entry.durationSec, timestamp: entry.timestamp, endedAt: entry.endedAt
    });
    await chrome.storage.local.set({ [WRAPUP_KEY]: list.slice(0, 10) });
  }

  async function dropWrapUp(key) {
    const { [WRAPUP_KEY]: q } = await chrome.storage.local.get([WRAPUP_KEY]);
    await chrome.storage.local.set({ [WRAPUP_KEY]: (Array.isArray(q) ? q : []).filter((x) => x.key !== key) });
  }

  /**
   * Save a disposition and note for a call (keyed by smdrCallId, or callId
   * when the platform sent none) and mirror it onto the history record.
   */
  async function saveWrapUp({ key, disposition, note }) {
    if (!key || typeof key !== 'string') return { ok: false, error: 'missing call key' };
    const d = String(disposition || '').trim().slice(0, 60);
    const n = String(note || '').trim().slice(0, 2000);
    const { [NOTES_KEY]: notes } = await chrome.storage.local.get([NOTES_KEY]);
    const all = notes && typeof notes === 'object' ? notes : {};
    all[key] = { disposition: d, note: n, at: new Date().toISOString() };
    // Keep the newest 500.
    const keys = Object.keys(all).sort((a, b) => String(all[b].at).localeCompare(String(all[a].at)));
    for (const k of keys.slice(MAX_HISTORY)) delete all[k];
    await chrome.storage.local.set({ [NOTES_KEY]: all });
    await withHistory((list) => {
      const i = list.findIndex((r) => r.smdrCallId === key || (!r.smdrCallId && r.callId === key));
      if (i === -1) return null;
      list[i] = { ...list[i], disposition: d, note: n || list[i].note || '' };
      return list;
    });
    await dropWrapUp(key);
    log('info', `wrap-up saved for ${key}${d ? ` (${d})` : ''}`);
    return { ok: true };
  }

  // -------------------------------------------------------- diagnostics ---
  /** Scrub secrets out of any text: the PIN, Basic tokens, URL credentials, shared keys. */
  function scrubber(secrets) {
    const list = [];
    for (const s of secrets) {
      if (!s || String(s).length < 3) continue;
      list.push(String(s), encodeURIComponent(String(s)));
    }
    return (text) => {
      let t = String(text);
      for (const s of list) t = t.split(s).join('[redacted]');
      t = t.replace(/(Basic\s+)[A-Za-z0-9+/=]{6,}/gi, '$1[redacted]');
      t = t.replace(/(wss?|https?):\/\/[^/\s"'@]+:[^/\s"'@]*@/gi, '$1://[redacted]@');
      t = redactUrl(t);
      return t;
    };
  }

  /**
   * Build the diagnostics JSON for support. Read the PIN only to scrub it.
   * @returns {Promise<object>}
   */
  async function diagnostics() {
    const [sync, local, p, eff] = await Promise.all([
      chrome.storage.sync.get(null),
      chrome.storage.local.get(['password', 'apiStatus', 'apiGuard', 'logs', 'callHistory', WRAPUP_KEY, 'screenPopLast']),
      policy(), effectiveSettings()
    ]);
    const pin = local.password || sync.password || '';
    const session = api.getSession();
    const secrets = [pin, eff.crmZohoKey, sync.crmZohoKey, p.values.crmZohoKey];
    if (pin && session && session.username) {
      const b64 = btoa(unescape(encodeURIComponent(`${session.username}:${pin}`)));
      secrets.push(b64, b64.replace(/=+$/, ''));
    }
    if (pin && sync.tenant && sync.extension) {
      const b64 = btoa(unescape(encodeURIComponent(`${api.usernameFor(sync.tenant, sync.extension)}:${pin}`)));
      secrets.push(b64, b64.replace(/=+$/, ''));
    }
    const scrub = scrubber(secrets);

    const settings = {};
    for (const [k, v] of Object.entries(sync)) {
      if (/password|pin$/i.test(k)) continue;
      settings[k] = k === 'crmZohoKey' ? (v ? '[set]' : '') : v;
    }
    const history = Array.isArray(local.callHistory) ? local.callHistory : [];
    const counts = {};
    for (const r of history) { const s = r.status || 'placed'; counts[s] = (counts[s] || 0) + 1; }
    const guard = local.apiGuard || {};
    let manifest = {};
    try { manifest = chrome.runtime.getManifest(); } catch (e) { /* unit tests */ }

    const report = {
      kind: 'vaspian-one-click-diagnostics',
      formatVersion: 1,
      generatedAt: new Date().toISOString(),
      extension: { name: manifest.name || 'Vaspian One Click', version: manifest.version || null, id: (chrome.runtime && chrome.runtime.id) || null },
      browser: { userAgent: (self.navigator && self.navigator.userAgent) || null },
      connection: {
        status: local.apiStatus || api.getStatus() || null,
        connected: api.isConnected(),
        guard: { stopped: guard.stopped || null, wsRejections: guard.wsRejections || 0, at: guard.at || null },
        session: session ? { account: session.account, tenantId: session.tenantId, extension: session.extension, isAdmin: !!session.isAdmin } : null,
        subscriptions: api.listSubscriptions().map((x) => ({ kind: x.kind, account: x.account, ok: x.result ? !!x.result.ok : null, errorClass: x.result ? x.result.errorClass || null : null }))
      },
      settings: { stored: settings, effective: { ...eff, crmZohoKey: eff.crmZohoKey ? '[set]' : '' } },
      managedPolicy: { active: p.active, managed: p.managedKeys, locked: p.locked },
      history: { total: history.length, byStatus: counts, wrapUpPending: (local[WRAPUP_KEY] || []).length },
      screenPopLast: local.screenPopLast ? { at: local.screenPopLast.at, url: local.screenPopLast.url } : null,
      inflightCalls: Object.keys(inflight).length,
      recentEvents: recentEvents.slice(-50),
      recentLogs: (Array.isArray(local.logs) ? local.logs : []).slice(-200).map((l) => ({ timestamp: l.timestamp, level: l.level, message: l.message, details: l.details == null ? null : (typeof l.details === 'string' ? l.details : JSON.stringify(l.details)).slice(0, 2000) }))
    };
    // Scrub every string (keys too), so nothing nested can carry a secret.
    const deep = (v) => {
      if (typeof v === 'string') return scrub(v);
      if (Array.isArray(v)) return v.map(deep);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [scrub(k), deep(x)]));
      return v;
    };
    return deep(JSON.parse(JSON.stringify(report)));
  }

  // ------------------------------------------------------------- wiring ---
  api.on('call', (ev) => { trackCall(ev).catch((e) => log('error', `history: ${e.message}`)); });
  api.on('presence', (ev) => remember({ at: ev.timestamp, kind: 'presence', type: ev.type, account: ev.account }));
  api.on('status', (st) => remember({ at: st.at || new Date().toISOString(), kind: 'status', state: st.state, reason: st.reason || null }));
  api.on('connected', () => { reconcile().catch((e) => log('error', `history reconcile: ${e.message}`)); });
  api.on('credentials', (c) => {
    if (c && !c.complete) {
      inflight = {};
      persistInflight();
      chrome.storage.local.set({ [WRAPUP_KEY]: [] });
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed') { managedCache = null; fetchManaged().then(() => publishPolicy()).catch(() => {}); }
    // History cleared (Clear history or logout): forget the wrap-up data too.
    if (area === 'local' && changes.callHistory && Array.isArray(changes.callHistory.newValue) && changes.callHistory.newValue.length === 0) {
      chrome.storage.local.set({ [WRAPUP_KEY]: [], [NOTES_KEY]: {} });
    }
  });

  const handlers = {
    'crm:getSettings': () => settingsForUi(),
    'crm:saveSettings': (r) => saveUserSettings(r.values),
    'crm:preview': async (r) => {
      const eff = await effectiveSettings();
      const p = await policy();
      const merged = { ...eff };
      for (const [k, v] of Object.entries(r.values || {})) if (USER_KEYS.includes(k) && !p.locked.includes(k)) merged[k] = v;
      return preview(merged, r.phone, r.name);
    },
    'crm:wrapUpSave': (r) => saveWrapUp(r),
    'crm:wrapUpDismiss': async (r) => { await dropWrapUp(r.key); return { ok: true }; },
    'crm:diagnostics': async () => ({ ok: true, report: await diagnostics() })
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const h = request && handlers[request.action];
    if (!h) return undefined;
    // Only extension pages talk to this module, never content scripts on web pages.
    if (sender && sender.url && !String(sender.url).startsWith(`chrome-extension://${chrome.runtime.id}/`)) {
      sendResponse({ ok: false, error: 'not allowed' });
      return false;
    }
    Promise.resolve().then(() => h(request))
      .then((res) => sendResponse(res))
      .catch((e) => { log('error', `${request.action}: ${e.message}`); sendResponse({ ok: false, error: e.message }); });
    return true;
  });

  // Cold start: until the first real managed read lands, use the last known
  // non-secret policy, so locked tenant / dial prefix / CRM still hold.
  chrome.storage.local.get([MANAGED_CACHE_KEY]).then((r) => {
    if (!managedCache && r && r[MANAGED_CACHE_KEY] && typeof r[MANAGED_CACHE_KEY] === 'object') managedCache = r[MANAGED_CACHE_KEY];
  }).catch(() => {}).finally(() => { publishPolicy().catch(() => {}); });

  self.OneClick.crm = {
    track: 'crm',
    PRESETS, DEFAULTS, MANAGED_MAP,
    templateFor, buildUrl, redactUrl, preview, urlFor,
    effectiveSettings, settingsForUi, saveUserSettings, policy,
    trackCall, saveWrapUp, diagnostics,
    /**
     * Test seam (service worker only, e.g. Playwright sw.evaluate): pretend
     * chrome.storage.managed holds `obj` (null restores the real area).
     */
    async _setManagedForTest(obj) { managedOverride = obj || null; return publishPolicy(); },
    /** Test seam: shorten the managed-read wait (ms). */
    _setManagedWaitForTest(ms) { managedWaitMs = ms; }
  };
})();
