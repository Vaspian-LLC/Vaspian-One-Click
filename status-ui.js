// Track B "status": header status pill (#statusMount) and the Call Center
// tab (#callCenterMount), in the popup and the side panel.
//
// Reads what presence.js publishes (chrome.storage.local statusState,
// statusDirectory, statusRecent, statusForwardLast, plus apiStatus) and the
// user's favorites (chrome.storage.sync statusFavorites, written here).
// Sends commands with chrome.runtime.sendMessage({action:'status:<verb>'}).
//
// Coworker presence is not available to regular users, so the directory is
// built around search, favorites and recent contacts instead of presence dots.
//
// Keep everything inside this IIFE; public surface: window.OneClickUI.status.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  const FAV_KEY = 'statusFavorites';
  const SEG_KEY = 'oneclick.status.segment';
  const MAX_ROWS = 200;

  let statusEl = null;
  let ccEl = null;
  let built = false;
  let st = null;          // statusState
  let conn = null;        // apiStatus
  let dir = null;         // statusDirectory
  let recent = [];
  let favorites = [];
  let fwdLast = '';
  let segment = 'team';
  let query = '';
  let fwdEditing = false;
  let flashTimer = null;
  let tickTimer = null;

  // ------------------------------------------------------------ helpers ---
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    forward: '<polyline points="15 17 20 12 15 7"/><path d="M4 18v-2a4 4 0 0 1 4-4h12"/>',
    headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>',
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    transfer: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    group: '<circle cx="12" cy="8" r="3"/><circle cx="5" cy="10" r="2"/><circle cx="19" cy="10" r="2"/><path d="M8 20v-1a4 4 0 0 1 8 0v1"/><path d="M2 20v-.5A2.5 2.5 0 0 1 4.5 17H6M22 20v-.5a2.5 2.5 0 0 0-2.5-2.5H18"/>',
    park: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
    refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
    contact: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'
  };
  const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  function initials(display) {
    const words = String(display || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length || /^\d+$/.test(words[0])) return '#';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }

  const AVATAR_COLORS = ['#2954A4', '#E66825', '#0f766e', '#7c3aed', '#475569', '#be123c', '#b45309', '#1d4ed8'];
  function avatarColor(key) {
    let h = 0;
    for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }

  function formatNumber(n) {
    const d = String(n || '').replace(/\D/g, '');
    const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
    return d || String(n || '');
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

  const signedIn = () => !!(conn && !(conn.state === 'off' && conn.reason === 'no_credentials') && (st && st.account || conn.account));
  const activeCall = () => {
    if (!st || !st.calls) return null;
    const t = st.transfer;
    const e = Object.entries(st.calls).find(([id, c]) => (c.phase === 'active' || c.phase === 'held') && !(t && id === t.consultCallId));
    return e ? { callId: e[0], ...e[1] } : null;
  };

  // ---------------------------------------------------------- the pill ---
  function renderPill() {
    if (!statusEl) return;
    if (!signedIn() || !st) { statusEl.innerHTML = ''; return; }
    const v = st.view || { key: 'connecting', label: 'Connecting' };
    const label = v.key === 'oncall' ? onCallLabel() : v.label;
    const chips = [];
    if (st.dnd && v.key !== 'dnd') chips.push(`<span class="st-chip st-chip-dnd">${icon('moon', 12)}DND</span>`);
    if (st.forward && st.forward.active) {
      const who = st.forward.targetName || formatNumber(st.forward.target);
      chips.push(`<span class="st-chip" title="Calls forward to ${esc(who)}">${icon('forward', 12)}<span class="st-chip-text">${esc(who)}</span></span>`);
    }
    if (st.acd) chips.push(`<span class="st-chip" title="Signed in to queues (ACD)">${icon('headset', 12)}Queues</span>`);
    const dndDisabled = !st.ready || !!(st.disabled && st.disabled.dnd) || !!(st.pending && st.pending.dnd);
    const dndTitle = st.disabled && st.disabled.dnd ? st.disabled.dnd
      : `${st.dnd ? 'Turn off' : 'Turn on'} Do Not Disturb (Alt+Shift+D)`;
    const html = `
      <div class="st-bar">
        <div class="st-pill st-pill--${esc(v.key === 'missed' ? 'available' : v.key)}" role="status" aria-live="polite" title="${esc(v.title || label)}">
          <span class="st-dot" aria-hidden="true"></span>
          <span class="st-label">${esc(label)}</span>
          ${chips.join('')}
          ${!chips.length && st.extension ? `<span class="st-pill-ext">Ext ${esc(st.extension)}</span>` : ''}
        </div>
        <button type="button" class="st-dnd-btn${st.dnd ? ' is-on' : ''}${st.pending && st.pending.dnd ? ' is-pending' : ''}" aria-pressed="${st.dnd ? 'true' : 'false'}"
          title="${esc(dndTitle)}" aria-label="Do Not Disturb" ${dndDisabled ? 'disabled' : ''}>
          ${icon('moon', 14)}<span>DND</span>
        </button>
      </div>`;
    if (statusEl.dataset.sig !== html) {
      statusEl.innerHTML = html;
      statusEl.dataset.sig = html;
      statusEl.querySelector('.st-dnd-btn').addEventListener('click', onDndClick);
    }
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
    if (!r.ok) flash(r.message, 'error');
  }

  // ------------------------------------------------- call center: frame ---
  function build() {
    if (built || !ccEl) return;
    built = true;
    try { segment = localStorage.getItem(SEG_KEY) || 'team'; } catch (e) { segment = 'team'; }
    if (!['team', 'groups', 'park'].includes(segment)) segment = 'team';
    ccEl.innerHTML = `
      <div class="st-cc">
        <div class="st-tiles" role="group" aria-label="My availability"></div>
        <div class="st-fwd"></div>
        <div class="st-flash" role="status" aria-live="polite" hidden></div>
        <div class="st-seg" role="tablist" aria-label="Call Center">
          <button type="button" role="tab" class="st-seg-btn" data-seg="team" id="st-tab-team" aria-controls="st-panel-team">${icon('users', 14)}<span>Team</span></button>
          <button type="button" role="tab" class="st-seg-btn" data-seg="groups" id="st-tab-groups" aria-controls="st-panel-groups">${icon('group', 14)}<span>Groups</span><span class="st-count" data-count="groups"></span></button>
          <button type="button" role="tab" class="st-seg-btn" data-seg="park" id="st-tab-park" aria-controls="st-panel-park">${icon('park', 14)}<span>Park</span><span class="st-count" data-count="park"></span></button>
        </div>
        <div class="st-panel" role="tabpanel" id="st-panel-team" aria-labelledby="st-tab-team">
          <div class="st-transfer"></div>
          <div class="st-search">
            ${icon('search', 16)}
            <input type="search" class="st-search-input" placeholder="Search name or extension" aria-label="Search the team directory" autocomplete="off" spellcheck="false">
            <button type="button" class="st-search-clear" aria-label="Clear search" hidden>${icon('x', 14)}</button>
          </div>
          <div class="st-dir"></div>
        </div>
        <div class="st-panel" role="tabpanel" id="st-panel-groups" aria-labelledby="st-tab-groups"></div>
        <div class="st-panel" role="tabpanel" id="st-panel-park" aria-labelledby="st-tab-park"></div>
      </div>`;

    ccEl.querySelectorAll('.st-seg-btn').forEach((b) => b.addEventListener('click', () => setSegment(b.dataset.seg)));
    ccEl.querySelector('.st-seg').addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const order = ['team', 'groups', 'park'];
      const next = order[(order.indexOf(segment) + (e.key === 'ArrowRight' ? 1 : 2)) % 3];
      setSegment(next);
      ccEl.querySelector(`.st-seg-btn[data-seg="${next}"]`).focus();
    });
    const input = ccEl.querySelector('.st-search-input');
    input.addEventListener('input', () => { query = input.value; renderDirectory(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) { e.preventDefault(); clearSearch(); }
      if (e.key === 'Enter') {
        const first = ccEl.querySelector('.st-dir .st-row .st-act-call');
        if (first) first.click();
      }
    });
    ccEl.querySelector('.st-search-clear').addEventListener('click', clearSearch);
    // One delegated handler for every row/tile button.
    ccEl.addEventListener('click', onCcClick);
    ccEl.addEventListener('change', onCcChange);
    setSegment(segment, true);
  }

  function clearSearch() {
    const input = ccEl.querySelector('.st-search-input');
    input.value = '';
    query = '';
    renderDirectory();
    input.focus();
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
    if (seg === 'team' && !dir) send('status:loadDirectory', { force: false });
  }

  // ------------------------------------------------------------- tiles ---
  function tile(key, iconName, title, stateText, on, opts = {}) {
    const short = opts.short || title;
    const disabledReason = opts.disabled || '';
    const pending = !!opts.pending;
    return `
      <button type="button" class="st-tile${on ? ' is-on' : ''}${pending ? ' is-pending' : ''}" data-tile="${key}"
        aria-pressed="${on ? 'true' : 'false'}" ${disabledReason || !st.ready ? 'disabled' : ''}
        title="${esc(disabledReason || opts.hint || '')}" aria-label="${esc(`${title}: ${stateText}`)}">
        <span class="st-tile-icon">${icon(iconName, 18)}</span>
        <span class="st-tile-title"><span class="st-long">${esc(title)}</span><span class="st-short" aria-hidden="true">${esc(short)}</span></span>
        <span class="st-tile-state">${esc(pending ? 'Updating…' : stateText)}</span>
      </button>`;
  }

  function renderTiles() {
    const el = ccEl.querySelector('.st-tiles');
    const d = st.disabled || {};
    const p = st.pending || {};
    const fwd = st.forward || {};
    const fwdText = fwd.active ? (fwd.targetName || formatNumber(fwd.target)) : 'Off';
    const html = [
      tile('dnd', 'moon', 'Do Not Disturb', st.dnd ? 'On' : 'Off', !!st.dnd, { short: 'DND', disabled: d.dnd, pending: p.dnd, hint: 'Send calls to voicemail or coverage (Alt+Shift+D)' }),
      tile('forward', 'forward', 'Forward', fwdText, !!fwd.active, { disabled: d.forward, pending: p.forward, hint: fwd.active ? 'Turn off call forwarding' : 'Forward all calls to a coworker or number' }),
      tile('acd', 'headset', 'Queues', st.acd ? 'Signed in' : 'Signed out', !!st.acd, { disabled: d.acd, pending: p.acd, hint: 'ACD queue sign-in for every queue you are an agent in' })
    ].join('');
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  function renderForward() {
    const el = ccEl.querySelector('.st-fwd');
    const fwd = st.forward || {};
    const err = st.errors && st.errors.forward;
    let html = '';
    if (fwdEditing) {
      const users = (dir && dir.users) || [];
      html = `
        <form class="st-fwd-form" novalidate>
          <label class="st-fwd-label" for="st-fwd-input">Forward all my calls to</label>
          <div class="st-fwd-row">
            <input id="st-fwd-input" class="st-input" list="st-fwd-list" inputmode="tel" autocomplete="off" placeholder="Extension or phone number" value="${esc(fwdLast || '')}">
            <button type="submit" class="st-btn st-btn-primary">Forward</button>
            <button type="button" class="st-btn st-btn-ghost" data-act="fwd-cancel">Cancel</button>
          </div>
          <datalist id="st-fwd-list">${users.slice(0, 500).map((u) => `<option value="${esc(u.ext)}">${esc(u.name)}</option>`).join('')}</datalist>
          ${err ? `<p class="st-error">${esc(err)}</p>` : ''}
        </form>`;
    } else if (fwd.active) {
      const who = fwd.targetName ? `${fwd.targetName} (${fwd.target})` : formatNumber(fwd.target);
      html = `<div class="st-fwd-line">${icon('forward', 14)}<span>Calls forward to <strong>${esc(who)}</strong></span>
        <button type="button" class="st-link" data-act="fwd-change">Change</button></div>`;
    } else if (err) {
      html = `<p class="st-error">${esc(err)}</p>`;
    }
    if (el.dataset.sig !== html) {
      const hadFocus = document.activeElement && document.activeElement.id === 'st-fwd-input';
      el.innerHTML = html;
      el.dataset.sig = html;
      const form = el.querySelector('.st-fwd-form');
      if (form) {
        form.addEventListener('submit', onForwardSubmit);
        if (!hadFocus) { const i = form.querySelector('input'); i.focus(); i.select(); }
      }
    }
  }

  async function onForwardSubmit(e) {
    e.preventDefault();
    const input = ccEl.querySelector('#st-fwd-input');
    const value = input.value.trim();
    const r = await send('status:setForward', { active: true, target: value });
    if (r.ok) { fwdEditing = false; renderCallCenter(); flash('Call forwarding is on.', 'success'); } else flash(r.message, 'error');
  }

  // ---------------------------------------------------------- directory ---
  function entryFor(ext) {
    const u = dir && dir.users && dir.users.find((x) => x.ext === ext);
    return u ? { ext: u.ext, name: u.name } : null;
  }

  function row(entry, { inCall, fav }) {
    const key = entry.ext ? `ext:${entry.ext}` : `num:${entry.number}`;
    const sub = entry.ext ? `Ext ${entry.ext}` : formatNumber(entry.number);
    const name = entry.name || sub;
    const target = entry.ext || entry.number;
    const t = st && st.transfer;
    const transferBusy = !!t || !!(st && st.pending && st.pending.transfer);
    const transferDisabled = (st && st.disabled && st.disabled.transfer) || '';
    return `
      <li class="st-row" data-key="${esc(key)}">
        <span class="st-avatar${entry.ext ? '' : ' is-contact'}" style="--st-av:${avatarColor(name)}" aria-hidden="true">${entry.ext ? esc(initials(name)) : icon('contact', 14)}</span>
        <span class="st-who"><span class="st-name">${esc(name)}</span><span class="st-sub">${esc(sub)}${entry.kind ? ` · ${esc(entry.kind)}` : ''}</span></span>
        ${entry.ext ? `<button type="button" class="st-icon-btn st-act-fav${fav ? ' is-on' : ''}" data-act="fav" data-ext="${esc(entry.ext)}" aria-pressed="${fav ? 'true' : 'false'}" aria-label="${fav ? 'Remove' : 'Add'} ${esc(name)} ${fav ? 'from' : 'to'} favorites" title="${fav ? 'Remove from favorites' : 'Add to favorites'}">${icon('star', 16)}</button>` : ''}
        ${inCall ? `<button type="button" class="st-icon-btn st-act-transfer" data-act="transfer" data-target="${esc(target)}" data-name="${esc(name)}" aria-label="Transfer the call to ${esc(name)}" title="${esc(transferDisabled || `Transfer the call to ${name}`)}" ${transferBusy || transferDisabled ? 'disabled' : ''}>${icon('transfer', 16)}</button>` : ''}
        <button type="button" class="st-icon-btn st-act-call" data-act="call" data-target="${esc(target)}" data-ext="${esc(entry.ext || '')}" data-name="${esc(name)}" aria-label="Call ${esc(name)}" title="Call ${esc(name)}">${icon('phone', 16)}</button>
      </li>`;
  }

  function section(title, entries, opts, extra = '') {
    if (!entries.length) return '';
    return `<div class="st-section"><div class="st-section-title">${esc(title)}${extra}</div><ul class="st-list">${entries.map((e) => row(e, { ...opts, fav: !!(e.ext && favorites.includes(e.ext)) })).join('')}</ul></div>`;
  }

  function renderTransfer() {
    const el = ccEl.querySelector('.st-transfer');
    const t = st.transfer;
    const call = activeCall();
    let html = '';
    if (t) {
      html = `<div class="st-banner st-banner-transfer" role="status">
        <div class="st-banner-text">${icon('transfer', 16)}<span>${t.phase === 'completing' ? 'Transferring to' : 'Talking to'} <strong>${esc(t.name || t.to)}</strong>. ${t.phase === 'completing' ? '' : 'Complete the transfer when ready.'}</span></div>
        <div class="st-banner-actions">
          <button type="button" class="st-btn st-btn-primary" data-act="transfer-complete" ${t.phase === 'completing' ? 'disabled' : ''}>Complete transfer</button>
          <button type="button" class="st-btn st-btn-ghost" data-act="transfer-cancel">Cancel</button>
        </div></div>`;
    } else if (call) {
      const who = call.party && (call.party.display || call.party.name);
      html = `<div class="st-banner" role="status">${icon('phone', 16)}<span>On a call${who ? ` with <strong>${esc(who)}</strong>` : ''}. Pick someone and press ${icon('transfer', 13)} to transfer.</span></div>`;
    }
    if (st.errors && st.errors.transfer && !t) html += `<p class="st-error">${esc(st.errors.transfer)}</p>`;
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  function renderDirectory() {
    const el = ccEl.querySelector('.st-dir');
    const clear = ccEl.querySelector('.st-search-clear');
    if (clear) clear.hidden = !query;
    const inCall = !!activeCall() && !st.transfer;
    const opts = { inCall };
    let html;
    if (st.disabled && st.disabled.directory) {
      html = `<div class="st-empty">${esc(st.disabled.directory)}</div>`;
    } else if (!dir) {
      html = `<div class="st-empty"><span class="st-spinner" aria-hidden="true"></span>Loading the team directory…</div>`;
    } else {
      const users = dir.users || [];
      const contacts = (dir.contacts || []).map((c) => ({ number: c.number, name: c.name, kind: 'Contact' }));
      if (query.trim()) {
        const hits = search([...users, ...contacts], query);
        const digits = query.replace(/\D/g, '');
        const dialable = digits.length >= 3 && digits === query.replace(/[\s()+.-]/g, '') && !hits.some((h) => (h.ext || h.number) === digits);
        html = hits.length
          ? section(`${hits.length} ${hits.length === 1 ? 'match' : 'matches'}`, hits.slice(0, MAX_ROWS), opts)
          : `<div class="st-empty">No one matches “${esc(query.trim())}”.</div>`;
        if (dialable) html = section('Dial', [{ number: digits.length <= 6 ? null : digits, ext: digits.length <= 6 ? digits : null, name: digits.length <= 6 ? `Extension ${digits}` : formatNumber(digits) }], opts) + html;
      } else {
        const favs = favorites.map((x) => entryFor(x)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
        const favSet = new Set(favorites);
        const rec = recent.map((r) => (r.ext ? (entryFor(r.ext) || { ext: r.ext, name: r.name || `Extension ${r.ext}` }) : { number: r.number, name: r.name || formatNumber(r.number) }))
          .filter((e) => !(e.ext && favSet.has(e.ext))).slice(0, 5);
        const hint = !favs.length ? `<div class="st-hint">${icon('star', 13)}<span>Star the people you call most to keep them here.</span></div>` : '';
        html = section('Favorites', favs, opts) + hint + section('Recent', rec, opts)
          + section('Everyone', users.slice(0, MAX_ROWS), opts, ` <span class="st-section-count">${users.length}</span>`)
          + (users.length > MAX_ROWS ? `<div class="st-hint">Showing ${MAX_ROWS} of ${users.length}. Search to find anyone.</div>` : '')
          + section('Contacts', contacts.slice(0, 50), opts);
        if (!users.length && !contacts.length) html = `<div class="st-empty">The directory is empty.</div>`;
      }
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  // ------------------------------------------------------------- groups ---
  function renderGroups() {
    const el = ccEl.querySelector('#st-panel-groups');
    const groups = st.groups || [];
    const p = st.pending || {};
    const e = st.errors || {};
    let html;
    if (st.disabled && st.disabled.groups) html = `<div class="st-empty">${esc(st.disabled.groups)}</div>`;
    else if (!st.groupsLoaded) html = `<div class="st-empty"><span class="st-spinner" aria-hidden="true"></span>Loading your groups…</div>`;
    else if (!groups.length) html = `<div class="st-empty">${icon('group', 28)}<span>You aren’t a member of any call groups.</span></div>`;
    else {
      const joined = groups.filter((g) => g.loggedIn).length;
      html = `<div class="st-section-title">Joined ${joined} of ${groups.length}</div><ul class="st-list st-groups">${groups.map((g) => {
        const key = `group:${g.callGroupId}`;
        const type = { ringGroup: 'Ring group', huntGroup: 'Hunt group', rolloverGroup: 'Rollover group', broadcastGroup: 'Broadcast group' }[g.type] || (g.type ? String(g.type).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()) : 'Group');
        return `<li class="st-row st-group${g.loggedIn ? ' is-on' : ''}">
          <span class="st-avatar is-group" style="--st-av:${g.loggedIn ? '#16a34a' : '#9ca3af'}" aria-hidden="true">${icon('group', 15)}</span>
          <span class="st-who"><span class="st-name">${esc(g.name)}</span><span class="st-sub">${g.extension ? `Ext ${esc(g.extension)} · ` : ''}${esc(type)}${g.queueEnabled ? ' · Queue' : ''}${p[key] ? ' · Updating…' : ''}</span>
          ${e[key] ? `<span class="st-error">${esc(e[key])}</span>` : ''}</span>
          <label class="st-switch" title="${g.loggedIn ? 'Leave' : 'Join'} ${esc(g.name)}">
            <input type="checkbox" data-group="${esc(g.callGroupId)}" ${g.loggedIn ? 'checked' : ''} ${p[key] ? 'disabled' : ''} aria-label="${esc(`Joined ${g.name}`)}">
            <span class="st-switch-track" aria-hidden="true"></span>
          </label>
        </li>`;
      }).join('')}</ul>`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  // --------------------------------------------------------------- park ---
  function renderPark() {
    const el = ccEl.querySelector('#st-panel-park');
    const slots = st.park || [];
    const p = st.pending || {};
    const e = st.errors || {};
    const retrieveOff = (st.disabled && st.disabled.retrieve) || (st.phones === 0 ? 'Retrieving needs a desk phone or softphone that’s signed in.' : '');
    let html;
    if (st.disabled && st.disabled.park) html = `<div class="st-empty">${esc(st.disabled.park)}</div>`;
    else if (!st.parkLoaded) html = `<div class="st-empty"><span class="st-spinner" aria-hidden="true"></span>Loading park slots…</div>`;
    else if (!slots.length) html = `<div class="st-empty">${icon('park', 28)}<span>No park slots are set up.</span></div>`;
    else {
      const busy = slots.filter((s) => s.status === 'busy');
      const free = slots.filter((s) => s.status !== 'busy');
      html = `<div class="st-section-title">${busy.length ? `${busy.length} parked` : 'No calls parked'}</div>`;
      if (busy.length) {
        html += `<ul class="st-list st-parked">${busy.map((s) => {
          const who = s.parkedName || (s.parkedNumber ? formatNumber(s.parkedNumber) : 'Parked call');
          const by = s.parkedBy ? ` · by ${s.parkedBy}` : '';
          return `<li class="st-row st-park-busy">
            <span class="st-slot" aria-hidden="true">${esc(s.number)}</span>
            <span class="st-who"><span class="st-name">${esc(who)}</span><span class="st-sub">Slot ${esc(s.number)}${esc(by)}${s.since ? ` · <span class="st-timer" data-since="${esc(s.since)}">${esc(elapsed(s.since))}</span>` : ''}</span>
            ${e[`park:${s.number}`] ? `<span class="st-error">${esc(e[`park:${s.number}`])}</span>` : ''}</span>
            <button type="button" class="st-btn st-btn-primary st-btn-sm" data-act="retrieve" data-slot="${esc(s.number)}" ${retrieveOff || p[`park:${s.number}`] ? 'disabled' : ''}
              title="${esc(retrieveOff || `Pick up the call parked in slot ${s.number}`)}" aria-label="Retrieve the call in slot ${esc(s.number)}">${p[`park:${s.number}`] ? 'Retrieving…' : 'Retrieve'}</button>
          </li>`;
        }).join('')}</ul>`;
      }
      html += `<div class="st-free" aria-label="Free park slots"><span class="st-free-label">Free</span>${free.map((s) => `<span class="st-free-slot" title="Slot ${esc(s.number)} is free">${esc(s.number)}</span>`).join('') || '<span class="st-sub">none</span>'}</div>`;
      if (retrieveOff && busy.length) html += `<p class="st-hint">${esc(retrieveOff)}</p>`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  function tickTimers() {
    if (!ccEl) return;
    ccEl.querySelectorAll('.st-timer').forEach((t) => { t.textContent = elapsed(t.dataset.since); });
  }

  // ------------------------------------------------------------ actions ---
  async function onCcClick(e) {
    const tileBtn = e.target.closest('.st-tile');
    if (tileBtn && !tileBtn.disabled) {
      const k = tileBtn.dataset.tile;
      if (k === 'dnd') { const r = await send('status:setDnd', { active: !st.dnd }); if (!r.ok) flash(r.message, 'error'); }
      if (k === 'acd') { const r = await send('status:setAcd', { active: !st.acd }); if (!r.ok) flash(r.message, 'error'); }
      if (k === 'forward') {
        if (st.forward && st.forward.active) {
          fwdEditing = false;
          const r = await send('status:setForward', { active: false });
          flash(r.ok ? 'Call forwarding is off.' : r.message, r.ok ? 'success' : 'error');
        } else {
          fwdEditing = !fwdEditing;
          renderCallCenter();
        }
      }
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'fwd-cancel') { fwdEditing = false; renderCallCenter(); return; }
    if (act === 'fwd-change') { fwdLast = (st.forward && st.forward.target) || fwdLast; fwdEditing = true; renderCallCenter(); return; }
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
    if (act === 'dir-retry') { send('status:loadDirectory', { force: true }); }
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
  function renderCallCenter() {
    if (!ccEl) return;
    const tabBtn = document.querySelector('.tab-btn[data-tab="callcenter"]');
    const show = signedIn() && !!st;
    if (tabBtn) {
      if (!tabBtn.dataset.stBound) {
        tabBtn.dataset.stBound = '1';
        tabBtn.addEventListener('click', () => requestAnimationFrame(() => { if (built) fitPopup(); }));
      }
      tabBtn.hidden = !show;
      if (!show && tabBtn.classList.contains('active') && typeof window.switchTab === 'function') window.switchTab('dial');
    }
    if (!show) { if (built) { ccEl.innerHTML = ''; built = false; } return; }
    build();
    // While a transfer is in progress the availability tiles step aside so the banner and list fit.
    ccEl.querySelector('.st-cc').classList.toggle('is-transferring', !!st.transfer);
    renderTiles();
    renderForward();
    const counts = {
      groups: (st.groups || []).length ? `${(st.groups || []).filter((g) => g.loggedIn).length}/${st.groups.length}` : '',
      park: (st.park || []).filter((s) => s.status === 'busy').length || ''
    };
    ccEl.querySelectorAll('.st-count').forEach((c) => {
      const v = String(counts[c.dataset.count] || '');
      c.textContent = v;
      c.hidden = !v;
      c.classList.toggle('is-alert', c.dataset.count === 'park' && !!v);
    });
    if (segment === 'team') { renderTransfer(); renderDirectory(); }
    if (segment === 'groups') renderGroups();
    if (segment === 'park') renderPark();
    fitPopup();
    clearInterval(tickTimer);
    if (segment === 'park' && (st.park || []).some((s) => s.status === 'busy')) tickTimer = setInterval(tickTimers, 1000);
  }

  /**
   * The popup is capped at about 600 px and its body doesn’t scroll, so the
   * visible list gets whatever height is left (the side panel scrolls normally).
   */
  function fitPopup() {
    if (document.body.classList.contains('sidebar-mode')) return;
    const pane = ccEl.querySelector(`#st-panel-${segment}`);
    const list = segment === 'team' ? ccEl.querySelector('.st-dir') : pane;
    if (!list || pane.hidden) return;
    const top = list.getBoundingClientRect().top;
    if (!top) return; // tab not visible yet
    list.style.maxHeight = `${Math.max(120, Math.floor(576 - top))}px`;
  }

  let frame = null;
  function render() {
    if (frame) return;
    frame = requestAnimationFrame(() => { frame = null; renderPill(); renderCallCenter(); });
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
    load().catch(() => {});
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        let touched = false;
        if (changes.statusState) { st = changes.statusState.newValue || null; touched = true; }
        if (changes.apiStatus) { conn = changes.apiStatus.newValue || null; touched = true; }
        if (changes.statusDirectory) { dir = changes.statusDirectory.newValue || null; touched = true; }
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
   * Open the Call Center directory, e.g. from Track A's call card
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

  window.OneClickUI.status = { mount, openDirectory, render };
})();
