// Team view console (operator.html, opened in a browser tab).
//
// Live data comes from operator.js over the runtime port 'operator'
// (snapshot, then deltas a few times a second). Own call, transfer, park
// slots and own groups come from what calls.js / presence.js already publish
// (session.callcardCalls, local.statusState); favourites are the shared
// sync.statusFavorites list. Actions reuse the existing messages:
// status:call, status:transfer (calls.startTransfer, attended), status:completeTransfer,
// status:cancelTransfer, status:retrievePark, status:setGroup.
// Nothing here can touch a coworker's call: no answer, pick up, hold or hang up.
//
// Rendering: one element per person, patched in place (no grid rebuilds), a
// stable order (favourites, then name), timers ticked once a second from
// data-since. Keep everything inside this IIFE.

(function () {
  'use strict';

  const FAV_KEY = 'statusFavorites';
  const PREF_KEY = 'oneclick.operator.view'; // per-viewer convenience (density + filter), localStorage
  const MAX_FAVS = 50;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const ICONS = {
    phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>',
    transfer: '<polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>',
    star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
    users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/>',
    wifiOff: '<line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
    key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
    search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
    park: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M9 17V7h4a3 3 0 0 1 0 6H9"/>',
    group: '<circle cx="12" cy="8" r="3"/><circle cx="5" cy="10" r="2"/><circle cx="19" cy="10" r="2"/><path d="M8 20v-1a4 4 0 0 1 8 0v1"/><path d="M2 20v-.5A2.5 2.5 0 0 1 4.5 17H6M22 20v-.5a2.5 2.5 0 0 0-2.5-2.5H18"/>',
    moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    headset: '<path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/>'
  };
  const icon = (name, size = 16) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // Avatars are one neutral tint (operator.css): the status dot, text and stripe are the only state colours on a tile.
  function initials(display) {
    const words = String(display || '').replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length || /^\d+$/.test(words[0])) return '#';
    return (words[0][0] + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
  }
  function formatNumber(n) {
    const d = String(n || '').replace(/\D/g, '');
    const ten = d.length === 11 && d[0] === '1' ? d.slice(1) : d;
    if (ten.length === 10) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
    return d || String(n || '');
  }
  function nice(name) {
    const v = String(name || '');
    if (!v || /[a-z]/.test(v) || !/[A-Z]/.test(v)) return v;
    return v.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
  }
  function toMs(t) { return typeof t === 'number' ? t : (t ? new Date(t).getTime() : 0); }
  function elapsed(since) {
    const t = toMs(since);
    if (!t) return '';
    const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
    const m = Math.floor(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }

  function send(action, payload = {}) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ action, ...payload }, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, message: 'One\u00a0Click is restarting. Try again in a moment.' });
          else resolve(r || { ok: false, message: 'No response.' });
        });
      } catch (e) { resolve({ ok: false, message: e.message }); }
    });
  }

  // -------------------------------------------------------------- state ---
  /** What happens to a call or transfer, by the coworker's state (shown as a hint; the button still works). */
  const TRANSFER_NOTE = {
    dnd: 'Do not disturb: goes to their voicemail',
    nophone: 'No phone: goes to their voicemail',
    oncall: 'On a call: they’ll get call waiting',
    onhold: 'On a call: they’ll get call waiting',
    ringing: 'Ringing: they’ll get call waiting'
  };
  const TIMED = new Set(['ringing', 'oncall', 'onhold']);
  const STATE_TEXT = { available: 'Available', ringing: 'Ringing', oncall: 'On a call', onhold: 'On hold', dnd: 'Do not disturb', nophone: 'No phone' };
  const FILTERS = [
    { key: 'all', label: 'Everyone' },
    { key: 'available', label: 'Available', dot: 'available' },
    { key: 'oncall', label: 'On a call', dot: 'oncall' },
    { key: 'ringing', label: 'Ringing', dot: 'ringing' },
    { key: 'dnd', label: 'Do not disturb', dot: 'dnd' },
    { key: 'nophone', label: 'No phone', dot: 'nophone' },
    { key: 'favorites', label: 'Favorites', star: true }
  ];

  const people = new Map();   // ext -> public person record (operator.js)
  let groups = [];
  let counts = { available: 0, oncall: 0, ringing: 0, dnd: 0, nophone: 0, total: 0 };
  let phase = 'connecting';
  let isAdmin = null;
  let enabled = true;
  let lastSyncAt = null;
  let st = null;              // local.statusState (presence.js)
  let conn = null;            // local.apiStatus
  let myCalls = [];           // session.callcardCalls.calls
  let favorites = [];
  let filter = 'all';
  let density = 'cards';
  let query = '';
  let gotSnapshot = false;
  let starting = null;        // {name} from the moment a transfer is asked for until presence.js reports it

  try {
    const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (pref.density === 'list' || pref.density === 'cards') density = pref.density;
    if (FILTERS.some((f) => f.key === pref.filter)) filter = pref.filter;
  } catch (e) { /* per-viewer convenience only */ }
  function savePref() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ density, filter })); } catch (e) { /* ignore */ } }

  // -------------------------------------------------------------- port ---
  let port = null;
  let portRetry = 0;
  let extensionGone = false;  // One Click was reloaded or updated: this page's context is dead
  function contextGone(e) {
    try { if (!chrome.runtime || !chrome.runtime.id) return true; } catch (x) { return true; }
    return !!(e && /context invalidated/i.test(String(e.message || e)));
  }
  function goneForGood() {
    extensionGone = true;
    port = null;
    render();
  }
  function connectPort() {
    if (extensionGone) return;
    try {
      port = chrome.runtime.connect({ name: 'operator' });
    } catch (e) {
      if (contextGone(e)) { goneForGood(); return; }
      setTimeout(connectPort, 1500);
      return;
    }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      if (contextGone()) { goneForGood(); return; }
      // The service worker restarted: reconnect with a short backoff.
      portRetry = Math.min(portRetry + 1, 5);
      setTimeout(connectPort, 400 * portRetry);
    });
  }

  function onPortMessage(m) {
    if (!m || !m.type) return;
    portRetry = 0;
    if (m.type === 'snapshot') {
      const s = m.state || {};
      gotSnapshot = true;
      people.clear();
      for (const p of s.people || []) people.set(p.ext, p);
      groups = s.groups || [];
      counts = s.counts || counts;
      phase = s.phase || 'connecting';
      isAdmin = !!s.isAdmin;
      enabled = s.enabled !== false;
      lastSyncAt = s.lastSyncAt || null;
      orderDirty = true;
      render();
    } else if (m.type === 'delta') {
      for (const p of m.people || []) { if (!people.has(p.ext)) orderDirty = true; people.set(p.ext, p); }
      groups = m.groups || groups;
      counts = m.counts || counts;
      if (m.phase) phase = m.phase;
      if (m.lastSyncAt) lastSyncAt = m.lastSyncAt;
      if (m.people && m.people.length > 20) orderDirty = true;
      render(m.people);
    } else if (m.type === 'cleared') {
      people.clear();
      groups = [];
      counts = { available: 0, oncall: 0, ringing: 0, dnd: 0, nophone: 0, total: 0 };
      phase = m.phase || 'off';
      orderDirty = true;
      for (const t of tiles.values()) t.el.remove();
      tiles.clear();
      // Ask again: the reason (signed out, turned off, not an admin) decides what to show.
      send('operator:get').then((r) => { if (r && r.state) { isAdmin = !!r.state.isAdmin; enabled = r.state.enabled !== false; phase = r.state.phase; } render(); });
    }
  }

  // ------------------------------------------------------------ render ---
  const tiles = new Map();    // ext -> {el, parts..., sig}
  let orderDirty = true;
  let lastOrderSig = '';
  let frame = null;
  let pendingChanged = null;

  function render(changed) {
    if (changed && pendingChanged !== 'all') { pendingChanged = pendingChanged || new Set(); for (const p of changed) pendingChanged.add(p.ext); }
    else pendingChanged = 'all';
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const ch = pendingChanged;
      pendingChanged = null;
      renderAll(ch);
    });
  }

  /** Which big surface shows: a state card (sign in, turned off, no access, PIN) or the live layout. */
  function surface() {
    if (extensionGone) return 'gone';
    if (conn && conn.state === 'error' && conn.reason === 'auth') return 'auth';
    if (conn && conn.state === 'off' && conn.reason === 'no_credentials') return 'off';
    if (!gotSnapshot) return 'starting';
    if (phase === 'off') return 'off';
    if (phase === 'not_admin') return 'not_admin';
    if (phase === 'disabled') return 'disabled';
    return 'live';
  }

  function renderAll(changed) {
    const s = surface();
    renderLive(s);
    const live = s === 'live';
    $('opToolbar').hidden = !live;
    $('opLayout').hidden = !live;
    $('opStateCard').hidden = live || s === 'starting';
    document.body.dataset.surface = s;
    if (!live) {
      // A notice left over from 'lost' would contradict the state card (PIN rejected, signed out, ...).
      const n = $('opNotice');
      n.hidden = true; n.dataset.sig = ''; n.innerHTML = '';
      document.body.classList.remove('is-stale');
      renderStateCard(s);
      return;
    }
    renderFilters();
    renderNotice();
    renderMyCall();
    renderTiles(changed);
    renderRinging();
    renderGroups();
    renderPark();
    tick();
  }

  function renderLive(s) {
    const el = $('opLive');
    let cls = 'is-wait';
    let text = 'Connecting…';
    if (s === 'auth') { cls = 'is-bad'; text = 'PIN not accepted'; }
    else if (s === 'off') { cls = 'is-off'; text = 'Signed out'; }
    else if (s === 'disabled') { cls = 'is-off'; text = 'Off'; }
    else if (s === 'gone') { cls = 'is-off'; text = 'Reload needed'; }
    else if (s === 'live') {
      if (phase === 'live') { cls = 'is-live'; text = 'Live'; }
      else if (phase === 'lost') { cls = 'is-warn'; text = 'Reconnecting…'; }
      else if (phase === 'loading') { cls = 'is-wait'; text = 'Loading the team…'; }
    }
    el.hidden = s === 'not_admin'; // nothing to report: "Off" would read as if they turned it off
    if (el.dataset.cls !== cls || el.dataset.text !== text) {
      el.className = `op-live ${cls}`;
      el.querySelector('.op-live-text').textContent = text;
      el.dataset.cls = cls;
      el.dataset.text = text;
    }
    const sub = $('opSub');
    const total = counts.total || people.size;
    const subText = s === 'live' && total ? `${total} ${total === 1 ? 'person' : 'people'}` : 'Vaspian One\u00a0Click';
    if (sub.textContent !== subText) sub.textContent = subText;
  }

  function renderStateCard(s) {
    const card = $('opStateCard');
    let html = '';
    if (s === 'not_admin') {
      html = `<div class="op-state-icon">${icon('users', 28)}</div>
        <h2>Team view is for receptionists and supervisors</h2>
        <p>It shows everyone’s live status, which needs an extension with administrator access to your phone system. Yours doesn’t have it, and that’s normal for most people.</p>
        <p class="op-muted">You can still call and transfer to anyone from the Team tab in One\u00a0Click. If you answer calls for the whole office, ask your Vaspian administrator about access.</p>`;
    } else if (s === 'disabled') {
      html = `<div class="op-state-icon">${icon('power', 28)}</div>
        <h2>Team view is turned off</h2>
        <p>Turn it on to see who’s available, ringing or on a call, live.</p>
        <button type="button" class="op-btn op-btn-primary" data-act="enable">Turn on team view</button>`;
    } else if (s === 'off') {
      html = `<div class="op-state-icon">${icon('lock', 28)}</div>
        <h2>Sign in to One\u00a0Click</h2>
        <p>Click the One\u00a0Click button in your browser’s toolbar, sign in with your extension and PIN, then come back to this tab.</p>`;
    } else if (s === 'gone') {
      html = `<div class="op-state-icon">${icon('power', 28)}</div>
        <h2>One\u00a0Click was updated</h2>
        <p>Reload this tab to keep seeing your team.</p>
        <button type="button" class="op-btn op-btn-primary" data-act="reload">Reload</button>`;
    } else if (s === 'auth') {
      html = `<div class="op-state-icon is-bad">${icon('key', 28)}</div>
        <h2>Your PIN wasn’t accepted</h2>
        <p>Open One\u00a0Click from the toolbar and update your PIN in Settings. This page comes back on its own.</p>`;
    }
    if (card.dataset.sig !== s) { card.innerHTML = html; card.dataset.sig = s; }
  }

  function renderNotice() {
    const el = $('opNotice');
    let html = '';
    if (phase === 'lost') html = `${icon('wifiOff', 16)}<span>Connection lost. Reconnecting… The status below is from <span data-since-ago="${esc(lastSyncAt || '')}">a moment</span> ago.</span>`;
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; el.hidden = !html; }
    document.body.classList.toggle('is-stale', phase === 'lost');
  }

  function renderFilters() {
    const el = $('opFilters');
    const favCount = favorites.filter((x) => people.has(x)).length;
    const n = { all: counts.total || people.size, available: counts.available, oncall: counts.oncall, ringing: counts.ringing, dnd: counts.dnd, nophone: counts.nophone, favorites: favCount };
    const loading = isLoading();
    if (!el.dataset.built) {
      el.innerHTML = FILTERS.map((f) => `<button type="button" class="op-chip" data-filter="${f.key}" aria-pressed="false">
        ${f.dot ? `<span class="op-dot op-dot--${f.dot}" aria-hidden="true"></span>` : ''}${f.star ? `<span class="op-chip-star">${icon('star', 13)}</span>` : ''}<span class="op-chip-label">${esc(f.label)}</span><span class="op-chip-n" data-n="${f.key}">0</span></button>`).join('');
      el.dataset.built = '1';
    }
    el.querySelectorAll('.op-chip').forEach((b) => {
      const on = b.dataset.filter === filter;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const v = loading ? '–' : String(n[b.dataset.filter] || 0);
      const c = b.querySelector('.op-chip-n');
      if (c.textContent !== v) c.textContent = v;
      b.classList.toggle('is-alert', !loading && b.dataset.filter === 'ringing' && n.ringing > 0);
      b.setAttribute('aria-label', loading ? `${b.querySelector('.op-chip-label').textContent}: loading` : `${b.querySelector('.op-chip-label').textContent}: ${v}`);
    });
    document.querySelectorAll('.op-density-btn').forEach((b) => b.setAttribute('aria-pressed', b.dataset.density === density ? 'true' : 'false'));
  }

  /** First load still running: counts and park slots aren't real yet. */
  const isLoading = () => !people.size && (phase === 'loading' || phase === 'connecting');

  // ---------------------------------------------------------- my call ---
  function myActiveCall() {
    const live = myCalls.filter((c) => !c.consultFor && ['connected', 'held', 'ringing', 'dialing', 'ringback'].includes(c.state));
    return live.find((c) => c.state === 'connected') || live.find((c) => c.state === 'held') || live[0] || null;
  }
  function transferTargetPossible() {
    const c = myActiveCall();
    return !!c && (c.state === 'connected' || c.state === 'held') && !(st && st.transfer);
  }
  /** An attended transfer is in progress (or starting): nothing may place another call. */
  const xferBusy = () => !!(starting || (st && (st.transfer || (st.pending && st.pending.transfer))));
  /**
   * Why Call / Transfer / Enter must not act right now ('' = free). During a transfer the
   * consult target is already ringing; while my own call rings or is still connecting a
   * new call would go out over it.
   */
  function actionBlocked() {
    if (xferBusy()) return 'Finish or cancel the transfer first.';
    const c = myActiveCall();
    if (c && c.state === 'ringing') return 'Answer or decline your incoming call first.';
    if (c && (c.state === 'dialing' || c.state === 'ringback')) return 'Wait for your call to connect, or end it first.';
    return '';
  }
  const partyKey = (x) => { const d = String(x || '').replace(/\D/g, ''); return d.length > 10 ? d.slice(-10) : d; };
  function myCallKey() {
    const c = myActiveCall();
    return c && c.remote ? partyKey(c.remote.ext || c.remote.number || c.remote.raw) : '';
  }

  /**
   * The one line that describes a transfer, worded like the call card's transfer bar:
   * "Transferring to Keiko Kim · Calling… / Ringing… / Connected · talk, then complete".
   * Starting (before presence.js reports it) reads "Calling…" from the name we asked for.
   */
  function transferLine(t) {
    const name = t ? (t.name || t.to) : (starting && starting.name) || '';
    if (t && t.phase === 'completing') return `Transferring to <strong>${esc(name)}</strong>…`;
    const consult = myCalls.find((x) => x.consultFor && x.state !== 'ended');
    const state = !t || !consult ? 'Calling…' : consult.state === 'connected' ? 'Connected · talk, then complete' : 'Ringing…';
    return `Transferring to <strong>${esc(name)}</strong> · ${esc(state)}`;
  }

  function renderMyCall() {
    const el = $('opMyCall');
    const c = myActiveCall();
    const t = st && st.transfer;
    if (t) starting = null;
    const xfer = t || starting;
    let html = '';
    if (c) {
      const who = nice(c.name) || (c.remote ? (c.remote.isInternal ? (people.get(c.remote.ext) || {}).name || `Ext ${c.remote.ext}` : formatNumber(c.remote.number || c.remote.raw)) : 'Unknown caller');
      const label = { connected: 'On a call with', held: 'On hold with', ringing: 'Incoming call from', dialing: 'Calling', ringback: 'Calling' }[c.state] || 'On a call with';
      const since = c.state === 'connected' ? c.answeredAt : c.state === 'held' ? (c.heldAt || c.answeredAt) : c.createdAt;
      let hint = '';
      if (xfer) hint = '';
      else if (c.state === 'connected' || c.state === 'held') hint = 'Pick anyone below to transfer this call to them.';
      else if (c.state === 'ringing') hint = 'Answer on your phone.';
      html = `<div class="op-mycall-main op-mycall--${esc(c.state)}">
          <span class="op-mycall-icon">${icon(xfer ? 'transfer' : 'phone', 18)}</span>
          <div class="op-mycall-text">
            <div class="op-mycall-title"><span class="op-mycall-label">${esc(label)}</span> <strong>${esc(who)}</strong><span class="op-timer op-mycall-timer" data-since="${esc(since || '')}"></span></div>
            ${xfer ? `<div class="op-mycall-sub">${transferLine(t)}</div>` : (hint ? `<div class="op-mycall-sub">${esc(hint)}</div>` : '')}
          </div>
          ${t ? `<div class="op-mycall-actions">
            <button type="button" class="op-btn op-btn-primary" data-act="transfer-complete" ${t.phase === 'completing' ? 'disabled' : ''}>Complete transfer</button>
            <button type="button" class="op-btn op-btn-ghost" data-act="transfer-cancel">Cancel</button></div>` : ''}
        </div>`;
    }
    if (st && st.errors && st.errors.transfer && !t) html += `<p class="op-error">${esc(st.errors.transfer)}</p>`;
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; el.hidden = !html; checkStuck(); }
    document.body.classList.toggle('is-transfer-mode', transferTargetPossible());
  }

  // ------------------------------------------------------------ tiles ---
  function matches(p) {
    if (filter === 'favorites' && !favorites.includes(p.ext)) return false;
    if (filter === 'oncall' && p.state !== 'oncall' && p.state !== 'onhold') return false;
    if (filter !== 'all' && filter !== 'favorites' && filter !== 'oncall' && p.state !== filter) return false;
    return true;
  }

  function searchScore(p, q) {
    const qq = q.trim().toLowerCase();
    if (!qq) return 1;
    const name = String(p.name || '').toLowerCase();
    const nameWords = name.split(/[\s,.'-]+/);
    let score = 0;
    const ok = qq.split(/\s+/).every((w) => {
      if (/^\d+$/.test(w)) { if (p.ext === w) { score += 5; return true; } if (p.ext.includes(w)) { score += 1; return true; } return false; }
      if (nameWords.some((nw) => nw.startsWith(w))) { score += 2; return true; }
      if (w.length >= 3 && name.includes(w)) { score += 1; return true; }
      return false;
    });
    return ok ? score : 0;
  }

  /** Visible people in display order: favourites first, then name. Search ranks by match quality. */
  function visibleList() {
    const favSet = new Set(favorites);
    const list = [...people.values()].filter(matches);
    if (query.trim()) {
      const scored = list.map((p) => ({ p, s: searchScore(p, query) })).filter((x) => x.s > 0);
      scored.sort((a, b) => b.s - a.s || (favSet.has(b.p.ext) - favSet.has(a.p.ext)) || a.p.name.localeCompare(b.p.name));
      return scored.map((x) => x.p);
    }
    list.sort((a, b) => (favSet.has(b.ext) - favSet.has(a.ext)) || a.name.localeCompare(b.name) || a.ext.localeCompare(b.ext));
    return list;
  }

  function buildTile(p) {
    const el = document.createElement('article');
    el.className = 'op-tile';
    el.setAttribute('role', 'listitem');
    el.dataset.ext = p.ext;
    el.innerHTML = `
      <div class="op-av" aria-hidden="true"><span class="op-av-text"></span><span class="op-av-dot"></span></div>
      <div class="op-id"><div class="op-name"></div><div class="op-meta"><span class="op-ext"></span><span class="op-badges"></span></div></div>
      <div class="op-status"><span class="op-state-text"></span><span class="op-timer"></span></div>
      <div class="op-foot"><div class="op-detail"></div></div>
      <div class="op-actions">
        <button type="button" class="op-star" data-act="fav" aria-pressed="false" tabindex="-1">${icon('star', 16)}</button>
        <button type="button" class="op-action" data-act="primary"><span class="op-action-icon"></span><span class="op-action-label"></span></button>
      </div>`;
    const t = {
      el,
      av: el.querySelector('.op-av'), avText: el.querySelector('.op-av-text'),
      name: el.querySelector('.op-name'), ext: el.querySelector('.op-ext'),
      stateText: el.querySelector('.op-state-text'), timer: el.querySelector('.op-timer'),
      detail: el.querySelector('.op-detail'), badges: el.querySelector('.op-badges'),
      star: el.querySelector('.op-star'), action: el.querySelector('.op-action'),
      actionIcon: el.querySelector('.op-action-icon'), actionLabel: el.querySelector('.op-action-label'),
      last: {}
    };
    tiles.set(p.ext, t);
    return t;
  }

  const setText = (node, v) => { if (node.textContent !== v) node.textContent = v; };
  const setAttr = (node, k, v) => { if (node.getAttribute(k) !== v) node.setAttribute(k, v); };

  function detailFor(p) {
    const c = p.call;
    if (c) {
      const other = c.otherName ? nice(c.otherName) : (c.otherNumber ? formatNumber(c.otherNumber) : (c.otherExt ? `Ext ${c.otherExt}` : ''));
      const num = c.otherName && c.otherNumber ? formatNumber(c.otherNumber) : '';
      if (!other) return { text: p.state === 'ringing' ? 'Incoming call' : '', title: '' };
      if (c.phase === 'ringing') return { text: `from ${other}`, title: num ? `${other}, ${num}` : other };
      if (c.phase === 'dialing') return { text: `calling ${other}`, title: num ? `${other}, ${num}` : other };
      return { text: `with ${other}`, title: num ? `${other}, ${num}` : other };
    }
    return { text: '', title: '' };
  }

  function updateTile(t, p, ctx) {
    const last = t.last;
    if (last.name !== p.name) {
      setText(t.name, p.name);
      t.name.title = p.name;
      setText(t.avText, initials(p.name));
      setText(t.ext, `Ext ${p.ext}`);
      last.name = p.name;
    }
    if (last.state !== p.state) { t.el.dataset.state = p.state; last.state = p.state; }
    setText(t.stateText, STATE_TEXT[p.state] || 'Available');
    const since = p.call && (p.state === 'oncall' || p.state === 'onhold' || p.state === 'ringing') ? (p.state === 'oncall' && p.call.phase !== 'connected' ? p.since || p.call.startedAt : p.call.startedAt) : p.since;
    const showTimer = !!since && TIMED.has(p.state); // never for Do not disturb, available or no phone
    const sinceStr = showTimer ? String(since) : '';
    if (t.timer.dataset.since !== sinceStr) { t.timer.dataset.since = sinceStr; t.timer.textContent = showTimer ? elapsed(since) : ''; }
    const d = detailFor(p);
    setText(t.detail, d.text);
    t.detail.title = d.title;
    // Badges beside the extension (never next to the detail): Do not disturb (when the state shows something else), queues.
    const badges = [];
    if (p.dnd && p.state !== 'dnd') badges.push(`<span class="op-badge op-badge--dnd" title="Do not disturb is on" aria-label="Do not disturb is on">${icon('moon', 11)}</span>`);
    if (p.inQueue) badges.push(`<span class="op-badge op-badge--queue" title="Signed in to take queue calls">${icon('headset', 11)}<span class="op-badge-text">Queues</span></span>`);
    const bh = badges.join('');
    if (last.badges !== bh) { t.badges.innerHTML = bh; last.badges = bh; }
    // Favourite.
    const fav = favorites.includes(p.ext);
    if (last.fav !== fav) {
      t.star.classList.toggle('is-on', fav);
      setAttr(t.star, 'aria-pressed', fav ? 'true' : 'false');
      setAttr(t.star, 'aria-label', `${fav ? 'Remove' : 'Add'} ${p.name} ${fav ? 'from' : 'to'} favorites`);
      t.star.title = fav ? 'Remove from favorites' : 'Add to favorites';
      t.el.classList.toggle('is-fav', fav);
      last.fav = fav;
    }
    // Primary action: Transfer while I'm on a call, Call otherwise. Never a control over their call.
    const isMyParty = ctx.myKey && partyKey(p.ext) === ctx.myKey;
    let mode = ctx.transfer || ctx.busy ? 'transfer' : 'call';
    if (isMyParty && (ctx.transfer || ctx.busy)) mode = 'mine';
    const disabled = mode === 'mine' || !!ctx.blocked; // one call / transfer at a time
    // Only an available coworker can take a transfer right away: the others get a quiet button and a hint.
    // A call to someone on Do not disturb or without a phone goes to voicemail: a quiet Call says so.
    const quiet = (mode === 'transfer' && p.state !== 'available') || (mode === 'call' && (p.state === 'dnd' || p.state === 'nophone'));
    const actionSig = `${mode}|${disabled}|${ctx.blocked}|${p.name}|${p.state}`;
    if (last.action !== actionSig) {
      t.action.className = `op-action op-action--${mode}${quiet ? ' is-quiet' : ''}`;
      t.actionIcon.innerHTML = mode === 'transfer' ? icon('transfer', 15) : icon('phone', 15);
      setText(t.actionLabel, mode === 'transfer' ? 'Transfer' : mode === 'mine' ? 'On your call' : 'Call');
      t.action.disabled = disabled;
      const note = mode === 'mine' ? '' : TRANSFER_NOTE[p.state] || '';
      const base = mode === 'transfer' ? `Transfer your call to ${p.name}` : mode === 'mine' ? `${p.name} is on your call` : `Call ${p.name}`;
      setAttr(t.action, 'aria-label', note ? `${base}. ${note}` : base);
      t.action.title = mode === 'mine' ? 'You’re already talking to them' : ctx.blocked ? ctx.blocked : note ? `${base}. ${note}` : base;
      last.action = actionSig;
    }
    const label = `${p.name}, Ext ${p.ext}, ${STATE_TEXT[p.state] || ''}${d.text ? `, ${d.text}` : ''}`;
    setAttr(t.el, 'aria-label', label);
  }

  function renderTiles(changed) {
    const grid = $('opGrid');
    grid.classList.toggle('is-list', density === 'list');
    grid.classList.toggle('is-cards', density !== 'list');
    const list = visibleList();
    const blocked = actionBlocked();
    const ctx = { transfer: transferTargetPossible(), myKey: myCallKey(), busy: xferBusy(), blocked };
    const ctxSig = `${ctx.transfer}|${ctx.myKey}|${ctx.busy}|${blocked}|${favorites.join(',')}`;
    const all = changed === 'all' || !changed || ctxSig !== renderTiles.ctxSig;
    renderTiles.ctxSig = ctxSig;
    const orderSig = list.map((p) => p.ext).join(',');
    for (const p of list) {
      const t = tiles.get(p.ext) || buildTile(p);
      if (all || changed.has(p.ext) || !t.el.isConnected) updateTile(t, p, ctx);
    }
    if (orderSig !== lastOrderSig || orderDirty) {
      // Re-append in order; elements that are already in place are not moved.
      const visible = new Set(list.map((p) => p.ext));
      for (const [ext, t] of tiles) if (!visible.has(ext) && t.el.isConnected) t.el.remove();
      let prev = null;
      for (const p of list) {
        const el = tiles.get(p.ext).el;
        const want = prev ? prev.nextSibling : grid.firstChild;
        if (want !== el) grid.insertBefore(el, want);
        prev = el;
      }
      lastOrderSig = orderSig;
      orderDirty = false;
    }
    // Empty / loading.
    const empty = $('opEmpty');
    let eh = '';
    if (!people.size && (phase === 'loading' || phase === 'connecting')) {
      grid.classList.add('is-loading');
      if (!grid.querySelector('.op-skel')) grid.innerHTML = Array.from({ length: 20 }, () => '<div class="op-tile op-skel" aria-hidden="true"><div class="op-av"></div><div class="op-id"><div class="op-skel-line"></div><div class="op-skel-line is-short"></div></div></div>').join('');
      eh = '';
    } else {
      grid.classList.remove('is-loading');
      grid.querySelectorAll('.op-skel').forEach((x) => x.remove());
      if (!people.size) eh = `<div class="op-empty-icon">${icon('users', 26)}</div><p>No one to show yet.</p>`;
      else if (!list.length) {
        const q = query.trim();
        const digits = q.replace(/[\s()+.-]/g, '');
        if (q && /^\d{3,}$/.test(digits)) eh = `<div class="op-empty-icon">${icon('search', 26)}</div><p>No one matches “${esc(q)}”.</p><p class="op-muted">${blocked ? esc(blocked) : `Press Enter to ${transferTargetPossible() ? 'transfer your call to' : 'call'} ${esc(digits.length <= 6 ? `Ext ${digits}` : formatNumber(digits))}.`}</p>`;
        else if (q) eh = `<div class="op-empty-icon">${icon('search', 26)}</div><p>No one matches “${esc(q)}”.</p>${filter !== 'all' ? '<p class="op-muted">Searching within the current filter. <button type="button" class="op-link" data-act="show-all">Show everyone</button></p>' : ''}`;
        else if (filter === 'favorites') eh = `<div class="op-empty-icon">${icon('star', 26)}</div><p>No favorites yet.</p><p class="op-muted">Star the people you transfer to most and they’ll stay at the top.</p>`;
        else eh = `<div class="op-empty-icon">${icon('users', 26)}</div><p>No one is ${esc((FILTERS.find((f) => f.key === filter) || {}).label || '').toLowerCase()} right now.</p><p class="op-muted"><button type="button" class="op-link" data-act="show-all">Show everyone</button></p>`;
      }
    }
    if (empty.dataset.sig !== eh) { empty.innerHTML = eh; empty.dataset.sig = eh; empty.hidden = !eh; }
    // Search: the top match is what Enter acts on.
    const top = query.trim() && list.length && !blocked ? list[0].ext : '';
    if (renderTiles.top !== top) {
      const prevTop = renderTiles.top && tiles.get(renderTiles.top);
      if (prevTop) prevTop.el.classList.remove('is-top');
      if (top) tiles.get(top).el.classList.add('is-top');
      renderTiles.top = top;
    }
    const hint = $('opSearchHint');
    let ht = '';
    if (query.trim() && list.length && !blocked) ht = `Enter to ${transferTargetPossible() ? 'transfer to' : 'call'} ${list[0].name.split(' ')[0]}`;
    setText(hint, ht);
    $('opSearchClear').hidden = !query;
  }

  // ---------------------------------------------------------- ringing ---
  /** When a person's ringing started, as the tile shows it (snapshot states have no time). */
  const ringSince = (p) => (p.call && p.call.startedAt) || p.since || null;
  // ext -> {at, seq}: fixed when someone starts ringing, so the list never reshuffles while they ring.
  const ringSeen = new Map();
  let ringSeq = 0;

  /** Who is ringing right now, longest first (then first seen): a read-only list in the side column (pick-up is not offered). */
  function renderRinging() {
    const el = $('opRinging');
    const now = [...people.values()].filter((p) => p.state === 'ringing');
    const exts = new Set(now.map((p) => p.ext));
    for (const ext of ringSeen.keys()) if (!exts.has(ext)) ringSeen.delete(ext);
    for (const p of now) if (!ringSeen.has(p.ext)) ringSeen.set(p.ext, { at: toMs(ringSince(p)) || Infinity, seq: ++ringSeq });
    const key = (p) => ringSeen.get(p.ext);
    const ringing = now.sort((a, b) => (key(a).at - key(b).at) || (key(a).seq - key(b).seq));
    const MAX = 5;
    let html;
    if (isLoading()) html = '<p class="op-muted op-pad">Loading…</p>';
    else if (!ringing.length) html = '<p class="op-muted op-pad">No one is ringing right now.</p>';
    else {
      html = `<ul class="op-ringing">${ringing.slice(0, MAX).map((p) => {
        const d = detailFor(p);
        return `<li><button type="button" class="op-ring" data-act="goto" data-ext="${esc(p.ext)}" title="${esc(`Show ${p.name}${d.title ? `, ${d.title}` : ''}`)}">
          <span class="op-ring-dot" aria-hidden="true"></span>
          <span class="op-ring-text"><span class="op-ring-name">${esc(p.name)}</span>${d.text ? `<span class="op-ring-sub">${esc(d.text)}</span>` : ''}</span>
          <span class="op-timer" data-since="${esc(ringSince(p) || '')}"></span>
        </button></li>`;
      }).join('')}</ul>${ringing.length > MAX ? `<button type="button" class="op-link op-ring-more" data-act="show-ringing">Show all ${ringing.length} ringing</button>` : ''}`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; tick(); }
  }

  /** Scroll a person's tile into view and flash it (switching to Everyone if a filter or search hides it). */
  function gotoTile(ext) {
    const show = () => {
      const t = tiles.get(ext);
      if (!t || !t.el.isConnected) return;
      t.el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      t.el.classList.remove('is-flash');
      void t.el.offsetWidth; // restart the animation
      t.el.classList.add('is-flash');
      setTimeout(() => t.el.classList.remove('is-flash'), 1600);
      if (!t.action.disabled) t.action.focus({ preventScroll: true });
    };
    const t = tiles.get(ext);
    if (t && t.el.isConnected) { show(); return; }
    filter = 'all'; query = ''; search.value = ''; savePref(); orderDirty = true;
    renderAll('all');
    show();
  }

  // ----------------------------------------------------------- groups ---
  function renderGroups() {
    const el = $('opGroups');
    const mine = new Map(((st && st.groups) || []).map((g) => [String(g.extension), g]));
    const pending = (st && st.pending) || {};
    let html;
    if (!groups.length && (phase === 'loading' || phase === 'connecting')) html = '<p class="op-muted op-pad">Loading…</p>';
    else if (!groups.length) html = '<p class="op-muted op-pad">No ring groups or queues to show.</p>';
    else {
      html = `<ul class="op-groups">${groups.map((g) => {
        const own = mine.get(String(g.ext));
        const waiting = g.waiting || [];
        const longest = waiting.length ? waiting[0].since : null;
        const kind = g.kind === 'queue' ? 'Queue' : 'Ring group';
        const members = g.members ? `${g.joined} of ${g.members} taking calls` : kind;
        const callerOf = (w) => nice(w.name) || formatNumber(w.number) || 'Caller';
        const who = waiting.map(callerOf).join(', ');
        const first = waiting.length ? callerOf(waiting[0]) : '';
        return `<li class="op-group${waiting.length ? ' has-waiting' : ''}">
          <div class="op-group-head">
            <span class="op-group-icon" aria-hidden="true">${icon(g.kind === 'queue' ? 'headset' : 'group', 15)}</span>
            <div class="op-group-text"><div class="op-group-name" title="${esc(g.name)}">${esc(g.name)}</div><div class="op-group-sub">${esc(members)}</div></div>
            ${waiting.length ? `<span class="op-waiting" title="Callers waiting">${waiting.length} waiting</span>` : ''}
          </div>
          ${waiting.length ? `<div class="op-group-wait" title="Waiting: ${esc(who)}">Longest wait <span class="op-timer" data-since="${esc(longest)}"></span><span class="op-group-wait-who"> · ${esc(first)}</span></div>` : ''}
          ${own ? `<div class="op-group-mine"><span>${own.loggedIn ? 'You’re taking calls' : 'You’re not taking calls'}</span>
            <button type="button" class="op-btn op-btn-sm ${own.loggedIn ? 'op-btn-ghost' : 'op-btn-secondary'}" data-act="group" data-id="${esc(own.callGroupId)}" data-on="${own.loggedIn ? '0' : '1'}" ${pending[`group:${own.callGroupId}`] ? 'disabled' : ''}>${pending[`group:${own.callGroupId}`] ? 'Updating…' : (own.loggedIn ? 'Leave' : 'Join')}</button></div>` : ''}
        </li>`;
      }).join('')}</ul>`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
  }

  function renderPark() {
    const el = $('opPark');
    const slots = (st && st.park) || [];
    const pending = (st && st.pending) || {};
    const errors = (st && st.errors) || {};
    const retrieveOff = (st && st.disabled && st.disabled.retrieve) || (st && st.phones === 0 ? 'Retrieving needs a desk phone or softphone that’s signed in.' : '');
    const busy = slots.filter((s) => s.status === 'busy');
    // A parked call is someone waiting: the card moves to the top of the side column and stands out.
    // With nothing parked it stays a one-line card at the bottom.
    const card = $('opParkCard');
    const loading = !st || !st.parkLoaded || isLoading();
    card.classList.toggle('is-busy', !loading && busy.length > 0);
    card.classList.toggle('is-quiet', !loading && !busy.length);
    const count = $('opParkCount');
    const n = loading ? '' : String(busy.length || '');
    if (count.textContent !== n) { count.textContent = n; count.hidden = !n; }
    let html;
    if (loading) html = '<p class="op-muted op-pad">Loading…</p>';
    else if (!slots.length) html = '<p class="op-muted op-park-none">No slots set up</p>';
    else if (!busy.length) html = `<p class="op-muted op-park-none">None · ${slots.length} free</p>`;
    else {
      html = `<ul class="op-parked">${busy.map((s) => {
        const who = nice(s.parkedName) || (s.parkedNumber ? formatNumber(s.parkedNumber) : 'Parked call');
        const by = s.parkedBy ? `by ${nice(s.parkedBy)}` : `Slot ${s.number}`;
        const k = `park:${s.number}`;
        return `<li class="op-park">
          <span class="op-slot" aria-hidden="true">${esc(s.number)}</span>
          <span class="op-park-who" title="${esc(who)}">${esc(who)}</span>
          <span class="op-timer" data-since="${esc(s.since || '')}"></span>
          <span class="op-park-sub" title="${esc(`Slot ${s.number}${s.parkedBy ? `, parked by ${nice(s.parkedBy)}` : ''}`)}">${esc(by)}</span>
          <button type="button" class="op-btn op-btn-sm op-btn-primary" data-act="retrieve" data-slot="${esc(s.number)}" ${retrieveOff || pending[k] ? 'disabled' : ''}
            title="${esc(retrieveOff || `Pick up the call parked in slot ${s.number}`)}" aria-label="Retrieve the call in slot ${esc(s.number)}">${pending[k] ? 'Retrieving…' : 'Retrieve'}</button>
          ${errors[k] ? `<span class="op-error">${esc(errors[k])}</span>` : ''}
        </li>`;
      }).join('')}</ul>${retrieveOff ? `<p class="op-muted op-pad">${esc(retrieveOff)}</p>` : ''}`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; tick(); }
  }

  // ------------------------------------------------------------- tick ---
  function tick() {
    document.querySelectorAll('.op-timer[data-since]').forEach((n) => {
      const v = n.dataset.since ? elapsed(/^\d+$/.test(n.dataset.since) ? Number(n.dataset.since) : n.dataset.since) : '';
      if (n.textContent !== v) n.textContent = v;
    });
    document.querySelectorAll('[data-since-ago]').forEach((n) => {
      const t = toMs(/^\d+$/.test(n.dataset.sinceAgo) ? Number(n.dataset.sinceAgo) : n.dataset.sinceAgo);
      const m = t ? Math.max(0, Math.round((Date.now() - t) / 60000)) : 0;
      const v = m < 1 ? 'a moment' : `${m} min`;
      if (n.textContent !== v) n.textContent = v;
    });
  }
  setInterval(tick, 1000);

  // ---------------------------------------------------------- actions ---
  let flashTimer = null;
  function flash(message, kind = 'info') {
    const el = $('opFlash');
    el.textContent = message;
    el.className = `op-flash op-flash--${kind}`;
    el.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.hidden = true; }, kind === 'error' ? 6000 : 3500);
  }

  /** Start an attended transfer. The banner over the team shows its progress (no separate flash). */
  async function startTransfer(number, name) {
    $('opFlash').hidden = true;
    starting = { name };
    render();
    const r = await send('status:transfer', { number, name });
    if (!r.ok) { starting = null; render(); flash(r.message || 'Couldn’t start the transfer.', 'error'); return; }
    setTimeout(() => { if (starting) { starting = null; render(); } }, 3000); // presence.js normally reports it first
  }

  async function primary(ext) {
    const p = people.get(ext);
    if (!p) return;
    const blocked = actionBlocked();
    if (blocked) { flash(blocked, 'error'); return; }
    if (transferTargetPossible()) {
      if (myCallKey() && partyKey(ext) === myCallKey()) return;
      await startTransfer(ext, p.name);
      return;
    }
    const r = await send('status:call', { number: ext, ext, name: p.name });
    flash(r.ok ? (r.message || `Calling ${p.name}…`) : (r.message || 'Couldn’t place the call.'), r.ok ? 'info' : 'error');
  }

  async function dialDigits(digits) {
    const blocked = actionBlocked();
    if (blocked) { flash(blocked, 'error'); return; }
    if (transferTargetPossible()) {
      await startTransfer(digits, digits.length <= 6 ? `Ext ${digits}` : formatNumber(digits));
      return;
    }
    const r = await send('status:call', { number: digits, ext: digits.length <= 6 ? digits : null, name: '' });
    flash(r.ok ? (r.message || 'Calling…') : (r.message || 'Couldn’t place the call.'), r.ok ? 'info' : 'error');
  }

  async function toggleFavorite(ext) {
    const next = favorites.includes(ext) ? favorites.filter((x) => x !== ext) : [...favorites, ext].slice(-MAX_FAVS);
    favorites = next;
    orderDirty = true;
    render();
    try { await chrome.storage.sync.set({ [FAV_KEY]: next }); } catch (e) { flash('Couldn’t save favorites.', 'error'); }
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act], button[data-filter], button[data-density]');
    if (!b || b.disabled) return;
    if (b.dataset.filter) { filter = b.dataset.filter; savePref(); orderDirty = true; render(); return; }
    if (b.dataset.density) { density = b.dataset.density; savePref(); render(); return; }
    const act = b.dataset.act;
    const tile = b.closest('.op-tile');
    if (act === 'fav' && tile) return toggleFavorite(tile.dataset.ext);
    if (act === 'primary' && tile) return primary(tile.dataset.ext);
    if (act === 'reload') { location.reload(); return; }
    if (act === 'enable') { const r = await send('operator:setEnabled', { enabled: true }); if (r && r.ok) { phase = r.phase || 'connecting'; render(); } return; }
    if (act === 'goto') { gotoTile(b.dataset.ext); return; }
    if (act === 'show-ringing') { filter = 'ringing'; query = ''; search.value = ''; savePref(); orderDirty = true; render(); window.scrollTo({ top: 0 }); return; }
    if (act === 'show-all') { filter = 'all'; savePref(); orderDirty = true; render(); return; }
    if (act === 'transfer-complete') { const r = await send('status:completeTransfer'); if (!r.ok) flash(r.message || 'Couldn’t complete the transfer.', 'error'); return; }
    if (act === 'transfer-cancel') { const r = await send('status:cancelTransfer'); if (!r.ok) flash(r.message || 'Couldn’t cancel the transfer.', 'error'); return; }
    if (act === 'retrieve') { const r = await send('status:retrievePark', { number: b.dataset.slot }); flash(r.ok ? (r.message || 'Your phone will ring.') : (r.message || 'Couldn’t retrieve the call.'), r.ok ? 'info' : 'error'); return; }
    if (act === 'group') { const r = await send('status:setGroup', { callGroupId: b.dataset.id, loggedIn: b.dataset.on === '1' }); if (!r.ok) flash(r.message || 'Couldn’t update the group.', 'error'); }
  });

  const search = $('opSearch');
  search.addEventListener('input', () => { query = search.value; orderDirty = true; render(); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); search.value = ''; query = ''; orderDirty = true; render(); return; }
    if (e.key === 'ArrowDown') {
      const first = actionButtons()[0];
      if (first) { e.preventDefault(); first.focus(); }
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const list = visibleList();
      if (list.length) primary(list[0].ext);
      else {
        const digits = query.replace(/[\s()+.-]/g, '');
        if (/^\d{3,}$/.test(digits)) dialDigits(digits);
      }
    }
  });
  $('opSearchClear').addEventListener('click', () => { search.value = ''; query = ''; orderDirty = true; render(); search.focus(); });

  /** Enabled action buttons of the visible tiles, in display order. */
  function actionButtons() {
    return [...$('opGrid').querySelectorAll('.op-tile:not(.op-skel) .op-action')].filter((b) => !b.disabled);
  }
  function gridColumns() {
    const grid = $('opGrid');
    if (!grid.classList.contains('is-cards')) return 1;
    const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  }

  // Arrow keys move between people; 'f' stars the focused person. Both only while a tile's
  // button has focus, so typing a name anywhere else still goes to the search box.
  $('opGrid').addEventListener('keydown', (e) => {
    const b = e.target.closest && e.target.closest('.op-action');
    if (!b || e.ctrlKey || e.metaKey || e.altKey) return;
    const tile = b.closest('.op-tile');
    if (e.key === 'f' || e.key === 'F') { e.preventDefault(); toggleFavorite(tile.dataset.ext); return; }
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: gridColumns(), ArrowUp: -gridColumns() }[e.key];
    if (!step) return;
    e.preventDefault();
    const all = [...$('opGrid').querySelectorAll('.op-tile:not(.op-skel)')];
    let i = all.indexOf(tile) + step;
    while (i >= 0 && i < all.length) {
      const next = all[i].querySelector('.op-action');
      if (next && !next.disabled) { next.focus(); next.scrollIntoView({ block: 'nearest' }); return; }
      i += step > 0 ? 1 : -1; // skip disabled (e.g. the person already on my call)
    }
    if (step < 0 && all.indexOf(tile) < Math.abs(step)) { search.focus(); search.select(); }
  });

  // Type anywhere to search.
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (surface() !== 'live') return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.key === '/' ) { e.preventDefault(); search.focus(); search.select(); return; }
    if (e.key.length === 1 && /\S/.test(e.key)) search.focus(); // the key lands in the search box
  });

  // ------------------------------------------------------------- data ---
  async function load() {
    const [local, session, sync] = await Promise.all([
      chrome.storage.local.get(['statusState', 'apiStatus']),
      chrome.storage.session.get(['callcardCalls']),
      chrome.storage.sync.get([FAV_KEY])
    ]);
    st = local.statusState || null;
    conn = local.apiStatus || null;
    myCalls = (session.callcardCalls && session.callcardCalls.calls) || [];
    favorites = sync[FAV_KEY] || [];
    render();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    let touched = false;
    if (area === 'local') {
      if (changes.statusState) { st = changes.statusState.newValue || null; touched = true; }
      if (changes.apiStatus) { conn = changes.apiStatus.newValue || null; touched = true; }
    } else if (area === 'session' && changes.callcardCalls) {
      myCalls = (changes.callcardCalls.newValue && changes.callcardCalls.newValue.calls) || [];
      touched = true;
    } else if (area === 'sync' && changes[FAV_KEY]) {
      favorites = changes[FAV_KEY].newValue || [];
      orderDirty = true;
      touched = true;
    }
    if (touched) render();
  });

  // The docked call sticks just under the header and toolbar, whatever their height.
  function measureTop() {
    const h = document.querySelector('.op-header');
    const t = $('opToolbar');
    const top = (h ? h.offsetHeight : 0) + (t && !t.hidden ? t.offsetHeight : 0);
    document.documentElement.style.setProperty('--op-top', `${top}px`);
  }
  if (window.ResizeObserver) new ResizeObserver(measureTop).observe($('opToolbar'));
  window.addEventListener('resize', measureTop);
  // The fade under the docked call shows only while it is actually stuck (not over the flash at rest).
  let stuckFrame = null;
  function checkStuck() {
    stuckFrame = null;
    const dock = $('opMyCall');
    if (dock.hidden) return;
    const top = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--op-top')) || 0;
    dock.classList.toggle('is-stuck', window.scrollY > 0 && dock.getBoundingClientRect().top <= top + 0.5);
  }
  window.addEventListener('scroll', () => { if (!stuckFrame) stuckFrame = requestAnimationFrame(checkStuck); }, { passive: true });

  load().catch(() => {});
  connectPort();
  send('status:refresh').catch(() => {});

  window.OneClickOperatorConsole = { version: 1, _state: () => ({ phase, people: people.size, filter, density, query, tiles: tiles.size }) };
})();
