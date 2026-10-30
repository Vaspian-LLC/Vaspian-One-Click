// Track B "status": own presence, DND, call forward, call groups, ACD
// sign-in, park slots, team directory, toolbar badge and the 'toggle-dnd'
// command (service worker).
//
// Built on self.OneClick.api (fleet/ARCHITECTURE.md). Everything the UI
// renders is published to chrome.storage.local:
//   statusState      the live state object (see emptyState())
//   statusDirectory  {at, tenantId, users:[{ext,name,first,last}], contacts:[{id,name,number}]}
//   statusRecent     [{ext|null, number|null, name, at}] coworkers/numbers recently called or talked to
//   statusForwardLast  last call-forward target the user typed
// and chrome.storage.sync.statusFavorites (written by the UI).
//
// The UI sends { action: 'status:<verb>', ... } messages (see onMessage below).
//
// Platform facts this file depends on (fleet/CAPABILITIES.md):
//   - A regular user sees only their OWN presence. Coworker presence returns
//     404 RestrictedDataAccessAttempt, so the directory never asks for it.
//   - There are no WS available/unavailable events on phone registration:
//     "no device" comes from polling presencestatus (alarm, 1 min).
//   - Group events and presence groupStatus are keyed by the group's
//     EXTENSION (e.g. "626"), not its callGroupId; only keys that match a
//     known membership are trusted (monitoring shows up there as a "group").
//   - Call forward has no presence event: its state comes from the PUT
//     response and a follow-up GET.
//   - Permission errors (403/404/405, errorClass 'forbidden') never count
//     toward the PIN lockout; only 401 does, and the client stops on it.
//
// Keep everything inside this IIFE; public surface: self.OneClick.presence.

