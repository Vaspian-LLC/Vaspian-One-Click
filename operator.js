// Team view ("operator panel") engine for Vaspian One Click (service worker).
//
// Tenant admins (receptionists, supervisors) get live, team-wide visibility:
// who is available, ringing, on a call (and with whom), on hold, on Do Not
// Disturb or without a phone, plus ring group / queue activity.
//
// Platform facts (fleet/STATE.md 2026-10-30, read-only live capture as an admin):
//   - Admin = the root links include v1:presenceStatusTenantAccounts
//     (api.getSession().isAdmin). Regular users get 404 RestrictedDataAccessAttempt
//     for everything below, so for them this file makes NO requests at all.
//   - Initial load: ONE GET presencestatus/tenants/{tid}/extensions
//     (_embedded.presenceStatus[]). User-shaped entries carry availability /
//     dndStatus / acdAvailability / groupStatus / callStatus; group-shaped
//     entries carry callStatus + groupPresenceState.
//   - Live: wildcard subscriptions on the existing socket (ALL_USERS@{tid} for
//     call + presence events, ALL_CALL_GROUP_EXTENSIONS@{tid} and
//     ALL_ACD_EXTENSIONS@{tid} for group / queue calls). The client routes
//     coworker frames to the 'team' bus event only (never 'call'/'presence',
//     never logged), see lib/vaspian-api.js handleFrame.
//   - Never per-extension GETs or subscriptions (lockout, 3-request limit).
//     Re-sync with one tenant GET after every (re)connect and at most every 5 min.
//
// Privacy (hard rules): coworker presence, who they talk to and outside
// numbers are kept in memory and in chrome.storage.session 'operatorState'
// only (extension pages; content scripts have no access). Never logged, never
// in chrome.storage.sync/local, never in diagnostics. Cleared on sign-out,
// account change, PIN rejection, toggle off, or when the account is not an admin.
//
// Storage: session.operatorState (published at most ~4x/s), local.operatorEnabled
// (the Settings toggle, a preference: absent = on).
// Pages: runtime port 'operator' (snapshot, then deltas), messages 'operator:*'.
// Public surface: self.OneClick.operator. Everything stays inside this IIFE.

