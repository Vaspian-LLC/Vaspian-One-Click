// Live call card UI (popup and sidebar). Track A "callcard".
//
// Renders into <div id="callCardMount"> at the top of the Dial tab:
//   - one card per live call (caller, number, direction, state, timer,
//     CRM link) with state-aware controls: Answer / Voicemail while ringing,
//     Hold-Resume / Transfer / Park / Hang up while connected
//   - controls the user's phone refused (calls.js remembers them per device)
//     are shown disabled with a tooltip and a one-line explanation
//   - the missed-call list with Call back, and an "Enable desktop
//     notifications" button (optional permission, requested on click)
// Nothing is rendered while idle with no missed calls, so the mount collapses.
//
// State comes from calls.js through storage (session.callcardCalls,
// session.callcardNotice, local.callcardMissed, local.callcardDeviceCaps);
// commands go back with chrome.runtime.sendMessage({action:'callcard:<verb>'}).
// Event data (caller names, numbers) is only ever set with textContent.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  const ENDED_VISIBLE_MS = 6000;
  const NOTICE_VISIBLE_MS = 6000;
  const MISSED_COLLAPSED = 3;

  /** Control -> 3PCC callRequest (matches calls.js CONTROL_REQUEST). */
  const REQ = { answer: 'answerCall', voicemail: 'deflectCall', hold: 'holdCall', resume: 'resumeHeldCall', hangup: 'hangupCall', park: 'parkCall', transfer: 'transfer' };
  const UNSUPPORTED = {
    answerCall: "Your phone model doesn't support remote answer",
    deflectCall: "Your phone model doesn't support sending calls to voicemail from the browser",
    holdCall: "Your phone model doesn't support remote hold",
    resumeHeldCall: "Your phone model doesn't support remote resume",
    hangupCall: "Your phone model doesn't support remote hang up",
    parkCall: "Your phone model doesn't support parking from the browser",
    transfer: "Your phone model doesn't support transfer from the browser"
  };
  const HINT = {
    answerCall: 'Pick up on your phone to answer.',
    holdCall: 'Use the Hold key on your phone.',
    resumeHeldCall: 'Resume from your phone.',
    parkCall: "Use your phone's Park key.",
    transfer: 'Transfer from your phone.',
    deflectCall: 'Let it ring through to voicemail.',
    hangupCall: 'Hang up on your phone.'
  };

  const ICONS = {
    answer: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    hangup: '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7a2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91"/><line x1="23" y1="1" x2="1" y2="23"/>',
    voicemail: '<circle cx="5.5" cy="11.5" r="4.5"/><circle cx="18.5" cy="11.5" r="4.5"/><line x1="5.5" y1="16" x2="18.5" y2="16"/>',
    hold: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    resume: '<polygon points="6 4 20 12 6 20 6 4"/>',
    transfer: '<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>',
    park: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
    incoming: '<line x1="17" y1="7" x2="7" y2="17"/><polyline points="16 17 7 17 7 8"/>',
    outgoing: '<line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    missed: '<line x1="23" y1="1" x2="17" y2="7"/><line x1="17" y1="1" x2="23" y2="7"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
  };

  let mountEl = null;
  let miniEl = null;   // #callMiniMount: compact bar on the other tabs
  let directory = [];  // statusDirectory users, for transfer suggestions
  let model = { calls: [], missed: [], caps: {}, notice: null, notifGranted: false, notifAvailable: false };
  const ui = { transferOpen: {}, transferValue: {}, busy: {}, missedExpanded: false, localMsg: {} };
  let tickTimer = null;
  let seenTimer = null;

  // ------------------------------------------------------------ helpers ---
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function icon(name, size = 18) {
    const span = el('span', 'cc-icon');
    // Static markup from ICONS only (never event data).
    span.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
    return span;
  }
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || { ok: false, message: 'No response from the extension.' }); });
      } catch (e) { resolve({ ok: false, message: e.message }); }
    });
  }
  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  function timeAgo(at) {
    const d = Date.now() - at;
    if (d < 60000) return 'Just now';
    if (d < 3600000) return `${Math.floor(d / 60000)} min ago`;
    const date = new Date(at);
    const today = new Date();
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (date.toDateString() === today.toDateString()) return time;
    const y = new Date(today); y.setDate(today.getDate() - 1);
    if (date.toDateString() === y.toDateString()) return `Yesterday ${time}`;
    return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
  }
  /**
   * Carrier caller ID often arrives in capitals ("JORDAN LEE"); show it in
   * Title Case like the directory. Mixed-case names are left alone. Display
   * only: lookups keep the raw value.
   */
  function nice(name) {
    const s = String(name || '');
    if (!s || /[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  function initials(name) {
    const words = String(name || '').replace(/[^A-Za-z\s'-]/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }
  function who(call) {
    const r = call.remote;
    const display = r ? r.display : 'Unknown caller';
    if (call.name) return { name: nice(call.name), sub: display };
    if (r && r.isInternal) return { name: display, sub: 'Internal extension' };
    return { name: display, sub: r && r.number ? (call.direction === 'outbound' ? 'Outside call' : 'Outside caller') : '' };
  }
  function unsupported(call, control) {
    const req = REQ[control];
    // Per phone, and per phone model: auto-discovered SIP phones get a new
    // phoneId on every registration, the model name stays.
    const dev = call.deviceKey && model.caps[call.deviceKey];
    const mod = call.deviceModel && model.caps[`model:${call.deviceModel}`];
    return !!((dev && dev[req]) || (mod && mod[req]));
  }
  function visibleCalls() {
    const now = Date.now();
    const byId = new Map(model.calls.map((c) => [c.callId, c]));
    return model.calls.filter((c) => {
      if (c.state === 'ended' && now - (c.endedAt || 0) > ENDED_VISIBLE_MS) return false;
      if (c.state === 'ended' && c.missed) return false; // the missed list shows it
      // A consult leg is shown inside the call it transfers.
      if (c.consultFor && byId.has(c.consultFor) && byId.get(c.consultFor).state !== 'ended') return false;
      return true;
    }).sort((a, b) => {
      const rank = (c) => (c.state === 'ringing' && c.direction === 'inbound' ? 0 : c.state === 'ended' ? 3 : c.state === 'held' ? 2 : 1);
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    });
  }

  // ---------------------------------------------------------- rendering ---
  function stateInfo(call) {
    const inbound = call.direction === 'inbound';
    switch (call.state) {
      case 'ringing': return { cls: inbound ? 'ringing' : 'calling', label: inbound ? 'Ringing' : 'Calling…', timer: false };
      case 'dialing': return { cls: 'calling', label: 'Dialing…', timer: false };
      case 'ringback': return { cls: 'calling', label: 'Ringing…', timer: false };
      case 'connected': return { cls: 'connected', label: call.remoteHold ? 'They put you on hold' : 'Connected', timer: true };
      case 'held': return { cls: 'held', label: 'On hold', timer: true };
      case 'parked': return { cls: 'held', label: call.parkedAt ? `Parked on ${call.parkedAt}` : 'Parked', timer: false };
      case 'ended': {
        let label = 'Call ended';
        if (call.missed) label = 'Missed call';
        else if (call.answeredBy === 'other') label = 'Answered elsewhere';
        else if (call.deflected) label = 'Sent to voicemail';
        else if (call.transferred) label = 'Transferred';
        else if (call.parkedAt) label = `Parked on ${call.parkedAt}`;
        return { cls: 'ended', label, timer: false };
      }
      default: return { cls: 'connected', label: call.state, timer: false };
    }
  }

  function controlsFor(call) {
    if (call.state === 'ringing' && call.direction === 'inbound') return ['answer', 'voicemail'];
    if (call.state === 'ringing' || call.state === 'dialing' || call.state === 'ringback') return ['hangup'];
    // During a transfer the bar's Complete / Cancel are the only actions (no accidental hang-up on the caller).
    if (call.consultCallId) return [];
    if (call.state === 'connected') return ['hold', 'transfer', 'park', 'hangup'];
    if (call.state === 'held') return ['resume', 'transfer', 'park', 'hangup'];
    return [];
  }
  const LABEL = { answer: 'Answer', voicemail: 'Voicemail', hold: 'Hold', resume: 'Resume', transfer: 'Transfer', park: 'Park', hangup: 'Hang up' };
  const TITLE = {
    answer: 'Answer (Alt+Shift+A)', voicemail: 'Send to voicemail, or wherever your unanswered calls go', hold: 'Put the caller on hold',
    resume: 'Take the caller off hold', transfer: 'Transfer to an extension or number', park: 'Park the call so anyone can pick it up',
    hangup: 'Hang up (Alt+Shift+H)'
  };

  /** A finished call: one slim line that fades out after a few seconds. */
  function renderEnded(call) {
    const info = stateInfo(call);
    const card = el('section', 'cc-card cc-ended cc-compact');
    card.dataset.callId = call.callId;
    const row = el('div', 'cc-compact-row');
    row.append(icon(call.direction === 'inbound' ? 'incoming' : 'outgoing', 14));
    const w = who(call);
    const txt = el('div', 'cc-compact-text');
    const nm = el('span', 'cc-compact-name', w.name); nm.title = w.name;
    txt.append(nm, el('span', 'cc-state-label', info.label));
    row.append(txt);
    if (call.answeredAt && call.endedAt && call.answeredBy === 'self') row.append(el('span', 'cc-timer', fmtDuration(call.endedAt - call.answeredAt)));
    const x = el('button', 'cc-dismiss');
    x.type = 'button'; x.title = 'Dismiss'; x.setAttribute('aria-label', 'Dismiss');
    x.dataset.action = 'dismiss'; x.dataset.callId = call.callId;
    x.append(icon('close', 14));
    row.append(x);
    card.append(row);
    return card;
  }

  // "Incoming call" while it rings; once it's up, just the direction.
  function dirLabel(call, info) {
    const inbound = call.direction === 'inbound';
    if (info.cls === 'ringing' || info.cls === 'calling') return inbound ? 'Incoming call' : 'Outgoing call';
    return inbound ? 'Inbound' : 'Outbound';
  }

  function renderCard(call) {
    if (call.state === 'ended') return renderEnded(call);
    const info = stateInfo(call);
    const card = el('section', `cc-card cc-${info.cls}`);
    card.dataset.callId = call.callId;
    card.setAttribute('aria-label', `${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call`);

    // ---- band
    const band = el('div', 'cc-band');
    const top = el('div', 'cc-band-top');
    const dir = el('span', 'cc-dir');
    dir.append(icon(call.direction === 'inbound' ? 'incoming' : 'outgoing', 13), el('span', '', dirLabel(call, info)));
    const state = el('span', 'cc-state');
    if (info.cls === 'ringing' || info.cls === 'calling') state.append(el('span', 'cc-dot'));
    state.append(el('span', 'cc-state-label', info.label));
    if (info.timer && call.answeredAt) {
      const t = el('span', 'cc-timer', fmtDuration(Date.now() - call.answeredAt));
      t.dataset.since = String(call.answeredAt);
      state.append(t);
    }
    top.append(dir, state);

    const id = el('div', 'cc-id');
    const w = who(call);
    const avatar = el('div', 'cc-avatar');
    const ini = initials(call.name);
    if (ini) avatar.textContent = ini; else avatar.append(icon('user', 20));
    const names = el('div', 'cc-names');
    const nm = el('div', 'cc-name', w.name); nm.title = w.name;
    names.append(nm);
    if (w.sub) names.append(el('div', 'cc-sub', w.sub));
    id.append(avatar, names);
    band.append(top, id);

    if (call.crmUrl && /^https?:\/\//i.test(call.crmUrl)) {
      const a = el('a', 'cc-crm');
      a.href = call.crmUrl; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.title = 'Open this caller in your CRM';
      a.append(el('span', '', `Open in ${call.crmLabel || 'CRM'}`), icon('external', 13));
      band.append(a);
    } else if (call.crmOpen) {
      // The service worker builds and opens the URL (it can carry a CRM key).
      const b = el('button', 'cc-crm');
      b.type = 'button'; b.dataset.action = 'open-crm'; b.dataset.callId = call.callId;
      b.title = 'Open this caller in your CRM';
      b.append(el('span', '', `Open in ${call.crmLabel || 'CRM'}`), icon('external', 13));
      band.append(b);
    }
    card.append(band);

    // ---- body
    const controls = controlsFor(call);
    const consult = call.consultCallId ? model.calls.find((c) => c.callId === call.consultCallId) : null;
    if (!controls.length && !consult && !noticeFor(call)) return card;
    const body = el('div', 'cc-body');

    if (consult || call.consultCallId) body.append(renderTransferBar(call, consult));

    if (controls.length) {
      const grid = el('div', `cc-controls cc-n${controls.length}`);
      const blocked = [];
      for (const c of controls) {
        const b = el('button', `cc-btn cc-btn-${c}`);
        b.type = 'button';
        b.dataset.action = 'control'; b.dataset.control = c; b.dataset.callId = call.callId;
        b.append(icon(c === 'hangup' ? 'hangup' : c, 20), el('span', 'cc-btn-label', LABEL[c]));
        const off = unsupported(call, c);
        const busy = ui.busy[`${call.callId}|${c}`];
        if (off) {
          b.classList.add('cc-unsupported');
          b.setAttribute('aria-disabled', 'true');
          b.title = UNSUPPORTED[REQ[c]];
          blocked.push(REQ[c]);
        } else {
          b.title = TITLE[c];
        }
        if (busy) { b.classList.add('cc-busy'); b.setAttribute('aria-busy', 'true'); }
        if (c === 'transfer' && ui.transferOpen[call.callId]) b.classList.add('cc-active');
        grid.append(b);
      }
      body.append(grid);
      if (blocked.length) {
        const first = blocked[0];
        const hint = el('div', 'cc-hint');
        hint.append(el('strong', '', `${UNSUPPORTED[first]}.`), document.createTextNode(` ${HINT[first] || ''}`));
        body.append(hint);
      }
    }

    if (ui.transferOpen[call.callId] && !call.consultCallId && (call.state === 'connected' || call.state === 'held')) body.append(renderTransferForm(call));
    const n = noticeFor(call);
    if (n) body.append(el('div', `cc-notice cc-notice-${n.level}`, n.text));
    card.append(body);
    return card;
  }

  function noticeFor(call) {
    const local = ui.localMsg[call.callId];
    if (local && Date.now() - local.at < NOTICE_VISIBLE_MS) return local;
    const n = model.notice;
    if (n && n.callId === call.callId && Date.now() - n.at < NOTICE_VISIBLE_MS && n.level !== 'warning') return n;
    return null;
  }

  function renderTransferForm(call) {
    const f = el('form', 'cc-transfer');
    f.dataset.callId = call.callId;
    f.noValidate = true;
    const label = el('label', 'cc-transfer-label', 'Transfer to');
    const inputId = `ccTransfer-${call.callId.replace(/[^\w-]/g, '_')}`;
    label.htmlFor = inputId;
    const input = el('input', 'cc-input');
    input.type = 'tel'; input.id = inputId; input.autocomplete = 'off';
    input.placeholder = 'Extension or phone number';
    input.value = ui.transferValue[call.callId] || '';
    input.dataset.callId = call.callId;
    // Suggest coworkers from the team directory (Call Center keeps it in storage).
    if (directory.length) {
      const listId = `${inputId}-dir`;
      input.setAttribute('list', listId);
      const dl = el('datalist');
      dl.id = listId;
      for (const u of directory.slice(0, 500)) {
        const o = document.createElement('option');
        o.value = u.ext;
        o.label = u.name || `Ext ${u.ext}`;
        o.textContent = u.name || `Ext ${u.ext}`;
        dl.append(o);
      }
      f.append(dl);
    }
    const row = el('div', 'cc-transfer-actions');
    const now = el('button', 'cc-pill-btn cc-pill-primary', 'Transfer');
    now.type = 'submit'; now.dataset.mode = 'now';
    now.title = 'Call the target and hand the caller over as soon as it rings';
    const consult = el('button', 'cc-pill-btn', 'Talk first');
    consult.type = 'button'; consult.dataset.action = 'transfer-consult'; consult.dataset.callId = call.callId;
    consult.title = 'Call the target first, then complete the transfer';
    const cancel = el('button', 'cc-link-btn', 'Cancel');
    cancel.type = 'button'; cancel.dataset.action = 'transfer-close'; cancel.dataset.callId = call.callId;
    row.append(now, consult, cancel);
    f.append(label, input, row);
    return f;
  }

  function renderTransferBar(call, consult) {
    const bar = el('div', 'cc-xfer');
    const target = call.transferTarget || (consult && consult.remote && consult.remote.display) || '';
    const targetLabel = /^\d{1,6}$/.test(target) ? `Ext ${target}` : (consult && consult.remote ? consult.remote.display : target);
    const st = !consult ? 'Calling…' : consult.state === 'connected' ? 'Connected · talk, then complete' : consult.state === 'ended' ? 'Hung up' : 'Ringing…';
    const text = el('div', 'cc-xfer-text');
    const stalled = call.transferStalled && (!consult || consult.state === 'dialing' || consult.state === 'ringing');
    const stateText = call.transferMode === 'now' ? 'Handing over as soon as it rings\u2026' : (stalled ? 'Target not ringing yet \u00B7 complete or cancel' : st);
    text.append(el('span', 'cc-xfer-title', `Transferring to ${targetLabel}`), el('span', 'cc-xfer-state', stateText));
    const actions = el('div', 'cc-xfer-actions');
    if (call.transferMode !== 'now') {
      const done = el('button', 'cc-pill-btn cc-pill-primary', 'Complete transfer');
      done.type = 'button'; done.dataset.action = 'transfer-complete'; done.dataset.callId = call.callId;
      actions.append(done);
    }
    const cancel = el('button', 'cc-pill-btn', 'Cancel');
    cancel.type = 'button'; cancel.dataset.action = 'transfer-cancel'; cancel.dataset.callId = call.callId;
    cancel.title = 'Hang up on the transfer target and go back to the caller';
    actions.append(cancel);
    bar.append(text, actions);
    return bar;
  }

  function renderMissed() {
    const list = model.missed || [];
    const wrap = el('section', 'cc-missed');
    wrap.setAttribute('aria-label', 'Missed calls');
    const head = el('div', 'cc-missed-head');
    const title = el('div', 'cc-missed-title');
    title.append(icon('missed', 16), el('span', '', 'Missed calls'), el('span', 'cc-badge', String(list.length)));
    head.append(title);
    const clear = el('button', 'cc-link-btn', 'Clear');
    clear.type = 'button'; clear.dataset.action = 'missed-clear'; clear.title = 'Remove all missed calls';
    head.append(clear);
    wrap.append(head);

    const ul = el('ul', 'cc-missed-list');
    const shown = ui.missedExpanded ? list : list.slice(0, MISSED_COLLAPSED);
    for (const m of shown) {
      const li = el('li', `cc-missed-item${m.seen ? '' : ' cc-unseen'}`);
      const ini = initials(m.name);
      const av = el('div', `cc-mini-avatar${ini ? '' : ' cc-mini-avatar--anon'}`);
      // A person glyph for unnamed callers: a phone glyph next to the phone-shaped Call back read as two buttons.
      if (ini) av.textContent = ini; else av.append(icon('user', 14));
      const txt = el('div', 'cc-missed-text');
      const primary = nice(m.name) || m.display || 'Unknown caller';
      const n = el('div', 'cc-missed-name', primary); n.title = primary;
      const meta = el('div', 'cc-missed-meta', m.name ? `${m.display} · ${timeAgo(m.at)}` : timeAgo(m.at));
      txt.append(n, meta);
      const back = el('button', 'cc-callback');
      back.type = 'button'; back.dataset.action = 'callback'; back.dataset.id = m.id;
      back.title = `Call back ${primary}`.trim();
      back.setAttribute('aria-label', `Call back ${primary}`);
      back.append(icon('phone', 16));
      if (ui.busy[`missed|${m.id}`]) back.classList.add('cc-busy');
      const rm = el('button', 'cc-remove');
      rm.type = 'button'; rm.dataset.action = 'missed-remove'; rm.dataset.id = m.id;
      rm.title = 'Remove'; rm.setAttribute('aria-label', 'Remove');
      rm.append(icon('close', 14));
      li.append(av, txt, back, rm);
      const msg = ui.localMsg[`missed|${m.id}`];
      if (msg && Date.now() - msg.at < NOTICE_VISIBLE_MS) li.append(el('div', `cc-missed-msg cc-notice-${msg.level}`, msg.text));
      ul.append(li);
    }
    wrap.append(ul);
    if (list.length > MISSED_COLLAPSED) {
      const more = el('button', 'cc-link-btn cc-more', ui.missedExpanded ? 'Show fewer' : `Show all ${list.length}`);
      more.type = 'button'; more.dataset.action = 'missed-toggle';
      wrap.append(more);
    }
    if (model.notifAvailable && !model.notifGranted) {
      const nb = el('button', 'cc-notify-btn');
      nb.type = 'button'; nb.dataset.action = 'enable-notifications';
      nb.title = 'Show a desktop notification with Call back when you miss a call';
      nb.append(icon('bell', 14), el('span', '', 'Enable desktop notifications'));
      wrap.append(nb);
    }
    return wrap;
  }

  /** The compact bar on Call Center / History / Settings: the call stays in reach. */
  function renderMini(calls) {
    if (!miniEl) return;
    const call = calls.find((c) => c.state !== 'ended');
    if (!call) { if (miniEl.firstChild) miniEl.replaceChildren(); return; }
    const info = stateInfo(call);
    const w = who(call);
    const bar = el('div', `cc-minibar cc-minibar--${info.cls}`);
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Current call');
    const open = el('button', 'cc-mini-open');
    open.type = 'button'; open.dataset.action = 'mini-open';
    open.title = 'Show the call';
    const ini = initials(call.name);
    const av = el('span', 'cc-mini-av');
    if (ini) av.textContent = ini; else av.append(icon('user', 14));
    const nm = el('span', 'cc-mini-name', w.name);
    const stl = el('span', 'cc-mini-state', info.label);
    open.append(av, nm, stl);
    if (info.timer && call.answeredAt) {
      const t = el('span', 'cc-timer', fmtDuration(Date.now() - call.answeredAt));
      t.dataset.since = String(call.answeredAt);
      open.append(t);
    }
    bar.append(open);
    // Hang up when it's a live call and the phone allows it (a ringing inbound call is answered on the Dial tab).
    if (!(call.state === 'ringing' && call.direction === 'inbound') && !call.consultCallId && !unsupported(call, 'hangup')) {
      const h = el('button', 'cc-mini-hangup');
      h.type = 'button'; h.dataset.action = 'control'; h.dataset.control = 'hangup'; h.dataset.callId = call.callId;
      h.title = 'Hang up'; h.setAttribute('aria-label', `Hang up on ${w.name}`);
      h.append(icon('hangup', 16));
      bar.append(h);
    }
    miniEl.replaceChildren(bar);
  }

  function render() {
    if (!mountEl) return;
    // Keep focus and typing in the transfer box across re-renders.
    const active = document.activeElement;
    const focusId = active && mountEl.contains(active) && active.id ? active.id : null;
    const selStart = focusId && active.selectionStart;

    const calls = visibleCalls();
    const nodes = calls.map(renderCard);
    if ((model.missed || []).length) nodes.push(renderMissed());
    mountEl.replaceChildren(...nodes); // empty -> .mount:empty collapses
    mountEl.classList.toggle('cc-has-calls', calls.some((c) => c.state !== 'ended'));
    renderMini(calls);

    if (focusId) {
      const again = document.getElementById(focusId);
      if (again) { again.focus(); try { again.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ } }
    }
    const needsTick = calls.some((c) => c.answeredAt && (c.state === 'connected' || c.state === 'held')) || calls.some((c) => c.state === 'ended');
    if (needsTick && !tickTimer) tickTimer = setInterval(tick, 1000);
    if (!needsTick && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    scheduleSeen();
  }

  /** Update timers in place; re-render when an ended card should disappear. */
  function tick() {
    if (!mountEl) return;
    for (const t of document.querySelectorAll('#callCardMount .cc-timer[data-since], #callMiniMount .cc-timer[data-since]')) t.textContent = fmtDuration(Date.now() - Number(t.dataset.since));
    const now = Date.now();
    const shown = new Set([...mountEl.querySelectorAll('.cc-card')].map((c) => c.dataset.callId));
    if (model.calls.some((c) => c.state === 'ended' && shown.has(c.callId) && now - (c.endedAt || 0) > ENDED_VISIBLE_MS)) render();
  }

  /** Mark missed calls as seen once the list has been visible for a moment. */
  function scheduleSeen() {
    clearTimeout(seenTimer);
    if (!(model.missed || []).some((m) => !m.seen)) return;
    seenTimer = setTimeout(() => {
      if (document.visibilityState === 'visible' && mountEl && mountEl.querySelector('.cc-missed') && mountEl.offsetParent !== null) send({ action: 'callcard:missedSeen' });
    }, 2500);
  }

  // ------------------------------------------------------------ actions ---
  async function runControl(callId, control) {
    const call = model.calls.find((c) => c.callId === callId);
    if (!call) return;
    if (control === 'transfer') {
      if (unsupported(call, 'transfer')) return;
      ui.transferOpen[callId] = !ui.transferOpen[callId];
      render();
      if (ui.transferOpen[callId]) {
        const input = mountEl.querySelector(`form.cc-transfer[data-call-id="${CSS.escape(callId)}"] input`);
        if (input) input.focus();
      }
      return;
    }
    if (unsupported(call, control)) return; // disabled: the tooltip explains why
    const key = `${callId}|${control}`;
    if (ui.busy[key]) return;
    ui.busy[key] = true;
    render();
    const r = await send({ action: 'callcard:control', callId, control });
    delete ui.busy[key];
    if (!r.ok && !r.unsupported) ui.localMsg[callId] = { text: r.message || 'That did not work.', level: 'error', at: Date.now() };
    render();
    if (r.unsupported) {
      // Normally the control turns disabled (with a hint) once the capability lands in storage;
      // if it did not, say why the click did nothing.
      setTimeout(() => {
        const now = model.calls.find((c) => c.callId === callId);
        if (now && !unsupported(now, control)) { ui.localMsg[callId] = { text: r.message, level: 'warning', at: Date.now() }; render(); }
      }, 400);
    }
  }

  async function runTransfer(callId, mode) {
    const value = (ui.transferValue[callId] || '').trim();
    if (!value) {
      ui.localMsg[callId] = { text: 'Enter an extension or phone number.', level: 'error', at: Date.now() };
      render();
      return;
    }
    ui.localMsg[callId] = { text: mode === 'now' ? `Transferring to ${value}…` : `Calling ${value}…`, level: 'info', at: Date.now() };
    render();
    const r = await send({ action: 'callcard:transfer', callId, target: value, mode });
    if (r.ok) {
      ui.transferOpen[callId] = false;
      ui.transferValue[callId] = '';
      delete ui.localMsg[callId];
    } else {
      ui.localMsg[callId] = { text: r.message || 'Transfer failed.', level: 'error', at: Date.now() };
    }
    render();
  }

  async function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !(mountEl.contains(btn) || (miniEl && miniEl.contains(btn)))) return;
    if (btn.dataset.action === 'mini-open') {
      const tab = document.querySelector('.tab-btn[data-tab="dial"]');
      if (tab) tab.click();
      return;
    }
    const { action, callId, id } = btn.dataset;
    if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    switch (action) {
      case 'control': return runControl(callId, btn.dataset.control);
      case 'dismiss': return send({ action: 'callcard:dismiss', callId });
      case 'transfer-consult': return runTransfer(callId, 'consult');
      case 'transfer-close': ui.transferOpen[callId] = false; return render();
      case 'transfer-complete': {
        const r = await send({ action: 'callcard:completeTransfer', callId });
        if (!r.ok) { ui.localMsg[callId] = { text: r.message || 'Transfer failed.', level: 'error', at: Date.now() }; render(); }
        return undefined;
      }
      case 'transfer-cancel': return send({ action: 'callcard:cancelTransfer', callId });
      case 'callback': {
        const key = `missed|${id}`;
        if (ui.busy[key]) return undefined;
        ui.busy[key] = true; render();
        const r = await send({ action: 'callcard:callBack', id });
        delete ui.busy[key];
        if (!r.success) ui.localMsg[key] = { text: r.error || 'Call back failed.', level: 'error', at: Date.now() };
        return render();
      }
      case 'missed-remove': return send({ action: 'callcard:missedRemove', id });
      case 'missed-clear': return send({ action: 'callcard:missedClear' });
      case 'missed-toggle': ui.missedExpanded = !ui.missedExpanded; return render();
      case 'enable-notifications': return enableNotifications();
      case 'open-crm': {
        const r = await send({ action: 'callcard:openCrm', callId });
        if (!r.ok) { ui.localMsg[callId] = { text: r.message || 'Could not open the CRM.', level: 'error', at: Date.now() }; render(); }
        return undefined;
      }
      default: return undefined;
    }
  }

  /**
   * Ask for the optional "notifications" permission. The request must be the
   * first thing in the click handler (user gesture). The popup can close when
   * the prompt takes focus, so the result is read back from contains()/onAdded.
   */
  function enableNotifications() {
    try {
      chrome.permissions.request({ permissions: ['notifications'] }, (granted) => {
        void chrome.runtime.lastError;
        model.notifGranted = !!granted;
        if (granted) send({ action: 'callcard:notificationsChanged' });
        render();
      });
    } catch (e) { /* permissions API missing: button stays */ }
  }

  // --------------------------------------------------------------- data ---
  async function load() {
    const [s, l] = await Promise.all([
      chrome.storage.session.get(['callcardCalls', 'callcardNotice']).catch(() => ({})),
      chrome.storage.local.get(['callcardMissed', 'callcardDeviceCaps', 'statusDirectory'])
    ]);
    model.calls = (s.callcardCalls && s.callcardCalls.calls) || [];
    model.notice = s.callcardNotice || null;
    model.missed = l.callcardMissed || [];
    model.caps = l.callcardDeviceCaps || {};
    directory = (l.statusDirectory && Array.isArray(l.statusDirectory.users)) ? l.statusDirectory.users.filter((u) => u && u.ext) : [];
    model.notifAvailable = !!(chrome.permissions && chrome.permissions.request);
    try { model.notifGranted = await chrome.permissions.contains({ permissions: ['notifications'] }); } catch (e) { model.notifGranted = false; }
    render();
    if (model.calls.some((c) => c.state !== 'ended' && !c.deviceKey)) send({ action: 'callcard:refresh' });
  }

  function onStorage(changes, area) {
    let dirty = false;
    if (area === 'session' && changes.callcardCalls) { model.calls = (changes.callcardCalls.newValue && changes.callcardCalls.newValue.calls) || []; dirty = true; }
    if (area === 'session' && changes.callcardNotice) { model.notice = changes.callcardNotice.newValue || null; dirty = true; }
    if (area === 'local' && changes.callcardMissed) { model.missed = changes.callcardMissed.newValue || []; dirty = true; }
    if (area === 'local' && changes.callcardDeviceCaps) { model.caps = changes.callcardDeviceCaps.newValue || {}; dirty = true; }
    if (area === 'local' && changes.statusDirectory) {
      const d = changes.statusDirectory.newValue;
      directory = d && Array.isArray(d.users) ? d.users.filter((u) => u && u.ext) : [];
    }
    if (dirty) render();
  }

  function mount(target) {
    mountEl = target;
    miniEl = document.getElementById('callMiniMount');
    if (miniEl) miniEl.addEventListener('click', (e) => { onClick(e).catch(() => {}); });
    mountEl.setAttribute('aria-live', 'polite');
    mountEl.addEventListener('click', (e) => { onClick(e).catch(() => {}); });
    mountEl.addEventListener('submit', (e) => {
      const f = e.target.closest('form.cc-transfer');
      if (!f) return;
      e.preventDefault();
      runTransfer(f.dataset.callId, 'now');
    });
    mountEl.addEventListener('input', (e) => {
      if (e.target.matches('.cc-transfer input')) ui.transferValue[e.target.dataset.callId] = e.target.value;
    });
    mountEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target.matches('.cc-transfer input')) { ui.transferOpen[e.target.dataset.callId] = false; render(); }
    });
    chrome.storage.onChanged.addListener(onStorage);
    if (chrome.permissions && chrome.permissions.onAdded) {
      chrome.permissions.onAdded.addListener(() => { model.notifGranted = true; render(); });
      chrome.permissions.onRemoved.addListener(() => { model.notifGranted = false; render(); });
    }
    document.addEventListener('visibilitychange', scheduleSeen);
    load().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('callCardMount');
    if (target) mount(target);
  });

  window.OneClickUI.callcard = { mount, render, _model: () => model };
})();
