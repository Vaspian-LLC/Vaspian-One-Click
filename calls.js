// Live calls for Vaspian One Click (service worker). Track A "callcard".
//
// Builds a per-call state machine from the event bus (lib/vaspian-api.js),
// publishes it for the call card UI, and runs the call controls:
//   inbound   offer/ringing -> answer -> end            (offer may arrive twice)
//   outbound  dial -> ringback -> answer -> end
//   any       hold/held/resume/resumed, park, transfer, forward
// Also owns: missed calls (offer -> end with nobody answering), the optional
// missed-call desktop notification, chrome.commands 'answer' / 'hangup' /
// 'dial-selection', and the "Call <selection> with Vaspian" context menu.
//
// Storage (published, read by callcard-ui.js):
//   session.callcardCalls   { calls: [CallRecord], at }   live calls (survive a SW restart, not a browser restart)
//   local.callcardMissed    [MissedCall]                  newest first, max 50
//   local.callcardMissedUnseen  number                    for a toolbar badge (Track B owns the badge)
//   local.callcardDeviceCaps    { deviceKey: { callRequest: {at, model} } }  controls the phone refused
//   session.callcardNotice  { text, level, at }           last control result worth telling the user
//
// Capability-aware controls: answerCall / holdCall (and maybe parkCall) return
// 400 RequestNotValidForSpecifiedDevice on basic SIP phones. That error (and
// only that error) is remembered per device so the UI disables the control
// with an explanation instead of failing every time.
//
// Transfer: the Public API only has an attended transfer (two calls bridged
// with callRequest 'transfer' + otherCallId). "Transfer" here = hold call A,
// makeCall to the target (call B), then 'Complete transfer' posts transfer on
// B with otherCallId = A. There is no blind-transfer request in the API.
//
// Everything stays inside this IIFE (fleet/ARCHITECTURE.md §2).