(function () {
  'use strict';
  const api = self.OneClick.api;

  const KEYS = { state: 'operatorState', enabled: 'operatorEnabled' };
  const PORT_NAME = 'operator';
  const RESYNC_ALARM = 'operatorResync';
  const CONFIG = {
    publishMs: 250,                 // coalesce: at most ~4 publishes a second
    resyncMs: 5 * 60 * 1000,        // periodic tenant GET (plus one after every reconnect)
    groupsTtlMs: 60 * 60 * 1000,    // group / queue names
    maxPages: 5,
    maxBuffered: 2000,              // frames held while the snapshot loads
    callMaxAgeMs: 12 * 60 * 60 * 1000
  };
  /** [kind, wildcard account] subscribed for admins. */
  const WILDCARDS = [['call', 'ALL_USERS'], ['presence', 'ALL_USERS'], ['call', 'ALL_CALL_GROUP_EXTENSIONS'], ['call', 'ALL_ACD_EXTENSIONS']];

  /** Generic, data-free log lines only (counts, phases). Never names, numbers or extensions of coworkers. */
  function log(level, message) {
    try { if (typeof addLog === 'function') addLog(level, `Team view: ${message}`); } catch (e) { /* never break */ } // eslint-disable-line no-undef
  }

  // ------------------------------------------------------------- model ---
  // Pure functions over a model object, exported as helpers for unit tests.

  function newModel(selfExt) {
    return {
      selfExt: selfExt ? String(selfExt) : null,
      people: new Map(),    // ext -> Person (internal, see newPerson)
      groups: new Map(),    // ext -> Group (internal)
      userDir: new Map(),   // ext -> display name (enabled userExt, from presence.js's directory)
      groupDir: new Map(),  // ext -> {name, kind:'group'|'queue'}
      groupish: new Set(),  // exts the snapshot showed as group-shaped (no availability)
      dirty: new Set(),     // person exts changed since the last publish
      groupsDirty: false
    };
  }

  function newPerson(ext) {
    return { ext, avail: null, dnd: false, acd: false, groupStatus: {}, callStatus: 'idle', calls: {}, state: 'available', since: null };
  }
  function newGroup(ext) {
    return { ext, callStatus: 'idle', presenceState: '', waiting: {} };
  }

  const extOf = (party) => {
    const s = String(party == null ? '' : party).trim();
    if (!s) return null;
    return s.split('@')[0];
  };
  const isInternal = (s) => /^\d{1,6}$/.test(String(s || ''));

  /** "CHRIS A" -> "Chris A"; mixed case is kept. */
  function niceName(n) {
    const s = String(n || '').trim();
    if (!s || s !== s.toUpperCase() || !/[A-Z]/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }

  /** The other party of a call as {otherExt, otherNumber, otherName}. */
  function otherParty(model, raw) {
    const r = raw || '';
    const e = extOf(r);
    if (!e) return { otherExt: null, otherNumber: null, otherName: '' };
    if (isInternal(e)) return { otherExt: e, otherNumber: null, otherName: model.userDir.get(e) || '' };
    let d = e.replace(/\D/g, '');
    if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
    if (d.length > 11) d = d.slice(-10); // a dial prefix in front of an 11-digit number
    return { otherExt: null, otherNumber: d || null, otherName: '' };
  }

  function isGroupExt(model, ext) {
    return model.groupDir.has(ext) || model.groupish.has(ext);
  }

  function person(model, ext) {
    let p = model.people.get(ext);
    if (!p) { p = newPerson(ext); model.people.set(ext, p); }
    return p;
  }
  function group(model, ext) {
    let g = model.groups.get(ext);
    if (!g) { g = newGroup(ext); model.groups.set(ext, g); }
    return g;
  }

  /**
   * Visible state from the person's calls and presence.
   * Calls first (on a call > on hold > ringing > calling out > busy without
   * detail), then no phone, then DND, then available.
   */
  function stateOf(p) {
    const calls = Object.values(p.calls);
    if (calls.some((c) => c.phase === 'connected')) return 'oncall';
    if (calls.some((c) => c.phase === 'held')) return 'onhold';
    if (calls.some((c) => c.phase === 'ringing')) return 'ringing';
    if (calls.some((c) => c.phase === 'dialing')) return 'oncall';
    if (p.callStatus === 'busy') return 'oncall';
    if (p.avail === 'unavailable') return 'nophone';
    if (p.dnd) return 'dnd';
    return 'available';
  }

  /** Recompute state; `since` = local receive time of the change (null when it came from a snapshot). */
  function derive(model, p, now, fromSnapshot) {
    const next = stateOf(p);
    if (next !== p.state) { p.state = next; p.since = fromSnapshot ? null : now; }
    model.dirty.add(p.ext);
  }

  /** The call a tile shows: the live one, else held, else ringing, else dialing. */
  function primaryCall(p) {
    const calls = Object.values(p.calls);
    for (const phase of ['connected', 'held', 'ringing', 'dialing']) {
      const c = calls.filter((x) => x.phase === phase).sort((a, b) => b.startedAt - a.startedAt)[0];
      if (c) return c;
    }
    return null;
  }

  function reduceCall(model, ext, raw, now) {
    const type = String(raw.event || '');
    const id = String(raw.callId);
    if (isGroupExt(model, ext)) {
      const g = group(model, ext);
      if (type === 'offer' || type === 'ringing') {
        if (!g.waiting[id]) {
          const o = otherParty(model, raw.from);
          g.waiting[id] = { since: now, name: niceName(raw.callingName) || o.otherName, number: o.otherNumber, ext: o.otherExt };
        }
      } else if (type === 'answer' || type === 'end' || type === 'callError') {
        delete g.waiting[id];
      }
      model.groupsDirty = true;
      return;
    }
    const p = person(model, ext);
    let c = p.calls[id];
    if (type === 'end' || type === 'callError') {
      if (c) { delete p.calls[id]; derive(model, p, now); }
      return;
    }
    if (!c) {
      let direction = 'inbound';
      if (type === 'dial' || type === 'ringback') direction = 'outbound';
      else if (type !== 'offer' && type !== 'ringing' && extOf(raw.from) === ext) direction = 'outbound';
      c = { direction, phase: null, startedAt: now, answeredAt: null, otherExt: null, otherNumber: null, otherName: '' };
      p.calls[id] = c;
    }
    // Who is on the other end.
    if (c.direction === 'inbound' && raw.from && extOf(raw.from) !== ext) {
      Object.assign(c, otherParty(model, raw.from));
      if (raw.callingName) c.otherName = niceName(raw.callingName) || c.otherName;
    } else if (c.direction === 'outbound' && raw.to && extOf(raw.to) !== ext && !c.otherExt && !c.otherNumber) {
      Object.assign(c, otherParty(model, raw.to));
    }
    switch (type) {
      case 'offer':
      case 'ringing':
        if (c.phase !== 'connected' && c.phase !== 'held') c.phase = 'ringing';
        break;
      case 'dial':
      case 'ringback':
        if (c.phase !== 'connected' && c.phase !== 'held') c.phase = 'dialing';
        break;
      case 'answer': {
        const by = extOf(raw.answeringParty);
        if (c.direction === 'inbound' && by && isInternal(by) && by !== ext) {
          // A ring group call a coworker picked up: it was never this person's call.
          delete p.calls[id];
          derive(model, p, now);
          return;
        }
        if (c.direction === 'outbound' && by && by !== ext) Object.assign(c, otherParty(model, raw.answeringParty));
        c.phase = 'connected';
        c.answeredAt = now;
        break;
      }
      case 'hold': {
        const holder = extOf(raw.holdingParty);
        if (!holder || holder === ext) c.phase = 'held';
        break;
      }
      case 'held': {
        const held = extOf(raw.heldParty);
        if (!held || held !== ext) c.phase = 'held';
        break;
      }
      case 'resume': case 'resumed': case 'retrieved': case 'unhold': case 'unheld':
        if (c.phase === 'held') c.phase = 'connected';
        break;
      default:
        if (!c.phase) c.phase = 'connected'; // first event of an unknown type: assume talking
    }
    derive(model, p, now);
  }

  function reducePresence(model, ext, raw, now) {
    if (isGroupExt(model, ext)) {
      const g = group(model, ext);
      if (raw.event === 'busy' || raw.event === 'idle') g.callStatus = raw.event;
      model.groupsDirty = true;
      return;
    }
    const p = person(model, ext);
    switch (raw.event) {
      case 'dndOn': p.dnd = true; break;
      case 'dndOff': p.dnd = false; break;
      case 'signedInAcd': p.acd = true; break;
      case 'signedOutAcd': p.acd = false; break;
      case 'joinedGroup': if (raw.groupJoined) p.groupStatus[String(raw.groupJoined)] = true; model.groupsDirty = true; break;
      case 'leftGroup': if (raw.groupLeft) p.groupStatus[String(raw.groupLeft)] = false; model.groupsDirty = true; break;
      case 'available': p.avail = 'available'; break;
      case 'unavailable': p.avail = 'unavailable'; break;
      case 'busy': p.callStatus = 'busy'; break;
      case 'idle': p.callStatus = 'idle'; p.calls = {}; break; // no calls left: drop any we missed the end of
      default: return;
    }
    derive(model, p, now);
  }

  /** One team frame (raw WS JSON). Own frames and park slots are ignored here. */
  function reduceFrame(model, raw, now = Date.now()) {
    if (!raw || !raw.event || !raw.observedParty) return false;
    const ext = extOf(raw.observedParty);
    if (!ext || /^PL\d+$/i.test(ext) || ext === model.selfExt) return false;
    if (raw.callId) reduceCall(model, ext, raw, now);
    else reducePresence(model, ext, raw, now);
    return true;
  }

  /** Apply the tenant presence GET (items of _embedded.presenceStatus). */
  function applySnapshot(model, items, now = Date.now()) {
    const seen = new Set();
    for (const it of items || []) {
      const ext = extOf(it && it.accountId);
      if (!ext || ext === model.selfExt) continue;
      seen.add(ext);
      const userShaped = it.availability !== undefined || it.dndStatus !== undefined;
      if (!userShaped && !model.userDir.has(ext)) {
        model.groupish.add(ext);
        const g = group(model, ext);
        g.callStatus = it.callStatus || 'idle';
        g.presenceState = it.groupPresenceState || '';
        if (g.callStatus === 'idle') g.waiting = {};
        model.groupsDirty = true;
        continue;
      }
      const p = person(model, ext);
      p.avail = it.availability || null;
      p.dnd = it.dndStatus === 'dndOn';
      p.acd = it.acdAvailability === 'signedInAcd';
      const gs = {};
      for (const [k, v] of Object.entries(it.groupStatus || {})) gs[String(k)] = v === 'groupJoined';
      p.groupStatus = gs;
      p.callStatus = it.callStatus === 'busy' ? 'busy' : 'idle';
      if (p.callStatus === 'idle') p.calls = {}; // lost 'end' events
      for (const [id, c] of Object.entries(p.calls)) if (now - c.startedAt > CONFIG.callMaxAgeMs) delete p.calls[id];
      derive(model, p, now, true);
    }
    model.groupsDirty = true;
    return seen.size;
  }

  /** Public, minimal record for one person (only directory users are shown). */
  function publicPerson(model, p) {
    const c = primaryCall(p);
    const groups = Object.entries(p.groupStatus).filter(([k, v]) => v && model.groupDir.has(k)).map(([k]) => k);
    return {
      ext: p.ext,
      name: model.userDir.get(p.ext) || `Extension ${p.ext}`,
      state: p.state,
      since: p.since,
      dnd: !!p.dnd,
      inQueue: !!p.acd,
      nophone: p.avail === 'unavailable',
      groups,
      call: c ? {
        phase: c.phase, direction: c.direction,
        startedAt: c.phase === 'connected' && c.answeredAt ? c.answeredAt : c.startedAt,
        otherName: c.otherName || (c.otherExt ? model.userDir.get(c.otherExt) || '' : ''),
        otherNumber: c.otherNumber, otherExt: c.otherExt
      } : null,
      calls: Object.keys(p.calls).length
    };
  }

  function publicGroups(model) {
    const members = new Map(); // group ext -> {joined, total}
    for (const p of model.people.values()) {
      if (!model.userDir.has(p.ext)) continue;
      for (const [k, v] of Object.entries(p.groupStatus)) {
        if (!model.groupDir.has(k)) continue; // monitoring residue and unknown keys are ignored
        const m = members.get(k) || { joined: 0, total: 0 };
        m.total++;
        if (v) m.joined++;
        members.set(k, m);
      }
    }
    const out = [];
    for (const [ext, info] of model.groupDir) {
      const g = model.groups.get(ext);
      const waiting = g ? Object.values(g.waiting).sort((a, b) => a.since - b.since) : [];
      const m = members.get(ext) || null;
      if (!m && !waiting.length && !(g && g.callStatus === 'busy')) continue; // nobody we can see belongs to it
      out.push({
        ext, name: info.name, kind: info.kind,
        joined: m ? m.joined : null, members: m ? m.total : null,
        waiting: waiting.map((w) => ({ since: w.since, name: w.name, number: w.number, ext: w.ext })),
        busy: !!(g && g.callStatus === 'busy')
      });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  function countsOf(list) {
    const c = { available: 0, oncall: 0, ringing: 0, dnd: 0, nophone: 0, total: list.length };
    for (const p of list) {
      if (p.state === 'onhold' || p.state === 'oncall') c.oncall++;
      else if (c[p.state] !== undefined) c[p.state]++;
    }
    return c;
  }

  /** Every visible person (directory users), sorted by name: a stable order the UI keeps. */
  function visiblePeople(model) {
    const out = [];
    for (const [ext] of model.userDir) {
      if (ext === model.selfExt) continue;
      out.push(publicPerson(model, model.people.get(ext) || newPerson(ext)));
    }
    out.sort((a, b) => a.name.localeCompare(b.name) || a.ext.localeCompare(b.ext));
    return out;
  }

  // ------------------------------------------------------------ runtime ---
  let model = newModel(null);
  let enabledPref = true;       // local.operatorEnabled (absent = on)
  let prefLoaded = false;
  let active = false;           // wildcard subscriptions are in the client's desired set
  let phase = 'off';            // off | not_admin | disabled | connecting | loading | live | lost | auth
  let account = null;
  let buffer = null;            // frames held while a snapshot is in flight (null = not loading)
  let snapshotPromise = null;
  let lastSyncAt = 0;
  let groupsLoadedAt = 0;
  let publishTimer = null;
  let lastPublishAt = 0;
  let snapshotLoaded = false;
  const ports = new Set();

  function sessionNow() { return api.getSession ? api.getSession() : null; }

  function phaseFromConnection() {
    const st = api.getStatus ? api.getStatus() || {} : {};
    if (st.state === 'error' && st.reason === 'auth') return 'auth';
    if (api.isConnected && api.isConnected()) return snapshotLoaded ? 'live' : 'loading';
    return snapshotLoaded ? 'lost' : 'connecting';
  }

  function snapshotState() {
    const people = active || snapshotLoaded ? visiblePeople(model) : [];
    return {
      v: 1, account, phase, at: Date.now(), lastSyncAt: lastSyncAt || null,
      people, groups: publicGroups(model), counts: countsOf(people)
    };
  }

  function post(msg) {
    for (const port of ports) { try { port.postMessage(msg); } catch (e) { ports.delete(port); } }
  }

  /** Coalesced publish: session storage (full) + port delta, at most every CONFIG.publishMs. */
  function schedulePublish() {
    if (publishTimer) return;
    const wait = Math.max(0, lastPublishAt + CONFIG.publishMs - Date.now());
    publishTimer = setTimeout(flush, wait);
  }

  function flush() {
    publishTimer = null;
    lastPublishAt = Date.now();
    if (!account || phase === 'off' || phase === 'not_admin') return;
    const full = snapshotState();
    const changed = [];
    for (const ext of model.dirty) {
      if (!model.userDir.has(ext) || ext === model.selfExt) continue;
      changed.push(publicPerson(model, model.people.get(ext) || newPerson(ext)));
    }
    model.dirty.clear();
    model.groupsDirty = false;
    chrome.storage.session.set({ [KEYS.state]: full }).catch(() => {});
    post({ type: 'delta', phase, at: full.at, lastSyncAt: full.lastSyncAt, people: changed, groups: full.groups, counts: full.counts });
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    if (next === 'off' || next === 'not_admin') return;
    log('info', `status ${next}`);
    schedulePublish();
  }

  /** Forget everything about the team (memory, session storage, open pages). */
  async function clearAll(nextPhase) {
    clearTimeout(publishTimer);
    publishTimer = null;
    model = newModel(model.selfExt);
    buffer = null;
    snapshotLoaded = false;
    lastSyncAt = 0;
    groupsLoadedAt = 0;
    phase = nextPhase || 'off';
    post({ type: 'cleared', phase });
    try { await chrome.storage.session.remove(KEYS.state); } catch (e) { /* tests */ }
  }

  async function deactivate(nextPhase) {
    if (active) {
      active = false;
      for (const [kind, acct] of WILDCARDS) api.unsubscribe(kind, acct).catch(() => {});
      log('info', 'stopped');
    }
    chrome.alarms.clear(RESYNC_ALARM).catch(() => {});
    await clearAll(nextPhase);
  }

  function wanted() {
    const s = sessionNow();
    return !!(s && s.isAdmin && enabledPref);
  }

  /** Bring the engine in line with session + preference + connection. */
  async function evaluate() {
    if (!prefLoaded) return;
    const s = sessionNow();
    if (!s) { if (active || phase !== 'off') await deactivate('off'); account = null; return; }
    if (account && account !== s.account) await deactivate('off');
    account = s.account;
    model.selfExt = String(s.extension);
    if (!s.isAdmin) { if (active || phase !== 'not_admin') await deactivate('not_admin'); return; }
    if (!enabledPref) { if (active || phase !== 'disabled') await deactivate('disabled'); return; }
    if (!active) {
      active = true;
      log('info', 'starting');
      chrome.alarms.create(RESYNC_ALARM, { periodInMinutes: CONFIG.resyncMs / 60000 });
      const results = await Promise.all(WILDCARDS.map(([kind, acct]) => api.subscribe(kind, acct)));
      if (results.some((r) => r && r.errorClass === 'forbidden')) {
        log('warning', 'team-wide updates are not permitted for this account');
        await deactivate('not_admin');
        return;
      }
      if (api.isConnected()) resync('start');
    }
    setPhase(phaseFromConnection());
  }

  async function loadGroupsDirectory(tid) {
    if (Date.now() - groupsLoadedAt < CONFIG.groupsTtlMs && model.groupDir.size) return;
    const dirMap = new Map();
    for (const [type, kind] of [['groupExt', 'group'], ['acdExt', 'queue']]) {
      let path = `tenants/${tid}/extensions?extensionType=${type}&expand=item`;
      for (let page = 0; path && page < CONFIG.maxPages; page++) {
        const res = await api.request('GET', path);
        if (!res.ok) break;
        for (const it of halList(res.body, 'extension')) {
          const ext = it && it.extension != null ? String(it.extension) : null;
          if (!ext || it.enabled === false) continue;
          if (it.extensionType && it.extensionType !== type) continue;
          dirMap.set(ext, { name: String(it.name || `${kind === 'queue' ? 'Queue' : 'Group'} ${ext}`), kind });
        }
        const next = res.body && res.body._links && res.body._links.next && relPath(res.body._links.next.href);
        path = next && next.startsWith(`tenants/${tid}/extensions`) ? next : null;
      }
    }
    if (dirMap.size) { model.groupDir = dirMap; groupsLoadedAt = Date.now(); model.groupsDirty = true; }
  }

  async function loadUserDirectory() {
    const pres = self.OneClick.presence;
    try { if (pres && typeof pres.loadDirectory === 'function') await pres.loadDirectory(false); } catch (e) { /* named later */ }
    await readUserDirectory();
  }

  async function readUserDirectory() {
    const r = await chrome.storage.local.get('statusDirectory');
    const d = r.statusDirectory;
    const s = sessionNow();
    if (!d || !s || d.tenantId !== s.tenantId) return;
    const m = new Map();
    for (const u of d.users || []) if (u && u.ext && u.enabled !== false) m.set(String(u.ext), String(u.name || `Extension ${u.ext}`));
    model.userDir = m;
    for (const ext of m.keys()) model.dirty.add(ext);
  }

  function halList(body, rel) {
    const emb = body && body._embedded;
    if (!emb) return [];
    const v = emb[rel] !== undefined ? emb[rel] : Object.values(emb)[0];
    return Array.isArray(v) ? v : (v ? [v] : []);
  }
  function relPath(href) {
    const s = String(href || '');
    const i = s.indexOf('/api/v1/');
    return i >= 0 ? s.slice(i + '/api/v1/'.length) : null;
  }

  /**
   * One tenant GET (plus the cached directories). Frames that arrive meanwhile
   * are buffered and replayed on top, so nothing is lost or applied twice.
   */
  function resync(why) {
    if (snapshotPromise) return snapshotPromise;
    snapshotPromise = (async () => {
      const s = sessionNow();
      if (!active || !s || !s.isAdmin) return { ok: false };
      buffer = [];
      setPhase(snapshotLoaded ? phaseFromConnection() : 'loading');
      try {
        await loadUserDirectory();
        await loadGroupsDirectory(s.tenantId);
        let path = `presencestatus/tenants/${s.tenantId}/extensions`;
        const items = [];
        let first = null;
        for (let page = 0; path && page < CONFIG.maxPages; page++) {
          const res = await api.request('GET', path);
          if (!first) first = res;
          if (!res.ok) break;
          items.push(...halList(res.body, 'presenceStatus'));
          const next = res.body && res.body._links && res.body._links.next && relPath(res.body._links.next.href);
          path = next && next.startsWith(`presencestatus/tenants/${s.tenantId}/extensions`) ? next : null;
        }
        if (!active) return { ok: false };
        if (!first || !first.ok) {
          if (first && first.errorClass === 'forbidden') { await deactivate('not_admin'); return { ok: false }; }
          log('warning', `team snapshot failed (${first ? first.status : 'no response'})`);
          return { ok: false };
        }
        const now = Date.now();
        const n = applySnapshot(model, items, now);
        const queued = buffer || [];
        buffer = null;
        for (const raw of queued) reduceFrame(model, raw, Date.now());
        snapshotLoaded = true;
        lastSyncAt = now;
        log('info', `synced (${why}): ${n} accounts, ${queued.length} queued updates`);
        setPhase(phaseFromConnection());
        schedulePublish();
        return { ok: true };
      } finally {
        if (buffer) { const q = buffer; buffer = null; for (const raw of q) reduceFrame(model, raw, Date.now()); }
      }
    })().finally(() => { snapshotPromise = null; });
    return snapshotPromise;
  }

  function onTeamFrame(raw) {
    if (!active) return;
    if (buffer) { if (buffer.length < CONFIG.maxBuffered) buffer.push(raw); return; }
    if (reduceFrame(model, raw)) schedulePublish();
  }

  // -------------------------------------------------------------- wiring ---
  api.on('team', onTeamFrame);
  api.on('session', () => { evaluate().catch(() => {}); });
  api.on('connected', () => {
    if (active) { setPhase(phaseFromConnection()); resync('reconnect'); } else evaluate().catch(() => {});
  });
  api.on('disconnected', () => { if (active) setPhase(phaseFromConnection()); });
  api.on('status', () => { if (active) setPhase(phaseFromConnection()); });
  api.on('auth-failed', () => { deactivate('off').catch(() => {}); });
  api.on('credentials', (c) => {
    // Sign-out, or a different extension: forget the team immediately.
    if (!c || !c.complete || (model.selfExt && c.extension && String(c.extension) !== model.selfExt)) {
      account = null;
      deactivate('off').catch(() => {});
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEYS.enabled]) {
      enabledPref = changes[KEYS.enabled].newValue !== false;
      evaluate().catch(() => {});
    }
    if (area === 'local' && changes.statusDirectory && active) {
      readUserDirectory().then(() => { model.groupsDirty = true; schedulePublish(); }).catch(() => {});
    }
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== RESYNC_ALARM) return;
    if (!active || !api.isConnected()) return;
    if (Date.now() - lastSyncAt < CONFIG.resyncMs - 15000) return; // a reconnect just did it
    resync('periodic');
  });

  /** Only extension pages (popup, side panel, console) may talk to the engine; never content scripts. */
  function fromExtensionPage(sender) {
    try {
      const base = chrome.runtime.getURL('');
      return !!(sender && sender.id === chrome.runtime.id && sender.url && sender.url.startsWith(base));
    } catch (e) { return false; }
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    if (!fromExtensionPage(port.sender)) { try { port.disconnect(); } catch (e) { /* ignore */ } return; }
    ports.add(port);
    port.onDisconnect.addListener(() => ports.delete(port));
    try { port.postMessage({ type: 'snapshot', state: publicStatus() }); } catch (e) { ports.delete(port); }
  });

  /** What any page may know: the phase always, the data only for an active admin. */
  function publicStatus() {
    const s = sessionNow();
    const base = { phase: s ? (s.isAdmin ? (enabledPref ? phase : 'disabled') : 'not_admin') : 'off', enabled: enabledPref, isAdmin: !!(s && s.isAdmin), account: s ? s.account : null };
    if (!active) return { ...base, people: [], groups: [], counts: countsOf([]) };
    return { ...snapshotState(), ...base };
  }

  async function setEnabled(on) {
    enabledPref = !!on;
    await chrome.storage.local.set({ [KEYS.enabled]: enabledPref });
    await evaluate();
    return { ok: true, enabled: enabledPref, phase: publicStatus().phase };
  }

  async function openConsole() {
    const url = chrome.runtime.getURL('operator.html');
    try {
      if (chrome.runtime.getContexts) {
        const ctx = await chrome.runtime.getContexts({ contextTypes: ['TAB'], documentUrls: [url] });
        const hit = ctx && ctx.find((c) => c.tabId >= 0);
        if (hit) {
          await chrome.tabs.update(hit.tabId, { active: true });
          if (hit.windowId >= 0 && chrome.windows) await chrome.windows.update(hit.windowId, { focused: true }).catch(() => {});
          return { ok: true, reused: true };
        }
      }
    } catch (e) { /* fall through to a new tab */ }
    await chrome.tabs.create({ url });
    return { ok: true };
  }

  const HANDLERS = {
    'operator:get': async () => ({ ok: true, state: publicStatus() }),
    'operator:setEnabled': async (m) => setEnabled(m.enabled !== false),
    'operator:open': async () => openConsole(),
    'operator:refresh': async () => {
      if (!active) return { ok: false, message: 'Team view is off.' };
      if (Date.now() - lastSyncAt < 30000) return { ok: true, recent: true };
      return resync('manual');
    }
  };

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    const h = req && HANDLERS[req.action];
    if (!h) return undefined;
    if (!fromExtensionPage(sender)) { sendResponse({ ok: false, message: 'Not available here.' }); return false; }
    h(req).then((r) => sendResponse(r || { ok: true }), (e) => sendResponse({ ok: false, message: e.message }));
    return true;
  });

  // -------------------------------------------------------------- start ---
  chrome.storage.local.get(KEYS.enabled).then((r) => {
    enabledPref = r[KEYS.enabled] !== false;
    prefLoaded = true;
    return evaluate();
  }).catch(() => { prefLoaded = true; });

  self.OneClick.operator = {
    track: 'operator',
    KEYS, CONFIG, WILDCARDS,
    getState: publicStatus,
    setEnabled, resync, openConsole,
    isActive: () => active,
    helpers: { newModel, reduceFrame, applySnapshot, visiblePeople, publicGroups, countsOf, stateOf, niceName, otherParty }
  };
})();
