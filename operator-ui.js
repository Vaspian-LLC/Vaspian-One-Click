// Team view bits inside the popup and side panel (tenant admins only):
//   - Call Center: an "Open team view" bar, and a live status slot in each
//     Team row (dot, state, timer), filled in place so status-ui.js never
//     has to rebuild its list for a status change.
//   - Settings > Options: the "Team view" toggle.
// Reads session.operatorState (published by operator.js), local.apiStatus
// (isAdmin) and local.operatorEnabled. The console itself is operator.html.
// Keep everything inside this IIFE; public surface: window.OneClickUI.operator.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  const STATE_TEXT = { available: 'Available', ringing: 'Ringing', oncall: 'On a call', onhold: 'On hold', dnd: 'Do not disturb', nophone: 'No phone' };
  let opState = null;   // session.operatorState
  let isAdmin = false;  // apiStatus.isAdmin
  let enabled = true;   // local.operatorEnabled (absent = on)
  let signedIn = false;
  let byExt = new Map();
  let ccEl = null;
  let wasActive = false;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function elapsed(t) {
    if (!t) return '';
    const s = Math.max(0, Math.floor((Date.now() - Number(t)) / 1000));
    const m = Math.floor(s / 60);
    if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  }
  function send(action, payload = {}) {
    return new Promise((resolve) => {
      try { chrome.runtime.sendMessage({ action, ...payload }, (r) => resolve(chrome.runtime.lastError ? { ok: false } : (r || { ok: false }))); } catch (e) { resolve({ ok: false }); }
    });
  }

  /** True when live team data is available to show. */
  function isActive() {
    return !!(signedIn && isAdmin && enabled && opState && Array.isArray(opState.people));
  }

  /** Timers only for ringing, on a call and on hold (never Do not disturb), as in the console. */
  function sinceFor(p) {
    if (p.state !== 'ringing' && p.state !== 'oncall' && p.state !== 'onhold') return null;
    if (p.call) return p.call.phase === 'connected' || p.state !== 'oncall' ? p.call.startedAt : (p.since || p.call.startedAt);
    return p.since;
  }

  /** Fill (or refresh) the live status slots in the Team rows and the Open team view bar. */
  function decorate(root) {
    if (root) ccEl = root;
    if (!ccEl) return;
    renderBar();
    if (!isActive()) return;
    ccEl.querySelectorAll('.op-rs[data-op-ext]').forEach((slot) => {
      const p = byExt.get(slot.dataset.opExt);
      const state = p ? p.state : '';
      const since = p ? sinceFor(p) : null;
      const sig = `${state}|${since || ''}`;
      if (slot.dataset.sig === sig) return;
      slot.dataset.sig = sig;
      if (!p) { slot.innerHTML = ''; slot.removeAttribute('data-state'); return; }
      slot.dataset.state = state;
      slot.innerHTML = `<span class="op-rs-dot" aria-hidden="true"></span><span class="op-rs-text">${esc(STATE_TEXT[state] || '')}</span>${since ? `<span class="op-rs-timer" data-since="${esc(since)}">${esc(elapsed(since))}</span>` : ''}<span class="op-rs-sep" aria-hidden="true">·</span>`;
    });
  }

  function renderBar() {
    const cc = ccEl && ccEl.querySelector('.st-cc');
    if (!cc) return;
    let bar = cc.querySelector('.op-bar');
    const show = signedIn && isAdmin && enabled;
    if (!show) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'op-bar';
      bar.innerHTML = `
        <span class="op-bar-icon" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg></span>
        <span class="op-bar-text"><span class="op-bar-sub"></span></span>
        <button type="button" class="op-bar-btn" aria-label="Open team view"><span class="op-bar-long">Open team view</span><span class="op-bar-short" aria-hidden="true">Team view</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        </button>`;
      bar.querySelector('.op-bar-btn').addEventListener('click', () => { send('operator:open'); });
      cc.insertBefore(bar, cc.firstChild);
    }
    const c = opState && opState.counts;
    let sub = 'Everyone’s status, live';
    if (opState && opState.phase === 'lost') sub = 'Reconnecting…';
    else if (c && c.total) sub = `${c.available} available${c.ringing ? ` · ${c.ringing} ringing` : ''}`;
    const subEl = bar.querySelector('.op-bar-sub');
    if (subEl.textContent !== sub) subEl.textContent = sub;
  }

  function tick() {
    if (!ccEl || !isActive()) return;
    ccEl.querySelectorAll('.op-rs-timer[data-since]').forEach((t) => {
      const v = elapsed(t.dataset.since);
      if (t.textContent !== v) t.textContent = v;
    });
  }

  // ----------------------------------------------------------- settings ---
  function renderSettings() {
    const mount = document.getElementById('operatorSettingsMount');
    if (!mount) return;
    if (!(signedIn && isAdmin)) { if (mount.innerHTML) mount.innerHTML = ''; return; }
    if (!mount.querySelector('#operatorEnabled')) {
      mount.innerHTML = `
        <div class="setting-divider"></div>
        <label class="toggle-label">
          <input type="checkbox" id="operatorEnabled" class="toggle-checkbox">
          <span class="toggle-slider"></span>
          <span class="toggle-text">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            Team view
          </span>
        </label>
        <p class="setting-description">For receptionists: see who’s available, ringing or on a call across your company</p>`;
      mount.querySelector('#operatorEnabled').addEventListener('change', (e) => {
        enabled = e.target.checked;
        send('operator:setEnabled', { enabled });
        refreshAll();
      });
    }
    const box = mount.querySelector('#operatorEnabled');
    if (box.checked !== enabled) box.checked = enabled;
  }

  // -------------------------------------------------------------- data ---
  function adopt(state) {
    opState = state || null;
    byExt = new Map(((opState && opState.people) || []).map((p) => [p.ext, p]));
  }

  function refreshAll() {
    const active = isActive();
    if (active !== wasActive) {
      wasActive = active;
      // Rows gain or lose their status slot: let status-ui render the list once.
      const st = window.OneClickUI.status;
      if (st && typeof st.render === 'function') st.render();
    }
    renderSettings();
    decorate();
  }

  async function load() {
    const [local, session, sync] = await Promise.all([
      chrome.storage.local.get(['apiStatus', 'operatorEnabled']),
      chrome.storage.session.get(['operatorState']),
      chrome.storage.sync.get(['tenant', 'extension'])
    ]);
    const st = local.apiStatus || {};
    isAdmin = !!st.isAdmin;
    signedIn = !!(sync.tenant && sync.extension) && !(st.state === 'off' && st.reason === 'no_credentials');
    enabled = local.operatorEnabled !== false;
    adopt(session.operatorState);
    refreshAll();
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.operatorState) { adopt(changes.operatorState.newValue); refreshAll(); }
    if (area === 'local' && changes.apiStatus) {
      const st = changes.apiStatus.newValue || {};
      const nextAdmin = !!st.isAdmin;
      const nextSigned = !(st.state === 'off' && st.reason === 'no_credentials');
      if (nextAdmin !== isAdmin || nextSigned !== signedIn) { isAdmin = nextAdmin; signedIn = nextSigned; refreshAll(); }
    }
    if (area === 'local' && changes.operatorEnabled) { enabled = changes.operatorEnabled.newValue !== false; refreshAll(); }
    if (area === 'sync' && (changes.tenant || changes.extension)) load().catch(() => {});
  });

  setInterval(tick, 1000);
  document.addEventListener('DOMContentLoaded', () => { load().catch(() => {}); });

  window.OneClickUI.operator = { isActive, decorate, stateFor: (ext) => byExt.get(String(ext)) || null };
})();