(function () {
  'use strict';
  const api = self.OneClick.api;
  const VERSION = 1;

  const KEYS = {
    calls: 'callcardCalls',            // session
    notice: 'callcardNotice',          // session
    missed: 'callcardMissed',          // local
    unseen: 'callcardMissedUnseen',    // local
    caps: 'callcardDeviceCaps',        // local
    owner: 'callcardOwner'             // local: extension the missed list belongs to
  };
  const ENDED_LINGER_MS = 6000;        // an ended card stays visible this long
  const MISSED_MAX = 50;
  const MENU_SELECTION = 'callcard-call-selection';
  const MENU_LINK = 'callcard-call-link';

  /** Controls the UI can ask for -> 3PCC callRequest. */
  const CONTROL_REQUEST = {
    answer: 'answerCall',
    voicemail: 'deflectCall',
    hold: 'holdCall',
    resume: 'resumeHeldCall',
    hangup: 'hangupCall',
    park: 'parkCall',
    transfer: 'transfer'
  };
  /** Why a control is disabled after the phone refused it (tooltip). */
  const UNSUPPORTED_TEXT = {
    answerCall: "Your phone model doesn't support remote answer. Answer on the phone.",
    holdCall: "Your phone model doesn't support remote hold. Use the Hold key on the phone.",
    resumeHeldCall: "Your phone model doesn't support remote resume. Use the phone to resume.",
    deflectCall: "Your phone model doesn't support sending calls to voicemail from the browser.",
    hangupCall: "Your phone model doesn't support remote hang up. Hang up on the phone.",
    parkCall: "Your phone model doesn't support parking from the browser. Use the phone's Park key.",
    transfer: "Your phone model doesn't support transfer from the browser. Transfer on the phone."
  };

  function log(level, msg) {
    try { addLog(level, `Call card: ${msg}`); } catch (e) { /* addLog missing in unit tests */ } // eslint-disable-line no-undef
  }

  // ------------------------------------------------------- state machine ---
  /**
   * @typedef {object} CallRecord
   * @property {string} callId
   * @property {string|null} smdrCallId
   * @property {'inbound'|'outbound'|'unknown'} direction
   * @property {'ringing'|'dialing'|'ringback'|'connected'|'held'|'parked'|'ended'} state
   * @property {{raw:string, display:string, number:string|null, ext:string|null, isInternal:boolean}|null} remote
   * @property {string} name          caller name from the offer ('' if none)
   * @property {number} createdAt     epoch ms when this SW first saw the call
   * @property {number|null} answeredAt   epoch ms (stamped on receipt, for the UI timer)
   * @property {number|null} heldAt
   * @property {number|null} endedAt
   * @property {string|null} endReason
   * @property {'self'|'other'|null} answeredBy
   * @property {boolean} remoteHold   the other party put us on hold
   * @property {boolean} deflected    the user sent it to voicemail
   * @property {boolean} transferred
   * @property {boolean} missed
   * @property {string[]} devices     ringing device ids
   * @property {string|null} answerDeviceId
   * @property {string|null} parkedAt park location
   * @property {string|null} consultFor  this call is the consult leg of a transfer for that callId
   * @property {string|null} consultCallId  this call is being transferred via that consult leg
   * @property {string|null} transferTarget
   * @property {string|null} crmUrl
   * @property {string} dialedDigits  what the caller dialed (a group extension shows as "Via" on the card)
   * @property {number|null} callDurationMs  the server's callDuration from the end event (the card's ended
   *           bar and crm.js wrap-up/history both prefer it over the local timer, so they agree)
   * @property {number} lastEventAt
   */

  /** A fresh store: { calls: {callId: CallRecord} }. */
  function newStore() { return { calls: {} }; }

  function partyLite(p) {
    if (!p) return null;
    return { raw: p.raw, display: p.isInternal ? `Ext ${p.ext}` : p.display, number: p.number, ext: p.ext, isInternal: !!p.isInternal };
  }

  /** True when a raw party is the observed (own) account. */
  function isOwn(party, ev) {
    if (!party) return false;
    if (party.isSelf) return true;
    return !!ev.observedParty && api.sameParty(party, ev.observedParty);
  }

  function remoteFor(ev, direction) {
    if (direction === 'outbound') {
      if (ev.to && !isOwn(ev.to, ev)) return partyLite(ev.to);
      if (ev.dialedDigits) return partyLite(api.normalizeParty(ev.dialedDigits));
      return null;
    }
    if (ev.from && !isOwn(ev.from, ev)) return partyLite(ev.from);
    return null;
  }

  // Names we already know for a number we are about to dial (Call back on a
  // missed call): the outbound events carry no caller-ID name.
  const nameHints = new Map(); // digits key -> { name, at }
  const NAME_HINT_MS = 2 * 60 * 1000;
  const hintKey = (d) => { const x = String(d || '').replace(/\D/g, ''); return x.length > 10 ? x.slice(-10) : x; };
  function nameHint(remote) {
    if (!remote) return '';
    const h = nameHints.get(hintKey(remote.ext || remote.number || remote.digits));
    return h && Date.now() - h.at < NAME_HINT_MS ? h.name : '';
  }
  api.on('dial:nameHint', (d) => { if (d && d.number && d.name) nameHints.set(hintKey(d.number), { name: String(d.name), at: Date.now() }); });

  function createRecord(ev, now) {
    let state = 'ringing';
    if (ev.type === 'dial') state = 'dialing';
    else if (ev.type === 'ringback') state = 'ringback';
    else if (ev.type === 'answer') state = 'connected';
    else if (ev.type === 'hold' || ev.type === 'held') state = 'held';
    else if (ev.type === 'end') state = 'ended';
    let direction = ev.direction || 'unknown';
    // A 3PCC makeCall rings our own device first: from = self, so it is outbound.
    if (direction === 'inbound' && ev.from && isOwn(ev.from, ev) && ev.to && !isOwn(ev.to, ev)) direction = 'outbound';
    const remote = remoteFor(ev, direction);
    return {
      callId: ev.callId,
      smdrCallId: ev.smdrCallId || null,
      direction,
      state,
      remote,
      name: ev.callingName || (direction === 'outbound' ? nameHint(remote) : ''),
      createdAt: now,
      answeredAt: state === 'connected' || state === 'held' ? now : null,
      heldAt: state === 'held' ? now : null,
      endedAt: null,
      endReason: null,
      answeredBy: state === 'connected' || state === 'held' ? 'self' : null,
      remoteHold: false,
      deflected: false,
      transferred: false,
      missed: false,
      devices: [],
      answerDeviceId: null,
      parkedAt: null,
      consultFor: null,
      consultCallId: null,
      transferTarget: null,
      crmUrl: null,
      crmOpen: false,
      dialedDigits: ev.dialedDigits || '',  // UX: "Via" segment on the card
      callDurationMs: null,                 // UX: set from the end event (one duration source)
      lastEventAt: now
    };
  }

  /**
   * Apply one normalized CallEvent to the store. Mutates `store` and returns
   * the side effects for the caller: { changed, effects: [{type:'missed'|'ended'|'answered'|'new', call}] }.
   * Keyed on callId in this store (not on ev.isNew: the client forgets its
   * per-call memory on disconnect, so mid-call events can come back "new").
   * @param {{calls: Object<string, CallRecord>}} store
   * @param {object} ev CallEvent from lib/vaspian-api.js
   * @param {number} [now]
   */
  function reduce(store, ev, now = Date.now()) {
    const effects = [];
    if (!ev || !ev.callId) return { changed: false, effects };
    let rec = store.calls[ev.callId];
    if (rec && rec.state === 'ended') {
      // Late events for a finished call are ignored, except a fresh offer
      // reusing the id, which never happens on Silhouette (ids are unique).
      return { changed: false, effects };
    }
    if (!rec) {
      if (ev.type === 'end' || ev.type === 'callError') return { changed: false, effects }; // never saw it ring: nothing to show
      rec = createRecord(ev, now);
      store.calls[ev.callId] = rec;
      effects.push({ type: 'new', call: rec });
    }
    rec.lastEventAt = now;
    if (!rec.remote) rec.remote = remoteFor(ev, rec.direction);
    if (ev.callingName && !rec.name) rec.name = ev.callingName;
    if (ev.dialedDigits && !rec.dialedDigits) rec.dialedDigits = ev.dialedDigits; // UX: "Via" on the card
    const live = rec.state !== 'ended';

    switch (ev.type) {
      case 'offer':
        // Ring groups send the offer twice with the same callId: nothing new.
        break;
      case 'ringing':
        if (ev.deviceId && !rec.devices.includes(String(ev.deviceId))) rec.devices.push(String(ev.deviceId));
        break;
      case 'dial':
        if (rec.state === 'ringing') rec.state = 'dialing';
        break;
      case 'ringback':
        if (rec.state === 'dialing' || rec.state === 'ringing') rec.state = 'ringback';
        break;
      case 'answer': {
        const by = ev.answeringParty;
        if (rec.direction === 'inbound' && by && !isOwn(by, ev)) {
          // Someone else in the ring group picked it up; it is over for us.
          rec.answeredBy = 'other';
          rec.state = 'ended';
          rec.endedAt = now;
          rec.endReason = 'Answered elsewhere';
          effects.push({ type: 'ended', call: rec });
          break;
        }
        if (rec.direction === 'outbound' && by && !isOwn(by, ev) && (!rec.remote || rec.remote.isInternal === false)) {
          rec.remote = rec.remote || partyLite(by);
        }
        rec.answeredBy = 'self';
        if (!rec.answeredAt) rec.answeredAt = now;
        if (ev.deviceId) rec.answerDeviceId = String(ev.deviceId);
        rec.state = 'connected';
        effects.push({ type: 'answered', call: rec });
        break;
      }
      case 'hold': {
        // Holding-party view. If the holder is us, we are on hold; otherwise the other side held us.
        const holder = api.normalizeParty(ev.raw && ev.raw.holdingParty);
        if (holder && !isOwn(holder, ev)) rec.remoteHold = true;
        else { rec.state = 'held'; rec.heldAt = now; }
        break;
      }
      case 'held': {
        // Held-party view. If the held party is us, the other side put us on hold.
        const held = api.normalizeParty(ev.raw && ev.raw.heldParty);
        if (held && isOwn(held, ev)) rec.remoteHold = true;
        else { rec.state = 'held'; rec.heldAt = now; }
        break;
      }
      case 'resume':
      case 'resumed': {
        const held = api.normalizeParty(ev.raw && ev.raw.heldParty);
        if (held && isOwn(held, ev)) rec.remoteHold = false;
        else if (rec.state === 'held' || rec.state === 'parked') { rec.state = 'connected'; rec.heldAt = null; }
        else rec.remoteHold = false;
        if (!rec.answeredAt) rec.answeredAt = now;
        break;
      }
      case 'park':
        rec.state = 'parked';
        rec.parkedAt = (ev.raw && (ev.raw.parkLocationId || ev.raw.parkLocationNumber)) ? String(ev.raw.parkLocationId || ev.raw.parkLocationNumber) : rec.parkedAt;
        break;
      case 'transfer':
        rec.transferred = true;
        break;
      case 'end':
        rec.state = 'ended';
        rec.endedAt = now;
        rec.endReason = ev.endReason || null;
        // UX: keep the server's talk time so the ended bar shows what wrap-up/history show (crm.js talkMs).
        if (ev.callDurationMs != null) rec.callDurationMs = ev.callDurationMs;
        if (rec.direction === 'inbound' && !rec.answeredBy && !rec.deflected && !rec.transferred && rec.remote) {
          rec.missed = true;
          effects.push({ type: 'missed', call: rec });
        }
        effects.push({ type: 'ended', call: rec });
        break;
      default:
        break;
    }
    return { changed: live || rec.state === 'ended', effects };
  }

  /** callState from GET /calls -> card state (shape varies; missing -> connected). */
  function stateFromActive(c) {
    const s = String(c.callState || c.state || '').toLowerCase();
    if (/ring|offer|alert/.test(s)) return 'ringing';
    if (/held|hold/.test(s)) return 'held';
    if (/dial|ringback|originat/.test(s)) return 'ringback';
    return 'connected';
  }

  /**
   * Merge GET /calls into the store after a reconnect. Drops calls missing
   * from the list whose last event predates the request (they ended while we
   * were away; never counted as missed), adds calls we did not know about.
   *
   * Only the signed-in user's own calls are added. For a tenant admin GET /calls
   * may list coworkers' calls too (unverified live), and a card would offer Hang up
   * / Hold on a call the user is not a party to. The observer is the callId suffix
   * (1007-0-...:196@4, true for every captured callId) or observedParty; with
   * neither, the call is kept only when from/to is the user. No account: nothing is added.
   * @param {string|null} selfAccount the signed-in account ('196@4')
   * @returns {boolean} changed
   */
  function resync(store, activeCalls, requestedAt, now = Date.now(), selfAccount = null) {
    let changed = false;
    activeCalls = (activeCalls || []).filter((c) => isOwnActiveCall(c, selfAccount));
    const ids = new Set(activeCalls.map((c) => c.callId || c.callObserverId).filter(Boolean));
    for (const rec of Object.values(store.calls)) {
      if (rec.state !== 'ended' && !ids.has(rec.callId) && rec.lastEventAt < requestedAt) {
        rec.state = 'ended';
        rec.endedAt = now;
        rec.endReason = rec.endReason || 'Ended';
        changed = true;
      }
    }
    for (const c of activeCalls) {
      const callId = c.callId || c.callObserverId;
      if (!callId || store.calls[callId]) continue;
      // The observer account is the callId suffix (1007-0-...:196@4).
      const observedParty = (String(callId).match(/:([^:]+@[^:]+)$/) || [])[1] || null;
      const from = api.normalizeParty(c.from);
      const to = api.normalizeParty(c.to);
      const ev = { callId, smdrCallId: c.smdrCallId || null, type: 'resync', from, to, callingName: c.callingName || '', observedParty };
      ev.direction = from && isOwn(from, ev) ? 'outbound' : 'inbound';
      const rec = createRecord(ev, now);
      rec.state = stateFromActive(c);
      if (rec.state === 'connected' || rec.state === 'held') { rec.answeredAt = now; rec.answeredBy = 'self'; }
      store.calls[callId] = rec;
      changed = true;
    }
    return changed;
  }

  /** True when a GET /calls entry is observed by (or, without an observer, involves) selfAccount. */
  function isOwnActiveCall(c, selfAccount) {
    if (!c || !selfAccount) return false;
    const observer = api.callObserver(c.callId || c.callObserverId) || c.observedParty || null;
    if (observer) return api.sameAccount(observer, selfAccount);
    return api.sameParty(c.from, selfAccount) || api.sameParty(c.to, selfAccount);
  }

  /** Remove ended calls that have lingered long enough. */
  function prune(store, now = Date.now()) {
    let changed = false;
    for (const [id, rec] of Object.entries(store.calls)) {
      if (rec.state === 'ended' && now - (rec.endedAt || 0) > ENDED_LINGER_MS) { delete store.calls[id]; changed = true; }
    }
    return changed;
  }

  // ------------------------------------------------------ runtime wiring ---
  let store = newStore();
  let hydrated = false;
  const pending = [];           // events that arrived before hydration
  let writeChain = Promise.resolve();
  let pruneTimer = null;

  function snapshot() {
    const calls = Object.values(store.calls).sort((a, b) => a.createdAt - b.createdAt);
    return { calls, at: Date.now() };
  }

  /** Write the current snapshot; writes are chained so they land in order. */
  function publish() {
    const snap = snapshot();
    writeChain = writeChain.then(() => chrome.storage.session.set({ [KEYS.calls]: snap })).catch((e) => log('error', `publish failed: ${e.message}`));
    if (snap.calls.some((c) => c.state === 'ended')) schedulePrune();
    return writeChain;
  }

  function schedulePrune() {
    if (pruneTimer) return;
    pruneTimer = setTimeout(() => {
      pruneTimer = null;
      if (prune(store)) publish();
      else if (Object.values(store.calls).some((c) => c.state === 'ended')) schedulePrune();
    }, ENDED_LINGER_MS + 200);
  }

  async function notice(text, level = 'info', extra = {}) {
    await chrome.storage.session.set({ [KEYS.notice]: { text, level, at: Date.now(), ...extra } });
  }

  async function hydrate() {
    try {
      const r = await chrome.storage.session.get([KEYS.calls]);
      const snap = r[KEYS.calls];
      if (snap && Array.isArray(snap.calls)) {
        for (const c of snap.calls) if (c && c.callId && !store.calls[c.callId]) store.calls[c.callId] = c;
      }
      prune(store);
    } catch (e) {
      log('error', `could not restore calls: ${e.message}`);
    } finally {
      hydrated = true;
      const queued = pending.splice(0);
      for (const ev of queued) handleEvent(ev);
      publish();
    }
  }

  /** CRM link for an external caller, via the Screen Pop URL builder (Track C may provide crm.urlFor). */
  async function crmUrlFor(rec) {
    if (!rec.remote || !rec.remote.number) return null;
    try {
      const crm = self.OneClick.crm;
      if (crm && typeof crm.urlFor === 'function') {
        // Track C: managed policy + presets. The URL may carry a shared key
        // (Zoho), so it is never stored or sent to the page: the card shows a
        // button and the service worker opens the page (callcard:openCrm).
        const u = await crm.urlFor({ from: rec.remote.raw, name: rec.name });
        return u ? { open: true, label: u.label } : null;
      }
      const sp = self.OneClick.screenpop;
      if (!sp) return null;
      const s = await chrome.storage.sync.get(['screenPopEnabled', 'screenPopCrm', 'screenPopUrl']);
      if (!s.screenPopEnabled) return null;
      const template = s.screenPopCrm === 'custom' ? s.screenPopUrl : sp.PRESETS[s.screenPopCrm || 'simplicity'];
      if (!template) return null;
      return safeUrl(sp.buildUrl(template, { from: rec.remote.raw, name: rec.name }));
    } catch (e) {
      log('warning', `CRM link failed: ${e.message}`);
      return null;
    }
  }

  function safeUrl(u) {
    try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.href : null; } catch (e) { return null; }
  }

  async function crmLabel() {
    const s = await chrome.storage.sync.get(['screenPopCrm']);
    return s.screenPopCrm === 'custom' ? 'CRM' : 'Simplicity';
  }

  function handleEvent(ev) {
    if (!hydrated) { pending.push(ev); return; }
    const { changed, effects } = reduce(store, ev);
    if (!changed) return;
    publish();
    for (const fx of effects) {
      if (fx.type === 'new') {
        log('info', `${fx.call.direction} call ${fx.call.remote ? fx.call.remote.display : ''} (${fx.call.state})`);
        attachCrm(fx.call);
      } else if (fx.type === 'missed') {
        recordMissed(fx.call).catch((e) => log('error', `missed call: ${e.message}`));
      } else if (fx.type === 'ended') {
        onEnded(fx.call);
      } else if (fx.type === 'answered') {
        onAnswered(fx.call);
      }
    }
  }

  async function attachCrm(rec) {
    const url = await crmUrlFor(rec);
    if (!url) return;
    const live = store.calls[rec.callId];
    if (!live) return;
    if (typeof url === 'object') {
      live.crmOpen = true;
      live.crmLabel = url.label;
    } else {
      live.crmUrl = url;
      live.crmLabel = await crmLabel();
    }
    publish();
  }

  /** "Open in <CRM>" on the card: build the URL here and open it in the screen pop tab. */
  async function openCrm(callId) {
    const rec = store.calls[callId];
    const crm = self.OneClick.crm;
    const sp = self.OneClick.screenpop;
    if (!rec || !rec.remote || !crm || typeof crm.urlFor !== 'function') return { ok: false, message: 'No CRM page for this caller.' };
    const u = await crm.urlFor({ from: rec.remote.raw, name: rec.name });
    if (!u) return { ok: false, message: 'Screen pop is turned off or has no CRM address.' };
    if (sp && typeof sp.open === 'function') await sp.open(u.url);
    else await chrome.tabs.create({ url: u.url, active: true });
    log('info', `opened ${u.label} for ${rec.remote.display}`);
    return { ok: true };
  }

  // ------------------------------------------------- transfer bookkeeping ---
  function onAnswered(rec) {
    // The answering device may differ from the ringing-time default: recompute capabilities.
    refreshDeviceKeys().catch(() => {});
  }

  function onEnded(rec) {
    // A consult leg that ends without completing: resume the original call.
    if (rec.consultFor) {
      const a = store.calls[rec.consultFor];
      if (a && a.consultCallId === rec.callId && !rec.transferred) {
        a.consultCallId = null;
        a.transferTarget = null;
        publish();
      }
    }
    // The original call ended while a consult leg was up: the consult leg is a normal call now.
    if (rec.consultCallId) {
      const b = store.calls[rec.consultCallId];
      if (b) { b.consultFor = null; publish(); }
    }
  }

  // ----------------------------------------------------- device memory ---
  /**
   * Which device a control on this call goes to: the device that answered,
   * the single device that rang, the chosen phone when it is one of several
   * ringing, the default click-to-call phone, else 'default'.
   * @returns {Promise<{key:string, model:string|null}>}
   */
  async function deviceFor(rec) {
    let phones = [];
    try {
      const r = await api.getMyPhones();
      if (r.ok) phones = r.phones || [];
    } catch (e) { /* keep [] */ }
    const modelOf = (id) => {
      const p = phones.find((x) => String(x.phoneId) === String(id));
      return p ? (p.phoneModelName || null) : null;
    };
    if (rec && rec.answerDeviceId) return { key: `device:${rec.answerDeviceId}`, model: modelOf(rec.answerDeviceId) };
    if (rec && rec.devices && rec.devices.length === 1) return { key: `device:${rec.devices[0]}`, model: modelOf(rec.devices[0]) };
    if (rec && rec.devices && rec.devices.length > 1 && api.ringDevice) {
      // Ringing on several phones: Answer goes to the chosen phone (see control()).
      const d = await api.ringDevice();
      if (d.deviceId && rec.devices.includes(String(d.deviceId))) return { key: `device:${d.deviceId}`, model: modelOf(d.deviceId) };
    }
    const def = phones.find((p) => p.defaultC2CPhone) || (phones.length === 1 ? phones[0] : null);
    if (def && def.phoneId !== undefined) return { key: `device:${def.phoneId}`, model: def.phoneModelName || null };
    return { key: 'default', model: null };
  }

  async function getCaps() {
    const r = await chrome.storage.local.get([KEYS.caps]);
    return r[KEYS.caps] || {};
  }

  /**
   * Remember a refused control for this phone and for its model
   * (`model:<phoneModelName>`): basic SIP phones are re-discovered with a new
   * phoneId on every registration, so a phoneId alone is forgotten daily.
   * Entries for phoneIds no longer registered are pruned.
   */
  async function markUnsupported(device, callRequest) {
    const caps = await getCaps();
    const entry = { at: Date.now(), model: device.model };
    for (const key of [device.key, device.model ? `model:${device.model}` : null]) {
      if (!key) continue;
      caps[key] = caps[key] || {};
      caps[key][callRequest] = entry;
    }
    try {
      const r = await api.getMyPhones();
      if (r.ok && Array.isArray(r.phones) && r.phones.length) {
        const live = new Set(r.phones.map((p) => `device:${p.phoneId}`));
        for (const k of Object.keys(caps)) if (k.startsWith('device:') && k !== device.key && !live.has(k)) delete caps[k];
      }
    } catch (e) { /* keep everything */ }
    await chrome.storage.local.set({ [KEYS.caps]: caps });
    log('warning', `${callRequest} not supported on ${device.key}${device.model ? ` (${device.model})` : ''}; control disabled for this device`);
  }

  async function isUnsupported(device, callRequest) {
    const caps = await getCaps();
    const byModel = device.model ? caps[`model:${device.model}`] : null;
    return !!((caps[device.key] && caps[device.key][callRequest]) || (byModel && byModel[callRequest]));
  }

  /** Publish the device key per live call so the UI can look up capabilities. */
  async function refreshDeviceKeys() {
    let changed = false;
    for (const rec of Object.values(store.calls)) {
      if (rec.state === 'ended') continue;
      const d = await deviceFor(rec);
      if (rec.deviceKey !== d.key) { rec.deviceKey = d.key; rec.deviceModel = d.model; changed = true; }
    }
    if (changed) publish();
  }

  // ------------------------------------------------------------ controls ---
  const CONTROL_ERROR_TEXT = {
    state: 'The call is no longer in a state that allows that.',
    notFound: 'That call has already ended.',
    forbidden: "Your account isn't allowed to do that.",
    auth: 'Your PIN was rejected. Save the correct PIN in Settings.',
    stopped: 'Not connected to the phone system.',
    network: "Couldn't reach the phone system. Check your connection.",
    timeout: 'The phone system did not answer in time.',
    busy: 'The phone system is busy. Try again in a moment.',
    server: 'The phone system had a problem with that request.',
    invalid: 'The phone system rejected that request.'
  };

  /**
   * Run one control on a call.
   * @param {string} callId
   * @param {'answer'|'voicemail'|'hold'|'resume'|'hangup'|'park'} control
   * @param {{featureData?:string}} [opts]
   * @returns {Promise<{ok:boolean, unsupported?:boolean, message?:string, errorClass?:string|null}>}
   */
  async function control(callId, control, opts = {}) {
    const callRequest = CONTROL_REQUEST[control];
    const rec = store.calls[callId];
    if (!callRequest || callRequest === 'transfer') return { ok: false, message: 'Unknown control' };
    if (!rec || rec.state === 'ended') return { ok: false, message: CONTROL_ERROR_TEXT.notFound, errorClass: 'notFound' };
    const device = await deviceFor(rec);
    if (await isUnsupported(device, callRequest)) {
      // Make sure the UI shows this control disabled for the device it applies to.
      if (rec.deviceKey !== device.key) { rec.deviceKey = device.key; rec.deviceModel = device.model; publish(); }
      return { ok: false, unsupported: true, message: UNSUPPORTED_TEXT[callRequest] };
    }
    const extra = {};
    if (callRequest === 'answerCall' && api.ringDevice) {
      // Multi-desk: answer on the phone chosen in Settings when it is one of the phones ringing.
      const d = await api.ringDevice();
      if (d.deviceId && rec.devices.includes(String(d.deviceId))) extra.deviceId = String(d.deviceId);
    }
    if (callRequest === 'parkCall' && opts.featureData) extra.featureData = String(opts.featureData).replace(/\D/g, '');
    if (callRequest === 'deflectCall') {
      rec.deflected = true; // set before the end event can arrive
      // History (crm.js) records the call as sent to voicemail, not missed.
      api.emit('callcard:deflected', { callId, smdrCallId: rec.smdrCallId || null });
    }
    log('info', `${callRequest} on ${callId}`);
    const r = await api.callControl(callId, callRequest, extra);
    if (r.ok) {
      if (callRequest === 'holdCall' && store.calls[callId] && store.calls[callId].state === 'connected') {
        // Optimistic: the hold event follows, but show it now.
        store.calls[callId].state = 'held'; store.calls[callId].heldAt = Date.now(); publish();
      } else if (callRequest === 'resumeHeldCall' && store.calls[callId] && store.calls[callId].state === 'held') {
        store.calls[callId].state = 'connected'; store.calls[callId].heldAt = null; publish();
      }
      return { ok: true };
    }
    if (callRequest === 'deflectCall') {
      if (store.calls[callId]) store.calls[callId].deflected = false;
      api.emit('callcard:deflectFailed', { callId, smdrCallId: (rec && rec.smdrCallId) || null });
    }
    if (r.errorClass === 'device') {
      await markUnsupported(device, callRequest);
      if (store.calls[callId]) { store.calls[callId].deviceKey = device.key; store.calls[callId].deviceModel = device.model; publish(); }
      const message = UNSUPPORTED_TEXT[callRequest];
      await notice(message, 'warning', { callId, control });
      return { ok: false, unsupported: true, message, errorClass: 'device' };
    }
    const message = (r.errorClass && CONTROL_ERROR_TEXT[r.errorClass]) || r.message || 'That did not work.';
    log('error', `${callRequest} failed: ${r.status} ${r.errorCode || ''} (${r.errorClass})`);
    await notice(message, 'error', { callId, control });
    return { ok: false, message, errorClass: r.errorClass || null };
  }

  async function dialPrefix() {
    return api.dialPrefix(); // managed (IT-locked) prefix wins, same as click-to-dial
  }

  /** Digits worth dialing from free text (selection, tel: link, typed target), else ''. */
  function cleanNumber(text) {
    const s = String(text || '').trim().replace(/^tel:/i, '');
    if (!s || s.length > 40) return '';
    if (/[a-z]/i.test(s.replace(/\b(ext|x)\.?\s*\d+$/i, ''))) return ''; // words, not a number
    const main = s.replace(/\b(ext|x)\.?\s*\d+$/i, '');
    const digits = main.replace(/[^\d*#]/g, '');
    if (digits.length < 2 || digits.length > 15) return '';
    return digits;
  }

  /**
   * Start a transfer: hold call A (if the phone can), place call B to the
   * target, and link them. mode 'consult' waits for the user to press
   * Complete; mode 'now' completes as soon as the target starts ringing.
   */
  async function startTransfer(callId, target, mode = 'consult') {
    const a = store.calls[callId];
    if (!a || a.state === 'ended') return { ok: false, message: CONTROL_ERROR_TEXT.notFound };
    if (a.consultCallId) return { ok: false, message: 'A transfer is already in progress for this call.' };
    const digits = cleanNumber(target);
    if (!digits) return { ok: false, message: 'Enter an extension or phone number to transfer to.' };
    const device = await deviceFor(a);
    if (await isUnsupported(device, 'transfer')) return { ok: false, unsupported: true, message: UNSUPPORTED_TEXT.transfer };

    if (a.state === 'connected') {
      const h = await control(callId, 'hold');
      if (!h.ok && !h.unsupported) return { ok: false, message: `Couldn't put the caller on hold: ${h.message}` };
    }
    const to = api.dialString(digits, await dialPrefix());
    log('info', `transfer (${mode}) of ${callId}: calling ${to}`);
    // Place the consult call from the phone that has call A, not just the chosen phone.
    const fromDevice = a.answerDeviceId || (a.devices.length === 1 ? a.devices[0] : null);
    const r = await api.makeCall(to, fromDevice ? { deviceId: String(fromDevice) } : {});
    if (!r.ok || !r.callId) {
      const message = r.errorClass === 'device'
        ? 'Your phone could not place the second call needed for a transfer.'
        : ((r.errorClass && CONTROL_ERROR_TEXT[r.errorClass]) || r.message || 'Could not call the transfer target.');
      if (r.errorClass === 'device') await markUnsupported(device, 'transfer');
      await notice(message, 'error', { callId, control: 'transfer' });
      return { ok: false, message, unsupported: r.errorClass === 'device' };
    }
    const now = Date.now();
    const b = store.calls[r.callId] || createRecord({ callId: r.callId, type: 'dial', direction: 'outbound', to: api.normalizeParty(digits), from: null, callingName: '', observedParty: null }, now);
    b.consultFor = callId;
    b.transferMode = mode;
    b.transferTarget = digits;
    store.calls[r.callId] = b;
    const liveA = store.calls[callId];
    if (liveA) { liveA.consultCallId = r.callId; liveA.transferTarget = digits; liveA.transferMode = mode; }
    publish();
    if (mode === 'now') scheduleAutoComplete(r.callId);
    return { ok: true, consultCallId: r.callId };
  }

  /**
   * "Transfer now": complete once the target rings or answers. Never transfer
   * blind on a timer: makeCall rings the user's own phone first, so the
   * target leg may not exist yet. After TIMING.autoCompleteMs without ringback the
   * transfer falls back to consult mode (Complete / Cancel buttons).
   */
  const TIMING = { autoCompleteMs: 8000 }; // exposed for tests
  function scheduleAutoComplete(consultCallId) {
    const t0 = Date.now();
    const tick = async () => {
      const b = store.calls[consultCallId];
      if (!b || b.state === 'ended' || b.transferDone) return;
      if (b.state === 'ringback' || b.state === 'connected') {
        await completeTransfer(b.consultFor);
        return;
      }
      if (Date.now() - t0 > TIMING.autoCompleteMs) {
        b.transferMode = 'consult';
        const a = store.calls[b.consultFor];
        if (a) { a.transferMode = 'consult'; a.transferStalled = true; }
        publish();
        log('info', `transfer of ${b.consultFor}: target not ringing yet, waiting for Complete`);
        return;
      }
      setTimeout(tick, 250);
    };
    setTimeout(tick, 250);
  }

  /** POST transfer on the consult leg with otherCallId = the original call. */
  async function completeTransfer(callId) {
    const a = store.calls[callId];
    if (!a || !a.consultCallId) return { ok: false, message: 'No transfer in progress.' };
    const b = store.calls[a.consultCallId];
    if (!b || b.state === 'ended') return { ok: false, message: 'The transfer target hung up.' };
    b.transferDone = true;
    const r = await api.callControl(b.callId, 'transfer', { otherCallId: a.callId });
    if (r.ok) {
      a.transferred = true; b.transferred = true;
      publish();
      await notice(`Transferred to ${b.transferTarget || 'target'}.`, 'success', { callId });
      return { ok: true };
    }
    b.transferDone = false;
    if (r.errorClass === 'device') {
      const device = await deviceFor(a);
      await markUnsupported(device, 'transfer');
    }
    const message = r.errorClass === 'device' ? UNSUPPORTED_TEXT.transfer : ((r.errorClass && CONTROL_ERROR_TEXT[r.errorClass]) || r.message || 'Transfer failed.');
    await notice(message, 'error', { callId, control: 'transfer' });
    return { ok: false, message, unsupported: r.errorClass === 'device' };
  }

  /** Cancel: hang up the consult leg and resume the original call. */
  async function cancelTransfer(callId) {
    const a = store.calls[callId];
    if (!a || !a.consultCallId) return { ok: false, message: 'No transfer in progress.' };
    const bId = a.consultCallId;
    a.consultCallId = null; a.transferTarget = null;
    publish();
    if (store.calls[bId] && store.calls[bId].state !== 'ended') await api.callControl(bId, 'hangupCall');
    if (a.state === 'held') await control(callId, 'resume');
    return { ok: true };
  }

  // -------------------------------------------------------- missed calls ---
  async function recordMissed(rec) {
    const r = await chrome.storage.local.get([KEYS.missed]);
    const list = r[KEYS.missed] || [];
    if (list.some((m) => m.callId === rec.callId)) return;
    const entry = {
      id: `${rec.callId}`,
      callId: rec.callId,
      number: rec.remote ? (rec.remote.number || rec.remote.ext || rec.remote.raw) : '',
      display: rec.remote ? rec.remote.display : 'Unknown caller',
      name: rec.name || '',
      at: rec.endedAt || Date.now(),
      seen: false
    };
    list.unshift(entry);
    const trimmed = list.slice(0, MISSED_MAX);
    await chrome.storage.local.set({ [KEYS.missed]: trimmed, [KEYS.unseen]: trimmed.filter((m) => !m.seen).length });
    log('info', `missed call from ${entry.display}`);
    await notifyMissed(entry);
  }

  async function updateMissed(fn) {
    const r = await chrome.storage.local.get([KEYS.missed]);
    const list = fn(r[KEYS.missed] || []);
    await chrome.storage.local.set({ [KEYS.missed]: list, [KEYS.unseen]: list.filter((m) => !m.seen).length });
    return list;
  }

  async function notificationsGranted() {
    try { return await chrome.permissions.contains({ permissions: ['notifications'] }); } catch (e) { return false; }
  }

  async function notifyMissed(entry) {
    if (!chrome.notifications || !(await notificationsGranted())) return;
    try {
      const canCallBack = !!cleanNumber(entry.number);
      chrome.notifications.create(`callcard-missed:${entry.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Missed call',
        message: entry.name ? `${entry.name}\n${entry.display}` : entry.display,
        contextMessage: 'Vaspian One Click',
        buttons: canCallBack ? [{ title: 'Call back' }] : [],
        priority: 1
      });
    } catch (e) {
      log('warning', `notification failed: ${e.message}`);
    }
  }

  async function notifyText(title, message) {
    if (!chrome.notifications || !(await notificationsGranted())) return false;
    try {
      chrome.notifications.create(`callcard-info:${Date.now()}`, { type: 'basic', iconUrl: 'icons/icon128.png', title, message, priority: 0 });
      return true;
    } catch (e) { return false; }
  }

  let notificationListeners = false;
  function wireNotifications() {
    if (notificationListeners || !chrome.notifications) return;
    notificationListeners = true;
    const missedIdOf = (nid) => (String(nid).startsWith('callcard-missed:') ? String(nid).slice('callcard-missed:'.length) : null);
    chrome.notifications.onButtonClicked.addListener((nid) => {
      const id = missedIdOf(nid);
      if (!id) return;
      callBack(id).catch((e) => log('error', `call back: ${e.message}`));
      chrome.notifications.clear(nid);
    });
    chrome.notifications.onClicked.addListener((nid) => {
      if (!missedIdOf(nid) && !String(nid).startsWith('callcard-info:')) return;
      chrome.notifications.clear(nid);
    });
  }

  /** Call back a missed caller (by missed id) with the shared dial path. */
  async function callBack(id) {
    const r = await chrome.storage.local.get([KEYS.missed]);
    const entry = (r[KEYS.missed] || []).find((m) => m.id === id);
    if (!entry) return { success: false, error: 'That missed call is gone.' };
    if (entry.name) api.emit('dial:nameHint', { number: entry.number, name: entry.name });
    const result = await dial(entry.number);
    if (result.success) await updateMissed((list) => list.filter((m) => m.id !== id));
    return result;
  }

  /** Dial through background.js (3PCC first, X-Tone fallback). */
  async function dial(number) {
    const digits = cleanNumber(number);
    if (!digits) return { success: false, error: 'That does not look like a phone number.' };
    try {
      const result = await self.OneClick.dial(digits);
      return { success: true, result };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  // --------------------------------------------- commands & context menu ---
  /** The ringing inbound call to answer / the live call to hang up. */
  function pick(kind) {
    const live = Object.values(store.calls).filter((c) => c.state !== 'ended').sort((a, b) => b.createdAt - a.createdAt);
    if (kind === 'ringing') return live.find((c) => c.direction === 'inbound' && c.state === 'ringing') || null;
    return live.find((c) => c.state === 'connected')
      || live.find((c) => c.state === 'ringback' || c.state === 'dialing')
      || live.find((c) => c.direction === 'inbound' && c.state === 'ringing')
      || live.find((c) => c.state === 'held')
      || null;
  }

  /**
   * chrome.commands handler (exposed for tests).
   *  answer          answer the newest ringing inbound call
   *  hangup          hang up the active call; a ringing inbound call is sent to
   *                  voicemail instead (hangupCall on a ringing call is a 409)
   *  dial-selection  ask the focused frame of the active tab for its selection
   */
  async function onCommand(name) {
    if (name === 'answer') {
      const c = pick('ringing');
      if (!c) { log('info', 'answer shortcut: nothing ringing'); return { ok: false, message: 'Nothing is ringing.' }; }
      return control(c.callId, 'answer');
    }
    if (name === 'hangup') {
      const c = pick('active');
      if (!c) { log('info', 'hang up shortcut: no call'); return { ok: false, message: 'No call to hang up.' }; }
      return control(c.callId, c.direction === 'inbound' && c.state === 'ringing' ? 'voicemail' : 'hangup');
    }
    if (name === 'dial-selection') return dialSelectionInActiveTab();
    return { ok: false, ignored: true };
  }

  /**
   * The content script reads the selection in the focused frame and dials it
   * through its own makeCall (which shows the on-page "Calling..." toast).
   */
  async function dialSelectionInActiveTab() {
    let tab = null;
    try { [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true }); } catch (e) { tab = null; }
    if (!tab || tab.id === undefined) return { ok: false, message: 'No active tab.' };
    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { action: 'callcard:dialSelection' });
    } catch (e) {
      res = null; // no content script on this page (chrome://, Web Store, PDF viewer...)
    }
    if (!res || !res.text) {
      log('info', 'dial-selection: no selected phone number in the active tab');
      await notifyText('Nothing to call', 'Select a phone number on the page, then press the shortcut again.');
      return { ok: false, message: 'No phone number selected.' };
    }
    if (res.invalid) return { ok: false, message: 'The selection is not a phone number.' };
    return { ok: true, handledBy: 'content' };
  }

  /** contextMenus.onClicked handler (exposed for tests). */
  async function onMenuClick(info) {
    if (!info || (info.menuItemId !== MENU_SELECTION && info.menuItemId !== MENU_LINK)) return { success: false, ignored: true };
    const text = info.menuItemId === MENU_LINK ? decodeURIComponent(String(info.linkUrl || '')) : info.selectionText;
    const digits = cleanNumber(text);
    if (!digits) {
      log('info', 'context menu: selection is not a phone number');
      await notifyText('Not a phone number', 'Select a phone number (digits, spaces, dashes or parentheses) to call it.');
      return { success: false, error: 'That does not look like a phone number.' };
    }
    const r = await dial(digits);
    if (!r.success) await notifyText('Call failed', r.error);
    return r;
  }

  function createMenus() {
    const done = () => { void chrome.runtime.lastError; }; // duplicate id on reinstall: ignore
    try {
      chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Call "%s" with Vaspian', contexts: ['selection'] }, done);
      chrome.contextMenus.create({ id: MENU_LINK, title: 'Call with Vaspian', contexts: ['link'], targetUrlPatterns: ['tel:*'] }, done);
    } catch (e) {
      log('warning', `context menu: ${e.message}`);
    }
  }

  // ----------------------------------------------------- message handler ---
  const handlers = {
    'callcard:control': (m) => control(m.callId, m.control, m),
    'callcard:transfer': (m) => startTransfer(m.callId, m.target, m.mode === 'now' ? 'now' : 'consult'),
    'callcard:completeTransfer': (m) => completeTransfer(m.callId),
    'callcard:cancelTransfer': (m) => cancelTransfer(m.callId),
    'callcard:dial': (m) => dial(m.number),
    'callcard:callBack': (m) => callBack(m.id),
    'callcard:missedSeen': async () => { await updateMissed((l) => l.map((x) => ({ ...x, seen: true }))); return { ok: true }; },
    'callcard:missedRemove': async (m) => { await updateMissed((l) => l.filter((x) => x.id !== m.id)); return { ok: true }; },
    'callcard:missedClear': async () => { await updateMissed(() => []); return { ok: true }; },
    'callcard:dismiss': async (m) => { if (store.calls[m.callId] && store.calls[m.callId].state === 'ended') { delete store.calls[m.callId]; publish(); } return { ok: true }; },
    'callcard:resetCaps': async () => { await chrome.storage.local.remove(KEYS.caps); return { ok: true }; },
    'callcard:notificationsChanged': async () => { wireNotifications(); return { ok: true, granted: await notificationsGranted() }; },
    'callcard:refresh': async () => { await refreshDeviceKeys(); return { ok: true }; },
    'callcard:openCrm': async (m) => openCrm(m.callId)
  };

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    const h = request && handlers[request.action];
    if (!h) return undefined;
    Promise.resolve()
      .then(() => h(request))
      .then((r) => sendResponse(r))
      .catch((e) => { log('error', `${request.action}: ${e.message}`); sendResponse({ ok: false, success: false, message: e.message, error: e.message }); });
    return true;
  });

  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener((name) => {
      if (name !== 'answer' && name !== 'hangup' && name !== 'dial-selection') return; // toggle-dnd is Track B's
      onCommand(name).catch((e) => log('error', `command ${name}: ${e.message}`));
    });
  }
  if (chrome.contextMenus) {
    chrome.contextMenus.onClicked.addListener((info) => {
      onMenuClick(info).catch((e) => log('error', `context menu: ${e.message}`));
    });
    chrome.runtime.onInstalled.addListener(() => createMenus());
  }
  wireNotifications();
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener((p) => { if (p.permissions && p.permissions.includes('notifications')) wireNotifications(); });
  }

  // ---------------------------------------------------------- bus wiring ---
  api.on('call', (ev) => {
    try { handleEvent(ev); } catch (e) { log('error', `event ${ev && ev.type}: ${e.message}`); }
  });
  api.on('call:new', () => { refreshDeviceKeys().catch(() => {}); });

  api.on('connected', async () => {
    const requestedAt = Date.now();
    const r = await api.getActiveCalls();
    if (!r.ok) return;
    if (!hydrated) await new Promise((res) => setTimeout(res, 100));
    const me = api.getSession ? api.getSession() : null;
    if (resync(store, r.calls || [], requestedAt, Date.now(), me && me.account)) publish();
    refreshDeviceKeys().catch(() => {});
  });

  api.on('credentials', async (c) => {
    // Another extension logged in (or logout): the calls and missed list were someone else's.
    const r = await chrome.storage.local.get([KEYS.owner]);
    const owner = c && c.complete ? String(c.extension || '') : '';
    if (r[KEYS.owner] !== undefined && r[KEYS.owner] !== owner) {
      store = newStore();
      publish();
      await chrome.storage.local.set({ [KEYS.missed]: [], [KEYS.unseen]: 0, [KEYS.caps]: {} });
    }
    await chrome.storage.local.set({ [KEYS.owner]: owner });
  });

  hydrate();

  self.OneClick.calls = {
    track: 'callcard',
    version: VERSION,
    KEYS,
    CONTROL_REQUEST,
    UNSUPPORTED_TEXT,
    TIMING,
    // pure helpers (unit tests)
    newStore, reduce, resync, prune, cleanNumber, stateFromActive,
    // runtime
    getStore: () => store,
    control, startTransfer, completeTransfer, cancelTransfer, dial, callBack, openCrm,
    onCommand, onMenuClick, deviceFor
  };
})();
