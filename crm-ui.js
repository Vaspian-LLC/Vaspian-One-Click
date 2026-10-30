// Track C "crm" (popup and sidebar): Screen Pop card with CRM presets and a
// live preview, after-call wrap-up settings and prompt, diagnostics export,
// history filters, history rows with direction/status, CSV columns, and the
// read-only rendering of IT-managed settings.
//
// Mounts (fleet/ARCHITECTURE.md §8):
//   #crmSettingsMount   Screen Pop card (moved here from popup.html and rebuilt,
//                       same element ids), wrap-up card, diagnostics card
//   #historyMount       History tab: All / Missed / Inbound / Outbound filters
//   #historyInlineMount Sidebar Dial tab: the same filters
//   #crmWrapUpMount     created at runtime at the top of the Dial tab, under
//                       #callCardMount: the after-call prompt
// popup.js asks window.OneClickUI.crm.historyItemHTML / csvRows when present,
// and screenpop-ui.js steps aside when ownsScreenPop is true.
// Settings are read and written through crm.js (crm:getSettings /
// crm:saveSettings), which applies the managed policy and locks.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res));
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });

  function esc(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const ICONS = {
    screen: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    clipboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/><line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/></svg>',
    activity: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
    lock: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    download: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    inbound: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/></svg>',
    outbound: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg>',
    missed: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="23" y1="1" x2="17" y2="7"/><line x1="17" y1="1" x2="23" y2="7"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    note: '<svg class="note-indicator" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
    phone: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>'
  };
  const LOCK_NOTE = `<p class="crm-lock-note">${ICONS.lock}<span>Managed by your organization</span></p>`;

  // ------------------------------------------------------------ helpers ---
  /** Display form of a stored number: (315) 555-0100, Ext 197, or as stored. */
  function displayNumber(n) {
    const d = String(n || '').replace(/\D/g, '');
    if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
    if (d.length === 11 && d[0] === '1') return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
    if (d && d.length <= 6) return `Ext ${d}`;
    return String(n || '');
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.round(+sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  /** Normalized view of any history record (v1 click records have no direction). */
  function classify(call) {
    const direction = call.direction === 'inbound' ? 'inbound' : 'outbound';
    const status = call.status || 'placed';
    const kind = status === 'missed' ? 'missed' : direction;
    const labels = {
      answered: direction === 'inbound' ? 'Answered' : 'Outbound',
      missed: 'Missed',
      voicemail: 'Sent to voicemail',
      answered_elsewhere: call.answeredBy ? `Answered by ${call.answeredBy}` : 'Answered elsewhere',
      no_answer: 'No answer',
      placed: 'Placed from One Click',
      ended: direction === 'inbound' ? 'Inbound' : 'Outbound'
    };
    const titles = {
      inbound: status === 'answered_elsewhere' ? 'Inbound call answered by someone else'
        : (status === 'voicemail' ? 'Inbound call sent to voicemail' : 'Inbound call'),
      outbound: status === 'no_answer' ? 'Outbound call, not answered' : 'Outbound call',
      missed: 'Missed call'
    };
    return { direction, status, kind, label: labels[status] || status, title: titles[kind] };
  }

  function timeAgo(iso, helpers) {
    if (helpers && helpers.getTimeAgo) return helpers.getTimeAgo(new Date(iso));
    return new Date(iso).toLocaleString();
  }

  /**
   * One history row. Same structure and data attributes popup.js relies on
   * (.call-history-item with data-phone/-timestamp/-note, .redial-btn), plus
   * data-direction / data-status for the filters.
   * @param {object} call history record
   * @param {{getTimeAgo?: function}} [helpers] from popup.js
   */
  function historyItemHTML(call, helpers) {
    const c = classify(call);
    const number = displayNumber(call.phoneNumber);
    const name = String(call.name || '').trim();
    const note = String(call.note || '');
    const hasNote = note.trim().length > 0;
    const shortNote = note.length > 100 ? `${note.slice(0, 100)}...` : note;
    const meta = [name ? number : null, c.label, call.durationSec > 0 ? formatDuration(call.durationSec) : null, timeAgo(call.timestamp, helpers)]
      .filter(Boolean).map((m) => `<span class="crm-meta">${esc(m)}</span>`).join(' <span class="crm-sep">\u00B7</span> ');
    return `
    <div class="call-history-item crm-item crm-kind-${c.kind}${hasNote ? ' has-note' : ''}" data-phone="${esc(call.phoneNumber)}" data-timestamp="${esc(call.timestamp)}" data-note="${esc(note)}" data-direction="${c.direction}" data-status="${esc(c.status)}">
      <span class="crm-dir crm-dir-${c.kind}" title="${esc(c.title)}">${ICONS[c.kind]}</span>
      <div class="call-info">
        <div class="call-number${name ? ' crm-has-name' : ''}">
          <span class="crm-primary">${esc(name || number)}</span>
          ${call.disposition ? `<span class="crm-dispo" title="Disposition">${esc(call.disposition)}</span>` : ''}
          ${hasNote ? ICONS.note : ''}
        </div>
        <div class="call-time">${meta}</div>
        ${hasNote ? `<div class="call-note" title="${esc(note)}">${esc(shortNote)}</div>` : ''}
      </div>
      <button class="redial-btn" data-number="${esc(call.phoneNumber)}" title="Call back">${ICONS.phone}</button>
    </div>`;
  }

  /** A CSV cell: quoted, with spreadsheet formulas neutralized. */
  function csvCell(v, text) {
    let s = String(v == null ? '' : v);
    if (text && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  }

  /**
   * CSV lines (header first) for the history export. Keeps the v1 columns
   * (DateTime, Phone Number, Note) and adds the event-sourced fields.
   */
  function csvRows(history) {
    const rows = [['DateTime', 'Direction', 'Status', 'Phone Number', 'Name', 'Duration (s)', 'Disposition', 'Note', 'Call ID'].join(',')];
    for (const call of history || []) {
      const c = classify(call);
      rows.push([
        csvCell(new Date(call.timestamp).toLocaleString()), csvCell(c.direction), csvCell(c.status), csvCell(call.phoneNumber),
        csvCell(call.name, true), csvCell(call.durationSec || 0), csvCell(call.disposition, true), csvCell(call.note, true), csvCell(call.smdrCallId)
      ].join(','));
    }
    return rows;
  }

  // ----------------------------------------------------------- settings ---
  let ui = null;           // last crm:getSettings result
  const els = {};          // mounts

  function isLocked(key) { return !!(ui && ui.locked.includes(key)); }

  /** Disable a control and show the managed note under its field. */
  function applyLock(input, key, field) {
    if (!input) return;
    const locked = isLocked(key);
    if (input.tagName === 'INPUT' && input.type !== 'checkbox') input.readOnly = locked;
    else input.disabled = locked;
    input.classList.toggle('crm-locked', locked);
    const host = field || input.closest('.crm-field, .toggle-label');
    if (!host) return;
    host.classList.toggle('crm-field-locked', locked);
    // Toggles: the note goes under their description line; fields: at the end of the field.
    const isToggle = host.classList.contains('toggle-label');
    const after = isToggle && host.nextElementSibling && host.nextElementSibling.classList.contains('setting-description') ? host.nextElementSibling : host;
    const note = isToggle
      ? (after.nextElementSibling && after.nextElementSibling.classList.contains('crm-lock-note') ? after.nextElementSibling : null)
      : host.querySelector(':scope > .crm-lock-note');
    if (locked && !note) after.insertAdjacentHTML(isToggle ? 'afterend' : 'beforeend', LOCK_NOTE);
    else if (!locked && note) note.remove();
  }

  function screenPopCardHTML() {
    const presets = ui.presets;
    return `
      <div class="card-header">${ICONS.screen}<span>Screen Pop</span></div>
      <label class="toggle-label">
        <input type="checkbox" id="screenPopEnabled" class="toggle-checkbox">
        <span class="toggle-slider"></span>
        <span class="toggle-text">Open the caller in my CRM</span>
      </label>
      <p class="setting-description">When a call comes in, open the caller's record in your CRM</p>

      <div class="crm-field">
        <label for="screenPopCrm">CRM</label>
        <div class="select-wrapper">
          <select id="screenPopCrm">
            ${Object.entries(presets).map(([id, p]) => `<option value="${esc(id)}">${esc(p.label)}</option>`).join('')}
          </select>
        </div>
        <p class="crm-hint" id="crmPresetHint"></p>
      </div>

      <div class="crm-field" data-preset-field="crmZohoBaseUrl">
        <label for="crmZohoBaseUrl">Screen pop service URL</label>
        <input type="url" id="crmZohoBaseUrl" class="crm-input" spellcheck="false" autocomplete="off" placeholder="${esc(ui.defaults.crmZohoBaseUrl)}">
      </div>
      <div class="crm-field" data-preset-field="crmZohoKey">
        <label for="crmZohoKey">Access key</label>
        <div class="crm-input-row">
          <input type="password" id="crmZohoKey" class="crm-input" spellcheck="false" autocomplete="off" placeholder="Paste the key from Vaspian">
          <button type="button" class="crm-reveal" id="crmZohoKeyReveal" aria-pressed="false">Show</button>
        </div>
        <p class="crm-hint">Vaspian provides this key with your Zoho Desk screen pop service.</p>
      </div>
      <div class="crm-field" data-preset-field="crmSecureCrmBaseUrl">
        <label for="crmSecureCrmBaseUrl">Dialer URL</label>
        <input type="url" id="crmSecureCrmBaseUrl" class="crm-input" spellcheck="false" autocomplete="off" placeholder="${esc(ui.defaults.crmSecureCrmBaseUrl)}">
      </div>
      <div class="crm-field" data-preset-field="screenPopUrl" id="screenPopUrlField">
        <label for="screenPopUrl">URL</label>
        <input type="text" id="screenPopUrl" class="crm-input" spellcheck="false" autocomplete="off" placeholder="https://crm.example.com/search?phone={phone10}">
        <div class="crm-tokens" role="group" aria-label="Insert a token">
          <button type="button" class="crm-token" data-token="{phone10}" title="10-digit number, e.g. 3155550100">{phone10}</button>
          <button type="button" class="crm-token" data-token="{e164}" title="+1 and 10 digits, e.g. +13155550100">{e164}</button>
          <button type="button" class="crm-token" data-token="{phone}" title="The number as the phone system sent it">{phone}</button>
          <button type="button" class="crm-token" data-token="{name}" title="Caller ID name">{name}</button>
        </div>
      </div>

      <div class="crm-field">
        <label for="screenPopTrigger">Open when</label>
        <div class="select-wrapper">
          <select id="screenPopTrigger">
            <option value="answer">I answer the call</option>
            <option value="offer">The call starts ringing</option>
          </select>
        </div>
      </div>
      <label class="toggle-label crm-toggle-sub" data-preset-field="screenPopUrl">
        <input type="checkbox" id="screenPopInternal" class="toggle-checkbox">
        <span class="toggle-slider"></span>
        <span class="toggle-text">Also open for calls from coworkers</span>
      </label>

      <div class="crm-preview" id="crmPreview" data-ok="true">
        <div class="crm-preview-head"><span>Preview</span><span class="crm-preview-for" id="crmPreviewFor"></span></div>
        <code class="crm-preview-url" id="crmPreviewUrl">…</code>
      </div>

      <p class="field-description sp-status" id="screenPopStatus">Off</p>
      <div class="sp-actions">
        <input type="text" id="screenPopTestNumber" inputmode="tel" placeholder="Test number (e.g., 3155550100)">
        <div class="sp-buttons">
          <button type="button" class="btn btn-primary btn-sm" id="screenPopTest">Test</button>
          <button type="button" class="btn btn-outline btn-sm" id="screenPopReconnect" title="Reconnect the live connection">Reconnect</button>
        </div>
      </div>
      <p class="crm-feedback" id="crmTestFeedback" role="status"></p>`;
  }

  function wrapUpCardHTML() {
    return `
      <div class="card-header">${ICONS.clipboard}<span>After-call wrap-up</span></div>
      <label class="toggle-label">
        <input type="checkbox" id="crmWrapUpEnabled" class="toggle-checkbox">
        <span class="toggle-slider"></span>
        <span class="toggle-text">Ask how each call went</span>
      </label>
      <p class="setting-description">After an answered call, pick a disposition and add a note. Both are saved with the call in your history and CSV export.</p>
      <div class="crm-field" id="crmDispositionsField">
        <label>Dispositions</label>
        <div class="crm-chips crm-chips-edit" id="crmDispositionList"></div>
        <div class="crm-add-row" id="crmAddDispositionRow">
          <input type="text" id="crmNewDisposition" class="crm-input" maxlength="40" placeholder="Add a disposition">
          <button type="button" class="btn btn-outline btn-sm" id="crmAddDisposition">Add</button>
        </div>
      </div>`;
  }

  function diagnosticsCardHTML() {
    return `
      <div class="card-header">${ICONS.activity}<span>Diagnostics</span></div>
      <p class="card-description">Download a file for Vaspian support with your version, settings, connection status, recent call events and logs. Your PIN and keys are never included.</p>
      <button type="button" class="btn btn-outline btn-sm crm-diag-btn" id="crmExportDiagnostics">${ICONS.download}<span>Export diagnostics</span></button>
      <p class="crm-feedback" id="crmDiagFeedback" role="status"></p>`;
  }

  /** Current form values (only the fields the user may change). */
  function formValues() {
    const v = {
      screenPopEnabled: document.getElementById('screenPopEnabled').checked,
      screenPopCrm: document.getElementById('screenPopCrm').value,
      screenPopUrl: document.getElementById('screenPopUrl').value.trim(),
      screenPopTrigger: document.getElementById('screenPopTrigger').value,
      screenPopInternal: document.getElementById('screenPopInternal').checked,
      crmZohoBaseUrl: document.getElementById('crmZohoBaseUrl').value.trim(),
      crmSecureCrmBaseUrl: document.getElementById('crmSecureCrmBaseUrl').value.trim()
    };
    const key = document.getElementById('crmZohoKey');
    if (key.dataset.dirty === '1') v.crmZohoKey = key.value.trim();
    for (const k of Object.keys(v)) if (isLocked(k)) delete v[k];
    return v;
  }

  function showPresetFields() {
    const preset = document.getElementById('screenPopCrm').value;
    const p = ui.presets[preset] || { fields: [] };
    document.querySelectorAll('#screenPopCard [data-preset-field]').forEach((f) => { f.hidden = !p.fields.includes(f.dataset.presetField); });
    document.getElementById('crmPresetHint').textContent = p.description || '';
  }

  let previewTimer = null;
  function schedulePreview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 120);
  }
  async function updatePreview() {
    const testNumber = document.getElementById('screenPopTestNumber').value.trim();
    const values = formValues();
    // Preview what the user typed even if it is not saved yet (empty base = default).
    if (values.crmZohoBaseUrl === '') values.crmZohoBaseUrl = ui.defaults.crmZohoBaseUrl;
    if (values.crmSecureCrmBaseUrl === '') values.crmSecureCrmBaseUrl = ui.defaults.crmSecureCrmBaseUrl;
    const r = await send({ action: 'crm:preview', values, phone: testNumber, name: testNumber ? 'Test call' : 'Pat Caller' });
    const box = document.getElementById('crmPreview');
    const url = document.getElementById('crmPreviewUrl');
    const forEl = document.getElementById('crmPreviewFor');
    if (!box) return;
    box.dataset.ok = r && r.ok ? 'true' : 'false';
    url.textContent = r && r.ok ? r.url : ((r && r.error) || 'Preview unavailable');
    forEl.textContent = testNumber ? `for ${displayNumber(testNumber)}` : 'for a call from (315) 555-0100';
  }

  async function saveScreenPop() {
    const r = await send({ action: 'crm:saveSettings', values: formValues() });
    const key = document.getElementById('crmZohoKey');
    if (key) key.dataset.dirty = '0';
    const fb = document.getElementById('crmTestFeedback');
    if (r && !r.ok && r.refused && r.refused.length && fb) {
      fb.dataset.tone = 'error';
      fb.textContent = r.refused.some((k) => /BaseUrl$/.test(k)) ? 'That address is not a valid https:// URL, so it was not saved.' : 'Some settings could not be saved.';
    }
    return r;
  }

  /** Put the effective values into the Screen Pop card (skips the focused field). */
  function fillScreenPop() {
    const v = ui.values;
    const set = (id, val, prop = 'value') => {
      const el = document.getElementById(id);
      if (el && document.activeElement !== el) el[prop] = val;
    };
    set('screenPopEnabled', !!v.screenPopEnabled, 'checked');
    set('screenPopCrm', v.screenPopCrm);
    set('screenPopUrl', v.screenPopUrl || '');
    set('screenPopTrigger', v.screenPopTrigger || 'answer');
    set('screenPopInternal', !!v.screenPopInternal, 'checked');
    set('crmZohoBaseUrl', v.crmZohoBaseUrl === ui.defaults.crmZohoBaseUrl ? '' : (v.crmZohoBaseUrl || ''));
    set('crmSecureCrmBaseUrl', v.crmSecureCrmBaseUrl === ui.defaults.crmSecureCrmBaseUrl ? '' : (v.crmSecureCrmBaseUrl || ''));
    const key = document.getElementById('crmZohoKey');
    if (key && document.activeElement !== key && key.dataset.dirty !== '1') {
      key.value = ui.zohoKeyManaged ? '' : (v.crmZohoKey || '');
      key.placeholder = ui.zohoKeyManaged ? 'Set by your organization' : 'Paste the key from Vaspian';
    }
    applyLock(document.getElementById('screenPopEnabled'), 'screenPopEnabled');
    applyLock(document.getElementById('screenPopTrigger'), 'screenPopTrigger');
    applyLock(document.getElementById('screenPopInternal'), 'screenPopInternal');
    applyLock(document.getElementById('screenPopCrm'), 'screenPopCrm');
    applyLock(document.getElementById('screenPopUrl'), 'screenPopUrl');
    applyLock(document.getElementById('crmZohoBaseUrl'), 'crmZohoBaseUrl');
    applyLock(document.getElementById('crmZohoKey'), 'crmZohoKey');
    applyLock(document.getElementById('crmSecureCrmBaseUrl'), 'crmSecureCrmBaseUrl');
    document.querySelectorAll('#screenPopCard .crm-token').forEach((b) => { b.disabled = isLocked('screenPopUrl'); });
    const reveal = document.getElementById('crmZohoKeyReveal');
    if (reveal) reveal.hidden = isLocked('crmZohoKey');
    showPresetFields();
    schedulePreview();
  }

  function renderStatus(status) {
    const el = document.getElementById('screenPopStatus');
    const btn = document.getElementById('screenPopReconnect');
    if (!el || !btn) return;
    if (!status) { el.textContent = 'Not connected'; el.dataset.state = 'off'; return; }
    const labels = { off: 'Not connected', connecting: 'Connecting…', connected: '● Connected', retrying: 'Reconnecting…', error: '⚠ Not connected' };
    el.textContent = `${labels[status.state] || status.state}${status.detail ? ' · ' + status.detail : ''}`;
    el.dataset.state = status.state;
    // After a PIN rejection, Reconnect would resend the rejected PIN (3 failures
    // lock the extension); the way out is saving credentials again.
    const authStop = status.state === 'error' && status.reason === 'auth';
    btn.disabled = authStop;
    btn.title = authStop ? 'Your PIN was rejected. Log out and log in again with the correct PIN.' : 'Reconnect the live connection';
  }

  function wireScreenPop() {
    const byId = (id) => document.getElementById(id);
    byId('screenPopEnabled').addEventListener('change', saveScreenPop);
    byId('screenPopTrigger').addEventListener('change', saveScreenPop);
    byId('screenPopInternal').addEventListener('change', saveScreenPop);
    byId('screenPopCrm').addEventListener('change', async () => { showPresetFields(); schedulePreview(); await saveScreenPop(); });
    for (const id of ['screenPopUrl', 'crmZohoBaseUrl', 'crmSecureCrmBaseUrl', 'crmZohoKey', 'screenPopTestNumber']) {
      byId(id).addEventListener('input', () => { if (id === 'crmZohoKey') byId(id).dataset.dirty = '1'; schedulePreview(); });
      if (id !== 'screenPopTestNumber') byId(id).addEventListener('change', saveScreenPop);
    }
    byId('crmZohoKeyReveal').addEventListener('click', (e) => {
      const input = byId('crmZohoKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      e.currentTarget.setAttribute('aria-pressed', String(show));
    });
    byId('screenPopCard').addEventListener('click', (e) => {
      const tok = e.target.closest('.crm-token');
      if (!tok || tok.disabled) return;
      const input = byId('screenPopUrl');
      const start = input.selectionStart == null ? input.value.length : input.selectionStart;
      const end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      input.value = input.value.slice(0, start) + tok.dataset.token + input.value.slice(end);
      input.focus();
      input.setSelectionRange(start + tok.dataset.token.length, start + tok.dataset.token.length);
      schedulePreview();
      saveScreenPop();
    });
    byId('screenPopTest').addEventListener('click', async () => {
      const fb = byId('crmTestFeedback');
      const phoneNumber = byId('screenPopTestNumber').value.trim();
      const digits = phoneNumber.replace(/\D/g, '');
      fb.dataset.tone = 'error';
      if (!(digits.length === 10 || (digits.length === 11 && digits[0] === '1'))) {
        fb.textContent = 'Enter a 10-digit test number first.';
        byId('screenPopTestNumber').focus();
        return;
      }
      await saveScreenPop();
      await updatePreview();
      if (byId('crmPreview').dataset.ok !== 'true') { fb.textContent = 'Fix the CRM URL first.'; return; }
      const r = await send({ action: 'screenPopTest', phoneNumber });
      if (r && r.success) { fb.dataset.tone = 'ok'; fb.textContent = `Opened the CRM for ${displayNumber(phoneNumber)}.`; } else fb.textContent = `Could not open the CRM${r && r.error ? `: ${r.error}` : ''}.`;
    });
    byId('screenPopReconnect').addEventListener('click', () => { send({ action: 'apiReconnect' }); });
  }

  // --------------------------------------------------------- wrap-up card ---
  function dispositions() { return (ui && Array.isArray(ui.values.crmDispositions)) ? ui.values.crmDispositions : []; }

  function fillWrapUpCard() {
    const locked = isLocked('crmDispositions');
    const list = document.getElementById('crmDispositionList');
    if (!list) return;
    const items = dispositions();
    list.innerHTML = items.length
      ? items.map((d, i) => `<span class="crm-chip crm-chip-static">${esc(d)}${locked ? '' : `<button type="button" class="crm-chip-x" data-index="${i}" title="Remove ${esc(d)}" aria-label="Remove ${esc(d)}">×</button>`}</span>`).join('')
      : '<span class="crm-empty-chips">No dispositions. Agents can still add a note.</span>';
    document.getElementById('crmAddDispositionRow').hidden = locked;
    applyLock(document.getElementById('crmWrapUpEnabled'), 'crmWrapUpEnabled');
    document.getElementById('crmWrapUpEnabled').checked = !!ui.values.crmWrapUpEnabled;
    const field = document.getElementById('crmDispositionsField');
    field.classList.toggle('crm-field-locked', locked);
    const note = field.querySelector(':scope > .crm-lock-note');
    if (locked && !note) field.insertAdjacentHTML('beforeend', LOCK_NOTE);
    else if (!locked && note) note.remove();
  }

  async function saveDispositions(next) {
    ui.values.crmDispositions = next;
    fillWrapUpCard();
    await send({ action: 'crm:saveSettings', values: { crmDispositions: next } });
  }

  function wireWrapUpCard() {
    const input = document.getElementById('crmNewDisposition');
    const add = () => {
      const v = input.value.trim();
      if (!v) return;
      if (!dispositions().some((d) => d.toLowerCase() === v.toLowerCase())) saveDispositions([...dispositions(), v]);
      input.value = '';
      input.focus();
    };
    document.getElementById('crmAddDisposition').addEventListener('click', add);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    document.getElementById('crmDispositionList').addEventListener('click', (e) => {
      const x = e.target.closest('.crm-chip-x');
      if (!x) return;
      const next = dispositions().slice();
      next.splice(+x.dataset.index, 1);
      saveDispositions(next);
    });
    document.getElementById('crmWrapUpEnabled').addEventListener('change', (e) => {
      send({ action: 'crm:saveSettings', values: { crmWrapUpEnabled: e.target.checked } });
    });
  }

  // ---------------------------------------------------------- diagnostics ---
  function wireDiagnostics() {
    document.getElementById('crmExportDiagnostics').addEventListener('click', async () => {
      const fb = document.getElementById('crmDiagFeedback');
      fb.dataset.tone = '';
      fb.textContent = 'Preparing…';
      const r = await send({ action: 'crm:diagnostics' });
      if (!r || !r.ok) { fb.dataset.tone = 'error'; fb.textContent = `Could not build the file${r && r.error ? `: ${r.error}` : ''}.`; return; }
      const blob = new Blob([JSON.stringify(r.report, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      const ext = (r.report.connection && r.report.connection.session && r.report.connection.session.extension) || 'ext';
      a.href = url;
      a.download = `oneclick-diagnostics-${String(ext).replace(/[^a-z0-9]/gi, '')}-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      fb.dataset.tone = 'ok';
      fb.textContent = 'Saved. Send the file to Vaspian support.';
      window.OneClickUI.crm.lastDiagnostics = r.report; // for tests and support sessions
    });
  }

  // ------------------------------------------------------ login form locks ---
  function applyFoundationLocks() {
    const tenant = document.getElementById('tenant');
    if (tenant && ui.managed.includes('tenant')) {
      if (isLocked('tenant')) {
        tenant.value = ui.values.tenant || tenant.value;
        tenant.readOnly = true;
        tenant.classList.add('crm-locked');
        tenant.title = 'Managed by your organization';
        if (!(tenant.nextElementSibling && tenant.nextElementSibling.classList.contains('crm-lock-note'))) tenant.insertAdjacentHTML('afterend', LOCK_NOTE);
      } else if (!tenant.value && ui.values.tenant) {
        tenant.value = ui.values.tenant;
      }
    }
    const prefix = document.getElementById('dialPrefix');
    if (prefix && isLocked('dialPrefix')) {
      prefix.value = ui.values.dialPrefix;
      prefix.disabled = true;
      prefix.title = 'Managed by your organization';
      const host = prefix.closest('.select-wrapper') || prefix;
      if (!(host.nextElementSibling && host.nextElementSibling.classList.contains('crm-lock-note'))) host.insertAdjacentHTML('afterend', LOCK_NOTE);
    }
  }

  // ------------------------------------------------------ history filters ---
  let filter = 'all';
  let history = [];

  function counts() {
    const c = { all: history.length, missed: 0, inbound: 0, outbound: 0 };
    for (const call of history) {
      const k = classify(call);
      if (k.status === 'missed') c.missed++;
      c[k.direction]++;
    }
    return c;
  }

  function filtersHTML(c) {
    const chip = (id, label, n, extra = '') => `<button type="button" class="crm-filter${filter === id ? ' active' : ''}" data-filter="${id}" aria-pressed="${filter === id}">${label}${n ? ` <span class="crm-count${extra}">${n}</span>` : ''}</button>`;
    const empty = { missed: 'No missed calls', inbound: 'No inbound calls yet', outbound: 'No outbound calls yet' };
    return `<div class="crm-filters" role="group" aria-label="Filter calls">
        ${chip('all', 'All', c.all)}${chip('missed', 'Missed', c.missed, ' crm-count-missed')}${chip('inbound', 'Inbound', 0)}${chip('outbound', 'Outbound', 0)}
      </div>
      ${filter !== 'all' && c[filter] === 0 ? `<p class="crm-filter-empty">${empty[filter]}</p>` : ''}`;
  }

  function renderFilters() {
    const c = counts();
    for (const m of [els.history, els.historyInline]) {
      if (!m) continue;
      m.innerHTML = history.length ? filtersHTML(c) : '';
    }
    for (const id of ['historyContainer', 'historyContainerInline']) {
      const box = document.getElementById(id);
      if (box) box.dataset.crmFilter = filter;
    }
  }

  async function loadHistory() {
    const { callHistory } = await chrome.storage.local.get(['callHistory']);
    history = Array.isArray(callHistory) ? callHistory : [];
    renderFilters();
  }

  function wireFilters() {
    for (const m of [els.history, els.historyInline]) {
      if (!m) continue;
      m.addEventListener('click', (e) => {
        const b = e.target.closest('.crm-filter');
        if (!b) return;
        filter = b.dataset.filter;
        const editor = document.getElementById('inlineNoteEditor');
        if (editor) editor.remove();
        document.querySelectorAll('.call-history-item.note-editing').forEach((i) => i.classList.remove('note-editing'));
        renderFilters();
      });
    }
  }

  // ------------------------------------------------------- wrap-up prompt ---
  let wrapQueue = [];
  let wrapDraft = { key: null, disposition: '', note: '' };

  function ensureWrapUpMount() {
    let m = document.getElementById('crmWrapUpMount');
    if (m) return m;
    const anchor = document.getElementById('callCardMount');
    const pane = document.getElementById('dial');
    if (!pane) return null;
    m = document.createElement('div');
    m.id = 'crmWrapUpMount';
    m.className = 'mount crm-wrapup-mount';
    if (anchor && anchor.parentNode === pane) anchor.after(m); else pane.prepend(m);
    return m;
  }

  function renderWrapUp() {
    const m = ensureWrapUpMount();
    if (!m) return;
    const item = wrapQueue[0];
    if (!item) { m.innerHTML = ''; wrapDraft = { key: null, disposition: '', note: '' }; return; }
    if (wrapDraft.key !== item.key) wrapDraft = { key: item.key, disposition: '', note: '' };
    const c = classify(item);
    const who = item.name ? `${item.name} · ${displayNumber(item.phoneNumber)}` : displayNumber(item.phoneNumber);
    const sub = [c.direction === 'inbound' ? 'Inbound' : 'Outbound', item.durationSec > 0 ? formatDuration(item.durationSec) : null].filter(Boolean).join(' · ');
    const list = dispositions();
    m.innerHTML = `
      <div class="crm-wrapup" data-key="${esc(item.key)}">
        <div class="crm-wrapup-head">
          <span class="crm-dir crm-dir-${c.kind}">${ICONS[c.kind]}</span>
          <div class="crm-wrapup-titles">
            <div class="crm-wrapup-title">How did the call go?</div>
            <div class="crm-wrapup-sub"><span class="crm-wrapup-who">${esc(who)}</span> <span class="crm-sep">\u00B7</span> ${esc(sub)}</div>
          </div>
          <button type="button" class="crm-wrapup-close" data-act="skip" title="Skip" aria-label="Skip">×</button>
        </div>
        ${list.length ? `<div class="crm-chips" role="radiogroup" aria-label="Disposition">${list.map((d) => `<button type="button" class="crm-chip crm-chip-pick${wrapDraft.disposition === d ? ' selected' : ''}" role="radio" aria-checked="${wrapDraft.disposition === d}" data-value="${esc(d)}">${esc(d)}</button>`).join('')}</div>` : ''}
        <textarea class="crm-wrapup-note" rows="2" maxlength="2000" placeholder="Add a note (optional)">${esc(wrapDraft.note)}</textarea>
        <div class="crm-wrapup-actions">
          <span class="crm-wrapup-more">${wrapQueue.length > 1 ? `${wrapQueue.length - 1} more to wrap up` : ''}</span>
          <button type="button" class="btn btn-outline btn-sm" data-act="skip">Skip</button>
          <button type="button" class="btn btn-primary btn-sm" data-act="save"${wrapDraft.disposition || wrapDraft.note.trim() ? '' : ' disabled'}>Save</button>
        </div>
      </div>`;
  }

  function wireWrapUp() {
    const m = ensureWrapUpMount();
    if (!m) return;
    m.addEventListener('click', async (e) => {
      const chip = e.target.closest('.crm-chip-pick');
      if (chip) {
        wrapDraft.disposition = wrapDraft.disposition === chip.dataset.value ? '' : chip.dataset.value;
        m.querySelectorAll('.crm-chip-pick').forEach((b) => { const on = b.dataset.value === wrapDraft.disposition; b.classList.toggle('selected', on); b.setAttribute('aria-checked', String(on)); });
        m.querySelector('[data-act="save"]').disabled = !(wrapDraft.disposition || wrapDraft.note.trim());
        return;
      }
      const act = e.target.closest('[data-act]');
      if (!act || !wrapDraft.key) return;
      const key = wrapDraft.key;
      act.disabled = true;
      if (act.dataset.act === 'save') await send({ action: 'crm:wrapUpSave', key, disposition: wrapDraft.disposition, note: wrapDraft.note });
      else await send({ action: 'crm:wrapUpDismiss', key });
    });
    m.addEventListener('input', (e) => {
      if (!e.target.classList.contains('crm-wrapup-note')) return;
      wrapDraft.note = e.target.value;
      const save = m.querySelector('[data-act="save"]');
      if (save) save.disabled = !(wrapDraft.disposition || wrapDraft.note.trim());
    });
  }

  async function loadWrapUp() {
    const { crmWrapUp } = await chrome.storage.local.get(['crmWrapUp']);
    wrapQueue = Array.isArray(crmWrapUp) ? crmWrapUp : [];
    // Don't wipe what the agent is typing when an unrelated update arrives.
    const m = document.getElementById('crmWrapUpMount');
    const typing = m && m.contains(document.activeElement) && wrapQueue[0] && wrapQueue[0].key === wrapDraft.key;
    if (!typing) renderWrapUp();
  }

  // --------------------------------------------------------------- mount ---
  async function refreshSettings() {
    const r = await send({ action: 'crm:getSettings' });
    if (!r || !r.values) return false;
    ui = r;
    if (document.getElementById('crmPresetHint')) fillScreenPop();
    if (document.getElementById('crmDispositionList')) fillWrapUpCard();
    applyFoundationLocks();
    if (wrapQueue.length && !(document.getElementById('crmWrapUpMount') || { contains: () => false }).contains(document.activeElement)) renderWrapUp();
    return true;
  }

  /**
   * Build everything. `mounts` = {settings, history, historyInline}.
   */
  async function mount(mounts) {
    Object.assign(els, mounts);
    // The service worker may be waking up; try a few times before giving up.
    let ready = false;
    for (let i = 0; i < 4 && !ready; i++) {
      ready = await refreshSettings();
      if (!ready) await new Promise((r) => setTimeout(r, 300));
    }
    if (!ready) return;

    // Screen Pop card: move it into the mount and rebuild it (same ids).
    let card = document.getElementById('screenPopCard');
    if (!card) { card = document.createElement('div'); card.id = 'screenPopCard'; }
    card.className = 'settings-card crm-card';
    card.innerHTML = screenPopCardHTML();
    const wrap = document.createElement('div');
    wrap.id = 'crmWrapUpCard';
    wrap.className = 'settings-card crm-card';
    wrap.innerHTML = wrapUpCardHTML();
    const diag = document.createElement('div');
    diag.id = 'crmDiagnosticsCard';
    diag.className = 'settings-card crm-card';
    diag.innerHTML = diagnosticsCardHTML();
    if (els.settings) els.settings.append(card, wrap, diag);

    wireScreenPop();
    wireWrapUpCard();
    wireDiagnostics();
    fillScreenPop();
    fillWrapUpCard();
    applyFoundationLocks();
    // popup.js fills the login form after its own storage read; re-apply after it.
    setTimeout(applyFoundationLocks, 400);

    const { apiStatus } = await chrome.storage.local.get(['apiStatus']);
    renderStatus(apiStatus);

    wireFilters();
    await loadHistory();
    wireWrapUp();
    await loadWrapUp();

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local') {
        if (changes.apiStatus) renderStatus(changes.apiStatus.newValue);
        if (changes.callHistory) { history = Array.isArray(changes.callHistory.newValue) ? changes.callHistory.newValue : []; renderFilters(); }
        if (changes.crmWrapUp) loadWrapUp();
        if (changes.crmPolicy) refreshSettings();
      } else if (area === 'sync' && Object.keys(changes).some((k) => k.startsWith('screenPop') || k.startsWith('crm'))) {
        refreshSettings();
      } else if (area === 'managed') {
        refreshSettings();
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    mount({
      settings: document.getElementById('crmSettingsMount'),
      history: document.getElementById('historyMount'),
      historyInline: document.getElementById('historyInlineMount')
    }).catch((e) => console.error('CRM UI failed to load:', e));
  });

  window.OneClickUI.crm = {
    mount,
    /** screenpop-ui.js checks this and leaves the Screen Pop card to this file. */
    ownsScreenPop: true,
    historyItemHTML,
    csvRows,
    displayNumber,
    formatDuration
  };
})();