(function () {
  'use strict';
  const api = self.OneClick.api;

  const STATE_KEY = 'statusState';
  const DIR_KEY = 'statusDirectory';
  const RECENT_KEY = 'statusRecent';
  const FWD_LAST_KEY = 'statusForwardLast';
  const POLL_ALARM = 'statusPresencePoll';

  const CONFIG = {
    eventFallbackMs: 2500,     // a toggle that got 200 but no WS event within this applies the PUT result
    directoryTtlMs: 60 * 60 * 1000,
    directoryMaxPages: 10,
    maxParkSubscriptions: 20,
    maxRecent: 12
  };

  /** Log through background.js addLog with a Status: prefix. Never pass the PIN. */
  function log(level, message, details) {
    try {
      if (typeof addLog === 'function') addLog(level, `Status: ${message}`, details); // eslint-disable-line no-undef
    } catch (e) { /* logging must never break the feature */ }
  }

  // ------------------------------------------------------------ helpers ---
  // Pure functions, exported on self.OneClick.presence.helpers for unit tests.

  /** "Last, First" -> {first, last, display:"First Last"}; other shapes pass through. */
  function formatName(raw, first, last) {
    const f = String(first || '').trim();
    const l = String(last || '').trim();
    if (f || l) return { first: f, last: l, display: [f, l].filter(Boolean).join(' ') };
    // An empty half ("April, " or ", April") leaves a stray comma on live data: drop it.
    const s = String(raw || '').trim().replace(/^,+\s*|\s*,+$/g, '');
    const m = s.match(/^([^,]+),\s*(.+)$/);
    if (m) return { first: m[2].trim(), last: m[1].trim(), display: `${m[2].trim()} ${m[1].trim()}` };
    return { first: s, last: '', display: s };
  }

  /** Initials for an avatar: "Jane Doe" -> "JD", "197" -> "#". */
  function initials(display) {
    const words = String(display || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length || /^\d+$/.test(words[0])) return '#';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  /**
   * Client-side directory search: every word must match the name (word start)
   * or the extension/number (substring). Extension-exact hits sort first.
   * @param {Array<{ext?:string,number?:string,name:string}>} entries
   * @param {string} query
   */
  function searchDirectory(entries, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return entries.slice();
    const words = q.split(/\s+/);
    const digits = q.replace(/\D/g, '');
    const scored = [];
    for (const e of entries) {
      const name = String(e.name || '').toLowerCase();
      const nameWords = name.split(/[\s,.'-]+/);
      const num = String(e.ext || e.number || '');
      let score = 0;
      const allMatch = words.every((w) => {
        const wd = w.replace(/\D/g, '');
        if (nameWords.some((nw) => nw.startsWith(w))) { score += 2; return true; }
        if (w.length >= 3 && name.includes(w)) { score += 1; return true; } // mid-word only for 3+ letters
        if (wd && wd === w && num.includes(wd)) { score += num === wd ? 5 : 1; return true; }
        return false;
      });
      if (!allMatch && digits && digits === q.replace(/[\s()+-]/g, '') && num.includes(digits)) { scored.push({ e, score: num === digits ? 5 : 1 }); continue; }
      if (allMatch) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.e.name).localeCompare(String(b.e.name)));
    return scored.map((x) => x.e);
  }

  /**
   * Only trust groupStatus keys that are one of the user's known groups
   * (monitoring relationships also appear there, e.g. "196":"groupLeft").
   * @returns {Object<string, boolean>} group extension -> joined
   */
  function trustedGroupStatus(groupStatus, groups) {
    const out = {};
    if (!groupStatus || typeof groupStatus !== 'object') return out;
    const known = new Set((groups || []).map((g) => String(g.extension)));
    for (const [k, v] of Object.entries(groupStatus)) {
      if (known.has(String(k))) out[k] = v === 'groupJoined';
    }
    return out;
  }

  const BADGE = {
    signedout: { text: '', color: '#6b7280', label: 'Not signed in' },
    offline: { text: '!', color: '#d97706', label: 'Not connected' },
    connecting: { text: '', color: '#6b7280', label: 'Connecting' },
    ringing: { text: 'RING', color: '#E66825', label: 'Incoming call' },
    oncall: { text: 'CALL', color: '#2954A4', label: 'On a call' },
    nodevice: { text: 'OFF', color: '#6b7280', label: 'No phone connected' },
    dnd: { text: 'DND', color: '#dc2626', label: 'Do not disturb' },
    forward: { text: 'FWD', color: '#E66825', label: 'Forwarding' },
    missed: { text: '', color: '#dc2626', label: 'Missed calls' },
    available: { text: '', color: '#16a34a', label: 'Available' }
  };

  /**
   * One overall status for the toolbar badge and the header pill.
   * Precedence: signed out > connection problem > ringing > on a call >
   * no phone > DND > forwarding > unseen missed calls (count) > available.
   * (All calls forwarded means nothing rings here: never say "Available".) (A live call
   * proves a device; "no phone" beats DND because nothing can ring at all.)
   * Missed calls come from Track A (local.callcardMissedUnseen), passed in as s.missedUnseen.
   * @param {object} s statusState
   * @param {object} conn apiStatus
   * @returns {{key:string, text:string, color:string, label:string, title:string}}
   */
  function deriveStatus(s, conn) {
    const c = conn || {};
    let key;
    if (c.state === 'off' && c.reason === 'no_credentials') key = 'signedout';
    else if (c.state === 'error' || (c.state === 'off' && c.reason === 'stopped')) key = 'offline';
    else if (c.state === 'off' && !s.ready) key = 'signedout';
    else if ((c.state === 'connecting' || c.state === 'retrying') && !s.ready) key = c.state === 'retrying' ? 'offline' : 'connecting';
    else {
      const calls = Object.values(s.calls || {});
      if (calls.some((x) => x.phase === 'ringing')) key = 'ringing';
      else if (calls.length || s.callStatus === 'busy') key = 'oncall';
      else if (s.availability === 'unavailable') key = 'nodevice';
      else if (s.dnd) key = 'dnd';
      else if (s.forward && s.forward.active) key = 'forward';
      else if (s.missedUnseen > 0 && s.ready) key = 'missed';
      else if (s.ready) key = 'available';
      else key = 'connecting';
    }
    let b = BADGE[key];
    // A rejected PIN needs the user, not a retry: say so in the pill and title.
    if (key === 'offline' && c.reason === 'auth') b = { ...b, color: '#dc2626', label: 'PIN rejected' };
    const extras = [];
    if (key === 'offline' && c.reason === 'auth') extras.push('update your PIN in Settings');
    if (key !== 'dnd' && s.dnd && key !== 'signedout' && key !== 'offline') extras.push('Do not disturb on');
    if (s.forward && s.forward.active && key !== 'forward') extras.push(`forwarding to ${s.forward.targetName || s.forward.target || 'another number'}`);
    if (key === 'nodevice') extras.push('calls can’t ring here until a phone or softphone signs in');
    const missed = Number(s.missedUnseen) || 0;
    let label = b.label;
    let text = b.text;
    if (key === 'forward') {
      const to = s.forward.targetName || s.forward.target || '';
      label = to ? `Forwarding to ${to}` : 'Forwarding calls';
    }
    if (key === 'missed') {
      label = missed === 1 ? '1 missed call' : `${missed} missed calls`;
      text = missed > 9 ? '9+' : String(missed);
    } else if (missed > 0 && key !== 'signedout' && key !== 'offline') {
      extras.push(missed === 1 ? '1 missed call' : `${missed} missed calls`);
    }
    const title = `Vaspian One Click: ${label}${extras.length ? ` (${extras.join('; ')})` : ''}`;
    // The pill keeps saying "Available" when the only news is missed calls.
    return { key, text, color: b.color, label: key === 'missed' ? 'Available' : label, title };
  }

  /** Every array/object item under a HAL body's _embedded (tolerant: shapes not captured live). */
  function halItems(body) {
    if (!body || typeof body !== 'object') return [];
    if (Array.isArray(body)) return body;
    const emb = body._embedded;
    if (emb && typeof emb === 'object') {
      for (const v of Object.values(emb)) {
        if (Array.isArray(v)) return v;
      }
      const objs = Object.values(emb).filter((v) => v && typeof v === 'object');
      if (objs.length === 1) return objs;
    }
    return [];
  }

  /** Strip the API prefix from a HAL href so it can be passed to api.request(). */
  function relPath(href) {
    if (!href) return null;
    let p = String(href).replace(/^https?:\/\/[^/]+/, '').replace(/\{[^}]*\}/g, '');
    p = p.replace(/^\/?api\/v1\//, '');
    return p.replace(/^\//, '');
  }

  /** HAL embeds can be one object or (as seen live) a one-element array. */
  const one = (v) => (Array.isArray(v) ? v[0] : v);

  /**
   * Parse one callGroupMember (tolerant). Live shape (2026-10-29):
   * { extension: <MEMBER ext>, loggedIn, _embedded: { callGroup: [{ callGroupId,
   * extension: <GROUP ext>, name, callGroupType }], extension: [<member>] } }.
   * The group's extension comes only from the group object: item.extension
   * is the member's own extension.
   */
  function parseGroup(item, tid, ext) {
    const emb = (item && item._embedded) || {};
    const g = one(emb.callGroup) || one(emb.callingGroup) || one(item.callGroup) || item;
    const href = relPath(item && item._links && item._links.self && item._links.self.href);
    let id = g.callGroupId || item.callGroupId || null;
    if (!id && href) id = (href.match(/callinggroups\/(\d+)/) || [])[1] || null;
    if (!id) return null;
    id = String(id);
    const memberPath = href && new RegExp(`^tenants/\\d+/callinggroups/${id}/members/\\d+$`).test(href)
      ? href : `tenants/${tid}/callinggroups/${id}/members/${ext}`;
    const extension = g !== item && g.extension != null ? String(g.extension) : null;
    return {
      callGroupId: id,
      extension,
      name: String(g.name || (extension ? `Group ${extension}` : `Group ${id}`)),
      type: g.callGroupType || null,
      queueEnabled: !!g.queueEnabled,
      loggedIn: item.loggedIn !== false,
      path: memberPath
    };
  }

  /** Parse GET callforward (tolerant). */
  function parseForward(body) {
    if (!body || typeof body !== 'object') return null;
    const active = body.active === true;
    if (!active) return { active: false, type: null, target: null, targetName: null };
    const emb = body._embedded || {};
    let targetName = null;
    for (const v of Object.values(emb)) {
      if (v && typeof v === 'object') {
        const n = formatName(v.name, v.firstName, v.lastName).display;
        if (n) { targetName = n; break; }
      }
    }
    return {
      active: true,
      type: body.callForwardTargetType || null,
      target: body.targetNumber != null ? String(body.targetNumber) : null,
      targetName
    };
  }

  /** Parse one directory extension item. */
  function parseExtension(item) {
    const emb = (item && item._embedded) || {};
    const u = emb.user || emb.userExtension || {};
    const ext = item.extension != null ? String(item.extension) : null;
    if (!ext) return null;
    const n = formatName(item.name, u.firstName, u.lastName);
    return { ext, name: n.display || `Extension ${ext}`, first: n.first, last: n.last, enabled: item.enabled !== false };
  }

  /** Parse one park slot (REST snapshot or event). */
  function parsePark(item) {
    const acct = String(item.accountId || item.observedParty || '');
    const n = item.parkLocationNumber != null ? String(item.parkLocationNumber) : ((acct.match(/^PL(\d+)@/i) || [])[1] || null);
    if (!n) return null;
    return {
      number: n,
      accountId: acct || null,
      status: String(item.status || item.event || 'idle').toLowerCase() === 'busy' ? 'busy' : 'idle',
      parkedName: item.parkedPartyName || null,
      parkedNumber: item.parkedPartyNumber || null,
      parkedBy: item.parkingPartyName || item.parkingPartyNumber || null
    };
  }

  // -------------------------------------------------------------- state ---
  function emptyState() {
    return {
      ready: false,             // session known and the first snapshot loaded
      account: null, extension: null, tenantId: null, isAdmin: false,
      availability: null,       // 'available' | 'unavailable' (device registration)
      callStatus: null,         // 'idle' | 'busy'
      dnd: null, acd: null,
      forward: null,            // {active, type, target, targetName}
      phones: null,             // registered phones (myphones count), null = unknown
      groups: [], groupsLoaded: false,
      park: [], parkLoaded: false,
      calls: {},                // callId -> {phase:'ringing'|'dialing'|'active'|'held', party, since}
      missedUnseen: 0,          // Track A's local.callcardMissedUnseen (badge count)
      transfer: null,           // {phase:'consulting'|'completing', originalCallId, consultCallId, to, name}
      pending: {},              // control key -> true while a request is in flight
      errors: {},               // control key -> user-readable message (last failure)
      disabled: {},             // control key -> reason the control is unavailable for this account/device
      view: deriveStatus({}, { state: 'off', reason: 'no_credentials' }),
      updatedAt: null
    };
  }

  let state = emptyState();
  let conn = api.getStatus ? api.getStatus() : {};
  let publishTimer = null;
  const waiters = new Map();   // control key -> {timer}
  const parkSubscribed = new Set(); // park slot numbers already subscribed (the client re-applies them on reconnect)
  let lastRefreshAt = 0;

  function publish() {
    state.view = deriveStatus(state, conn);
    state.updatedAt = new Date().toISOString();
    clearTimeout(publishTimer);
    publishTimer = setTimeout(() => {
      chrome.storage.local.set({ [STATE_KEY]: state }).catch(() => {});
      updateBadge();
    }, 30);
  }

  let lastBadge = null;
  function updateBadge() {
    const v = state.view;
    const sig = `${v.text}|${v.color}|${v.title}`;
    if (sig === lastBadge || !chrome.action) return;
    lastBadge = sig;
    try {
      chrome.action.setBadgeText({ text: v.text });
      chrome.action.setBadgeBackgroundColor({ color: v.color });
      if (chrome.action.setBadgeTextColor) chrome.action.setBadgeTextColor({ color: '#ffffff' });
      chrome.action.setTitle({ title: v.title });
    } catch (e) { /* action API unavailable (tests) */ }
  }

  function session() { return api.getSession ? api.getSession() : null; }

  function adoptSession(s) {
    if (!s) return;
    if (state.account && state.account !== s.account) resetForNewAccount();
    state.account = s.account;
    state.extension = s.extension;
    state.tenantId = s.tenantId;
    state.isAdmin = !!s.isAdmin;
  }

  function resetForNewAccount() {
    for (const w of waiters.values()) clearTimeout(w.timer);
    waiters.clear();
    for (const n of parkSubscribed) api.unsubscribe('parklocation', `PL${n}`);
    parkSubscribed.clear();
    lastRefreshAt = 0;
    state = emptyState();
    chrome.storage.local.remove([DIR_KEY, RECENT_KEY]).catch(() => {});
  }

  /** User-readable message for a failed request. */
  function failureMessage(res, what) {
    switch (res && res.errorClass) {
      case 'forbidden': return `${what} isn’t available for your account.`;
      case 'device': return `${what} isn’t supported by your phone.`;
      case 'auth': case 'stopped': return 'Not connected. Check your PIN in Settings.';
      case 'network': case 'timeout': return `Couldn’t reach the phone system. ${what} wasn’t changed.`;
      case 'busy': case 'server': return `The phone system is busy. Try ${what.toLowerCase()} again in a moment.`;
      case 'notFound': return `${what} isn’t available right now.`;
      default: return (res && res.message) || `${what} failed (${(res && res.status) || 'no response'}).`;
    }
  }

  function setPending(key, on) {
    if (on) state.pending[key] = true; else delete state.pending[key];
  }

  /**
   * Wait for the WS event that confirms a change. If none arrives within
   * eventFallbackMs, apply the PUT result instead (the socket may be down).
   */
  function awaitEvent(key, applyFallback) {
    const old = waiters.get(key);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      waiters.delete(key);
      if (!state.pending[key]) return;
      applyFallback();
      setPending(key, false);
      publish();
    }, CONFIG.eventFallbackMs);
    waiters.set(key, { timer });
  }

  function confirmEvent(key) {
    const w = waiters.get(key);
    if (w) { clearTimeout(w.timer); waiters.delete(key); }
    setPending(key, false);
  }

  // ---------------------------------------------------------- snapshots ---
  async function loadPresence() {
    const res = await api.getPresence();
    if (!res.ok || !res.body) return res;
    const b = res.body;
    if (b.availability) state.availability = b.availability;
    if (b.callStatus) {
      state.callStatus = b.callStatus;
      if (b.callStatus === 'idle') state.calls = {};
    }
    if (!state.pending.dnd && b.dndStatus) state.dnd = b.dndStatus === 'dndOn';
    if (!state.pending.acd && b.acdAvailability) state.acd = b.acdAvailability === 'signedInAcd';
    const gs = trustedGroupStatus(b.groupStatus, state.groups);
    for (const g of state.groups) {
      if (g.extension in gs && !state.pending[`group:${g.callGroupId}`]) g.loggedIn = gs[g.extension];
    }
    return res;
  }

  async function loadForward() {
    const res = await api.request('GET', `tenants/${state.tenantId}/users/${state.extension}/callforward`);
    if (res.ok) {
      const f = parseForward(res.body);
      if (f) state.forward = await nameForward(f);
      delete state.disabled.forward;
    } else if (res.errorClass === 'forbidden') {
      state.disabled.forward = 'Call forwarding isn’t available for your account.';
    }
    return res;
  }

  async function nameForward(f) {
    if (!f || !f.active || f.targetName || !f.target) return f;
    const dir = await readDirectory();
    const hit = dir && dir.users.find((u) => u.ext === f.target);
    if (hit) f.targetName = hit.name;
    return f;
  }

  async function loadGroups() {
    const res = await api.request('GET', `tenants/${state.tenantId}/users/${state.extension}/callinggroups?expand=item`);
    if (res.ok) {
      const groups = halItems(res.body).map((it) => parseGroup(it, state.tenantId, state.extension)).filter(Boolean);
      groups.sort((a, b) => a.name.localeCompare(b.name));
      state.groups = groups;
      state.groupsLoaded = true;
      delete state.disabled.groups;
    } else if (res.errorClass === 'forbidden') {
      state.groups = [];
      state.groupsLoaded = true;
      state.disabled.groups = 'Call groups aren’t available for your account.';
    }
    return res;
  }

  async function loadPark() {
    const res = await api.request('GET', `presencestatus/tenants/${state.tenantId}/parklocations`);
    if (res.ok) {
      const prev = new Map(state.park.map((p) => [p.number, p]));
      const slots = halItems(res.body).map(parsePark).filter(Boolean);
      slots.sort((a, b) => Number(a.number) - Number(b.number));
      state.park = slots.map((s) => {
        const p = prev.get(s.number);
        // Keep names learned from events; REST status may not carry them.
        if (p && s.status === 'busy' && p.status === 'busy') {
          return { ...s, parkedName: s.parkedName || p.parkedName, parkedNumber: s.parkedNumber || p.parkedNumber, parkedBy: s.parkedBy || p.parkedBy, since: p.since };
        }
        return { ...s, since: s.status === 'busy' ? new Date().toISOString() : null };
      });
      state.parkLoaded = true;
      delete state.disabled.park;
      // The client remembers subscriptions across reconnects: ask once per slot.
      for (const s of state.park.slice(0, CONFIG.maxParkSubscriptions)) {
        if (parkSubscribed.has(s.number)) continue;
        parkSubscribed.add(s.number);
        api.subscribe('parklocation', `PL${s.number}`);
      }
    } else if (res.errorClass === 'forbidden') {
      state.park = [];
      state.parkLoaded = true;
      state.disabled.park = 'Park slots aren’t available for your account.';
    }
    return res;
  }

  async function loadPhones() {
    const r = await api.getMyPhones({ force: true });
    if (r.ok) state.phones = r.phones.length;
    return r;
  }

  /** Resync own calls after a reconnect (events may have been missed). */
  async function resyncCalls() {
    const r = await api.getActiveCalls();
    if (!r.ok) return r;
    const live = new Set(r.calls.map((c) => c.callId).filter(Boolean));
    for (const id of Object.keys(state.calls)) if (!live.has(id)) delete state.calls[id];
    for (const c of r.calls) {
      if (!c.callId || state.calls[c.callId]) continue;
      const from = api.normalizeParty(c.from, { selfExt: state.extension });
      const to = api.normalizeParty(c.to, { selfExt: state.extension });
      const other = from && from.isSelf ? to : from;
      state.calls[c.callId] = { phase: 'active', party: partySummary(other), since: new Date().toISOString() };
    }
    return r;
  }

  let refreshing = null;
  /**
   * Load everything once the socket is up (and on demand).
   * @param {{maxAgeMs?:number}} [opts] skip if the last full refresh is newer than this
   */
  function refreshAll(opts = {}) {
    if (refreshing) return refreshing;
    if (opts.maxAgeMs && state.ready && Date.now() - lastRefreshAt < opts.maxAgeMs) return Promise.resolve({ ok: true, fresh: true });
    refreshing = (async () => {
      lastRefreshAt = Date.now();
      const s = await api.ensureSession();
      if (!s.ok) return { ok: false, errorClass: s.errorClass };
      adoptSession(session());
      // Groups first so presence groupStatus can be mapped onto them.
      await loadGroups();
      await Promise.all([loadPresence(), loadForward(), loadPhones(), loadPark(), resyncCalls()]);
      state.ready = true;
      publish();
      loadDirectory(false).catch(() => {});
      return { ok: true };
    })().finally(() => { refreshing = null; });
    return refreshing;
  }

  // ------------------------------------------------------------ toggles ---
  /**
   * Turn DND on or off. Resolves when the server accepted the PUT; the
   * published state flips when the dndOn/dndOff event arrives.
   */
  async function setDnd(active) {
    if (!state.tenantId) return { ok: false, message: 'Not connected yet.' };
    if (state.pending.dnd) return { ok: false, message: 'Already changing Do not disturb.' };
    const want = !!active;
    setPending('dnd', true);
    delete state.errors.dnd;
    publish();
    const res = await api.request('PUT', `tenants/${state.tenantId}/users/${state.extension}/dnd`, { body: { active: want } });
    if (!res.ok) {
      setPending('dnd', false);
      state.errors.dnd = failureMessage(res, 'Do not disturb');
      if (res.errorClass === 'forbidden') state.disabled.dnd = state.errors.dnd;
      log('warning', `DND ${want ? 'on' : 'off'} refused: ${res.status} ${res.errorCode || ''}`.trim());
      publish();
      return { ok: false, message: state.errors.dnd };
    }
    log('info', `DND ${want ? 'on' : 'off'} accepted; waiting for the presence event`);
    awaitEvent('dnd', () => { state.dnd = res.body && typeof res.body.active === 'boolean' ? res.body.active : want; });
    return { ok: true };
  }

  async function toggleDnd() {
    if (state.dnd === null && state.tenantId) await loadPresence();
    return setDnd(!state.dnd);
  }

  /** Global ACD (queue) sign-in. */
  async function setAcd(active) {
    if (!state.tenantId) return { ok: false, message: 'Not connected yet.' };
    if (state.pending.acd) return { ok: false, message: 'Already changing queue sign-in.' };
    const want = !!active;
    setPending('acd', true);
    delete state.errors.acd;
    publish();
    const res = await api.request('PUT', `tenants/${state.tenantId}/users/${state.extension}/loginacd`, { body: { active: want } });
    if (!res.ok) {
      setPending('acd', false);
      state.errors.acd = failureMessage(res, 'Queue sign-in');
      if (res.errorClass === 'forbidden') state.disabled.acd = state.errors.acd;
      publish();
      return { ok: false, message: state.errors.acd };
    }
    log('info', `ACD ${want ? 'sign in' : 'sign out'} accepted`);
    awaitEvent('acd', () => { state.acd = res.body && typeof res.body.active === 'boolean' ? res.body.active : want; });
    return { ok: true };
  }

  /** Join or leave one call group (by callGroupId). */
  async function setGroup(callGroupId, loggedIn) {
    const g = state.groups.find((x) => x.callGroupId === String(callGroupId));
    if (!g) return { ok: false, message: 'Unknown group.' };
    const key = `group:${g.callGroupId}`;
    if (state.pending[key]) return { ok: false, message: 'Already changing this group.' };
    const want = !!loggedIn;
    setPending(key, true);
    delete state.errors[key];
    publish();
    const res = await api.request('PUT', g.path, { body: { loggedIn: want } });
    if (!res.ok) {
      setPending(key, false);
      state.errors[key] = failureMessage(res, want ? 'Joining this group' : 'Leaving this group');
      publish();
      return { ok: false, message: state.errors[key] };
    }
    log('info', `${want ? 'join' : 'leave'} group ${g.name} (${g.extension}) accepted`);
    awaitEvent(key, () => {
      const cur = state.groups.find((x) => x.callGroupId === g.callGroupId);
      if (cur) cur.loggedIn = res.body && typeof res.body.loggedIn === 'boolean' ? res.body.loggedIn : want;
    });
    return { ok: true };
  }

  /**
   * Call forward (always). target: an extension (forward to a coworker) or a
   * phone number (external). No presence event exists for this, so the state
   * comes from the response and a follow-up GET.
   */
  async function setForward(active, target) {
    if (!state.tenantId) return { ok: false, message: 'Not connected yet.' };
    if (state.pending.forward) return { ok: false, message: 'Already changing call forwarding.' };
    let body = { active: false };
    if (active) {
      const digits = String(target || '').replace(/\D/g, '');
      if (!digits) return { ok: false, message: 'Enter an extension or phone number to forward to.' };
      if (digits === state.extension) return { ok: false, message: 'You can’t forward calls to yourself.' };
      const internal = digits.length <= 6;
      if (!internal && digits.length < 10) return { ok: false, message: 'Enter a 10-digit phone number or an extension.' };
      body = { active: true, callForwardTargetType: internal ? 'coworker' : 'external', targetNumber: digits };
      chrome.storage.local.set({ [FWD_LAST_KEY]: digits }).catch(() => {});
    }
    setPending('forward', true);
    delete state.errors.forward;
    publish();
    const res = await api.request('PUT', `tenants/${state.tenantId}/users/${state.extension}/callforward`, { body });
    if (!res.ok) {
      setPending('forward', false);
      state.errors.forward = failureMessage(res, 'Call forwarding');
      if (res.errorClass === 'forbidden') state.disabled.forward = state.errors.forward;
      publish();
      return { ok: false, message: state.errors.forward };
    }
    const echoed = parseForward(res.body);
    state.forward = await nameForward(echoed && (echoed.active || !active) ? echoed
      : { active: !!active, type: body.callForwardTargetType || null, target: body.targetNumber || null, targetName: null });
    setPending('forward', false);
    publish();
    log('info', active ? `call forward on (${body.callForwardTargetType})` : 'call forward off');
    loadForward().then(publish).catch(() => {});
    return { ok: true };
  }

  // --------------------------------------------------------------- park ---
  /** Retrieve a parked call to the user's phone (3PCC; needs a registered device). */
  async function retrievePark(number) {
    const n = String(number || '').replace(/\D/g, '');
    const slot = state.park.find((p) => p.number === n);
    if (!slot) return { ok: false, message: 'Unknown park slot.' };
    if (state.disabled.retrieve) return { ok: false, message: state.disabled.retrieve };
    if (state.phones === 0) return { ok: false, message: 'Retrieving needs a desk phone or softphone that’s signed in.' };
    const key = `park:${n}`;
    if (state.pending[key]) return { ok: false, message: 'Already retrieving.' };
    setPending(key, true);
    delete state.errors[key];
    publish();
    const res = await api.request('POST', 'calls', { body: { request: 'retrieveParkedCall', from: state.account, featureData: n } });
    setPending(key, false);
    if (!res.ok) {
      const msg = failureMessage(res, 'Retrieving a parked call');
      if (res.errorClass === 'device' || res.errorClass === 'forbidden') state.disabled.retrieve = msg;
      else state.errors[key] = msg;
      log('warning', `retrieve park ${n} refused: ${res.status} ${res.errorCode || ''}`.trim());
      publish();
      return { ok: false, message: msg };
    }
    log('info', `retrieve park ${n} accepted`);
    publish();
    return { ok: true, message: 'Your phone will ring with the parked call.' };
  }

  // ---------------------------------------------------------- directory ---
  async function readDirectory() {
    const r = await chrome.storage.local.get(DIR_KEY);
    const d = r[DIR_KEY];
    return d && d.tenantId === state.tenantId ? d : null;
  }

  let dirLoading = null;
  /** Team directory (names + extensions) and external contacts, cached for an hour. */
  function loadDirectory(force) {
    if (dirLoading) return dirLoading;
    dirLoading = (async () => {
      if (!state.tenantId) return { ok: false, message: 'Not connected yet.' };
      const cached = await readDirectory();
      if (!force && cached && Date.now() - cached.at < CONFIG.directoryTtlMs) return { ok: true, cached: true };
      const users = [];
      let path = `tenants/${state.tenantId}/extensions?extensionType=userExt&expand=item`;
      let first = null;
      for (let page = 0; path && page < CONFIG.directoryMaxPages; page++) {
        const res = await api.request('GET', path);
        if (!first) first = res;
        if (!res.ok) break;
        for (const it of halItems(res.body)) {
          const e = parseExtension(it);
          if (e && e.enabled && e.ext !== state.extension && (!it.extensionType || it.extensionType === 'userExt')) users.push(e);
        }
        const next = res.body && res.body._links && res.body._links.next && relPath(res.body._links.next.href);
        path = next && next.startsWith(`tenants/${state.tenantId}/extensions`) ? next : null;
      }
      if (!first || !first.ok) {
        if (first && first.errorClass === 'forbidden') state.disabled.directory = 'The team directory isn’t available for your account.';
        publish();
        return { ok: false, message: failureMessage(first, 'Loading the directory') };
      }
      const seen = new Set();
      const unique = users.filter((u) => (seen.has(u.ext) ? false : seen.add(u.ext)));
      unique.sort((a, b) => a.name.localeCompare(b.name));
      let contacts = [];
      const cr = await api.request('GET', `tenants/${state.tenantId}/externalcontacts?expand=item`);
      if (cr.ok) {
        contacts = halItems(cr.body).map((c) => ({
          id: String(c.externalContactId || c.id || c.phoneNumber || ''),
          name: String(c.name || c.phoneNumber || ''),
          number: String(c.phoneNumber || '').replace(/\D/g, '')
        })).filter((c) => c.number);
        contacts.sort((a, b) => a.name.localeCompare(b.name));
      }
      delete state.disabled.directory;
      await chrome.storage.local.set({ [DIR_KEY]: { at: Date.now(), tenantId: state.tenantId, users: unique, contacts } });
      if (state.forward && state.forward.active && !state.forward.targetName) { state.forward = await nameForward(state.forward); }
      publish();
      log('info', `directory loaded: ${unique.length} coworkers, ${contacts.length} contacts`);
      return { ok: true, count: unique.length };
    })().finally(() => { dirLoading = null; });
    return dirLoading;
  }

  async function addRecent(entry) {
    if (!entry || (!entry.ext && !entry.number)) return;
    const r = await chrome.storage.local.get(RECENT_KEY);
    const list = (r[RECENT_KEY] || []).filter((x) => !(entry.ext ? x.ext === entry.ext : x.number === entry.number));
    list.unshift({ ext: entry.ext || null, number: entry.number || null, name: entry.name || '', at: Date.now() });
    await chrome.storage.local.set({ [RECENT_KEY]: list.slice(0, CONFIG.maxRecent) });
  }

  // -------------------------------------------------------------- calls ---
  function partySummary(p, name) {
    if (!p) return { ext: null, number: null, display: name || 'Unknown', name: name || '' };
    return { ext: p.isInternal ? p.ext : null, number: p.number || (p.isInternal ? null : p.digits), display: name || p.display, name: name || '' };
  }

  /** The call a "transfer here" would move: prefer Track A's view, else ours. */
  function activeCall() {
    const calls = self.OneClick.calls;
    try {
      if (calls && typeof calls.getActiveCall === 'function') {
        const c = calls.getActiveCall();
        if (c && c.callId) return { callId: c.callId, phase: c.phase || c.state || 'active' };
      } else if (calls && typeof calls.getStore === 'function') {
        // Track A's store: {calls: {callId: {state:'connected'|'held'|..., consultFor}}}
        const recs = Object.values((calls.getStore() || {}).calls || {})
          .filter((r) => (r.state === 'connected' || r.state === 'held') && !r.consultFor);
        if (recs.length) {
          const r = recs.find((x) => x.state === 'connected') || recs[0];
          return { callId: r.callId, phase: r.state === 'held' ? 'held' : 'active' };
        }
        if (Object.keys((calls.getStore() || {}).calls || {}).length) return null;
      }
    } catch (e) { /* fall back to our own tracking */ }
    const t = state.transfer;
    const entries = Object.entries(state.calls).filter(([id, c]) => (c.phase === 'active' || c.phase === 'held') && !(t && id === t.consultCallId));
    if (!entries.length) return null;
    return { callId: entries[0][0], phase: entries[0][1].phase };
  }

  function onCall(ev) {
    if (!ev || !ev.callId) return;
    const id = ev.callId;
    const cur = state.calls[id];
    const other = ev.direction === 'outbound' ? ev.to : ev.from;
    const summary = cur ? cur.party : partySummary(other && !other.isSelf ? other : null, ev.callingName);
    const set = (phase) => { state.calls[id] = { phase, party: summary, since: (cur && cur.since) || ev.timestamp || new Date().toISOString() }; };
    switch (ev.type) {
      case 'offer': case 'ringing': if (!cur || cur.phase === 'ringing') set('ringing'); break;
      case 'dial': case 'ringback': if (!cur) set('dialing'); break;
      case 'answer': set('active');
        if (summary && (summary.ext || summary.number)) addRecent(summary).catch(() => {});
        break;
      case 'hold': case 'held': set('held'); break;
      case 'resume': case 'resumed': case 'retrieve': case 'retrieved': set('active'); break;
      case 'park': case 'parked': delete state.calls[id]; break;
      case 'end': delete state.calls[id];
        if (state.transfer && (state.transfer.consultCallId === id || state.transfer.originalCallId === id)) state.transfer = null;
        break;
      default: if (!cur && ev.isNew) set('active');
    }
    // Own park events carry who was parked; attach it to the slot.
    if ((ev.type === 'park' || ev.type === 'parked') && ev.raw && ev.raw.parkLocationId != null) {
      const slot = state.park.find((p) => p.number === String(ev.raw.parkLocationId));
      if (slot) Object.assign(slot, { status: 'busy', parkedName: ev.raw.parkedPartyName || slot.parkedName, parkedNumber: ev.raw.parkedPartyNumber || slot.parkedNumber, parkedBy: ev.raw.parkingPartyName || slot.parkedBy, since: slot.since || ev.timestamp });
    }
    publish();
  }

  // ----------------------------------------------------------- transfer ---
  // Contract with Track A (documented in fleet/STATE.md):
  //   - If self.OneClick.calls.transfer(to, {name}) exists, the directory's
  //     "Transfer here" delegates to it and Track A owns the whole flow.
  //   - Otherwise this module runs an attended transfer: makeCall(to) starts
  //     a consult call, the user talks, then completeTransfer() POSTs
  //     transfer on the consult call with otherCallId = the original call.
  async function transfer(to, name) {
    const digits = String(to || '').replace(/[^\d*#]/g, '');
    if (!digits) return { ok: false, message: 'Nothing to transfer to.' };
    const calls = self.OneClick.calls;
    if (calls && typeof calls.transfer === 'function') {
      try {
        const r = await calls.transfer(digits, { name });
        return r && typeof r === 'object' ? r : { ok: !!r };
      } catch (e) { return { ok: false, message: e.message }; }
    }
    if (calls && typeof calls.startTransfer === 'function') {
      // Track A owns the transfer (its call card shows Complete / Cancel).
      const a = activeCall();
      if (!a) return { ok: false, message: 'There’s no active call to transfer.' };
      try {
        const r = await calls.startTransfer(a.callId, digits, 'consult');
        if (r && r.ok) {
          // Mirror Track A's consult so the Team tab banner can offer
          // Complete / Cancel too; both buttons route back to calls.js.
          state.transfer = { phase: 'consulting', delegated: true, originalCallId: a.callId, consultCallId: r.consultCallId || null, to: digits, name: name || digits };
          delete state.errors.transfer;
          publish();
          return { ok: true, consult: true, message: r.message || `Calling ${name || digits}. Complete the transfer when ready.` };
        }
        return { ok: false, message: (r && r.message) || 'Transfer failed.' };
      } catch (e) { return { ok: false, message: e.message }; }
    }
    if (state.disabled.transfer) return { ok: false, message: state.disabled.transfer };
    if (state.transfer) return { ok: false, message: 'A transfer is already in progress.' };
    const orig = activeCall();
    if (!orig) return { ok: false, message: 'There’s no active call to transfer.' };
    setPending('transfer', true);
    publish();
    const res = await api.makeCall(api.dialString(digits, await api.dialPrefix()));
    setPending('transfer', false);
    if (!res.ok || !res.callId) {
      const msg = res.ok ? 'The phone system didn’t return the new call.' : failureMessage(res, 'Transfer');
      if (res.errorClass === 'device' || res.errorClass === 'forbidden') state.disabled.transfer = msg;
      state.errors.transfer = msg;
      publish();
      return { ok: false, message: msg };
    }
    state.transfer = { phase: 'consulting', originalCallId: orig.callId, consultCallId: res.callId, to: digits, name: name || digits };
    delete state.errors.transfer;
    log('info', `transfer: consult call started to ${digits.length <= 6 ? digits : 'external number'}`);
    publish();
    return { ok: true, consult: true, message: `Calling ${name || digits}. Complete the transfer when ready.` };
  }

  async function completeTransfer() {
    const t = state.transfer;
    if (!t) return { ok: false, message: 'No transfer in progress.' };
    if (t.delegated) {
      const calls = self.OneClick.calls;
      t.phase = 'completing';
      publish();
      const r = calls && typeof calls.completeTransfer === 'function'
        ? await calls.completeTransfer(t.originalCallId)
        : { ok: false, message: 'Transfer failed.' };
      if (r && r.ok) { state.transfer = null; delete state.errors.transfer; publish(); return { ok: true, message: 'Transferred.' }; }
      if (state.transfer) state.transfer.phase = 'consulting';
      state.errors.transfer = (r && r.message) || 'Transfer failed.';
      publish();
      return { ok: false, message: state.errors.transfer };
    }
    t.phase = 'completing';
    publish();
    const res = await api.callControl(t.consultCallId, 'transfer', { otherCallId: t.originalCallId });
    if (!res.ok) {
      t.phase = 'consulting';
      const msg = failureMessage(res, 'Transfer');
      if (res.errorClass === 'device') state.disabled.transfer = msg;
      state.errors.transfer = msg;
      publish();
      return { ok: false, message: msg };
    }
    state.transfer = null;
    delete state.errors.transfer;
    publish();
    log('info', 'transfer completed');
    return { ok: true, message: 'Transferred.' };
  }

  async function cancelTransfer() {
    const t = state.transfer;
    if (!t) return { ok: true };
    if (t.delegated) {
      const calls = self.OneClick.calls;
      state.transfer = null;
      publish();
      const r = calls && typeof calls.cancelTransfer === 'function' ? await calls.cancelTransfer(t.originalCallId) : { ok: true };
      return r && r.ok === false ? { ok: false, message: r.message || 'Cancelling the transfer failed.' } : { ok: true };
    }
    const res = await api.callControl(t.consultCallId, 'hangupCall');
    state.transfer = null;
    publish();
    return res.ok || res.errorClass === 'notFound' ? { ok: true } : { ok: false, message: failureMessage(res, 'Cancelling the transfer') };
  }

  // ------------------------------------------------------------- events ---
  api.on('presence', (ev) => {
    // Only our own account is subscribed; ignore anything else defensively.
    if (!ev || (ev.account && state.extension && !api.sameParty(ev.account, state.extension))) return;
    switch (ev.type) {
      case 'dndOn': case 'dndOff':
        state.dnd = ev.type === 'dndOn';
        confirmEvent('dnd');
        delete state.errors.dnd;
        break;
      case 'signedInAcd': case 'signedOutAcd':
        state.acd = ev.type === 'signedInAcd';
        confirmEvent('acd');
        break;
      case 'joinedGroup': case 'leftGroup': {
        const ext = String(ev.groupJoined || ev.groupLeft || '');
        const g = state.groups.find((x) => x.extension === ext);
        if (!g) { refreshAll(); return; } // a group we didn't know about: reload the list
        g.loggedIn = ev.type === 'joinedGroup';
        confirmEvent(`group:${g.callGroupId}`);
        break;
      }
      case 'busy': state.callStatus = 'busy'; break;
      case 'idle': state.callStatus = 'idle'; state.calls = {}; state.transfer = null; break;
      case 'available': case 'unavailable': state.availability = ev.type; break;
      default: return;
    }
    publish();
  });

  api.on('parklocation', (ev) => {
    if (!ev || !ev.parkLocationNumber) return;
    const n = String(ev.parkLocationNumber);
    const raw = ev.raw || {};
    let slot = state.park.find((p) => p.number === n);
    if (!slot) {
      slot = parsePark({ accountId: ev.accountId, parkLocationNumber: n, status: 'idle' });
      state.park.push(slot);
      state.park.sort((a, b) => Number(a.number) - Number(b.number));
    }
    const busy = String(ev.type).toLowerCase() === 'busy' || (raw.status && String(raw.status).toLowerCase() === 'busy');
    if (busy) {
      Object.assign(slot, {
        status: 'busy',
        parkedName: raw.parkedPartyName || slot.parkedName || null,
        parkedNumber: raw.parkedPartyNumber || slot.parkedNumber || null,
        parkedBy: raw.parkingPartyName || raw.parkingPartyNumber || slot.parkedBy || null,
        since: slot.status === 'busy' && slot.since ? slot.since : (ev.timestamp || new Date().toISOString())
      });
    } else {
      Object.assign(slot, { status: 'idle', parkedName: null, parkedNumber: null, parkedBy: null, since: null });
      delete state.errors[`park:${n}`];
    }
    publish();
  });

  api.on('call', onCall);

  // Track A publishes the unseen missed-call count; the badge shows it.
  chrome.storage.local.get('callcardMissedUnseen').then((r) => {
    state.missedUnseen = Number(r.callcardMissedUnseen) || 0;
    publish();
  }).catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.callcardMissedUnseen) {
      state.missedUnseen = Number(changes.callcardMissedUnseen.newValue) || 0;
      publish();
    }
  });

  api.on('status', (st) => {
    conn = st || {};
    publish();
  });

  api.on('session', (s) => { adoptSession(s); publish(); });

  api.on('connected', () => { refreshAll(); });

  api.on('credentials', (c) => {
    if (!c || !c.complete) {
      resetForNewAccount();
      publish();
    }
  });

  // Poll presence: no WS events exist for phone (un)registration.
  chrome.alarms.create(POLL_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== POLL_ALARM) return;
    if (!api.isConnected() || !state.tenantId) return;
    // One after the other: after a server-side PIN change the first 401
    // stops everything, so the second request never sends the bad PIN.
    loadPresence().then(() => loadPhones()).then(publish).catch(() => {});
  });

  // ----------------------------------------------------------- commands ---
  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener((command) => {
      if (command !== 'toggle-dnd') return;
      toggleDnd().then((r) => { if (!r.ok) log('warning', `toggle-dnd shortcut: ${r.message}`); });
    });
  }

  // ----------------------------------------------------------- messages ---
  const HANDLERS = {
    'status:get': async () => ({ ok: true, state }),
    // The UI asks on open; a refresh newer than 30 s is reused.
    'status:refresh': async (m) => refreshAll({ maxAgeMs: m.force ? 0 : 30000 }),
    'status:setDnd': async (m) => setDnd(m.active),
    'status:toggleDnd': async () => toggleDnd(),
    'status:setAcd': async (m) => setAcd(m.active),
    'status:setGroup': async (m) => setGroup(m.callGroupId, m.loggedIn),
    'status:setForward': async (m) => setForward(m.active, m.target),
    'status:retrievePark': async (m) => retrievePark(m.number),
    'status:loadDirectory': async (m) => loadDirectory(!!m.force),
    'status:call': async (m) => {
      const target = String(m.number || '').replace(/[^\d*#]/g, '');
      if (!target) return { ok: false, message: 'No number to call.' };
      try {
        const r = await self.OneClick.dial(target);
        addRecent({ ext: m.ext || null, number: m.ext ? null : target, name: m.name || '' }).catch(() => {});
        return { ok: true, via: r.via, message: r.via === '3pcc' ? 'Your phone will ring first, then the call connects.' : 'Calling…' };
      } catch (e) { return { ok: false, message: e.message }; }
    },
    'status:transfer': async (m) => transfer(m.number, m.name),
    'status:completeTransfer': async () => completeTransfer(),
    'status:cancelTransfer': async () => cancelTransfer()
  };

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    const h = req && HANDLERS[req.action];
    if (!h) return undefined;
    h(req).then((r) => sendResponse(r || { ok: true }), (e) => sendResponse({ ok: false, message: e.message }));
    return true;
  });

  // -------------------------------------------------------------- start ---
  // Show the last known state immediately after a worker restart; the next
  // 'connected' refreshes it. Pending flags never survive a restart.
  chrome.storage.local.get(STATE_KEY).then((r) => {
    const prev = r[STATE_KEY];
    const s = session();
    if (prev && prev.account && (!s || s.account === prev.account)) {
      state = { ...emptyState(), ...prev, pending: {}, transfer: null, missedUnseen: state.missedUnseen };
    }
    if (s) adoptSession(s);
    publish();
    if (api.isConnected()) refreshAll();
  }).catch(() => {});

  self.OneClick.presence = {
    track: 'status',
    CONFIG,
    getState: () => state,
    refresh: refreshAll,
    setDnd, toggleDnd, setAcd, setGroup, setForward, retrievePark,
    loadDirectory, transfer, completeTransfer, cancelTransfer, activeCall,
    helpers: { formatName, initials, searchDirectory, trustedGroupStatus, deriveStatus, halItems, relPath, parseGroup, parseForward, parseExtension, parsePark }
  };
})();
