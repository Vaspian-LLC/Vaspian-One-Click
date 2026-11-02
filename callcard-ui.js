// Live call card UI (side panel). Track A "callcard".
//
// Renders into <div id="callCardMount"> at the top of the Calls tab:
//   - one card per live call: a state line (shape + words), the caller's name,
//     labelled segments (Number, Via, Ringing / Duration), the CRM line and
//     state-aware controls: Answer / Send to voicemail while ringing,
//     Hold-Resume / Transfer / Park / Hang up while connected
//   - controls the user's phone refused (calls.js remembers them per device)
//     are shown disabled with a tooltip and a one-line explanation
//   - an inline transfer picker: search the team directory by name or
//     extension (Recent first, live status when the team view is on), or type
//     any number; Transfer now / Talk first
//   - a finished call collapses to one quiet bar for a few seconds
// and into #callMiniMount a slim bar for the live call on Team and Settings.
// Missed calls are listed by Recent calls (crm-ui.js history, Missed filter);
// this file only marks them seen once the Calls tab has been on screen.
// Nothing is rendered while idle, so the mount collapses.
//
// State comes from calls.js through storage (session.callcardCalls,
// session.callcardNotice, local.callcardMissed, local.callcardDeviceCaps),
// plus local.statusDirectory / statusState (presence.js) for names, groups
// and the picker, and local.callcardTransferRecent (written here).
// Commands go back with chrome.runtime.sendMessage({action:'callcard:<verb>'}).
// Event data (caller names, numbers) is only ever set with textContent.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  const ENDED_VISIBLE_MS = 6000;
  const NOTICE_VISIBLE_MS = 6000;
  const CRM_OPENING_MS = 3500;
  const RECENT_KEY = 'callcardTransferRecent';
  const RECENT_MAX = 5;
  const PICKER_MAX = 60;

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
  /** Team view status -> word + shape (never colour alone). */
  const PRESENCE = {
    available: { text: 'Available', shape: 'circle' },
    ringing: { text: 'Ringing', shape: 'diamond' },
    oncall: { text: 'On a call', shape: 'square' },
    onhold: { text: 'On hold', shape: 'square' },
    dnd: { text: 'Do not disturb', shape: 'dnd' },
    nophone: { text: 'No phone', shape: 'hollow' }
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
    external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    check: '<polyline points="20 6 9 17 4 12"/>',
    close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'
  };
  // Filled glyph for the primary call buttons (Answer), as in the round-2 mock.
  const PHONE_FILLED = '<path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z" fill="currentColor" stroke="none"/>';

  let mountEl = null;
  let miniEl = null;   // #callMiniMount: compact bar on the other tabs
  let srEl = null;     // visually hidden live region: state changes only (timers never announce)
  let directory = [];  // statusDirectory users [{ext,name}]
  let contacts = [];   // statusDirectory contacts [{name,number}]
  let groupsByExt = new Map(); // statusState.groups: group extension -> name ("Via")
  let ownExt = '';
  let recents = [];    // local.callcardTransferRecent
  let popCfg = { enabled: false, trigger: 'answer' };
  const popTrigger = (v) => (v === 'manual' ? 'manual' : 'answer'); // a stored 'offer' (retired) reads as 'answer'
  let model = { calls: [], missed: [], caps: {}, notice: null };
  const ui = { transferOpen: {}, transferValue: {}, transferPick: {}, xferActive: {}, busy: {}, localMsg: {} };
  const seenCards = new Set();   // cards already shown (entrance motion plays once)
  const spoken = new Map();      // callId -> last announced state key
  let tickTimer = null;
  let seenTimer = null;
  let crmTimer = null;

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
    const body = name === 'phone-filled' ? PHONE_FILLED : ICONS[name];
    span.innerHTML = `<svg width="${size}" height="${size}" style="width:${size}px;height:${size}px" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
    return span;
  }
  /** Presence / state shape (decorative: the word next to it carries the meaning). */
  function shape(kind) {
    const s = el('span', `cc-shape cc-shape--${kind}`);
    s.setAttribute('aria-hidden', 'true');
    return s;
  }
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (r) => { void chrome.runtime.lastError; resolve(r || { ok: false, message: 'No response from the extension.' }); });
      } catch (e) { resolve({ ok: false, message: e.message }); }
    });
  }
  /** Live timer (counts whole seconds up). */
  function fmtDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return fmtSeconds(s);
  }
  function fmtSeconds(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  /**
   * Talk time of a finished call, by the same rule as crm.js (history and
   * wrap-up): the server's callDuration when the end event carried it, else
   * answered -> ended on our clock; rounded to the second.
   */
  function talkSeconds(call) {
    if (!call.answeredAt || call.answeredBy === 'other') return null;
    const ms = call.callDurationMs != null ? call.callDurationMs : Math.max(0, (call.endedAt || Date.now()) - call.answeredAt);
    return Math.round(ms / 1000);
  }
  function phoneDisplay(n) {
    const P = self.OneClickPhone;
    return P ? P.display(n) : String(n || '');
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
  const dirName = (ext) => { const u = ext && directory.find((x) => x.ext === String(ext)); return u ? u.name : ''; };
  /** Who the call is with: the big name, and the number for its segment ('' when the name is the number). */
  function who(call) {
    const r = call.remote;
    const display = r ? r.display : '';
    let name = call.name ? nice(call.name) : '';
    if (!name && r && r.isInternal) name = dirName(r.ext);
    if (!name) return { name: display || 'Unknown caller', number: '' };
    return { name, number: display };
  }
  /** The group or line the call came in on, when it's one of the user's call groups. */
  function viaFor(call) {
    if (call.direction !== 'inbound') return '';
    const d = String(call.dialedDigits || '');
    if (!d || d === ownExt) return '';
    return groupsByExt.get(d) || '';
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
      // A consult leg is shown inside the call it transfers.
      if (c.consultFor && byId.has(c.consultFor) && byId.get(c.consultFor).state !== 'ended') return false;
      return true;
    }).sort((a, b) => {
      const rank = (c) => (c.state === 'ringing' && c.direction === 'inbound' ? 0 : c.state === 'ended' ? 3 : c.state === 'held' ? 2 : 1);
      return rank(a) - rank(b) || b.createdAt - a.createdAt;
    });
  }

  // ---------------------------------------------------------- rendering ---
  /**
   * cls: card state class (popup.js keys the dialer off cc-connected / cc-held / cc-calling).
   * label: the state line. seg: the timed segment {label, since, live} or null.
   */
  function stateInfo(call) {
    const inbound = call.direction === 'inbound';
    switch (call.state) {
      case 'ringing':
        return inbound
          ? { cls: 'ringing', label: 'Incoming call', shape: 'diamond', seg: { label: 'Ringing', since: call.createdAt, live: true } }
          : { cls: 'calling', label: 'Calling…', shape: 'outgoing', seg: { label: 'Calling', since: call.createdAt } };
      case 'dialing': return { cls: 'calling', label: 'Calling…', shape: 'outgoing', seg: { label: 'Calling', since: call.createdAt } };
      case 'ringback': return { cls: 'calling', label: 'Calling…', shape: 'outgoing', seg: { label: 'Ringing', since: call.createdAt } };
      case 'connected':
        return call.remoteHold
          ? { cls: 'connected', label: 'They put you on hold', shape: 'pause', remoteHold: true, seg: call.answeredAt ? { label: 'Duration', since: call.answeredAt } : null }
          : { cls: 'connected', label: 'Connected', shape: 'square', seg: call.answeredAt ? { label: 'Duration', since: call.answeredAt } : null };
      case 'held': return { cls: 'held', label: 'On hold', shape: 'pause', seg: call.answeredAt ? { label: 'Duration', since: call.answeredAt } : null };
      case 'parked': return { cls: 'held', label: call.parkedAt ? `Parked on ${call.parkedAt}` : 'Parked', shape: 'pause', seg: null };
      case 'ended': {
        let label = 'Call ended';
        if (call.missed) label = 'Missed call';
        else if (call.answeredBy === 'other') label = 'Answered elsewhere';
        else if (call.deflected) label = 'Sent to voicemail';
        else if (call.transferred) label = 'Transferred';
        else if (call.parkedAt) label = `Parked on ${call.parkedAt}`;
        return { cls: 'ended', label, shape: null, seg: null };
      }
      default: return { cls: 'connected', label: call.state, shape: 'square', seg: null };
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
  const LABEL = { answer: 'Answer', voicemail: 'Send to voicemail', hold: 'Hold', resume: 'Resume', transfer: 'Transfer', park: 'Park', hangup: 'Hang up' };
  const TITLE = {
    answer: 'Answer (Alt+Shift+A)', voicemail: 'Send to voicemail, or wherever your unanswered calls go', hold: 'Put the caller on hold',
    resume: 'Take the caller off hold', transfer: 'Transfer to a coworker or a number', park: 'Park the call so anyone can pick it up',
    hangup: 'Hang up (Alt+Shift+H)'
  };

  function stateLine(info, extra) {
    const line = el('div', 'cc-state');
    if (info.shape === 'outgoing') line.append(icon('outgoing', 14));
    else if (info.shape) line.append(shape(info.shape));
    line.append(el('span', 'cc-state-label', info.label));
    if (extra) line.append(extra);
    return line;
  }

  function timerEl(since, cls = '') {
    const t = el('span', `cc-timer${cls ? ` ${cls}` : ''}`, fmtDuration(Date.now() - since));
    t.dataset.since = String(since);
    return t;
  }

  /** A finished call: one quiet bar that goes away after a few seconds. */
  function renderEnded(call) {
    const info = stateInfo(call);
    const card = el('section', 'cc-card cc-ended cc-compact');
    card.dataset.callId = call.callId;
    card.setAttribute('aria-label', 'Call ended');
    const row = el('div', 'cc-compact-row');
    row.append(icon(call.direction === 'inbound' ? 'incoming' : 'outgoing', 16));
    const w = who(call);
    const txt = el('div', 'cc-compact-text');
    const nm = el('span', 'cc-compact-name cc-name', w.name); nm.title = w.name;
    txt.append(nm, el('span', 'cc-state-label', info.label));
    row.append(txt);
    const secs = talkSeconds(call);
    if (secs != null && !call.missed) {
      const d = el('span', 'cc-timer cc-ended-time', fmtSeconds(secs));
      d.title = 'Talk time';
      row.append(d);
    }
    const x = el('button', 'cc-dismiss');
    x.type = 'button'; x.title = 'Dismiss'; x.setAttribute('aria-label', 'Dismiss');
    x.dataset.action = 'dismiss'; x.dataset.callId = call.callId;
    x.append(icon('close', 16));
    row.append(x);
    card.append(row);
    return card;
  }

  function renderSegs(call, info, w) {
    const segs = [];
    if (w.number) segs.push({ label: 'Number', value: w.number, cls: 'cc-sub' });
    const via = viaFor(call);
    if (via) segs.push({ label: 'Via', value: via, cls: 'cc-via' });
    if (info.seg) segs.push({ label: info.seg.label, since: info.seg.since, live: info.seg.live });
    if (!segs.length) return null;
    const row = el('div', `cc-segs cc-segs--${segs.length}`);
    for (const s of segs) {
      const seg = el('div', 'cc-seg');
      seg.append(el('span', 'cc-seg-label', s.label));
      if (s.since) seg.append(timerEl(s.since, `cc-seg-v${s.live ? ' cc-seg-v--live' : ''}`));
      else { const v = el('span', `cc-seg-v ${s.cls}`, s.value); v.title = s.value; seg.append(v); }
      row.append(seg);
    }
    return row;
  }

  /** "Open in Zoho Desk" (or "Opening in Zoho Desk…" right when the screen pop fires). */
  function renderCrm(call) {
    const label = call.crmLabel || 'CRM';
    const at = call.answeredAt;
    const opening = popCfg.enabled && popCfg.trigger !== 'manual' && at && call.direction === 'inbound' && Date.now() - at < CRM_OPENING_MS
      && call.state === 'connected';
    let node;
    if (call.crmUrl && /^https?:\/\//i.test(call.crmUrl)) {
      node = el('a', 'cc-crm');
      node.href = call.crmUrl; node.target = '_blank'; node.rel = 'noopener noreferrer';
    } else if (call.crmOpen) {
      // The service worker builds and opens the URL (it can carry a CRM key).
      node = el('button', 'cc-crm');
      node.type = 'button'; node.dataset.action = 'open-crm'; node.dataset.callId = call.callId;
    } else return null;
    node.title = 'Open this caller in your CRM';
    const line = el('div', `cc-crmline${opening ? ' cc-crmline--opening' : ''}`);
    if (opening) {
      const spin = el('span', 'cc-spinner'); spin.setAttribute('aria-hidden', 'true');
      line.append(spin);
      node.append(el('span', '', `Opening in ${label}…`));
      scheduleCrmRefresh(at + CRM_OPENING_MS - Date.now());
    } else {
      node.append(el('span', '', `Open in ${label}`), icon('external', 14));
    }
    line.append(node);
    return line;
  }
  function scheduleCrmRefresh(ms) {
    clearTimeout(crmTimer);
    crmTimer = setTimeout(render, Math.max(50, ms + 30));
  }

  function renderCard(call) {
    if (call.state === 'ended') return renderEnded(call);
    const info = stateInfo(call);
    const card = el('section', `cc-card cc-${info.cls}${info.remoteHold ? ' cc-remote-hold' : ''}`);
    card.dataset.callId = call.callId;
    card.setAttribute('aria-label', `${call.direction === 'inbound' ? 'Incoming' : 'Outgoing'} call`);
    if (!seenCards.has(call.callId)) { card.classList.add('cc-enter'); seenCards.add(call.callId); }

    // ---- head: state line, then the name
    const head = el('div', 'cc-head');
    head.append(stateLine(info));
    const w = who(call);
    const nm = el('h2', 'cc-name', w.name); nm.title = w.name;
    head.append(nm);
    card.append(head);
    const segs = renderSegs(call, info, w);
    if (segs) card.append(segs);
    const crm = renderCrm(call);
    if (crm) card.append(crm);

    // ---- body
    const controls = controlsFor(call);
    const consult = call.consultCallId ? model.calls.find((c) => c.callId === call.consultCallId) : null;
    const n = noticeFor(call);
    if (!controls.length && !consult && !call.consultCallId && !n && !info.remoteHold) { card.classList.add('cc-no-body'); return card; }
    const body = el('div', 'cc-body');

    if (info.remoteHold) body.append(el('div', 'cc-hint cc-hint--hold', 'The other person has you on hold. Stay on the line; you’ll hear them when they come back.'));
    if (consult || call.consultCallId) body.append(renderTransferBar(call, consult));

    if (controls.length) {
      const main = controls.filter((c) => c !== 'hangup' || controls.length === 1);
      const grid = el('div', `cc-controls cc-n${main.length}`);
      const blocked = [];
      const make = (c) => {
        const primary = c === 'answer' || c === 'resume';
        const b = el('button', `cc-btn cc-btn-${c}${primary ? ' cc-btn--primary' : ''}${c === 'hangup' ? ' cc-btn--danger' : ''}`);
        b.type = 'button';
        b.dataset.action = 'control'; b.dataset.control = c; b.dataset.callId = call.callId;
        b.append(icon(c === 'answer' ? 'phone-filled' : c, 18), el('span', 'cc-btn-label', LABEL[c]));
        const off = unsupported(call, c);
        if (off) {
          b.classList.add('cc-unsupported');
          b.setAttribute('aria-disabled', 'true');
          b.title = UNSUPPORTED[REQ[c]];
          blocked.push(REQ[c]);
        } else {
          b.title = TITLE[c];
        }
        if (ui.busy[`${call.callId}|${c}`]) { b.classList.add('cc-busy'); b.setAttribute('aria-busy', 'true'); }
        if (c === 'transfer') {
          b.setAttribute('aria-expanded', ui.transferOpen[call.callId] ? 'true' : 'false');
          if (ui.transferOpen[call.callId]) b.classList.add('cc-active');
        }
        return b;
      };
      for (const c of main) grid.append(make(c));
      body.append(grid);
      if (main.length !== controls.length) {
        const row = el('div', 'cc-controls cc-controls--end cc-n1');
        row.append(make('hangup'));
        body.append(row);
      }
      if (blocked.length) {
        const first = blocked[0];
        const hint = el('div', 'cc-hint');
        hint.append(el('strong', '', `${UNSUPPORTED[first]}.`), document.createTextNode(` ${HINT[first] || ''}`));
        body.append(hint);
      }
    }

    if (ui.transferOpen[call.callId] && !call.consultCallId && (call.state === 'connected' || call.state === 'held')) body.append(renderTransferForm(call));
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

  // ---------------------------------------------------- transfer picker ---
  const domId = (callId, part) => `cc-${part}-${String(callId).replace(/[^\w-]/g, '_')}`;
  const personKey = (p) => (p.ext ? `x${p.ext}` : `n${p.number}`);

  /** Same matching as status-ui.js search(): name words by prefix, digits within the number. */
  function search(entries, q) {
    const qq = String(q || '').trim().toLowerCase();
    if (!qq) return entries.slice();
    const words = qq.split(/\s+/);
    const digits = qq.replace(/\D/g, '');
    const scored = [];
    for (const e of entries) {
      const name = String(e.name || '').toLowerCase();
      const nameWords = name.split(/[\s,.'-]+/);
      const num = String(e.ext || e.number || '');
      let score = 0;
      const allMatch = words.every((w) => {
        const wd = w.replace(/\D/g, '');
        if (nameWords.some((nw) => nw.startsWith(w))) { score += 2; return true; }
        if (w.length >= 3 && name.includes(w)) { score += 1; return true; }
        if (wd && wd === w && num.includes(wd)) { score += num === wd ? 5 : 1; return true; }
        return false;
      });
      if (!allMatch && digits && digits === qq.replace(/[\s()+-]/g, '') && num.includes(digits)) { scored.push({ e, score: num === digits ? 5 : 1 }); continue; }
      if (allMatch) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.e.name).localeCompare(String(b.e.name)));
    return scored.map((x) => x.e);
  }

  /** People to offer: [{section, items}] with Recent first. */
  function pickerSections(callId) {
    const pick = ui.transferPick[callId];
    const q = pick ? '' : (ui.transferValue[callId] || '');
    const people = directory.map((u) => ({ ext: u.ext, name: u.name || `Ext ${u.ext}` }))
      .concat(contacts.map((c) => ({ number: c.number, name: c.name || phoneDisplay(c.number), contact: true })));
    const byKey = new Map(people.map((p) => [personKey(p), p]));
    const recentPeople = recents.map((r) => byKey.get(r.ext ? `x${r.ext}` : `n${r.number}`) || (r.ext ? { ext: r.ext, name: r.name || `Ext ${r.ext}` } : { number: r.number, name: r.name || phoneDisplay(r.number) }));
    const recentKeys = new Set(recentPeople.map(personKey));
    if (pick) return [{ section: '', items: [pick] }];
    const rec = search(recentPeople, q);
    const rest = search(people.filter((p) => !recentKeys.has(personKey(p))), q).slice(0, PICKER_MAX);
    const out = [];
    if (rec.length) out.push({ section: 'Recent', items: rec });
    if (rest.length) out.push({ section: q ? (rec.length ? 'Everyone' : '') : 'Everyone', items: rest });
    return out;
  }

  function presenceFor(p) {
    const op = window.OneClickUI.operator;
    if (!p.ext || !op || typeof op.isActive !== 'function' || !op.isActive()) return null;
    const s = op.stateFor(p.ext);
    return s && PRESENCE[s.state] ? { key: s.state, ...PRESENCE[s.state] } : null;
  }

  function renderResults(callId) {
    const list = el('div', 'cc-results');
    list.id = domId(callId, 'results');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'People');
    const sections = pickerSections(callId);
    const pick = ui.transferPick[callId];
    const flat = [];
    for (const s of sections) {
      if (s.section) {
        const h = el('div', 'cc-results-h', s.section);
        h.setAttribute('role', 'presentation');
        list.append(h);
      }
      for (const p of s.items) {
        const i = flat.length;
        flat.push(p);
        const row = el('div', 'cc-person');
        row.id = domId(callId, `opt-${i}`);
        row.setAttribute('role', 'option');
        row.dataset.action = 'transfer-pick'; row.dataset.callId = callId; row.dataset.index = String(i);
        if (p.ext) row.dataset.ext = p.ext; else row.dataset.number = p.number;
        row.dataset.name = p.name;
        const selected = !!pick && personKey(pick) === personKey(p);
        row.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (ui.xferActive[callId] === i) row.classList.add('cc-person--active');
        const av = el('span', 'cc-av', initials(p.name) || '#');
        av.setAttribute('aria-hidden', 'true');
        const main = el('span', 'cc-person-main');
        main.append(el('span', 'cc-person-name', p.name), el('span', 'cc-person-ext', p.ext || phoneDisplay(p.number)));
        row.append(av, main);
        const pr = presenceFor(p);
        if (pr) {
          const st = el('span', `cc-pres cc-pres--${pr.key}`);
          st.append(shape(pr.shape), el('span', '', pr.text));
          row.append(st);
        }
        if (selected) row.append(icon('check', 16));
        list.append(row);
      }
    }
    if (!flat.length) {
      const q = (ui.transferValue[callId] || '').trim();
      const digits = q.replace(/\D/g, '');
      const msg = !directory.length && !contacts.length && !q
        ? 'Type an extension or phone number.'
        : digits.length >= 2 ? `No one matches. Transfer now or Talk first calls ${phoneDisplay(digits)}.` : `No one matches “${q}”.`;
      list.append(el('div', 'cc-results-empty', msg));
    }
    list.dataset.count = String(flat.length);
    return list;
  }

  function renderTransferForm(call) {
    const callId = call.callId;
    const f = el('form', 'cc-transfer');
    f.dataset.callId = callId;
    f.noValidate = true;
    const inputId = domId(callId, 'xfer');
    const label = el('label', 'cc-transfer-label', 'Transfer to');
    label.htmlFor = inputId;
    const field = el('div', 'cc-search');
    field.append(icon('search', 16));
    const input = el('input', 'cc-input');
    input.type = 'text'; input.id = inputId; input.autocomplete = 'off'; input.spellcheck = false;
    input.placeholder = 'Search name or extension';
    input.value = ui.transferPick[callId] ? ui.transferPick[callId].name : (ui.transferValue[callId] || '');
    input.dataset.callId = callId;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', domId(callId, 'results'));
    if (ui.xferActive[callId] != null) input.setAttribute('aria-activedescendant', domId(callId, `opt-${ui.xferActive[callId]}`));
    field.append(input);
    if (input.value) {
      const clr = el('button', 'cc-search-clear');
      clr.type = 'button'; clr.dataset.action = 'transfer-clear'; clr.dataset.callId = callId;
      clr.title = 'Clear'; clr.setAttribute('aria-label', 'Clear');
      clr.append(icon('close', 14));
      field.append(clr);
    }
    const head = el('div', 'cc-transfer-head');
    const cancel = el('button', 'cc-link-btn', 'Cancel');
    cancel.type = 'button'; cancel.dataset.action = 'transfer-close'; cancel.dataset.callId = callId;
    head.append(label, cancel);

    const row = el('div', 'cc-transfer-actions');
    const now = el('button', 'cc-act cc-act--primary');
    now.type = 'submit'; now.dataset.mode = 'now';
    now.append(el('span', 'cc-act-title', 'Transfer now'), el('span', 'cc-act-hint', 'Hands the call over right away'));
    const consult = el('button', 'cc-act');
    consult.type = 'button'; consult.dataset.action = 'transfer-consult'; consult.dataset.callId = callId;
    consult.append(el('span', 'cc-act-title', 'Talk first'), el('span', 'cc-act-hint', 'Talk to them before you hand it over'));
    row.append(now, consult);
    f.append(head, field, renderResults(callId), row);
    return f;
  }

  /** Rebuild only the results list (typing / arrows) so the card doesn't re-render under the caret. */
  function refreshResults(callId) {
    const f = mountEl && mountEl.querySelector(`form.cc-transfer[data-call-id="${CSS.escape(callId)}"]`);
    if (!f) return;
    const old = f.querySelector('.cc-results');
    const next = renderResults(callId);
    old.replaceWith(next);
    const input = f.querySelector('input');
    if (ui.xferActive[callId] != null) input.setAttribute('aria-activedescendant', domId(callId, `opt-${ui.xferActive[callId]}`));
    else input.removeAttribute('aria-activedescendant');
    const act = next.querySelector('.cc-person--active');
    if (act) act.scrollIntoView({ block: 'nearest' });
    const clr = f.querySelector('.cc-search-clear');
    if (!!input.value !== !!clr) render();
  }

  function renderTransferBar(call, consult) {
    const bar = el('div', 'cc-xfer');
    const target = call.transferTarget || (consult && consult.remote && consult.remote.display) || '';
    const isExt = /^\d{1,6}$/.test(target);
    const nameOf = isExt ? dirName(target) : '';
    const targetLabel = isExt ? (nameOf ? `${nameOf} (${target})` : `Ext ${target}`) : (consult && consult.remote ? consult.remote.display : target);
    const st = !consult ? 'Calling…' : consult.state === 'connected' ? 'Connected · talk, then complete' : consult.state === 'ended' ? 'Hung up' : 'Ringing…';
    const text = el('div', 'cc-xfer-text');
    const stalled = call.transferStalled && (!consult || consult.state === 'dialing' || consult.state === 'ringing');
    const stateText = call.transferMode === 'now' ? 'Handing over as soon as it rings…' : (stalled ? 'Not ringing yet · complete or cancel' : st);
    const title = el('span', 'cc-xfer-title', `Transferring to ${targetLabel}`);
    title.title = title.textContent;
    text.append(title, el('span', 'cc-xfer-state', stateText));
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

  /** The compact bar on Team / Settings: the call stays in reach. */
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
    if (info.shape === 'outgoing') open.append(icon('outgoing', 14));
    else if (info.shape) open.append(shape(info.shape));
    const nm = el('span', 'cc-mini-name', w.name);
    const stl = el('span', 'cc-mini-state', info.cls === 'ringing' ? 'Ringing' : info.label);
    open.append(nm, stl);
    if (info.seg) open.append(timerEl(info.seg.since, info.seg.live ? 'cc-timer--live' : ''));
    bar.append(open);
    const ringingIn = call.state === 'ringing' && call.direction === 'inbound';
    if (ringingIn && !unsupported(call, 'answer')) {
      const a = el('button', 'cc-mini-btn cc-mini-answer');
      a.type = 'button'; a.dataset.action = 'control'; a.dataset.control = 'answer'; a.dataset.callId = call.callId;
      a.title = 'Answer (Alt+Shift+A)'; a.setAttribute('aria-label', `Answer ${w.name}`);
      a.append(icon('phone-filled', 14), el('span', '', 'Answer'));
      bar.append(a);
    } else if (!ringingIn && !call.consultCallId && !unsupported(call, 'hangup')) {
      const h = el('button', 'cc-mini-btn cc-mini-hangup');
      h.type = 'button'; h.dataset.action = 'control'; h.dataset.control = 'hangup'; h.dataset.callId = call.callId;
      h.title = 'Hang up (Alt+Shift+H)'; h.setAttribute('aria-label', `Hang up on ${w.name}`);
      h.append(icon('hangup', 16));
      bar.append(h);
    }
    miniEl.replaceChildren(bar);
  }

  /** Tell screen readers about state changes (the cards themselves are not a live region: timers tick). */
  function announce(calls) {
    if (!srEl) return;
    const msgs = [];
    const live = new Set();
    for (const c of calls) {
      live.add(c.callId);
      const info = stateInfo(c);
      const key = `${c.state}|${c.remoteHold ? 1 : 0}|${c.consultCallId ? 1 : 0}`;
      if (spoken.get(c.callId) === key) continue;
      spoken.set(c.callId, key);
      const w = who(c);
      if (info.cls === 'ringing') msgs.push(`Incoming call from ${w.name}`);
      else if (info.cls === 'ended') msgs.push(`${info.label}, ${w.name}`);
      else msgs.push(`${info.label}, ${w.name}`);
    }
    for (const id of [...spoken.keys()]) if (!live.has(id)) spoken.delete(id);
    if (msgs.length) srEl.textContent = msgs.join('. ');
  }

  function render() {
    if (!mountEl) return;
    // Keep focus and typing in the transfer box across re-renders.
    const active = document.activeElement;
    const focusId = active && mountEl.contains(active) && active.id ? active.id : null;
    const selStart = focusId && active.selectionStart;
    const resultsScroll = [...mountEl.querySelectorAll('.cc-results')].map((r) => [r.id, r.scrollTop]);

    const calls = visibleCalls();
    const nodes = calls.map(renderCard);
    mountEl.replaceChildren(...nodes); // empty -> .mount:empty collapses
    mountEl.classList.toggle('cc-has-calls', calls.some((c) => c.state !== 'ended'));
    // The mist ground (as in the round-2 mock) sits behind a live card; an on-hold card carries its own mist.
    mountEl.classList.toggle('cc-ground', calls.some((c) => c.state !== 'ended' && c.state !== 'held' && c.state !== 'parked'));
    renderMini(calls);
    announce(calls);

    for (const [id, top] of resultsScroll) { const r = document.getElementById(id); if (r) r.scrollTop = top; }
    if (focusId) {
      const again = document.getElementById(focusId);
      if (again) { again.focus(); try { again.setSelectionRange(selStart, selStart); } catch (e) { /* not a text input */ } }
    }
    const needsTick = calls.length > 0;
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

  /**
   * Missed calls are listed in Recent calls on the Calls tab. Once that tab has
   * been on screen for a moment, mark them seen (clears the toolbar badge).
   */
  function scheduleSeen() {
    clearTimeout(seenTimer);
    if (!(model.missed || []).some((m) => !m.seen)) return;
    seenTimer = setTimeout(() => {
      const pane = document.getElementById('dial');
      const onCalls = pane && pane.classList.contains('active') && pane.offsetParent !== null;
      if (document.visibilityState === 'visible' && onCalls) send({ action: 'callcard:missedSeen' });
    }, 2500);
  }

  // ------------------------------------------------------------ actions ---
  async function runControl(callId, control) {
    const call = model.calls.find((c) => c.callId === callId);
    if (!call) return;
    if (control === 'transfer') {
      if (unsupported(call, 'transfer')) return;
      ui.transferOpen[callId] = !ui.transferOpen[callId];
      delete ui.xferActive[callId];
      render();
      if (ui.transferOpen[callId]) {
        const f = mountEl.querySelector(`form.cc-transfer[data-call-id="${CSS.escape(callId)}"]`);
        if (f) { f.querySelector('input').focus({ preventScroll: true }); f.scrollIntoView({ block: 'nearest' }); }
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

  /** What to transfer to: the picked person, a typed number, or the only name that matches. */
  function transferTarget(callId) {
    const pick = ui.transferPick[callId];
    if (pick) return { target: pick.ext || pick.number, person: pick };
    const value = (ui.transferValue[callId] || '').trim();
    if (!value) return { error: 'Search for someone, or type an extension or phone number.' };
    if (/\d/.test(value) && !/[a-z]/i.test(value)) {
      const digits = value.replace(/\D/g, '');
      const u = directory.find((x) => x.ext === digits);
      return { target: value, person: u ? { ext: u.ext, name: u.name } : { ...(digits.length <= 6 ? { ext: digits } : { number: digits }), name: '' } };
    }
    const flat = pickerSections(callId).flatMap((s) => s.items);
    if (flat.length === 1) return { target: flat[0].ext || flat[0].number, person: flat[0] };
    return { error: flat.length ? 'Pick someone from the list.' : `No one matches “${value}”. Type an extension or phone number.` };
  }

  async function rememberRecent(person) {
    if (!person || (!person.ext && !person.number)) return;
    const entry = { ext: person.ext || null, number: person.ext ? null : person.number, name: person.name || '', at: Date.now() };
    recents = [entry, ...recents.filter((r) => personKey(r.ext ? { ext: r.ext } : { number: r.number }) !== personKey(person))].slice(0, RECENT_MAX);
    try { await chrome.storage.local.set({ [RECENT_KEY]: recents }); } catch (e) { /* storage full or gone: recents stay in memory */ }
  }

  async function runTransfer(callId, mode) {
    const t = transferTarget(callId);
    if (t.error) {
      ui.localMsg[callId] = { text: t.error, level: 'error', at: Date.now() };
      render();
      return;
    }
    const shown = (t.person && t.person.name) || t.target;
    ui.localMsg[callId] = { text: mode === 'now' ? `Transferring to ${shown}…` : `Calling ${shown}…`, level: 'info', at: Date.now() };
    render();
    const r = await send({ action: 'callcard:transfer', callId, target: t.target, mode });
    if (r.ok) {
      ui.transferOpen[callId] = false;
      ui.transferValue[callId] = '';
      delete ui.transferPick[callId];
      delete ui.xferActive[callId];
      delete ui.localMsg[callId];
      rememberRecent(t.person);
    } else {
      ui.localMsg[callId] = { text: r.message || 'Transfer failed.', level: 'error', at: Date.now() };
    }
    render();
  }

  function pickOption(callId, row) {
    if (!row) return;
    const p = row.dataset.ext ? { ext: row.dataset.ext, name: row.dataset.name } : { number: row.dataset.number, name: row.dataset.name };
    const cur = ui.transferPick[callId];
    if (cur && personKey(cur) === personKey(p)) delete ui.transferPick[callId]; // pick again to clear
    else ui.transferPick[callId] = p;
    ui.transferValue[callId] = ui.transferPick[callId] ? '' : (ui.transferValue[callId] || '');
    delete ui.xferActive[callId];
    render();
    const input = document.getElementById(domId(callId, 'xfer'));
    if (input) input.focus();
  }

  async function onClick(e) {
    const btn = e.target.closest('[data-action]');
    if (!btn || !(mountEl.contains(btn) || (miniEl && miniEl.contains(btn)))) return;
    if (btn.dataset.action === 'mini-open') {
      const tab = document.querySelector('.tab-btn[data-tab="dial"]');
      if (tab) tab.click();
      return;
    }
    const { action, callId } = btn.dataset;
    if (btn.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return; }
    switch (action) {
      case 'control': return runControl(callId, btn.dataset.control);
      case 'dismiss': return send({ action: 'callcard:dismiss', callId });
      case 'transfer-consult': return runTransfer(callId, 'consult');
      case 'transfer-close': ui.transferOpen[callId] = false; return render();
      case 'transfer-pick': return pickOption(callId, btn);
      case 'transfer-clear': {
        ui.transferValue[callId] = ''; delete ui.transferPick[callId]; delete ui.xferActive[callId];
        render();
        const input = document.getElementById(domId(callId, 'xfer'));
        if (input) input.focus();
        return undefined;
      }
      case 'transfer-complete': {
        const r = await send({ action: 'callcard:completeTransfer', callId });
        if (!r.ok) { ui.localMsg[callId] = { text: r.message || 'Transfer failed.', level: 'error', at: Date.now() }; render(); }
        return undefined;
      }
      case 'transfer-cancel': return send({ action: 'callcard:cancelTransfer', callId });
      case 'open-crm': {
        const r = await send({ action: 'callcard:openCrm', callId });
        if (!r.ok) { ui.localMsg[callId] = { text: r.message || 'Could not open the CRM.', level: 'error', at: Date.now() }; render(); }
        return undefined;
      }
      default: return undefined;
    }
  }

  function onKeydown(e) {
    if (!e.target.matches('.cc-transfer input')) return;
    const callId = e.target.dataset.callId;
    const count = Number((mountEl.querySelector(`#${CSS.escape(domId(callId, 'results'))}`) || { dataset: {} }).dataset.count || 0);
    if (e.key === 'Escape') {
      e.preventDefault();
      if (ui.xferActive[callId] != null) { delete ui.xferActive[callId]; refreshResults(callId); return; }
      ui.transferOpen[callId] = false;
      render();
      const t = mountEl.querySelector(`.cc-btn[data-control="transfer"][data-call-id="${CSS.escape(callId)}"]`);
      if (t) t.focus();
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!count) return;
      e.preventDefault();
      const cur = ui.xferActive[callId];
      const next = cur == null ? (e.key === 'ArrowDown' ? 0 : count - 1) : (cur + (e.key === 'ArrowDown' ? 1 : -1) + count) % count;
      ui.xferActive[callId] = next;
      refreshResults(callId);
      return;
    }
    // Enter picks the highlighted person; otherwise it submits (Transfer now) with what's typed or picked.
    if (e.key === 'Enter' && ui.xferActive[callId] != null) {
      e.preventDefault();
      pickOption(callId, document.getElementById(domId(callId, `opt-${ui.xferActive[callId]}`)));
    }
  }

  // --------------------------------------------------------------- data ---
  function adoptDirectory(d) {
    directory = d && Array.isArray(d.users) ? d.users.filter((u) => u && u.ext) : [];
    contacts = d && Array.isArray(d.contacts) ? d.contacts.filter((c) => c && c.number) : [];
  }
  /** Returns true when something the cards show (Via, own extension) changed. */
  function adoptStatus(s) {
    const next = new Map(((s && s.groups) || []).filter((g) => g && g.extension).map((g) => [String(g.extension), g.name || `Group ${g.extension}`]));
    const ext = (s && s.extension) ? String(s.extension) : '';
    const changed = ext !== ownExt || JSON.stringify([...next]) !== JSON.stringify([...groupsByExt]);
    groupsByExt = next; ownExt = ext;
    return changed;
  }

  async function load() {
    const [s, l, sy] = await Promise.all([
      chrome.storage.session.get(['callcardCalls', 'callcardNotice']).catch(() => ({})),
      chrome.storage.local.get(['callcardMissed', 'callcardDeviceCaps', 'statusDirectory', 'statusState', RECENT_KEY]),
      chrome.storage.sync.get(['screenPopEnabled', 'screenPopTrigger']).catch(() => ({}))
    ]);
    model.calls = (s.callcardCalls && s.callcardCalls.calls) || [];
    model.notice = s.callcardNotice || null;
    model.missed = l.callcardMissed || [];
    model.caps = l.callcardDeviceCaps || {};
    adoptDirectory(l.statusDirectory);
    adoptStatus(l.statusState);
    recents = Array.isArray(l[RECENT_KEY]) ? l[RECENT_KEY] : [];
    popCfg = { enabled: sy.screenPopEnabled === true, trigger: popTrigger(sy.screenPopTrigger) };
    // Calls already on screen when the panel opens don't replay their entrance or get re-announced.
    for (const c of model.calls) { seenCards.add(c.callId); spoken.set(c.callId, `${c.state}|${c.remoteHold ? 1 : 0}|${c.consultCallId ? 1 : 0}`); }
    render();
    if (model.calls.some((c) => c.state !== 'ended' && !c.deviceKey)) send({ action: 'callcard:refresh' });
  }

  function onStorage(changes, area) {
    let dirty = false;
    if (area === 'session' && changes.callcardCalls) { model.calls = (changes.callcardCalls.newValue && changes.callcardCalls.newValue.calls) || []; dirty = true; }
    if (area === 'session' && changes.callcardNotice) { model.notice = changes.callcardNotice.newValue || null; dirty = true; }
    if (area === 'local' && changes.callcardMissed) { model.missed = changes.callcardMissed.newValue || []; scheduleSeen(); }
    if (area === 'local' && changes.callcardDeviceCaps) { model.caps = changes.callcardDeviceCaps.newValue || {}; dirty = true; }
    const pickerOpen = Object.values(ui.transferOpen).some(Boolean);
    if (area === 'local' && changes.statusDirectory) { adoptDirectory(changes.statusDirectory.newValue); dirty = dirty || model.calls.length > 0; }
    if (area === 'local' && changes.statusState && adoptStatus(changes.statusState.newValue)) dirty = dirty || model.calls.length > 0;
    if (area === 'local' && changes[RECENT_KEY]) { recents = changes[RECENT_KEY].newValue || []; dirty = dirty || pickerOpen; }
    if (area === 'sync' && (changes.screenPopEnabled || changes.screenPopTrigger)) {
      if (changes.screenPopEnabled) popCfg.enabled = changes.screenPopEnabled.newValue === true;
      if (changes.screenPopTrigger) popCfg.trigger = popTrigger(changes.screenPopTrigger.newValue);
    }
    // Team view status changed: refresh the picker's presence in place.
    if (area === 'session' && changes.operatorState && pickerOpen && !dirty) {
      setTimeout(() => { for (const [id, open] of Object.entries(ui.transferOpen)) if (open) refreshResults(id); }, 0);
    }
    if (dirty) render();
  }

  function mount(target) {
    mountEl = target;
    miniEl = document.getElementById('callMiniMount');
    if (miniEl) miniEl.addEventListener('click', (e) => { onClick(e).catch(() => {}); });
    // Not a live region itself (timers tick inside it); state changes are spoken by srEl.
    mountEl.removeAttribute('aria-live');
    srEl = document.createElement('div');
    srEl.className = 'cc-sr';
    srEl.setAttribute('aria-live', 'polite');
    srEl.setAttribute('role', 'status');
    mountEl.after(srEl);
    mountEl.addEventListener('click', (e) => { onClick(e).catch(() => {}); });
    mountEl.addEventListener('submit', (e) => {
      const f = e.target.closest('form.cc-transfer');
      if (!f) return;
      e.preventDefault();
      runTransfer(f.dataset.callId, 'now');
    });
    mountEl.addEventListener('input', (e) => {
      if (!e.target.matches('.cc-transfer input')) return;
      const id = e.target.dataset.callId;
      ui.transferValue[id] = e.target.value;
      delete ui.transferPick[id]; // typing again starts a new search
      delete ui.xferActive[id];
      refreshResults(id);
    });
    mountEl.addEventListener('keydown', onKeydown);
    // Keep the mouse from stealing focus from the search box when picking a person.
    mountEl.addEventListener('mousedown', (e) => { if (e.target.closest('.cc-person')) e.preventDefault(); });
    chrome.storage.onChanged.addListener(onStorage);
    document.addEventListener('visibilitychange', scheduleSeen);
    window.addEventListener('focus', scheduleSeen);
    // Switching to the Calls tab (popup.js sets body[data-tab]) starts the "seen" clock.
    new MutationObserver(scheduleSeen).observe(document.body, { attributes: true, attributeFilter: ['data-tab'] });
    load().catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', () => {
    const target = document.getElementById('callCardMount');
    if (target) mount(target);
  });

  window.OneClickUI.callcard = { mount, render, _model: () => model };
})();
