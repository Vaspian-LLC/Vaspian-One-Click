// Track B "status": the header status pill and its status sheet (#statusMount),
// and the Team tab (#callCenterMount), in the side panel.
//
// Reads what presence.js publishes (chrome.storage.local statusState,
// statusDirectory, statusRecent, statusForwardLast, plus apiStatus) and the
// user's favorites (chrome.storage.sync statusFavorites, written here).
// Sends commands with chrome.runtime.sendMessage({action:'status:<verb>'}).
//
// Your own controls (Do not disturb, Forward my calls, Queues) live in the
// status sheet that drops from the header pill. The Team tab is about other
// people: a board of coworkers, call groups and park slots.
//
// Coworker presence is only available to tenant admins with the team view on
// (operator-ui.js). With it, the board ranks people by live state; without it,
// the board is A to Z and the state column stays empty. Never fetch presence here.
//
// Keep everything inside this IIFE; public surface: window.OneClickUI.status.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  const FAV_KEY = 'statusFavorites';
  const SEG_KEY = 'oneclick.status.segment';
  const MAX_ROWS = 200;
  const PICK_MAX = 6;

  let statusEl = null;
  let ccEl = null;
  let sheetEl = null;
  let built = false;
  let st = null;          // statusState
  let conn = null;        // apiStatus
  let dir = null;         // statusDirectory
  let dirError = '';      // last directory load failure (shown with Try again)
  let recent = [];
  let favorites = [];
  let fwdLast = '';
  let segment = 'team';
  let query = '';
  let fwdEditing = false;
  let fwdQuery = '';
  let fwdActive = -1;     // highlighted picker option
  let fwdOptions = [];    // [{target, name, ext, number}]
  let sheetOpen = false;
  let phones = null;      // {show, label} for "Phone for your calls"
  let lastLabel = '';
  let flashTimer = null;
  let sheetMsgTimer = null;
  let tickTimer = null;

  // ------------------------------------------------------------ helpers ---
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    desk: '<rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>',
    transfer: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    search: '<circle cx="11" cy="11" r="7"/><line x1="20" y1="20" x2="16" y2="16"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    group: '<circle cx="12" cy="8" r="3"/><circle cx="5" cy="10" r="2"/><circle cx="19" cy="10" r="2"/><path d="M8 20v-1a4 4 0 0 1 8 0v1"/><path d="M2 20v-.5A2.5 2.5 0 0 1 4.5 17H6M22 20v-.5a2.5 2.5 0 0 0-2.5-2.5H18"/>',
    park: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
    contact: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    chevDown: '<polyline points="6 9 12 15 18 9"/>',
    chevRight: '<polyline points="9 18 15 12 9 6"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    alert: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>'
  };
  const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  function initials(display) {
    const words = String(display || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length || /^\d+$/.test(words[0])) return '#';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  function formatNumber(n) {
    return self.OneClickPhone.display(n);
  }

  function elapsed(since) {
    if (!since) return '';
    const s = Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000));
    const m = Math.floor(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  /** Same search as presence.js helpers.searchDirectory (kept in sync; unit-tested there). */
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
        if (w.length >= 3 && name.includes(w)) { score += 1; return true; } // mid-word only for 3+ letters
        if (wd && wd === w && num.includes(wd)) { score += num === wd ? 5 : 1; return true; }
        return false;
      });
      if (!allMatch && digits && digits === qq.replace(/[\s()+-]/g, '') && num.includes(digits)) { scored.push({ e, score: num === digits ? 5 : 1 }); continue; }
      if (allMatch) scored.push({ e, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.e.name).localeCompare(String(b.e.name)));
    return scored.map((x) => x.e);
  }

  /** All-caps carrier caller ID ("CHRIS A") reads as shouting: Title Case for display only. */
  function nice(name) {
    const v = String(name || '');
    if (!v || /[a-z]/.test(v) || !/[A-Z]/.test(v)) return v;
    return v.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }

  function send(action, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action, ...payload }, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, message: 'One Click is restarting. Try again in a moment.' });
          else resolve(r || { ok: false, message: 'No response.' });
        });
      } catch (e) { resolve({ ok: false, message: e.message }); }
    });
  }

  /** Feedback line on the Team tab ("Calling Keiko Kim…", failures). */
  function flash(message, kind = 'info') {
    const el = ccEl && ccEl.querySelector('.st-flash');
    if (!el) return;
    el.textContent = message || '';
    el.dataset.kind = kind;
    el.hidden = !message;
    clearTimeout(flashTimer);
    fitPopup();
    if (message) flashTimer = setTimeout(() => { el.hidden = true; el.textContent = ''; fitPopup(); }, kind === 'error' ? 7000 : 4000);
  }

  /** Feedback line inside the status sheet. */
  function sheetMsg(message, kind = 'error') {
    const el = sheetEl && sheetEl.querySelector('.st-sheet-msg');
    if (!el) return;
    el.textContent = message || '';
    el.dataset.kind = kind;
    el.hidden = !message;
    clearTimeout(sheetMsgTimer);
    if (message) sheetMsgTimer = setTimeout(() => { el.hidden = true; el.textContent = ''; }, 7000);
  }

  /** A failure from a header or sheet control: shown where the user is looking. */
  function report(message) {
    if (!message) return;
    if (sheetOpen) sheetMsg(message, 'error');
    else { flash(message, 'error'); announce(message); }
  }

  function announce(text) {
    const live = statusEl && statusEl.querySelector('.st-live');
    if (live) live.textContent = text;
  }

  // Signed in = credentials saved. A rejected PIN still shows the pill (as
  // "PIN rejected"), so the header never claims "Ready" while nothing works.
  const signedIn = () => !!(conn && !(conn.state === 'off' && conn.reason === 'no_credentials')
    && (st && st.account || conn.account || (conn.state === 'error' && conn.reason === 'auth')));
  const authRejected = () => !!(conn && conn.state === 'error' && conn.reason === 'auth');
  const activeCall = () => {
    if (!st || !st.calls) return null;
    const t = st.transfer;
    const e = Object.entries(st.calls).find(([id, c]) => (c.phase === 'active' || c.phase === 'held') && !(t && id === t.consultCallId));
    return e ? { callId: e[0], ...e[1] } : null;
  };

  // ------------------------------------------------------------ presence ---
  /** Team view (operator-ui.js, tenant admins): live state for coworkers. */
  function teamView() {
    const op = window.OneClickUI.operator;
    return !!(op && typeof op.isActive === 'function' && op.isActive());
  }
  function stateOf(ext) {
    const op = window.OneClickUI.operator;
    if (!ext || !teamView() || typeof op.stateFor !== 'function') return '';
    const p = op.stateFor(ext);
    return (p && p.state) || '';
  }
  // Board order: ringing first (someone may need to pick up), then on a call, available, DND, no phone.
  const RANK = { ringing: 0, oncall: 1, onhold: 1, available: 2, dnd: 3, nophone: 4 };
  const rankOf = (ext) => { const s = stateOf(ext); return s in RANK ? RANK[s] : 5; };
  const PRESENCE_WORD = { available: 'Available', ringing: 'Ringing', oncall: 'On a call', onhold: 'On hold', dnd: 'Do not disturb', nophone: 'No phone' }; // same words as the board (operator-ui)
  /** Word + shape for the forward picker (the board's rows get operator-ui's live slot instead). */
  function presenceChip(ext) {
    const s = stateOf(ext);
    if (!s) return '';
    return `<span class="st-presence" data-state="${esc(s)}"><span class="st-shape" aria-hidden="true"></span>${esc(PRESENCE_WORD[s] || '')}</span>`;
  }

  // ---------------------------------------------------------- the pill ---
  function buildPill() {
    statusEl.innerHTML = `
      <div class="st-bar">
        <button type="button" class="st-pill" aria-haspopup="dialog" aria-expanded="false" aria-controls="st-sheet">
          <span class="st-dot" aria-hidden="true"></span>
          <span class="st-label"></span>
          <span class="st-chips"></span>
          <span class="st-pill-ext"></span>
          <span class="st-chev" aria-hidden="true">${icon('chevDown', 14)}</span>
        </button>
        <button type="button" class="st-dnd-btn" aria-pressed="false" aria-label="Do not disturb">${icon('moon', 14)}<span>DND</span></button>
        <span class="st-live st-vh" role="status" aria-live="polite"></span>
      </div>`;
    statusEl.querySelector('.st-pill').addEventListener('click', () => (sheetOpen ? closeSheet(true) : openSheet()));
    statusEl.querySelector('.st-dnd-btn').addEventListener('click', onDndClick);
    lastLabel = '';
  }

  function setAttr(el, name, value) {
    if (value == null || value === false) { if (el.hasAttribute(name)) el.removeAttribute(name); return; }
    const v = value === true ? '' : String(value);
    if (el.getAttribute(name) !== v) el.setAttribute(name, v);
  }
  function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
  function setHtml(el, html) { if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; } }

  function renderPill() {
    if (!statusEl) return;
    if (!signedIn() || !st) {
      if (statusEl.innerHTML) statusEl.innerHTML = '';
      if (sheetOpen) closeSheet(false);
      return;
    }
    if (!statusEl.querySelector('.st-pill')) buildPill();
    const v = st.view || { key: 'connecting', label: 'Connecting' };
    const label = v.key === 'oncall' ? onCallLabel() : v.label;
    // Secondary states as chips: at most one, the rest folded into "+N"
    // (the pill is one line; chips cut mid-word read as broken).
    const extra = []; // { html, text }
    if (st.dnd && v.key !== 'dnd') extra.push({ html: `<span class="st-chip st-chip-dnd st-chip--icon" title="Do not disturb">${icon('moon', 12)}</span>`, text: 'Do not disturb', icon: true });
    if (st.forward && st.forward.active && v.key !== 'forward') {
      const who = st.forward.targetName || formatNumber(st.forward.target);
      extra.push({ html: `<span class="st-chip" title="Calls forward to ${esc(who)}">${icon('forward', 12)}<span class="st-chip-text">${esc(who)}</span></span>`, text: `Forwarding to ${who}` });
    }
    if (st.acd) extra.push({ html: `<span class="st-chip" title="Signed in to your call queues">${icon('headset', 12)}<span class="st-chip-text">Queues</span></span>`, text: 'Signed in to your call queues' });
    // Next to a long label (Forwarding to…, On a call with…) the chip is icon-only.
    const iconOnly = label.length > 14;
    const chips = extra.slice(0, 1).map((x) => (iconOnly && !x.icon
      ? x.html.replace('class="st-chip', `title="${esc(x.text)}" class="st-chip st-chip--icon`)
      : x.html));
    if (extra.length > 1) {
      const rest = extra.slice(1).map((x) => x.text).join(', ');
      chips.push(`<span class="st-chip st-chip-more" title="${esc(rest)}">+${extra.length - 1}</span>`);
    }
    const pill = statusEl.querySelector('.st-pill');
    const key = v.key === 'missed' ? 'available' : v.key;
    const cls = `st-pill st-pill--${key}${v.key === 'offline' && authRejected() ? ' st-pill--auth' : ''}${sheetOpen ? ' is-open' : ''}`;
    if (pill.className !== cls) pill.className = cls;
    setText(pill.querySelector('.st-label'), label);
    setHtml(pill.querySelector('.st-chips'), chips.join(''));
    const extEl = pill.querySelector('.st-pill-ext');
    // The extension steps aside for a long state ("Forwarding to …") so the state is never cut.
    setText(extEl, !chips.length && !iconOnly && st.extension ? `Ext ${st.extension}` : '');
    const spoken = [label, ...extra.map((x) => x.text)].join(', ');
    setAttr(pill, 'title', `${v.title || label}. Change your status`);
    setAttr(pill, 'aria-label', `Your status: ${spoken}${st.extension ? `, extension ${st.extension}` : ''}. Open status options`);
    setAttr(pill, 'aria-expanded', sheetOpen ? 'true' : 'false');
    // Status changes are announced once (the pill is a button now, not a live region).
    if (lastLabel && lastLabel !== label) announce(label);
    lastLabel = label;

    const dndBtn = statusEl.querySelector('.st-dnd-btn');
    const dndDisabled = !st.ready || !!(st.disabled && st.disabled.dnd) || !!(st.pending && st.pending.dnd);
    const dndCls = `st-dnd-btn${st.dnd ? ' is-on' : ''}${st.pending && st.pending.dnd ? ' is-pending' : ''}`;
    if (dndBtn.className !== dndCls) dndBtn.className = dndCls;
    setAttr(dndBtn, 'aria-pressed', st.dnd ? 'true' : 'false');
    setAttr(dndBtn, 'title', st.disabled && st.disabled.dnd ? st.disabled.dnd : `${st.dnd ? 'Turn off' : 'Turn on'} Do not disturb (Alt+Shift+D)`);
    dndBtn.disabled = dndDisabled;
  }

  function onCallLabel() {
    const calls = Object.values((st && st.calls) || {});
    const c = calls.find((x) => x.phase === 'active') || calls.find((x) => x.phase === 'held') || calls[0];
    if (!c) return 'On a call';
    if (c.phase === 'held') return 'Call on hold';
    if (c.phase === 'dialing') return 'Calling…';
    return 'On a call';
  }

  async function onDndClick() {
    const r = await send('status:setDnd', { active: !(st && st.dnd) });
    if (!r.ok) report(r.message);
  }

  // --------------------------------------------------------- the sheet ---
  function ensureSheet() {
    if (sheetEl) return;
    sheetEl = document.createElement('div');
    sheetEl.id = 'st-sheet';
    sheetEl.className = 'st-sheet';
    sheetEl.setAttribute('role', 'dialog');
    sheetEl.setAttribute('aria-labelledby', 'st-sheet-title');
    sheetEl.hidden = true;
    sheetEl.innerHTML = `
      <div class="st-sheet-head">
        <h2 class="st-sheet-title" id="st-sheet-title">Your status</h2>
        <button type="button" class="st-icon-btn st-sheet-close" data-act="sheet-close" aria-label="Close" title="Close (Esc)">${icon('x', 16)}</button>
      </div>
      <p class="st-sheet-msg" role="alert" hidden></p>
      <div class="st-sheet-body">
        <div class="st-opt-wrap" data-part="dnd"></div>
        <div class="st-opt-wrap" data-part="fwd"></div>
        <div class="st-opt-wrap" data-part="acd"></div>
        <div class="st-opt-wrap" data-part="phone"></div>
      </div>`;
    // Under the app container so it shares the panel's stacking and fonts.
    (document.querySelector('.app') || document.body).appendChild(sheetEl);
    sheetEl.addEventListener('click', onSheetClick);
    sheetEl.addEventListener('keydown', onSheetKey);
  }

  function placeSheet() {
    if (!sheetEl) return;
    const header = document.querySelector('.app-header');
    const top = header ? Math.round(header.getBoundingClientRect().bottom) : 56;
    sheetEl.style.setProperty('--st-sheet-top', `${top}px`);
  }

  function openSheet() {
    if (sheetOpen || !st) return;
    ensureSheet();
    sheetOpen = true;
    placeSheet();
    sheetEl.hidden = false;
    renderSheet();
    renderPill();
    const first = sheetEl.querySelector('.st-sheet-body button:not(:disabled), .st-sheet-body input');
    (first || sheetEl.querySelector('.st-sheet-close')).focus();
    document.addEventListener('pointerdown', onDocPointer, true);
    document.addEventListener('keydown', onDocKey, true);
    window.addEventListener('resize', placeSheet);
    loadPhones();
  }

  function closeSheet(returnFocus) {
    if (!sheetOpen) return;
    sheetOpen = false;
    fwdEditing = false;
    fwdQuery = '';
    if (sheetEl) { sheetEl.hidden = true; sheetMsg(''); }
    document.removeEventListener('pointerdown', onDocPointer, true);
    document.removeEventListener('keydown', onDocKey, true);
    window.removeEventListener('resize', placeSheet);
    renderPill();
    const pill = statusEl && statusEl.querySelector('.st-pill');
    if (returnFocus && pill) pill.focus();
  }

  function onDocPointer(e) {
    if (!sheetOpen) return;
    if (sheetEl.contains(e.target)) return;
    if (statusEl && statusEl.contains(e.target)) return; // the pill toggles itself; the header DND keeps the sheet open
    closeSheet(false);
  }

  function onDocKey(e) {
    if (e.key !== 'Escape' || !sheetOpen) return;
    const input = sheetEl.querySelector('#st-fwd-input');
    if (input && document.activeElement === input && input.value) return; // the picker clears first
    e.preventDefault();
    e.stopPropagation();
    closeSheet(true);
  }

  async function loadPhones() {
    const r = await send('apiGetPhones');
    const list = (r && r.ok && r.phones) || [];
    const choice = (r && r.choice) || null;
    const show = list.length > 1 || !!choice;
    let label = '';
    if (show) {
      const current = choice ? (list.find((p) => p.phoneId === choice.phoneId) || list.find((p) => choice.model && p.model === choice.model)) : null;
      const def = list.find((p) => p.isDefault);
      label = choice ? (current ? current.label : `${choice.label || 'Chosen phone'} (signed out)`) : (def ? `Default (${def.label})` : 'Default phone');
    }
    phones = { show, label };
    if (sheetOpen) renderSheet();
  }

  /** One row of the sheet: icon, name, one-line explanation, and a control on the right. */
  function opt({ key, iconName, name, desc, control = '', cls = '' }) {
    return `<div class="st-opt${cls ? ` ${cls}` : ''}" data-opt="${key}">
      <span class="st-opt-ico" aria-hidden="true">${icon(iconName, 16)}</span>
      <span class="st-opt-text"><span class="st-opt-name" id="st-opt-${key}-name">${name}</span><span class="st-opt-desc" id="st-opt-${key}-desc">${desc}</span></span>
      ${control}
    </div>`;
  }

  function switchCtl(key, on, { disabled, pending, label }) {
    return `<button type="button" role="switch" class="st-switch-btn st-ctl" data-ctl="${key}" aria-checked="${on ? 'true' : 'false'}"
      aria-labelledby="st-opt-${key}-name" aria-describedby="st-opt-${key}-desc" title="${esc(label)}" ${disabled ? 'disabled' : ''} ${pending ? 'aria-busy="true"' : ''}>
      <span class="st-switch-track" aria-hidden="true"></span></button>`;
  }

  /** Queues only for agents: already signed in, or a member of a queue-enabled group. */
  function hasQueues() {
    if (!st) return false;
    if (st.acd) return true;
    if (st.disabled && st.disabled.acd) return false;
    return (st.groups || []).some((g) => g.queueEnabled);
  }

  function renderSheet() {
    if (!sheetEl || !sheetOpen || !st) return;
    const d = st.disabled || {};
    const p = st.pending || {};
    const e = st.errors || {};
    const notReady = !st.ready;

    // Do not disturb
    setHtml(sheetEl.querySelector('[data-part="dnd"]'), opt({
      key: 'dnd', iconName: 'moon', name: 'Do not disturb', cls: st.dnd ? 'is-on is-dnd' : '',
      desc: esc(d.dnd || (p.dnd ? 'Updating…' : (st.dnd ? 'On. Your calls go to voicemail or your coverage.' : 'Send your calls to voicemail or your coverage.'))),
      control: switchCtl('dnd', !!st.dnd, { disabled: d.dnd || notReady || p.dnd, pending: p.dnd, label: `${st.dnd ? 'Turn off' : 'Turn on'} Do not disturb (Alt+Shift+D)` })
    }));

    renderSheetForward();

    // Queues (agents only)
    const acdEl = sheetEl.querySelector('[data-part="acd"]');
    if (hasQueues()) {
      setHtml(acdEl, opt({
        key: 'acd', iconName: 'headset', name: 'Call queues', cls: st.acd ? 'is-on' : '',
        desc: esc(d.acd || (p.acd ? 'Updating…' : (st.acd ? 'Signed in. Queue calls can ring you.' : 'Signed out. Sign in to take queue calls.'))),
        control: switchCtl('acd', !!st.acd, { disabled: d.acd || notReady || p.acd, pending: p.acd, label: st.acd ? 'Sign out of your call queues' : 'Sign in to your call queues' })
      }) + (e.acd && !d.acd ? `<p class="st-error">${esc(e.acd)}</p>` : ''));
    } else setHtml(acdEl, '');

    // Phone for your calls (multi-desk): the control lives in Settings › Calling.
    const phoneEl = sheetEl.querySelector('[data-part="phone"]');
    if (phones && phones.show) {
      setHtml(phoneEl, `<button type="button" class="st-opt st-opt-link" data-act="phone-settings">
        <span class="st-opt-ico" aria-hidden="true">${icon('desk', 16)}</span>
        <span class="st-opt-text"><span class="st-opt-name">Phone for your calls</span><span class="st-opt-desc">${esc(phones.label)} · change in Settings</span></span>
        <span class="st-opt-chev" aria-hidden="true">${icon('chevRight', 16)}</span></button>`);
    } else setHtml(phoneEl, '');
  }

  function renderSheetForward() {
    const el = sheetEl.querySelector('[data-part="fwd"]');
    const fwd = st.forward || {};
    const d = st.disabled || {};
    const p = st.pending || {};
    const err = st.errors && st.errors.forward;
    let html;
    if (d.forward) {
      html = opt({ key: 'fwd', iconName: 'forward', name: 'Forward my calls', desc: esc(d.forward), cls: 'is-locked' });
    } else if (fwdEditing) {
      html = `${opt({ key: 'fwd', iconName: 'forward', name: 'Forward my calls', desc: 'Pick a coworker, or type an extension or phone number.' })}
        <form class="st-fwd-form" novalidate>
          <label class="st-vh" for="st-fwd-input">Forward all my calls to</label>
          <div class="st-picker">
            <div class="st-field">
              ${icon('search', 16)}
              <input id="st-fwd-input" class="st-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="st-fwd-list"
                autocomplete="off" spellcheck="false" placeholder="Name, extension or number">
            </div>
            <ul class="st-picker-list" id="st-fwd-list" role="listbox" aria-label="People and numbers" hidden></ul>
          </div>
          ${err ? `<p class="st-error">${esc(err)}</p>` : ''}
          <div class="st-fwd-actions">
            <button type="submit" class="st-btn st-btn-primary" ${p.forward ? 'disabled' : ''}>${p.forward ? 'Forwarding…' : 'Forward'}</button>
            <button type="button" class="st-btn st-btn-ghost" data-act="fwd-cancel">Cancel</button>
          </div>
        </form>`;
    } else if (fwd.active) {
      const who = fwd.targetName ? `${fwd.targetName} (${fwd.target})` : formatNumber(fwd.target);
      html = `<div class="st-opt st-fwd-line is-on" data-opt="fwd">
          <span class="st-opt-ico" aria-hidden="true">${icon('forward', 16)}</span>
          <span class="st-opt-text"><span class="st-opt-name">Forwarding to <strong>${esc(who)}</strong></span>
            <span class="st-opt-desc">${p.forward ? 'Updating…' : 'Every call goes there until you turn it off.'}</span></span>
        </div>
        <div class="st-fwd-actions st-fwd-actions--on">
          <button type="button" class="st-btn st-btn-primary" data-act="fwd-off" ${p.forward ? 'disabled' : ''}>Turn off</button>
          <button type="button" class="st-btn st-btn-ghost" data-act="fwd-change" ${p.forward ? 'disabled' : ''}>Change</button>
        </div>
        ${err ? `<p class="st-error">${esc(err)}</p>` : ''}`;
    } else {
      html = opt({
        key: 'fwd', iconName: 'forward', name: 'Forward my calls',
        desc: p.forward ? 'Updating…' : 'Off. Send every call to a coworker or another number.',
        control: `<button type="button" class="st-btn st-btn-secondary st-btn-sm" data-act="fwd-start" ${!st.ready || p.forward ? 'disabled' : ''}>Turn on</button>`
      }) + (err ? `<p class="st-error">${esc(err)}</p>` : '');
    }
    if (el.dataset.sig === html) { if (fwdEditing) renderPicker(); return; }
    const hadFocus = document.activeElement && document.activeElement.id === 'st-fwd-input';
    const caret = hadFocus ? document.activeElement.selectionStart : null;
    el.innerHTML = html;
    el.dataset.sig = html;
    const form = el.querySelector('.st-fwd-form');
    if (form) {
      const input = form.querySelector('#st-fwd-input');
      input.value = fwdQuery;
      form.addEventListener('submit', onForwardSubmit);
      input.addEventListener('input', () => { fwdQuery = input.value; fwdActive = -1; renderPicker(); });
      input.addEventListener('keydown', onPickerKey);
      input.focus();
      if (caret != null) input.setSelectionRange(caret, caret); else input.select();
      renderPicker();
    }
  }

  /** People (and a typed number) that match the picker text. */
  function pickerOptions() {
    const users = (dir && dir.users) || [];
    const q = fwdQuery.trim();
    let people;
    if (!q) {
      people = favorites.map((x) => users.find((u) => u.ext === x)).filter(Boolean);
      if (!people.length) people = recent.filter((r) => r.ext).map((r) => users.find((u) => u.ext === r.ext)).filter(Boolean);
    } else people = search(users, q);
    const out = people.slice(0, PICK_MAX).map((u) => ({ target: u.ext, ext: u.ext, name: u.name }));
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 3 && digits === q.replace(/[\s()+.-]/g, '') && !out.some((o) => o.ext === digits)) {
      out.push({ target: digits, number: digits, name: digits.length <= 6 ? `Extension ${digits}` : formatNumber(digits) });
    }
    return out;
  }

  function renderPicker() {
    const list = sheetEl && sheetEl.querySelector('#st-fwd-list');
    const input = sheetEl && sheetEl.querySelector('#st-fwd-input');
    if (!list || !input) return;
    fwdOptions = pickerOptions();
    if (fwdActive >= fwdOptions.length) fwdActive = fwdOptions.length - 1;
    const q = fwdQuery.trim();
    let html = '';
    if (fwdOptions.length) {
      html = (!q ? `<li class="st-picker-head" role="presentation">${favorites.length ? 'Favorites' : 'Recent'}</li>` : '')
        + fwdOptions.map((o, i) => `<li role="option" id="st-fwd-opt-${i}" class="st-pick${i === fwdActive ? ' is-active' : ''}" data-i="${i}" aria-selected="${i === fwdActive ? 'true' : 'false'}">
          <span class="st-avatar st-avatar--sm${o.ext ? '' : ' is-contact'}" aria-hidden="true">${o.ext ? esc(initials(o.name)) : icon('phone', 12)}</span>
          <span class="st-pick-name">${esc(o.number ? `Forward to ${o.name}` : o.name)}${o.ext ? `<span class="st-pick-ext">${esc(o.ext)}</span>` : ''}</span>
          ${o.ext ? presenceChip(o.ext) : ''}
        </li>`).join('');
    } else if (q) {
      html = `<li class="st-picker-empty" role="presentation">No one matches “${esc(q)}”. Type a full extension or phone number.</li>`;
    }
    setHtml(list, html);
    list.hidden = !html;
    input.setAttribute('aria-expanded', html && fwdOptions.length ? 'true' : 'false');
    if (fwdActive >= 0) input.setAttribute('aria-activedescendant', `st-fwd-opt-${fwdActive}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function onPickerKey(e) {
    const n = fwdOptions.length;
    if (e.key === 'ArrowDown' && n) { e.preventDefault(); fwdActive = (fwdActive + 1) % n; renderPicker(); }
    else if (e.key === 'ArrowUp' && n) { e.preventDefault(); fwdActive = fwdActive <= 0 ? n - 1 : fwdActive - 1; renderPicker(); }
    else if (e.key === 'Escape' && e.target.value) { e.preventDefault(); e.target.value = ''; fwdQuery = ''; fwdActive = -1; renderPicker(); }
  }

  async function forwardTo(target) {
    if (!target) { sheetMsg('Type an extension or phone number, or pick a coworker.'); return; }
    const r = await send('status:setForward', { active: true, target });
    // The "Forwarding to …" line says it's on; messages are for failures.
    if (r.ok) { fwdEditing = false; fwdQuery = ''; renderSheet(); } else sheetMsg(r.message, 'error');
  }

  function onForwardSubmit(e) {
    e.preventDefault();
    const input = sheetEl.querySelector('#st-fwd-input');
    const value = input.value.trim();
    if (fwdActive >= 0 && fwdOptions[fwdActive]) { forwardTo(fwdOptions[fwdActive].target); return; }
    // A typed name forwards to the best match; digits forward as typed.
    if (value && /[a-z]/i.test(value) && fwdOptions.length) { forwardTo(fwdOptions[0].target); return; }
    forwardTo(value);
  }

  async function onSheetClick(e) {
    const pick = e.target.closest('.st-pick');
    if (pick) { const o = fwdOptions[Number(pick.dataset.i)]; if (o) forwardTo(o.target); return; }
    const ctl = e.target.closest('.st-ctl');
    if (ctl && !ctl.disabled) {
      const k = ctl.dataset.ctl;
      if (k === 'dnd') { const r = await send('status:setDnd', { active: !st.dnd }); if (!r.ok) sheetMsg(r.message); }
      if (k === 'acd') { const r = await send('status:setAcd', { active: !st.acd }); if (!r.ok) sheetMsg(r.message); }
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'sheet-close') { closeSheet(true); return; }
    if (act === 'fwd-start') { fwdEditing = true; fwdQuery = fwdLast || ''; fwdActive = -1; renderSheet(); return; }
    if (act === 'fwd-change') { fwdEditing = true; fwdQuery = (st.forward && st.forward.target) || fwdLast || ''; fwdActive = -1; renderSheet(); return; }
    if (act === 'fwd-cancel') {
      fwdEditing = false; fwdQuery = ''; renderSheet();
      const again = sheetEl.querySelector('[data-act="fwd-start"], [data-act="fwd-change"]');
      if (again) again.focus();
      return;
    }
    if (act === 'fwd-off') {
      const r = await send('status:setForward', { active: false });
      if (!r.ok) sheetMsg(r.message);
      else { const on = sheetEl.querySelector('[data-act="fwd-start"]'); if (on) on.focus(); }
      return;
    }
    if (act === 'phone-settings') {
      closeSheet(false);
      if (typeof window.switchTab === 'function') window.switchTab('settings');
      if (window.OneClickSettings && typeof window.OneClickSettings.open === 'function') window.OneClickSettings.open('calling');
    }
  }

  /** Keep Tab inside the sheet while it is open (it is anchored, not modal: outside clicks close it). */
  function onSheetKey(e) {
    if (e.key !== 'Tab') return;
    const f = [...sheetEl.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // ------------------------------------------------------ team tab: frame ---
  const SEGS = ['team', 'groups', 'park'];

  function build() {
    if (built || !ccEl) return;
    built = true;
    try { segment = localStorage.getItem(SEG_KEY) || 'team'; } catch (e) { segment = 'team'; }
    if (!SEGS.includes(segment)) segment = 'team';
    ccEl.innerHTML = `
      <div class="st-cc">
        <div class="st-top">
          <div class="st-seg" role="tablist" aria-label="Team">
            <button type="button" role="tab" class="st-seg-btn" data-seg="team" id="st-tab-team" aria-controls="st-panel-team"><span class="st-seg-lbl">People</span><span class="st-seg-val st-count" data-count="people"></span></button>
            <button type="button" role="tab" class="st-seg-btn" data-seg="groups" id="st-tab-groups" aria-controls="st-panel-groups"><span class="st-seg-lbl">Groups</span><span class="st-seg-val st-count" data-count="groups"></span></button>
            <button type="button" role="tab" class="st-seg-btn" data-seg="park" id="st-tab-park" aria-controls="st-panel-park"><span class="st-seg-lbl">Park</span><span class="st-seg-val st-count" data-count="park"></span></button>
          </div>
          <div class="st-flash" role="status" aria-live="polite" hidden></div>
        </div>
        <div class="st-panel" role="tabpanel" id="st-panel-team" aria-labelledby="st-tab-team">
          <div class="st-ground">
            <div class="st-transfer"></div>
            <div class="st-search st-field">
              ${icon('search', 16)}
              <input type="search" class="st-search-input" placeholder="Search name or extension" aria-label="Search your team by name or extension" autocomplete="off" spellcheck="false">
              <button type="button" class="st-search-clear" aria-label="Clear search" hidden>${icon('x', 14)}</button>
            </div>
          </div>
          <div class="st-dir"></div>
        </div>
        <div class="st-panel" role="tabpanel" id="st-panel-groups" aria-labelledby="st-tab-groups"></div>
        <div class="st-panel" role="tabpanel" id="st-panel-park" aria-labelledby="st-tab-park"></div>
      </div>`;

    ccEl.querySelectorAll('.st-seg-btn').forEach((b) => b.addEventListener('click', () => setSegment(b.dataset.seg)));
    ccEl.querySelector('.st-seg').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const next = SEGS[(SEGS.indexOf(segment) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
      setSegment(next);
      ccEl.querySelector(`.st-seg-btn[data-seg="${next}"]`).focus();
    });
    const input = ccEl.querySelector('.st-search-input');
    input.addEventListener('input', () => { query = input.value; renderDirectory(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) { e.preventDefault(); clearSearch(); }
      if (e.key === 'Enter') {
        const first = ccEl.querySelector('.st-dir .st-row .st-act-primary');
        if (first) first.click();
      }
    });
    ccEl.querySelector('.st-search-clear').addEventListener('click', clearSearch);
    setSegment(segment, true);
  }

  function clearSearch() {
    const input = ccEl.querySelector('.st-search-input');
    input.value = '';
    query = '';
    renderDirectory();
    input.focus();
  }

  async function loadDirectory(force) {
    const r = await send('status:loadDirectory', { force: !!force });
    dirError = r && r.ok ? '' : ((r && r.message) || 'The team list didn’t load.');
    if (built && segment === 'team') renderDirectory();
  }

  function setSegment(seg, silent) {
    segment = seg;
    if (!silent) { try { localStorage.setItem(SEG_KEY, seg); } catch (e) { /* per-viewer convenience only */ } }
    ccEl.querySelectorAll('.st-seg-btn').forEach((b) => {
      const on = b.dataset.seg === seg;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
      b.tabIndex = on ? 0 : -1;
    });
    ccEl.querySelectorAll('.st-panel').forEach((p) => { p.hidden = p.id !== `st-panel-${seg}`; });
    renderCallCenter();
    if (seg === 'team' && !dir) loadDirectory(false);
  }

  // ---------------------------------------------------------- directory ---
  function entryFor(ext) {
    const u = dir && dir.users && dir.users.find((x) => x.ext === ext);
    return u ? { ext: u.ext, name: u.name } : null;
  }

  /** Digits key for "is this the person I'm talking to". */
  const partyKey = (x) => { const d = String((x && (x.ext || x.number)) || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };

  function row(entry, { inCall, fav, currentKey }) {
    const key = entry.ext ? `ext:${entry.ext}` : `num:${entry.number}`;
    const sub = entry.ext ? entry.ext : formatNumber(entry.number);
    const name = entry.name || (entry.ext ? `Extension ${entry.ext}` : sub);
    const target = entry.ext || entry.number;
    const t = st && st.transfer;
    const transferBusy = !!t || !!(st && st.pending && st.pending.transfer);
    const transferDisabled = (st && st.disabled && st.disabled.transfer) || '';
    const canTransfer = inCall && !(currentKey && partyKey(entry) === currentKey);
    const transferBtn = canTransfer
      ? `<button type="button" class="st-mini st-mini--pri st-act-transfer st-act-primary" data-act="transfer" data-target="${esc(target)}" data-name="${esc(name)}"
          aria-label="Transfer the call to ${esc(name)}" title="${esc(transferDisabled || `Transfer the call to ${name}`)}" ${transferBusy || transferDisabled ? 'disabled' : ''}>${icon('transfer', 13)}<span>Transfer</span></button>`
      : '';
    const callBtn = canTransfer
      ? `<button type="button" class="st-mini st-mini--icon st-act-call" data-act="call" data-target="${esc(target)}" data-ext="${esc(entry.ext || '')}" data-name="${esc(name)}" aria-label="Call ${esc(name)}" title="Call ${esc(name)}">${icon('phone', 14)}</button>`
      : `<button type="button" class="st-mini st-mini--pri st-act-call st-act-primary" data-act="call" data-target="${esc(target)}" data-ext="${esc(entry.ext || '')}" data-name="${esc(name)}" aria-label="Call ${esc(name)}" title="Call ${esc(name)}">${icon('phone', 13)}<span>Call</span></button>`;
    const favBtn = entry.ext
      ? `<button type="button" class="st-mini st-mini--icon st-act-fav${fav ? ' is-on' : ''}" data-act="fav" data-ext="${esc(entry.ext)}" aria-pressed="${fav ? 'true' : 'false'}"
          aria-label="${fav ? 'Remove' : 'Add'} ${esc(name)} ${fav ? 'from' : 'to'} favorites" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${icon('star', 14)}</button>`
      : '';
    return `
      <li class="st-row" data-key="${esc(key)}">
        <span class="st-avatar${entry.ext ? '' : ' is-contact'}" aria-hidden="true">${entry.ext ? esc(initials(name)) : icon('contact', 14)}</span>
        <span class="st-who"><span class="st-name">${esc(name)}</span><span class="st-sub">${entry.ext ? '<span class="st-vh">Ext </span>' : ''}${esc(sub)}${entry.kind ? ` · ${esc(entry.kind)}` : ''}</span></span>
        <span class="st-state">${entry.ext && teamView() ? `<span class="op-rs" data-op-ext="${esc(entry.ext)}"></span>` : ''}</span>
        <span class="st-acts">${transferBtn}${callBtn}${favBtn}</span>
      </li>`;
  }

  function section(title, entries, opts, { right = '', cls = '' } = {}) {
    if (!entries.length) return '';
    return `<div class="st-section${cls ? ` ${cls}` : ''}"><h3 class="st-section-title"><span>${esc(title)}</span>${right}</h3><ul class="st-list">${entries.map((e) => row(e, { ...opts, fav: !!(e.ext && favorites.includes(e.ext)) })).join('')}</ul></div>`;
  }

  /** The transfer's progress, worded like the call card's transfer bar. */
  function transferState(t) {
    if (t.phase === 'completing') return '…';
    const consult = t.consultCallId && st.calls && st.calls[t.consultCallId];
    if (!consult) return ' · Calling…';
    return consult.phase === 'active' ? ' · Connected. Talk, then complete.' : ' · Ringing…';
  }

  function renderTransfer() {
    const el = ccEl.querySelector('.st-transfer');
    const t = st.transfer;
    const call = activeCall();
    let html = '';
    if (t) {
      html = `<div class="st-banner st-banner-transfer" role="status">
        <div class="st-banner-text">${icon('transfer', 16)}<span>Transferring to <strong>${esc(t.name || t.to)}</strong>${esc(transferState(t))}</span></div>
        <div class="st-banner-actions">
          <button type="button" class="st-btn st-btn-primary" data-act="transfer-complete" ${t.phase === 'completing' ? 'disabled' : ''}>Complete transfer</button>
          <button type="button" class="st-btn st-btn-ghost" data-act="transfer-cancel">Cancel</button>
        </div></div>`;
    } else if (call) {
      const who = nice(call.party && (call.party.display || call.party.name));
      html = `<div class="st-banner st-banner-hint" role="status">${icon('transfer', 14)}<span>Transfer ${who ? `<strong>${esc(who)}</strong>` : 'your call'} to anyone below</span></div>`;
    }
    if (st.errors && st.errors.transfer && !t) html += `<p class="st-error">${esc(st.errors.transfer)}</p>`;
    setHtml(el, html);
  }

  function emptyState(iconName, title, body, action = '') {
    return `<div class="st-empty">${iconName ? `<span class="st-empty-ico" aria-hidden="true">${icon(iconName, 20)}</span>` : ''}<p class="st-empty-title">${title}</p>${body ? `<p class="st-empty-body">${body}</p>` : ''}${action}</div>`;
  }
  const loadingState = (text) => `<div class="st-empty st-empty--loading"><span class="st-spinner" aria-hidden="true"></span><p class="st-empty-body">${esc(text)}</p></div>`;

  /** Ranked by live state when the team view is on (ringing first), A to Z otherwise. */
  function ranked(list) {
    if (!teamView()) return list;
    return list.map((u, i) => ({ u, i, r: rankOf(u.ext) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.u);
  }

  function renderDirectory() {
    const el = ccEl.querySelector('.st-dir');
    const clear = ccEl.querySelector('.st-search-clear');
    if (clear) clear.hidden = !query;
    const live = activeCall();
    const inCall = !!live && !st.transfer;
    // The person on the line is never offered as a transfer target.
    const currentKey = live && live.party ? partyKey(live.party) : '';
    const opts = { inCall, currentKey };
    const searchBox = ccEl.querySelector('.st-search');
    let html;
    if (st.disabled && st.disabled.directory) {
      html = emptyState('lock', 'Your team list isn’t available', `${esc(st.disabled.directory)} Your office admin can turn it on.`);
    } else if (!dir && dirError) {
      html = emptyState('alert', 'Your team list didn’t load', esc(dirError), '<button type="button" class="st-btn st-btn-secondary st-btn-sm" data-act="dir-retry">Try again</button>');
    } else if (!dir) {
      html = loadingState('Loading your team…');
    } else {
      const users = dir.users || [];
      const contacts = (dir.contacts || []).map((c) => ({ number: c.number, name: c.name, kind: 'Contact' }));
      const ranking = teamView();
      if (query.trim()) {
        const hits = search([...users, ...contacts], query);
        const digits = query.replace(/\D/g, '');
        const dialable = digits.length >= 3 && digits === query.replace(/[\s()+.-]/g, '') && !hits.some((h) => (h.ext || h.number) === digits);
        html = hits.length
          ? section(`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`, hits.slice(0, MAX_ROWS), opts)
          : (dialable ? '' : emptyState('search', `No one matches “${esc(query.trim())}”`, 'Try a first or last name, or an extension.'));
        if (dialable) html = section('Call this number', [{ number: digits.length <= 6 ? null : digits, ext: digits.length <= 6 ? digits : null, name: digits.length <= 6 ? `Extension ${digits}` : formatNumber(digits) }], opts) + html;
      } else {
        const favs = ranked(favorites.map((x) => entryFor(x)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name)));
        const favSet = new Set(favorites);
        const rec = recent.map((r) => (r.ext ? (entryFor(r.ext) || { ext: r.ext, name: r.name || `Extension ${r.ext}` }) : { number: r.number, name: r.name || formatNumber(r.number) }))
          .filter((e) => !(e.ext && favSet.has(e.ext)))
          .filter((e) => !(inCall && currentKey && partyKey(e) === currentKey)).slice(0, 5);
        const everyone = ranked(users);
        const hint = !favs.length && users.length
          ? `<div class="st-section st-section--fav st-section--hint"><p class="st-hint">${icon('star', 13)}<span>Star the people you call most and they’ll stay at the top.</span></p></div>` : '';
        html = section('Favorites', favs, opts, { cls: 'st-section--fav', right: `<span class="st-section-note">${favs.length}</span>` }) + hint
          + section('Recent', rec, opts)
          + section('Everyone', everyone.slice(0, MAX_ROWS), opts, { right: `<span class="st-section-note">${ranking ? 'By state · ' : ''}<span class="st-section-count">${users.length}</span></span>` })
          + (users.length > MAX_ROWS ? `<p class="st-hint st-hint--more">Showing ${MAX_ROWS} of ${users.length}. Search to find anyone.</p>` : '')
          + section('Contacts', contacts.slice(0, 50), opts);
        if (!users.length && !contacts.length) html = emptyState('users', 'No coworkers to show yet', 'People appear here once your office admin adds them to your phone system.');
      }
    }
    if (searchBox) searchBox.hidden = !dir;
    setHtml(el, html);
    const op = window.OneClickUI.operator;
    if (op && typeof op.decorate === 'function') op.decorate(ccEl);
  }

  // ------------------------------------------------------------- groups ---
  function renderGroups() {
    const el = ccEl.querySelector('#st-panel-groups');
    const groups = st.groups || [];
    const p = st.pending || {};
    const e = st.errors || {};
    let html;
    if (st.disabled && st.disabled.groups) html = emptyState('lock', 'Call groups aren’t available', `${esc(st.disabled.groups)} Ask your office admin if you need them.`);
    else if (!st.groupsLoaded) html = loadingState('Loading your call groups…');
    else if (!groups.length) html = emptyState('group', 'You’re not in any call groups', 'When your office admin adds you to a ring or hunt group, you can join and leave it here.');
    else {
      const joined = groups.filter((g) => g.loggedIn).length;
      html = `<p class="st-lead">Join a group to take its calls. Leave it when you step away.</p>
        <div class="st-section"><h3 class="st-section-title"><span>Your groups</span><span class="st-section-note">In ${joined} of ${groups.length}</span></h3>
        <ul class="st-list st-groups">${groups.map((g) => {
        const key = `group:${g.callGroupId}`;
        const type = { ringGroup: 'Ring group', huntGroup: 'Hunt group', rolloverGroup: 'Rollover group', broadcastGroup: 'Broadcast group' }[g.type] || (g.type ? String(g.type).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : 'Group');
        return `<li class="st-row st-group${g.loggedIn ? ' is-on' : ''}">
          <span class="st-avatar is-group" aria-hidden="true">${icon('group', 15)}</span>
          <span class="st-who"><span class="st-name">${esc(g.name)}</span><span class="st-sub st-sub--line">${g.extension ? `Ext ${esc(g.extension)} · ` : ''}${esc(type)}${g.queueEnabled ? ' · Queue' : ''}${p[key] ? ' · Updating…' : ''}</span>
          ${e[key] ? `<span class="st-error">${esc(e[key])}</span>` : ''}</span>
          <span class="st-group-state">${g.loggedIn ? 'Joined' : 'Not joined'}</span>
          <label class="st-switch" title="${g.loggedIn ? 'Leave' : 'Join'} ${esc(g.name)}">
            <input type="checkbox" role="switch" data-group="${esc(g.callGroupId)}" ${g.loggedIn ? 'checked' : ''} ${p[key] ? 'disabled' : ''} aria-label="${esc(`Joined ${g.name}`)}">
            <span class="st-switch-track" aria-hidden="true"></span>
          </label>
        </li>`;
      }).join('')}</ul></div>`;
    }
    setHtml(el, html);
  }

  // --------------------------------------------------------------- park ---
  function renderPark() {
    const el = ccEl.querySelector('#st-panel-park');
    const slots = st.park || [];
    const p = st.pending || {};
    const e = st.errors || {};
    const retrieveOff = (st.disabled && st.disabled.retrieve) || (st.phones === 0 ? 'Retrieving needs a desk phone or softphone that’s signed in.' : '');
    let html;
    if (st.disabled && st.disabled.park) html = emptyState('lock', 'Park isn’t available', `${esc(st.disabled.park)} Ask your office admin if you need it.`);
    else if (!st.parkLoaded) html = loadingState('Loading park slots…');
    else if (!slots.length) html = emptyState('park', 'No park slots yet', 'Your company hasn’t set up any park slots. Ask your office admin if you’d like to park calls.');
    else {
      const busy = slots.filter((s) => s.status === 'busy');
      const free = slots.filter((s) => s.status !== 'busy');
      html = `<p class="st-lead">${busy.length ? 'Anyone can pick up a parked call from here.' : 'No calls are parked. Park a call from its call card and it shows up here.'}</p>`;
      if (busy.length) {
        html += `<div class="st-section"><h3 class="st-section-title"><span>Parked</span><span class="st-section-note">${busy.length}</span></h3><ul class="st-list st-parked">${busy.map((s) => {
          const who = s.parkedName || (s.parkedNumber ? formatNumber(s.parkedNumber) : 'Parked call');
          const by = s.parkedBy ? ` · by ${s.parkedBy}` : '';
          return `<li class="st-row st-park-busy">
            <span class="st-slot" aria-hidden="true">${esc(s.number)}</span>
            <span class="st-who"><span class="st-name">${esc(nice(who))}</span><span class="st-sub st-sub--line">Slot ${esc(s.number)}${esc(by)}</span>
            ${e[`park:${s.number}`] ? `<span class="st-error">${esc(e[`park:${s.number}`])}</span>` : ''}</span>
            ${s.since ? `<span class="st-since st-timer" data-since="${esc(s.since)}" title="Parked for">${esc(elapsed(s.since))}</span>` : ''}
            <button type="button" class="st-mini st-mini--pri" data-act="retrieve" data-slot="${esc(s.number)}" ${retrieveOff || p[`park:${s.number}`] ? 'disabled' : ''}
              title="${esc(retrieveOff || `Pick up the call parked in slot ${s.number}`)}" aria-label="Retrieve the call in slot ${esc(s.number)}">${p[`park:${s.number}`] ? 'Retrieving…' : 'Retrieve'}</button>
          </li>`;
        }).join('')}</ul></div>`;
        if (retrieveOff) html += `<p class="st-hint st-hint--inline">${esc(retrieveOff)}</p>`;
      }
      html += `<div class="st-section"><h3 class="st-section-title"><span>Free slots</span><span class="st-section-note">${free.length}</span></h3>
        <div class="st-free" aria-label="Free park slots">${free.map((s) => `<span class="st-free-slot" title="Slot ${esc(s.number)} is free">${esc(s.number)}</span>`).join('') || '<span class="st-sub">All slots are in use.</span>'}</div></div>`;
    }
    setHtml(el, html);
  }

  function tickTimers() {
    if (!ccEl) return;
    ccEl.querySelectorAll('.st-timer').forEach((t) => { t.textContent = elapsed(t.dataset.since); });
  }

  // ------------------------------------------------------------ actions ---
  async function onCcClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'fav') { toggleFavorite(btn.dataset.ext); return; }
    if (act === 'call') {
      btn.disabled = true;
      const r = await send('status:call', { number: btn.dataset.target, ext: btn.dataset.ext || null, name: btn.dataset.name });
      btn.disabled = false;
      flash(r.ok ? `Calling ${btn.dataset.name}. ${r.message || ''}` : r.message, r.ok ? 'success' : 'error');
      return;
    }
    if (act === 'transfer') {
      btn.disabled = true;
      const r = await send('status:transfer', { number: btn.dataset.target, name: btn.dataset.name });
      btn.disabled = false;
      if (!r.ok) flash(r.message || 'Transfer failed.', 'error');
      else if (!r.consult) flash(r.message || 'Transferring…', 'success'); // Track A ran it; our banner shows our own consult flow
      return;
    }
    if (act === 'transfer-complete') { const r = await send('status:completeTransfer'); flash(r.message || '', r.ok ? 'success' : 'error'); return; }
    if (act === 'transfer-cancel') { const r = await send('status:cancelTransfer'); if (!r.ok) flash(r.message, 'error'); return; }
    if (act === 'retrieve') {
      const r = await send('status:retrievePark', { number: btn.dataset.slot });
      flash(r.message || (r.ok ? 'Retrieving…' : 'Retrieve failed.'), r.ok ? 'success' : 'error');
      return;
    }
    if (act === 'dir-retry') { dirError = ''; renderDirectory(); loadDirectory(true); return; }
    if (act === 'open-account') {
      if (typeof window.switchTab === 'function') window.switchTab('settings');
      if (window.OneClickSettings && typeof window.OneClickSettings.open === 'function') window.OneClickSettings.open('account');
    }
  }

  async function onCcChange(e) {
    const input = e.target.closest('input[data-group]');
    if (!input) return;
    const want = input.checked;
    input.checked = !want; // the event (or the fallback) flips it for real
    const r = await send('status:setGroup', { callGroupId: input.dataset.group, loggedIn: want });
    if (!r.ok) flash(r.message, 'error');
  }

  async function toggleFavorite(ext) {
    if (!ext) return;
    const next = favorites.includes(ext) ? favorites.filter((x) => x !== ext) : [...favorites, ext].slice(-50);
    favorites = next;
    renderDirectory();
    try { await chrome.storage.sync.set({ [FAV_KEY]: next }); } catch (err) { flash('Couldn’t save favorites.', 'error'); }
  }

  // ------------------------------------------------------------- render ---
  /**
   * Team is always there once you're signed in. When there's nothing to show
   * yet (still connecting, or the PIN was rejected) the tab says why instead
   * of disappearing. Signed out: hidden, and the mount stays empty.
   */
  function renderGate() {
    const auth = authRejected();
    const html = auth
      ? `<div class="st-gate">${emptyState('lock', 'Your PIN needs updating', 'It wasn’t accepted, so your coworkers, groups and park slots can’t load. Update it in Settings › Account.',
        '<button type="button" class="st-btn st-btn-primary st-btn-sm" data-act="open-account">Open Account settings</button>')}</div>`
      : `<div class="st-gate">${loadingState('Connecting to your phone system…')}</div>`;
    if (built || ccEl.dataset.sig !== html) {
      ccEl.innerHTML = html;
      ccEl.dataset.sig = html;
      built = false;
    }
  }

  function renderCounts() {
    const users = dir && dir.users;
    const groups = st.groups || [];
    const busy = (st.park || []).filter((s) => s.status === 'busy').length;
    const vals = {
      people: users ? esc(users.length) : '…',
      groups: !st.groupsLoaded ? '…' : (groups.length ? `In ${groups.filter((g) => g.loggedIn).length} <em>of ${groups.length}</em>` : '<em>None</em>'),
      park: !st.parkLoaded ? '…' : ((st.park || []).length ? `${busy} <em>parked</em>` : '<em>None</em>')
    };
    ccEl.querySelectorAll('.st-count').forEach((c) => {
      setHtml(c, vals[c.dataset.count] || '');
      c.classList.toggle('is-alert', c.dataset.count === 'park' && busy > 0);
    });
  }

  function renderCallCenter() {
    if (!ccEl) return;
    const tabBtn = document.querySelector('.tab-btn[data-tab="callcenter"]');
    const show = signedIn();
    if (tabBtn) {
      if (!tabBtn.dataset.stBound) {
        tabBtn.dataset.stBound = '1';
        tabBtn.addEventListener('click', () => requestAnimationFrame(() => { if (built) fitPopup(); }));
      }
      tabBtn.hidden = !show;
      if (!show && tabBtn.classList.contains('active') && typeof window.switchTab === 'function') window.switchTab('dial');
    }
    if (!show) { if (ccEl.innerHTML) { ccEl.innerHTML = ''; delete ccEl.dataset.sig; } built = false; return; }
    if (!st || authRejected()) { renderGate(); return; }
    if (!built) delete ccEl.dataset.sig;
    build();
    renderCounts();
    if (segment === 'team') { renderTransfer(); renderDirectory(); }
    if (segment === 'groups') renderGroups();
    if (segment === 'park') renderPark();
    fitPopup();
    clearInterval(tickTimer);
    if (segment === 'park' && (st.park || []).some((s) => s.status === 'busy')) tickTimer = setInterval(tickTimers, 1000);
  }

  /**
   * Toolbar popup builds (no longer shipped) were capped at about 600 px, so the
   * list got whatever height was left. The side panel scrolls normally.
   */
  function fitPopup() {
    if (document.body.classList.contains('sidebar-mode')) return;
    const pane = ccEl.querySelector(`#st-panel-${segment}`);
    const list = segment === 'team' ? ccEl.querySelector('.st-dir') : pane;
    if (!list || pane.hidden) return;
    const top = list.getBoundingClientRect().top;
    if (!top) return; // tab not visible yet
    list.style.maxHeight = `${Math.max(260, Math.floor(576 - top))}px`;
  }

  let frame = null;
  function render() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; renderPill(); renderSheet(); renderCallCenter(); });
  }

  async function load() {
    const [local, sync] = await Promise.all([
      chrome.storage.local.get(['statusState', 'apiStatus', 'statusDirectory', 'statusRecent', 'statusForwardLast']),
      chrome.storage.sync.get([FAV_KEY])
    ]);
    st = local.statusState || null;
    conn = local.apiStatus || null;
    dir = local.statusDirectory || null;
    recent = local.statusRecent || [];
    fwdLast = local.statusForwardLast || '';
    favorites = sync[FAV_KEY] || [];
    render();
  }

  function mount(sEl, cEl) {
    statusEl = sEl;
    ccEl = cEl;
    if (!statusEl && !ccEl) return;
    // One delegated handler for every Team button (the tab's content is rebuilt, the mount is not).
    if (ccEl) { ccEl.addEventListener('click', onCcClick); ccEl.addEventListener('change', onCcChange); }
    load().catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        let touched = false;
        if (changes.statusState) { st = changes.statusState.newValue || null; touched = true; }
        if (changes.apiStatus) { conn = changes.apiStatus.newValue || null; touched = true; }
        if (changes.statusDirectory) { dir = changes.statusDirectory.newValue || null; if (dir) dirError = ''; touched = true; }
        if (changes.statusRecent) { recent = changes.statusRecent.newValue || []; touched = true; }
        if (changes.statusForwardLast) { fwdLast = changes.statusForwardLast.newValue || ''; }
        if (touched) render();
      } else if (area === 'sync' && changes[FAV_KEY]) {
        favorites = changes[FAV_KEY].newValue || [];
        render();
      }
    });
    // Ask the service worker for a fresh snapshot when the panel opens (it may have been asleep).
    send('status:refresh').catch(() => {});
  }

  /**
   * Open the Team tab's directory, e.g. from Track A's call card
   * ("Transfer…" button): window.OneClickUI.status.openDirectory({mode:'transfer'}).
   */
  function openDirectory({ query: q = '' } = {}) {
    if (typeof window.switchTab === 'function') window.switchTab('callcenter');
    if (!built) return;
    setSegment('team');
    const input = ccEl.querySelector('.st-search-input');
    input.value = q;
    query = q;
    renderDirectory();
    input.focus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    mount(document.getElementById('statusMount'), document.getElementById('callCenterMount'));
  });

  window.OneClickUI.status = { mount, openDirectory, render, openSheet, closeSheet };
})();
