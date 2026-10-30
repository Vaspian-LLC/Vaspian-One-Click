// Screen pop for Vaspian One Click (service worker).
//
// Opens a CRM page for the caller's number when an inbound call rings or is
// answered. The connection, credentials and event normalization all live in
// lib/vaspian-api.js; this module only listens to the bus:
//   - 'call:new' / 'call:offer' remember the caller (offer can arrive twice on
//     ring groups; 3PCC-originated inbound calls arrive with no offer at all)
//   - trigger 'offer'  -> pop on the first inbound event
//   - trigger 'answer' -> pop when the answering party is this user
//   - 'call:end' forgets the call
// Pops once per callId. Internal callers (extensions) pop only when the user
// opted in (screenPopInternal) and the URL template uses {phone} or {name}:
// the number-based tokens ({phone10}, {e164}) have nothing to fill in.
//
// Loaded into background.js with importScripts() after lib/vaspian-api.js.
// Track C (crm) extends it from crm.js: when self.OneClick.crm is loaded,
// settings come from crm.effectiveSettings() (managed policy over sync) and
// the URL template from crm.templateFor() (Simplicity, Zoho Desk, SecureCRM,
// custom). Without crm.js this file keeps the v1.2 behavior.

(function () {
  'use strict';
  const api = self.OneClick.api;

  const SCREEN_POP_PRESETS = {
    simplicity: 'https://app.simplicitycollect.com/dialer/update.aspx?dialer=true&phone={phone10}'
  };

  let calls = {}; // callId -> { from, name, popped }

  /** crm.js (Track C) loads after this file; look it up at call time. */
  const crm = () => (self.OneClick && self.OneClick.crm) || null;

  async function settings() {
    // Track C: managed policy over the user's settings, plus CRM preset options.
    if (crm() && crm().effectiveSettings) return crm().effectiveSettings();
    return chrome.storage.sync.get(['screenPopEnabled', 'screenPopCrm', 'screenPopUrl', 'screenPopTrigger']);
  }

  /** Last 10 digits of a North American number; '' for internal callers. */
  function normalize(number) {
    const p = api.normalizeParty(number, { selfExt: '' });
    return p && p.number ? p.number : '';
  }

  function buildUrl(template, call) {
    const phone10 = normalize(call.from);
    return template
      .replaceAll('{phone10}', phone10)
      .replaceAll('{e164}', phone10 ? encodeURIComponent(`+1${phone10}`) : '')
      .replaceAll('{phone}', encodeURIComponent(call.from || ''))
      .replaceAll('{name}', encodeURIComponent(call.name || ''));
  }

  /**
   * Open the CRM page. Reuses only the tab the last pop opened, so a tab the
   * agent is working in (half-typed notes) is never navigated away.
   */
  async function open(url) {
    const { screenPopTabId } = await chrome.storage.session.get(['screenPopTabId']);
    let tab = null;
    if (screenPopTabId) {
      try { tab = await chrome.tabs.get(screenPopTabId); } catch (e) { tab = null; }
    }
    if (tab) {
      await chrome.tabs.update(tab.id, { url, active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      addLog('success', `Screen pop: reused pop tab ${tab.id}`); // eslint-disable-line no-undef
    } else {
      tab = await chrome.tabs.create({ url, active: true });
      await chrome.storage.session.set({ screenPopTabId: tab.id });
      addLog('success', `Screen pop: opened new tab ${tab.id}`); // eslint-disable-line no-undef
    }
  }

  async function pop(callId) {
    const call = calls[callId];
    if (!call || call.popped) return;
    call.popped = true;

    const s = await settings();
    if (!s.screenPopEnabled && callId !== 'test') return;
    const template = crm() && crm().templateFor
      ? crm().templateFor(s)
      : (s.screenPopCrm === 'custom' ? s.screenPopUrl : SCREEN_POP_PRESETS[s.screenPopCrm || 'simplicity']);
    if (!template) {
      addLog('error', 'Screen pop: no URL configured'); // eslint-disable-line no-undef
      return;
    }
    if (!normalize(call.from)) {
      const internalOk = s.screenPopInternal && /\{(phone|name)\}/.test(template) && !/\{(phone10|e164)\}/.test(template);
      if (!internalOk) {
        addLog('info', `Screen pop: skipped ${call.from} (internal or not a 10-digit number)`); // eslint-disable-line no-undef
        return;
      }
    }
    const url = buildUrl(template, call);
    // Never log or store a CRM shared key (e.g. the Zoho worker's key=).
    const safeUrl = crm() && crm().redactUrl ? crm().redactUrl(url) : url;
    addLog('info', `Screen pop for ${call.from} (${call.name || 'no name'}): ${safeUrl}`); // eslint-disable-line no-undef
    await chrome.storage.local.set({ screenPopLast: { from: call.from, name: call.name, url: safeUrl, at: new Date().toISOString() } });
    await open(url);
  }

  /** @param {object} ev normalized call event from the bus */
  async function handleCall(ev) {
    const s = await settings();
    if (!s.screenPopEnabled) {
      if (ev.type === 'end') delete calls[ev.callId];
      return;
    }
    const trigger = s.screenPopTrigger || 'answer';
    const inbound = ev.direction === 'inbound';

    // Also an 'answer' for a call we don't know: the socket reconnected
    // while it rang (our map was cleared, the API's call memory was not).
    const answeredHere = ev.type === 'answer' && ev.answeringParty && ev.answeringParty.isSelf;
    if (inbound && !calls[ev.callId] && ev.from && !ev.from.isSelf && (ev.type === 'offer' || ev.isNew || answeredHere)) {
      calls[ev.callId] = { from: ev.from.raw, name: ev.callingName || '', popped: false };
      addLog('info', `Screen pop: incoming call from ${ev.from.raw} (${ev.callingName || 'no name'})`); // eslint-disable-line no-undef
    }
    if (ev.type === 'offer' && trigger === 'offer') await pop(ev.callId);
    else if (ev.type === 'answer' && trigger === 'answer' && calls[ev.callId] && ev.answeringParty && ev.answeringParty.isSelf) {
      await pop(ev.callId);
    } else if (ev.type === 'end') {
      delete calls[ev.callId];
    }
  }

  api.on('call', (ev) => handleCall(ev).catch((e) => addLog('error', `Screen pop: ${e.message}`))); // eslint-disable-line no-undef
  api.on('disconnected', () => { calls = {}; });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'screenPopTest') {
      calls.test = { from: request.phoneNumber, name: 'Test call', popped: false };
      pop('test')
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error.message }));
      return true;
    } else if (request.action === 'screenPopReconnect') {
      api.reconnect().then((r) => sendResponse({ success: r.ok, refused: r.refused || null }));
      return true;
    }
    return undefined;
  });

  self.OneClick.screenpop = { PRESETS: SCREEN_POP_PRESETS, buildUrl, normalize, pop, open };
})();
