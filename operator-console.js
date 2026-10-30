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

  const AVATAR_COLORS = ['#2954A4', '#E66825', '#0f766e', '#7c3aed', '#475569', '#be123c', '#b45309', '#1d4ed8'];
  function avatarColor(key) {
    let h = 0;
    for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return AVATAR_COLORS[h % AVATAR_COLORS.length];
  }
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
          if (chrome.runtime.lastError) resolve({ ok: false, message: 'One Click is restarting. Try again in a moment.' });
          else resolve(r || { ok: false, message: 'No response.' });
        });
      } catch (e) { resolve({ ok: false, message: e.message }); }
    });
  }

  // -------------------------------------------------------------- state ---
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

  try {
    const pref = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    if (pref.density === 'list' || pref.density === 'cards') density = pref.density;
    if (FILTERS.some((f) => f.key === pref.filter)) filter = pref.filter;
  } catch (e) { /* per-viewer convenience only */ }
  function savePref() { try { localStorage.setItem(PREF_KEY, JSON.stringify({ density, filter })); } catch (e) { /* ignore */ } }

  // -------------------------------------------------------------- port ---
  let port = null;
  let portRetry = 0;
  function connectPort() {
    try {
      port = chrome.runtime.connect({ name: 'operator' });
    } catch (e) { setTimeout(connectPort, 1500); return; }
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      port = null;
      // The service worker restarted (or the extension reloaded): reconnect with a short backoff.
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
    if (!live) { renderStateCard(s); return; }
    renderFilters();
    renderNotice();
    renderMyCall();
    renderTiles(changed);
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
    else if (s === 'not_admin' || s === 'disabled') { cls = 'is-off'; text = 'Off'; }
    else if (s === 'live') {
      if (phase === 'live') { cls = 'is-live'; text = 'Live'; }
      else if (phase === 'lost') { cls = 'is-warn'; text = 'Reconnecting…'; }
      else if (phase === 'loading') { cls = 'is-wait'; text = 'Loading the team…'; }
    }
    if (el.dataset.cls !== cls || el.dataset.text !== text) {
      el.className = `op-live ${cls}`;
      el.querySelector('.op-live-text').textContent = text;
      el.dataset.cls = cls;
      el.dataset.text = text;
    }
    const sub = $('opSub');
    const total = counts.total || people.size;
    const subText = s === 'live' && total ? `${total} ${total === 1 ? 'person' : 'people'}` : 'Vaspian One Click';
    if (sub.textContent !== subText) sub.textContent = subText;
  }

  function renderStateCard(s) {
    const card = $('opStateCard');
    let html = '';
    if (s === 'not_admin') {
      html = `<div class="op-state-icon">${icon('users', 28)}</div>
        <h2>Team view is for receptionists and supervisors</h2>
        <p>It shows everyone’s live status, which needs an extension with administrator access to your phone system. Yours doesn’t have it, and that’s normal for most people.</p>
        <p class="op-muted">You can still call and transfer to anyone from the Call Center tab in One Click. If you answer calls for the whole office, ask your Vaspian administrator about access.</p>`;
    } else if (s === 'disabled') {
      html = `<div class="op-state-icon">${icon('power', 28)}</div>
        <h2>Team view is turned off</h2>
        <p>Turn it on to see who’s available, ringing or on a call, live.</p>
        <button type="button" class="op-btn op-btn-primary" data-act="enable">Turn on team view</button>`;
    } else if (s === 'off') {
      html = `<div class="op-state-icon">${icon('lock', 28)}</div>
        <h2>Sign in to One Click</h2>
        <p>Click the One Click button in your browser’s toolbar, sign in with your extension and PIN, then come back to this tab.</p>`;
    } else if (s === 'auth') {
      html = `<div class="op-state-icon is-bad">${icon('key', 28)}</div>
        <h2>Your PIN wasn’t accepted</h2>
        <p>Open One Click from the toolbar and update your PIN in Settings. This page comes back on its own.</p>`;
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
    if (!el.dataset.built) {
      el.innerHTML = FILTERS.map((f) => `<button type="button" class="op-chip" data-filter="${f.key}" aria-pressed="false">
        ${f.dot ? `<span class="op-dot op-dot--${f.dot}" aria-hidden="true"></span>` : ''}${f.star ? `<span class="op-chip-star">${icon('star', 13)}</span>` : ''}<span class="op-chip-label">${esc(f.label)}</span><span class="op-chip-n" data-n="${f.key}">0</span></button>`).join('');
      el.dataset.built = '1';
    }
    el.querySelectorAll('.op-chip').forEach((b) => {
      const on = b.dataset.filter === filter;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      const v = String(n[b.dataset.filter] || 0);
      const c = b.querySelector('.op-chip-n');
      if (c.textContent !== v) c.textContent = v;
      b.classList.toggle('is-alert', b.dataset.filter === 'ringing' && n.ringing > 0);
      b.setAttribute('aria-label', `${b.querySelector('.op-chip-label').textContent}: ${v}`);
    });
    document.querySelectorAll('.op-density-btn').forEach((b) => b.setAttribute('aria-pressed', b.dataset.density === density ? 'true' : 'false'));
  }

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
  const xferBusy = () => !!(st && (st.transfer || (st.pending && st.pending.transfer)));
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

  function renderMyCall() {
    const el = $('opMyCall');
    const c = myActiveCall();
    const t = st && st.transfer;
    let html = '';
    if (c) {
      const who = nice(c.name) || (c.remote ? (c.remote.isInternal ? (people.get(c.remote.ext) || {}).name || `Ext ${c.remote.ext}` : formatNumber(c.remote.number || c.remote.raw)) : 'Unknown caller');
      const label = { connected: 'On a call with', held: 'On hold with', ringing: 'Incoming call from', dialing: 'Calling', ringback: 'Calling' }[c.state] || 'On a call with';
      const since = c.state === 'connected' ? c.answeredAt : c.state === 'held' ? (c.heldAt || c.answeredAt) : c.createdAt;
      let hint = '';
      if (t) hint = '';
      else if (c.state === 'connected' || c.state === 'held') hint = 'Choose Transfer on anyone below to hand this call over.';
      else if (c.state === 'ringing') hint = 'Answer on your phone.';
      html = `<div class="op-mycall-main op-mycall--${esc(c.state)}">
          <span class="op-mycall-icon">${icon(t ? 'transfer' : 'phone', 18)}</span>
          <div class="op-mycall-text">
            <div class="op-mycall-title"><span class="op-mycall-label">${esc(label)}</span> <strong>${esc(who)}</strong><span class="op-timer op-mycall-timer" data-since="${esc(since || '')}"></span></div>
            ${t ? `<div class="op-mycall-sub">${t.phase === 'completing' ? 'Transferring to' : 'Talking to'} <strong>${esc(t.name || t.to)}</strong>${t.phase === 'completing' ? '…' : '. Complete the transfer when they’re ready.'}</div>` : (hint ? `<div class="op-mycall-sub">${esc(hint)}</div>` : '')}
          </div>
          ${t ? `<div class="op-mycall-actions">
            <button type="button" class="op-btn op-btn-primary" data-act="transfer-complete" ${t.phase === 'completing' ? 'disabled' : ''}>Complete transfer</button>
            <button type="button" class="op-btn op-btn-ghost" data-act="transfer-cancel">Cancel</button></div>` : ''}
        </div>`;
    }
    if (st && st.errors && st.errors.transfer && !t) html += `<p class="op-error">${esc(st.errors.transfer)}</p>`;
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; el.hidden = !html; }
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
      <div class="op-id"><div class="op-name"></div><div class="op-ext"></div></div>
      <div class="op-status"><span class="op-state-text"></span><span class="op-timer"></span></div>
      <div class="op-detail"></div>
      <div class="op-badges"></div>
      <div class="op-actions">
        <button type="button" class="op-star" data-act="fav" aria-pressed="false">${icon('star', 16)}</button>
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
      t.av.style.setProperty('--op-av', avatarColor(p.name));
      setText(t.ext, `Ext ${p.ext}`);
      last.name = p.name;
    }
    if (last.state !== p.state) { t.el.dataset.state = p.state; last.state = p.state; }
    setText(t.stateText, STATE_TEXT[p.state] || 'Available');
    const since = p.call && (p.state === 'oncall' || p.state === 'onhold' || p.state === 'ringing') ? (p.state === 'oncall' && p.call.phase !== 'connected' ? p.since || p.call.startedAt : p.call.startedAt) : p.since;
    const showTimer = !!since && p.state !== 'available' && p.state !== 'nophone';
    const sinceStr = showTimer ? String(since) : '';
    if (t.timer.dataset.since !== sinceStr) { t.timer.dataset.since = sinceStr; t.timer.textContent = showTimer ? elapsed(since) : ''; }
    const d = detailFor(p);
    setText(t.detail, d.text);
    t.detail.title = d.title;
    // Badges: DND (when the state shows something else), queue.
    const badges = [];
    if (p.dnd && p.state !== 'dnd') badges.push('<span class="op-badge op-badge--dnd">DND</span>');
    if (p.inQueue) badges.push('<span class="op-badge op-badge--queue" title="Signed in to take queue calls">In queue</span>');
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
    const actionSig = `${mode}|${disabled}|${ctx.blocked}|${p.name}`;
    if (last.action !== actionSig) {
      t.action.className = `op-action op-action--${mode}`;
      t.actionIcon.innerHTML = mode === 'transfer' ? icon('transfer', 15) : icon('phone', 15);
      setText(t.actionLabel, mode === 'transfer' ? 'Transfer' : mode === 'mine' ? 'On your call' : 'Call');
      t.action.disabled = disabled;
      setAttr(t.action, 'aria-label', mode === 'transfer' ? `Transfer your call to ${p.name}` : mode === 'mine' ? `${p.name} is on your call` : `Call ${p.name}`);
      t.action.title = mode === 'mine' ? 'You’re already talking to them' : ctx.blocked ? ctx.blocked : mode === 'transfer' ? `Transfer your call to ${p.name}` : `Call ${p.name}`;
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
      if (!grid.querySelector('.op-skel')) grid.innerHTML = Array.from({ length: 12 }, () => '<div class="op-tile op-skel" aria-hidden="true"><div class="op-av"></div><div class="op-id"><div class="op-skel-line"></div><div class="op-skel-line is-short"></div></div></div>').join('');
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
    // Search hint: what Enter does.
    const hint = $('opSearchHint');
    let ht = '';
    if (query.trim() && list.length && !blocked) ht = `Enter to ${transferTargetPossible() ? 'transfer to' : 'call'} ${list[0].name.split(' ')[0]}`;
    setText(hint, ht);
    $('opSearchClear').hidden = !query;
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
        const who = waiting.slice(0, 3).map((w) => esc(nice(w.name) || formatNumber(w.number) || 'Caller')).join(', ');
        return `<li class="op-group${waiting.length ? ' has-waiting' : ''}">
          <div class="op-group-head">
            <span class="op-group-icon" aria-hidden="true">${icon(g.kind === 'queue' ? 'headset' : 'group', 15)}</span>
            <div class="op-group-text"><div class="op-group-name" title="${esc(g.name)}">${esc(g.name)}</div><div class="op-group-sub">${esc(members)}</div></div>
            ${waiting.length ? `<span class="op-waiting" title="Callers waiting">${waiting.length} waiting</span>` : ''}
          </div>
          ${waiting.length ? `<div class="op-group-wait" title="${who}">Longest wait <span class="op-timer" data-since="${esc(longest)}"></span> · ${who}${waiting.length > 3 ? ` +${waiting.length - 3}` : ''}</div>` : ''}
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
    let html;
    if (!st || !st.parkLoaded) html = '<p class="op-muted op-pad">Loading…</p>';
    else if (!slots.length) html = '<p class="op-muted op-pad">No park slots are set up.</p>';
    else if (!busy.length) html = `<p class="op-muted op-pad">No calls parked. ${slots.length} slots free.</p>`;
    else {
      html = `<ul class="op-parked">${busy.map((s) => {
        const who = nice(s.parkedName) || (s.parkedNumber ? formatNumber(s.parkedNumber) : 'Parked call');
        const k = `park:${s.number}`;
        return `<li class="op-park">
          <span class="op-slot" aria-hidden="true">${esc(s.number)}</span>
          <div class="op-park-text"><div class="op-park-who" title="${esc(who)}">${esc(who)}</div>
            <div class="op-park-sub">Slot ${esc(s.number)}${s.parkedBy ? ` · by ${esc(nice(s.parkedBy))}` : ''}${s.since ? ` · <span class="op-timer" data-since="${esc(s.since)}"></span>` : ''}</div>
            ${errors[k] ? `<div class="op-error">${esc(errors[k])}</div>` : ''}</div>
          <button type="button" class="op-btn op-btn-sm op-btn-primary" data-act="retrieve" data-slot="${esc(s.number)}" ${retrieveOff || pending[k] ? 'disabled' : ''}
            title="${esc(retrieveOff || `Pick up the call parked in slot ${s.number}`)}" aria-label="Retrieve the call in slot ${esc(s.number)}">${pending[k] ? 'Retrieving…' : 'Retrieve'}</button>
        </li>`;
      }).join('')}</ul>${retrieveOff ? `<p class="op-muted op-pad">${esc(retrieveOff)}</p>` : ''}`;
    }
    if (el.dataset.sig !== html) { el.innerHTML = html; el.dataset.sig = html; }
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

  async function primary(ext) {
    const p = people.get(ext);
    if (!p) return;
    const blocked = actionBlocked();
    if (blocked) { flash(blocked, 'error'); return; }
    if (transferTargetPossible()) {
      if (myCallKey() && partyKey(ext) === myCallKey()) return;
      flash(`Calling ${p.name} to hand over your call…`);
      const r = await send('status:transfer', { number: ext, name: p.name });
      if (!r.ok) flash(r.message || 'Couldn’t start the transfer.', 'error');
      return;
    }
    const r = await send('status:call', { number: ext, ext, name: p.name });
    flash(r.ok ? (r.message || `Calling ${p.name}…`) : (r.message || 'Couldn’t place the call.'), r.ok ? 'info' : 'error');
  }

  async function dialDigits(digits) {
    const blocked = actionBlocked();
    if (blocked) { flash(blocked, 'error'); return; }
    if (transferTargetPossible()) {
      const r = await send('status:transfer', { number: digits, name: digits.length <= 6 ? `Ext ${digits}` : formatNumber(digits) });
      if (!r.ok) flash(r.message || 'Couldn’t start the transfer.', 'error');
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
    if (act === 'enable') { const r = await send('operator:setEnabled', { enabled: true }); if (r && r.ok) { phase = r.phase || 'connecting'; render(); } return; }
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

  load().catch(() => {});
  connectPort();
  send('status:refresh').catch(() => {});

  window.OneClickOperatorConsole = { version: 1, _state: () => ({ phase, people: people.size, filter, density, query, tiles: tiles.size }) };
})();
