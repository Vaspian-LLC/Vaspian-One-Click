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
// popup.js asks window.OneClickUI.crm.historyItemHTML / csvRows when present.
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

  // Shell symbols (popup.html sprite) where they exist; module-only icons inline.
  const use = (id) => `<svg aria-hidden="true"><use href="#${id}"/></svg>`;
  const ICONS = {
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>',
    clipboard: use('i-clipboard'),
    lock: '<svg class="crm-lock-ico" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    download: use('i-download'),
    x: use('i-x'),
    check: '<svg class="crm-check" viewBox="0 0 24 24" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>',
    inbound: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="16 17 7 17 7 8"/></svg>',
    outbound: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg>',
    missed: '<svg viewBox="0 0 24 24" aria-hidden="true"><line x1="23" y1="1" x2="17" y2="7"/><line x1="17" y1="1" x2="23" y2="7"/><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    phone: use('i-phone')
  };
  const LOCK_TEXT = 'Set by your IT team';
  const LOCK_NOTE = `<p class="crm-lock-note">${ICONS.lock}<span>${LOCK_TEXT}</span></p>`;
  const LOCK_BADGE = `<span class="crm-lock-badge" title="${LOCK_TEXT}">${ICONS.lock}<span>Set by IT</span></span>`;

  /** Short, plain names and one-line descriptions for the app picker (crm.js keeps the long ones). */
  const PRESET_UI = {
    simplicity: { name: 'Simplicity Collect', line: 'Opens the account in the dialer' },
    zoho: { name: 'Zoho Desk', line: 'Opens the contact or a new ticket' },
    zohocrm: { name: 'Zoho CRM', line: 'Finds leads, contacts and deals' },
    securecrm: { name: 'SecureCRM', line: 'Opens the caller in the dialer' },
    googlecontacts: { name: 'Google Contacts', line: 'Searches your Google Contacts' },
    google: { name: 'Google search', line: 'Searches Google for the number' },
    custom: { name: 'Your own link', line: 'Any web page you choose' }
  };
  const presetName = (id) => (PRESET_UI[id] && PRESET_UI[id].name) || (ui && ui.presets[id] && ui.presets[id].label) || id;

  /**
   * Screen pop and wrap-up cards carry one "Set by IT" badge in the card header
   * (the shell shows the header only when it has one), plus a note on each locked field.
   */
  function syncLockBadge(card) {
    if (!card) return;
    const head = card.querySelector(':scope > .card-header');
    if (!head) return;
    const any = !!card.querySelector('.crm-field-locked, .crm-locked');
    const badge = head.querySelector('.crm-lock-badge');
    if (any && !badge) head.insertAdjacentHTML('beforeend', LOCK_BADGE);
    else if (!any && badge) badge.remove();
  }
  const badgeCard = (el) => (el ? el.closest('#screenPopCard, #crmWrapUpCard') : null);

  // ------------------------------------------------------------ helpers ---
  /** Display form of a stored number: (315) 555-0100, Ext 197, or as stored. */
  function displayNumber(n) {
    const d = self.OneClickPhone.stripAccessCode(n);
    if (d && d.length <= 6) return `Ext ${d}`;
    return self.OneClickPhone.display(n);
  }

  function formatDuration(sec) {
    const s = Math.max(0, Math.round(+sec || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
  }

  /** Title Case for all-caps carrier caller ID ("JORDAN LEE" -> "Jordan Lee"); display only. */
  function nice(name) {
    const s = String(name || '');
    if (!s || /[a-z]/.test(s) || !/[A-Z]/.test(s)) return s;
    return s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
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
    const name = nice(String(call.name || '').trim());
    const note = String(call.note || '');
    const hasNote = note.trim().length > 0;
    const shortNote = note.length > 100 ? `${note.slice(0, 100)}...` : note;
    // The tile already says in or out; the words add what the tile can't (missed, voicemail, someone else).
    const quiet = ['answered', 'ended', 'placed'].includes(c.status);
    const meta = [name ? number : null, quiet ? null : c.label, call.durationSec > 0 ? formatDuration(call.durationSec) : null, timeAgo(call.timestamp, helpers)]
      .filter(Boolean).map((m) => `<span class="crm-meta">${esc(m)}</span>`).join(' <span class="crm-sep" aria-hidden="true">\u00B7</span> ');
    return `
    <div class="call-history-item crm-item crm-kind-${c.kind}${hasNote ? ' has-note' : ''}" data-phone="${esc(call.phoneNumber)}" data-timestamp="${esc(call.timestamp)}" data-note="${esc(note)}" data-direction="${c.direction}" data-status="${esc(c.status)}">
      <span class="crm-dir crm-dir-${c.kind}" role="img" aria-label="${esc(c.title)}" title="${esc(c.title)}">${ICONS[c.kind]}</span>
      <div class="call-info">
        <div class="call-number${name ? ' crm-has-name' : ''}">
          <span class="crm-primary">${esc(name || number)}</span>
          ${call.disposition ? `<span class="crm-dispo" title="How the call went">${esc(call.disposition)}</span>` : ''}
        </div>
        <div class="call-time">${meta}</div>
        ${hasNote ? `<div class="call-note" title="${esc(note)}">${esc(shortNote)}</div>` : ''}
      </div>
      <button class="redial-btn" data-number="${esc(call.phoneNumber)}" title="Call back" aria-label="Call back ${esc(name || number)}">${ICONS.phone}</button>
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

  /**
   * Disable a control and mark its field "Set by your IT team" (lock icon and
   * text under the field; toggles get it under their row). Cards also keep one
   * header badge. Text inputs go read-only so the value stays selectable.
   */
  function applyLock(input, key, field) {
    if (!input) return;
    const locked = isLocked(key);
    if (input.tagName === 'INPUT' && input.type !== 'checkbox' && input.type !== 'radio') input.readOnly = locked;
    else input.disabled = locked;
    input.classList.toggle('crm-locked', locked);
    if (locked) input.title = LOCK_TEXT; else if (input.title === LOCK_TEXT) input.removeAttribute('title');
    const host = field || input.closest('.crm-field, .toggle-label');
    if (!host) return;
    host.classList.toggle('crm-field-locked', locked);
    const isToggle = host.classList.contains('toggle-label');
    const after = isToggle && host.nextElementSibling && host.nextElementSibling.classList.contains('setting-description') ? host.nextElementSibling : host;
    const note = isToggle
      ? (after.nextElementSibling && after.nextElementSibling.classList.contains('crm-lock-note') ? after.nextElementSibling : null)
      : host.querySelector(':scope > .crm-lock-note');
    if (locked && !note) after.insertAdjacentHTML(isToggle ? 'afterend' : 'beforeend', LOCK_NOTE);
    else if (!locked && note) note.remove();
    syncLockBadge(badgeCard(host));
  }

  const TOKENS = [
    ['{phone10}', '10 digits, like 3155550100'],
    ['{phone11}', '1 and 10 digits, like 13155550100'],
    ['{e164}', '+1 and 10 digits, like +13155550100'],
    ['{phoneDash}', 'With dashes, like 315-555-0100'],
    ['{phoneParen}', 'Area code in brackets, like (315) 555-0100'],
    ['{phone}', 'The number as the phone system sent it'],
    ['{name}', 'The caller ID name']
  ];

  const stepHead = (n, id, title) => `
        <div class="crm-step-head">
          <span class="crm-step-mark" aria-hidden="true"><span class="crm-step-n">${n}</span>${ICONS.check}</span>
          <h3 class="crm-step-title" id="${id}">${title}</h3>
          <span class="crm-step-state" aria-live="polite"></span>
        </div>`;

  function screenPopCardHTML() {
    const ids = Object.keys(ui.presets);
    return `
      <div class="card-header">${ICONS.screen}<span>Screen pop</span></div>
      <div class="set-group crm-sp-master">
        <label class="toggle-label">
          <span class="toggle-text">Open callers in my CRM<span class="setting-description" id="crmSpLead"></span></span>
          <input type="checkbox" id="screenPopEnabled" class="toggle-checkbox" role="switch" aria-describedby="crmSpLead">
          <span class="toggle-slider" aria-hidden="true"></span>
        </label>
      </div>

      <ol class="set-group crm-steps" id="crmSteps" aria-label="Set up screen pop">
        <li class="crm-step" data-step="pick">
          ${stepHead(1, 'crmStepPickTitle', 'Which app do you use?')}
          <div class="crm-step-body crm-field">
            <select id="screenPopCrm" class="sp-native" tabindex="-1" aria-hidden="true">
              ${ids.map((id) => `<option value="${esc(id)}">${esc(presetName(id))}</option>`).join('')}
            </select>
            <div class="crm-presets" role="radiogroup" aria-labelledby="crmStepPickTitle">
              ${ids.map((id) => `
              <label class="crm-preset" data-value="${esc(id)}">
                <input type="radio" name="crmPresetPick" value="${esc(id)}">
                <span class="crm-preset-text"><span class="crm-preset-name">${esc(presetName(id))}</span><span class="crm-preset-line">${esc((PRESET_UI[id] || {}).line || ui.presets[id].description || '')}</span></span>
                <span class="crm-preset-dot" aria-hidden="true"></span>
              </label>`).join('')}
            </div>
            <p class="crm-hint" id="crmPresetHint"></p>
          </div>
        </li>

        <li class="crm-step" data-step="connect">
          ${stepHead(2, 'crmStepConnectTitle', 'Connect it')}
          <div class="crm-step-body">
            <p class="crm-step-none" id="crmConnectNone"></p>
            <div class="crm-field" data-preset-field="crmZohoKey">
              <label class="field-label" for="crmZohoKey">Access key</label>
              <div class="crm-input-row">
                <input type="password" id="crmZohoKey" class="crm-input" spellcheck="false" autocomplete="off" placeholder="Paste your access key" aria-describedby="crmZohoKeyHelp">
                <button type="button" class="btn btn-secondary crm-reveal" id="crmZohoKeyReveal" aria-pressed="false" aria-controls="crmZohoKey">Show</button>
              </div>
              <p class="crm-hint" id="crmZohoKeyHelp">Your Zoho Desk admin gets this key when they connect Zoho Desk to Vaspian. Ask them, or call Vaspian support.</p>
            </div>
            <div class="crm-field" data-preset-field="crmZohoCrmOrg">
              <label class="field-label" for="crmZohoCrmOrg">Zoho CRM org ID</label>
              <input type="text" id="crmZohoCrmOrg" class="crm-input" spellcheck="false" autocomplete="off" placeholder="org123456789" aria-describedby="crmZohoCrmOrgHelp">
              <p class="crm-hint" id="crmZohoCrmOrgHelp">Open Zoho CRM and copy the part after <strong>/crm/</strong> in the address bar. Pasting the whole address works too.</p>
            </div>
            <div class="crm-field" data-preset-field="crmSecureCrmBaseUrl">
              <label class="field-label" for="crmSecureCrmBaseUrl">Dialer address <span class="crm-optional">(optional)</span></label>
              <input type="url" id="crmSecureCrmBaseUrl" class="crm-input" spellcheck="false" autocomplete="off" placeholder="${esc(ui.defaults.crmSecureCrmBaseUrl)}" aria-describedby="crmSecureCrmHelp">
              <p class="crm-hint" id="crmSecureCrmHelp">Leave this empty to use SecureCRM's usual dialer. Change it only if SecureCRM gave you a different address.</p>
            </div>
            <div class="crm-field" data-preset-field="screenPopUrl" id="screenPopUrlField">
              <label class="field-label" for="screenPopUrl">Link to open</label>
              <input type="text" id="screenPopUrl" class="crm-input crm-mono" spellcheck="false" autocomplete="off" placeholder="https://crm.example.com/search?phone={phone10}" aria-describedby="screenPopUrlHelp">
              <p class="crm-hint" id="screenPopUrlHelp">Paste the web address your CRM uses to look someone up. Then put the caller's number in it with a button below.</p>
              <div class="crm-tokens" role="group" aria-label="Add the caller's number or name to the link">
                ${TOKENS.map(([t, title]) => `<button type="button" class="crm-token" data-token="${t}" title="${esc(title)}">${t}</button>`).join('')}
              </div>
            </div>
            <label class="toggle-label crm-toggle-sub" data-preset-field="screenPopUrl">
              <span class="toggle-text">Also for calls from coworkers<span class="setting-description">Open the link for calls between extensions too.</span></span>
              <input type="checkbox" id="screenPopInternal" class="toggle-checkbox" role="switch">
              <span class="toggle-slider" aria-hidden="true"></span>
            </label>
          </div>
        </li>

        <li class="crm-step" data-step="when">
          ${stepHead(3, 'crmStepWhenTitle', 'When should it open?')}
          <div class="crm-step-body crm-field">
            <select id="screenPopTrigger" class="sp-native" tabindex="-1" aria-hidden="true">
              <option value="answer">When I answer</option>
              <option value="offer">When it rings</option>
            </select>
            <div class="crm-seg" role="radiogroup" aria-labelledby="crmStepWhenTitle">
              <label class="crm-seg-opt"><input type="radio" name="crmTriggerPick" value="answer"><span>When I answer</span></label>
              <label class="crm-seg-opt"><input type="radio" name="crmTriggerPick" value="offer"><span>When it rings</span></label>
            </div>
            <p class="crm-hint" id="crmTriggerHint"></p>
          </div>
        </li>

        <li class="crm-step" data-step="try">
          ${stepHead(4, 'crmStepTryTitle', 'Try it')}
          <div class="crm-step-body">
            <p class="crm-hint crm-hint-lead">Type any phone number and select Test to see what opens.</p>
            <div class="sp-actions crm-try-row">
              <input type="text" id="screenPopTestNumber" class="crm-input" inputmode="tel" autocomplete="off" placeholder="(315) 555-0100" aria-label="Phone number to test with">
              <button type="button" class="btn btn-primary" id="screenPopTest">Test</button>
            </div>
            <div class="crm-preview" id="crmPreview" data-ok="true">
              <div class="crm-preview-head"><span class="crm-preview-label">Opens</span><span class="crm-preview-for" id="crmPreviewFor"></span></div>
              <code class="crm-preview-url" id="crmPreviewUrl">…</code>
            </div>
            <p class="crm-feedback" id="crmTestFeedback" role="status"></p>
          </div>
        </li>
      </ol>`;
  }

  function wrapUpCardHTML() {
    return `
      <div class="card-header">${ICONS.clipboard}<span>After-call wrap-up</span></div>
      <label class="toggle-label">
        <span class="toggle-text">Ask how each call went<span class="setting-description">After you answer a call, pick how it went and add a note. Both are saved with the call in Recent calls and in the download.</span></span>
        <input type="checkbox" id="crmWrapUpEnabled" class="toggle-checkbox" role="switch">
        <span class="toggle-slider" aria-hidden="true"></span>
      </label>
      <div class="setting-divider"></div>
      <div class="crm-field" id="crmDispositionsField">
        <label class="field-label" for="crmNewDisposition">Call outcomes</label>
        <p class="setting-description">The choices you see after a call. The first nine also have number keys.</p>
        <div class="crm-chips crm-chips-edit" id="crmDispositionList"></div>
        <div class="crm-add-row" id="crmAddDispositionRow">
          <input type="text" id="crmNewDisposition" class="crm-input" maxlength="40" placeholder="Add an outcome, like Sale">
          <button type="button" class="btn btn-secondary" id="crmAddDisposition">Add</button>
        </div>
      </div>`;
  }

  function diagnosticsCardHTML() {
    return `
      <div class="set-line crm-diag-line">
        <span class="set-line-text">
          <span class="field-label">Diagnostics file</span>
          <span class="setting-description crm-diag-text">For Vaspian support: your version, settings, connection, recent calls and log. Never your PIN or keys.</span>
        </span>
        <button type="button" class="btn btn-secondary btn-sm crm-diag-btn" id="crmExportDiagnostics">${ICONS.download}<span>Download</span></button>
      </div>
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
      crmSecureCrmBaseUrl: document.getElementById('crmSecureCrmBaseUrl').value.trim(),
      crmZohoCrmOrg: document.getElementById('crmZohoCrmOrg').value.trim()
    };
    const key = document.getElementById('crmZohoKey');
    if (key.dataset.dirty === '1') v.crmZohoKey = key.value.trim();
    for (const k of Object.keys(v)) if (isLocked(k)) delete v[k];
    return v;
  }

  // ------------------------------------------------------ guided steps ---
  let tested = null;       // preset that last passed "Try it" (this page view)
  let previewOk = true;

  /** Radios and the segmented control follow the (visually hidden) selects. */
  function syncPickers() {
    const crm = document.getElementById('screenPopCrm').value;
    document.querySelectorAll('#screenPopCard .crm-preset').forEach((row) => {
      const on = row.dataset.value === crm;
      row.classList.toggle('is-selected', on);
      const r = row.querySelector('input');
      r.checked = on;
      r.disabled = isLocked('screenPopCrm');
    });
    document.querySelector('#screenPopCard .crm-presets').classList.toggle('is-locked', isLocked('screenPopCrm'));
    const trig = document.getElementById('screenPopTrigger').value;
    document.querySelectorAll('#screenPopCard .crm-seg-opt').forEach((opt) => {
      const r = opt.querySelector('input');
      r.checked = r.value === trig;
      r.disabled = isLocked('screenPopTrigger');
      opt.classList.toggle('is-selected', r.checked);
    });
    document.getElementById('crmTriggerHint').textContent = trig === 'offer'
      ? 'Opens while the phone rings, so the record is ready when you pick up.'
      : 'Opens once you pick up, so calls you miss don\'t open tabs.';
  }

  /** Done marks and the short state word on each step. Nothing is ever locked behind a step. */
  function updateSteps() {
    const card = document.getElementById('screenPopCard');
    if (!card) return;
    const on = document.getElementById('screenPopEnabled').checked;
    card.classList.toggle('is-off', !on);
    document.getElementById('crmSpLead').textContent = on
      ? 'When a call comes in, One Click opens the caller\'s record for you.'
      : 'Turn this on to open the caller\'s record in your CRM. Setup takes four short steps.';
    const crm = document.getElementById('screenPopCrm').value;
    const name = presetName(crm);
    const fields = (ui.presets[crm] || { fields: [] }).fields;
    const key = document.getElementById('crmZohoKey').value.trim();
    const org = document.getElementById('crmZohoCrmOrg').value.trim();
    const url = document.getElementById('screenPopUrl').value.trim();
    let connect = { done: true, word: 'Done' };
    if (crm === 'zoho' && !key && !ui.zohoKeyManaged) connect = { done: false, word: 'Needs your key' };
    else if (crm === 'zohocrm' && !/(^(org)?\d{5,15}$)|\/crm\/org\d{5,15}/i.test(org)) connect = { done: false, word: org ? 'Check the org ID' : 'Needs your org ID' };
    else if (crm === 'custom' && (!url || !previewOk)) connect = { done: false, word: url ? 'Check the link' : 'Needs your link' };
    document.getElementById('crmStepConnectTitle').textContent = crm === 'custom' ? 'Add your link' : `Connect ${name}`;
    const none = document.getElementById('crmConnectNone');
    none.hidden = fields.length > 0;
    none.textContent = `Nothing to set up. ${name} works as soon as screen pop is on.`;
    const set = (step, done, word) => {
      const li = card.querySelector(`.crm-step[data-step="${step}"]`);
      li.classList.toggle('is-done', !!done);
      const st = li.querySelector('.crm-step-state');
      st.textContent = word || '';
      st.dataset.tone = done ? 'done' : (word ? 'todo' : '');
    };
    set('pick', true, 'Done');
    set('connect', connect.done, connect.word);
    set('when', true, 'Done');
    set('try', tested === crm, tested === crm ? 'Done' : '');
  }

  function showPresetFields() {
    const preset = document.getElementById('screenPopCrm').value;
    const p = ui.presets[preset] || { fields: [] };
    document.querySelectorAll('#screenPopCard [data-preset-field]').forEach((f) => { f.hidden = !p.fields.includes(f.dataset.presetField); });
    document.getElementById('crmPresetHint').textContent = '';
    syncPickers();
    updateSteps();
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
    if (values.crmSecureCrmBaseUrl === '') values.crmSecureCrmBaseUrl = ui.defaults.crmSecureCrmBaseUrl;
    const r = await send({ action: 'crm:preview', values, phone: testNumber, name: testNumber ? 'Test call' : 'Pat Caller' });
    const box = document.getElementById('crmPreview');
    const url = document.getElementById('crmPreviewUrl');
    const forEl = document.getElementById('crmPreviewFor');
    if (!box) return;
    // Zoho Desk goes through Vaspian's service: its address is ours to manage, never shown to agents.
    box.hidden = document.getElementById('screenPopCrm').value === 'zoho';
    previewOk = !!(r && r.ok);
    box.dataset.ok = previewOk ? 'true' : 'false';
    url.textContent = previewOk ? r.url : String((r && r.error) || 'Preview unavailable').replace(/\bURL\b/g, 'link');
    forEl.textContent = previewOk ? (testNumber ? `for ${displayNumber(testNumber)}` : 'for a call from (315) 555-0100') : '';
    document.querySelector('#crmPreview .crm-preview-label').textContent = previewOk ? 'Opens' : 'This link won\'t work';
    updateSteps();
  }

  async function saveScreenPop() {
    const r = await send({ action: 'crm:saveSettings', values: formValues() });
    const key = document.getElementById('crmZohoKey');
    if (key) key.dataset.dirty = '0';
    const fb = document.getElementById('crmTestFeedback');
    if (r && !r.ok && r.refused && r.refused.length && fb) {
      fb.dataset.tone = 'error';
      fb.textContent = r.refused.some((k) => /BaseUrl$/.test(k)) ? 'That address doesn\'t start with https://, so it wasn\'t saved.'
        : r.refused.includes('crmZohoCrmOrg') ? 'That doesn\'t look like a Zoho CRM org ID. Copy it from the Zoho CRM address bar, like org123456789.'
          : 'Some settings couldn\'t be saved.';
    } else if (r && r.ok) {
      // Show the org ID the way it was saved, not the whole address the agent pasted.
      const org = document.getElementById('crmZohoCrmOrg');
      const m = org && org.value.match(/\/crm\/org(\d{5,15})(?:[/?#]|$)/i);
      if (m && document.activeElement !== org) org.value = `org${m[1]}`;
    }
    updateSteps();
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
    set('crmSecureCrmBaseUrl', v.crmSecureCrmBaseUrl === ui.defaults.crmSecureCrmBaseUrl ? '' : (v.crmSecureCrmBaseUrl || ''));
    set('crmZohoCrmOrg', v.crmZohoCrmOrg ? `org${v.crmZohoCrmOrg}` : '');
    const key = document.getElementById('crmZohoKey');
    if (key && document.activeElement !== key && key.dataset.dirty !== '1') {
      key.value = ui.zohoKeyManaged ? '' : (v.crmZohoKey || '');
      key.placeholder = ui.zohoKeyManaged ? LOCK_TEXT : 'Paste your access key';
    }
    applyLock(document.getElementById('screenPopEnabled'), 'screenPopEnabled');
    applyLock(document.getElementById('screenPopTrigger'), 'screenPopTrigger');
    applyLock(document.getElementById('screenPopInternal'), 'screenPopInternal');
    applyLock(document.getElementById('screenPopCrm'), 'screenPopCrm');
    applyLock(document.getElementById('screenPopUrl'), 'screenPopUrl');
    applyLock(document.getElementById('crmZohoKey'), 'crmZohoKey');
    applyLock(document.getElementById('crmSecureCrmBaseUrl'), 'crmSecureCrmBaseUrl');
    applyLock(document.getElementById('crmZohoCrmOrg'), 'crmZohoCrmOrg');
    document.querySelectorAll('#screenPopCard .crm-token').forEach((b) => { b.disabled = isLocked('screenPopUrl'); });
    const reveal = document.getElementById('crmZohoKeyReveal');
    if (reveal) reveal.hidden = isLocked('crmZohoKey') || !!ui.zohoKeyManaged;
    showPresetFields();
    schedulePreview();
  }

  function renderStatus(status) {
    const el = document.getElementById('screenPopStatus');
    const btn = document.getElementById('screenPopReconnect');
    if (!el || !btn) return;
    if (!status) { el.textContent = 'Not connected'; el.dataset.state = 'off'; return; }
    const labels = { off: 'Not connected', connecting: 'Connecting…', connected: 'Connected', retrying: 'Reconnecting…', error: 'Not connected' };
    // The Account card explains a rejected PIN right above this row: keep the status short.
    const detail = status.reason === 'auth' ? "PIN not accepted" : status.detail;
    el.textContent = `${labels[status.state] || status.state}${detail ? ' · ' + detail : ''}`;
    el.dataset.state = status.state;
    // After a PIN rejection, Reconnect would resend the rejected PIN (3 failures
    // lock the extension); the way out is saving credentials again.
    const authStop = status.state === 'error' && status.reason === 'auth';
    btn.disabled = authStop;
    btn.title = authStop ? "Your PIN wasn't accepted. Save the correct PIN above first." : 'Reconnect the live connection';
  }

  function wireScreenPop() {
    const byId = (id) => document.getElementById(id);
    const card = byId('screenPopCard');
    byId('screenPopEnabled').addEventListener('change', () => { updateSteps(); saveScreenPop(); });
    byId('screenPopTrigger').addEventListener('change', () => { syncPickers(); saveScreenPop(); });
    byId('screenPopInternal').addEventListener('change', saveScreenPop);
    byId('screenPopCrm').addEventListener('change', async () => {
      byId('crmTestFeedback').textContent = '';
      showPresetFields(); schedulePreview(); await saveScreenPop();
    });
    // The radio list and the segmented control drive the selects, so one save path runs.
    card.addEventListener('change', (e) => {
      const r = e.target;
      if (r.name !== 'crmPresetPick' && r.name !== 'crmTriggerPick') return;
      const sel = byId(r.name === 'crmPresetPick' ? 'screenPopCrm' : 'screenPopTrigger');
      if (sel.disabled || sel.value === r.value) return;
      sel.value = r.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (const id of ['screenPopUrl', 'crmSecureCrmBaseUrl', 'crmZohoCrmOrg', 'crmZohoKey', 'screenPopTestNumber']) {
      byId(id).addEventListener('input', () => { if (id === 'crmZohoKey') byId(id).dataset.dirty = '1'; updateSteps(); schedulePreview(); });
      if (id !== 'screenPopTestNumber') byId(id).addEventListener('change', saveScreenPop);
    }
    byId('screenPopTestNumber').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); byId('screenPopTest').click(); } });
    byId('crmZohoKeyReveal').addEventListener('click', (e) => {
      const input = byId('crmZohoKey');
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      e.currentTarget.textContent = show ? 'Hide' : 'Show';
      e.currentTarget.setAttribute('aria-pressed', String(show));
    });
    card.addEventListener('click', (e) => {
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
        fb.textContent = 'Type a 10-digit phone number to test with.';
        byId('screenPopTestNumber').focus();
        return;
      }
      await saveScreenPop();
      await updatePreview();
      if (byId('crmPreview').dataset.ok !== 'true') { fb.textContent = 'Fix the link in step 2 first.'; return; }
      const r = await send({ action: 'screenPopTest', phoneNumber });
      if (r && r.success) {
        tested = byId('screenPopCrm').value;
        fb.dataset.tone = 'ok';
        fb.textContent = `Opened ${presetName(tested)} for ${displayNumber(phoneNumber)}.`;
      } else fb.textContent = `Couldn't open it${r && r.error ? `: ${r.error}` : ''}.`;
      updateSteps();
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
      ? items.map((d, i) => `<span class="crm-chip crm-chip-static${locked ? ' crm-chip-locked' : ''}"><span class="crm-chip-text">${esc(d)}</span>${locked ? '' : `<button type="button" class="crm-chip-x" data-index="${i}" title="Remove ${esc(d)}" aria-label="Remove ${esc(d)}">${ICONS.x}</button>`}</span>`).join('')
      : '<span class="crm-empty-chips">No outcomes yet. Agents can still add a note.</span>';
    document.getElementById('crmAddDispositionRow').hidden = locked;
    applyLock(document.getElementById('crmWrapUpEnabled'), 'crmWrapUpEnabled');
    document.getElementById('crmWrapUpEnabled').checked = !!ui.values.crmWrapUpEnabled;
    const field = document.getElementById('crmDispositionsField');
    field.classList.toggle('crm-field-locked', locked);
    const note = field.querySelector(':scope > .crm-lock-note');
    if (locked && !note) field.insertAdjacentHTML('beforeend', LOCK_NOTE);
    else if (!locked && note) note.remove();
    syncLockBadge(badgeCard(field));
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
      const i = +x.dataset.index;
      next.splice(i, 1);
      saveDispositions(next).then(() => {
        // Keep keyboard focus in the list: the next chip's remove button, else the add field.
        const xs = document.querySelectorAll('#crmDispositionList .crm-chip-x');
        (xs[Math.min(i, xs.length - 1)] || input).focus();
      });
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
        tenant.title = 'Set by your IT team';
        if (!(tenant.nextElementSibling && tenant.nextElementSibling.classList.contains('crm-lock-note'))) tenant.insertAdjacentHTML('afterend', LOCK_NOTE);
      } else if (!tenant.value && ui.values.tenant) {
        tenant.value = ui.values.tenant;
      }
    }
    const prefix = document.getElementById('dialPrefix');
    if (prefix && isLocked('dialPrefix')) {
      prefix.value = ui.values.dialPrefix;
      prefix.disabled = true;
      prefix.title = 'Set by your IT team';
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
    const chip = (id, label, n, extra = '') => `<button type="button" class="crm-filter${filter === id ? ' active' : ''}" data-filter="${id}" aria-pressed="${filter === id}"><span class="crm-filter-label">${label}</span> <span class="crm-count${n ? extra : ''}" data-n="${n}">${n}</span></button>`;
    const empty = { missed: ['No missed calls', 'Every call in your list was answered.'], inbound: ['No inbound calls yet', 'Calls you get show up here.'], outbound: ['No outbound calls yet', 'Calls you make show up here.'] };
    return `<div class="crm-filters" role="group" aria-label="Show calls">
        ${chip('all', 'All', c.all)}${chip('missed', 'Missed', c.missed, ' crm-count-missed')}${chip('inbound', 'Inbound', c.inbound)}${chip('outbound', 'Outbound', c.outbound)}
      </div>
      ${filter !== 'all' && c[filter] === 0 ? `<div class="crm-filter-empty history-empty"><p>${empty[filter][0]}</p><span>${empty[filter][1]}</span></div>` : ''}`;
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
    const who = item.name ? `${nice(item.name)} · ${displayNumber(item.phoneNumber)}` : displayNumber(item.phoneNumber);
    const sub = [c.direction === 'inbound' ? 'Inbound' : 'Outbound', item.durationSec > 0 ? formatDuration(item.durationSec) : null].filter(Boolean).join(' · ');
    const list = dispositions();
    const keys = Math.min(list.length, 9);
    const picked = list.indexOf(wrapDraft.disposition);
    const canSave = !!(wrapDraft.disposition || wrapDraft.note.trim());
    m.innerHTML = `
      <section class="crm-wrapup" data-key="${esc(item.key)}" tabindex="-1" aria-labelledby="crmWrapUpTitle" aria-describedby="crmWrapUpHint">
        <div class="crm-wrapup-head">
          <span class="crm-dir crm-dir-${c.kind}" role="img" aria-label="${esc(c.title)}">${ICONS[c.kind]}</span>
          <div class="crm-wrapup-titles">
            <h2 class="crm-wrapup-title" id="crmWrapUpTitle">How did the call go?</h2>
            <div class="crm-wrapup-sub"><span class="crm-wrapup-who">${esc(who)}</span> <span class="crm-sep" aria-hidden="true">\u00B7</span> ${esc(sub)}</div>
            <div class="crm-wrapup-more">${wrapQueue.length > 1 ? `${wrapQueue.length - 1} more to wrap up` : ''}</div>
          </div>
          <button type="button" class="icon-btn crm-wrapup-close" data-act="skip" title="Skip" aria-label="Skip this wrap-up">${ICONS.x}</button>
        </div>
        ${list.length ? `<div class="crm-chips crm-chips-pick" role="radiogroup" aria-label="How the call went">${list.map((d, i) => `<button type="button" class="crm-chip crm-chip-pick${wrapDraft.disposition === d ? ' selected' : ''}" role="radio" aria-checked="${wrapDraft.disposition === d}" tabindex="${(picked === -1 ? i === 0 : i === picked) ? 0 : -1}" data-value="${esc(d)}"${i < 9 ? ` aria-keyshortcuts="${i + 1}"` : ''}>${esc(d)}</button>`).join('')}</div>` : ''}
        <textarea class="crm-wrapup-note" rows="2" maxlength="2000" placeholder="Add a note (optional)" aria-label="Note">${esc(wrapDraft.note)}</textarea>
        <div class="crm-wrapup-actions">
          <p class="crm-wrapup-hint" id="crmWrapUpHint">${keys ? `<kbd>1</kbd>${keys > 1 ? `–<kbd>${keys}</kbd>` : ''} to pick · ` : ''}<kbd>Ctrl</kbd>+<kbd>Enter</kbd> to save</p>
          <button type="button" class="btn-link crm-skip" data-act="skip">Skip</button>
          <button type="button" class="btn btn-primary btn-sm crm-wrapup-save" data-act="save" aria-keyshortcuts="Control+Enter"${canSave ? '' : ' disabled'}>Save</button>
        </div>
      </section>`;
  }

  /** Select a disposition in the open prompt (toggle: picking the selected one again clears it). */
  function pickDisposition(m, value, { toggle = true, focus = false } = {}) {
    wrapDraft.disposition = toggle && wrapDraft.disposition === value ? '' : value;
    const chips = [...m.querySelectorAll('.crm-chip-pick')];
    const sel = chips.findIndex((b) => b.dataset.value === wrapDraft.disposition);
    chips.forEach((b, i) => {
      const on = i === sel;
      b.classList.toggle('selected', on);
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = (sel === -1 ? (b.dataset.value === value) : on) ? 0 : -1;
      if (focus && b.dataset.value === value) b.focus();
    });
    const save = m.querySelector('[data-act="save"]');
    if (save) save.disabled = !(wrapDraft.disposition || wrapDraft.note.trim());
  }

  function wireWrapUp() {
    const m = ensureWrapUpMount();
    if (!m) return;
    m.addEventListener('click', async (e) => {
      const chip = e.target.closest('.crm-chip-pick');
      if (chip) { pickDisposition(m, chip.dataset.value); return; }
      const act = e.target.closest('[data-act]');
      if (!act || !wrapDraft.key || act.disabled) return;
      const key = wrapDraft.key;
      act.disabled = true;
      if (act.dataset.act === 'save') await send({ action: 'crm:wrapUpSave', key, disposition: wrapDraft.disposition, note: wrapDraft.note });
      else await send({ action: 'crm:wrapUpDismiss', key });
    });
    // Keyboard, while the prompt has focus: 1-9 pick (not while typing the note),
    // arrows move through the choices, Ctrl+Enter saves from anywhere in it.
    m.addEventListener('keydown', (e) => {
      const card = m.querySelector('.crm-wrapup');
      if (!card || !card.contains(e.target)) return;
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const save = card.querySelector('[data-act="save"]');
        e.preventDefault();
        if (save && !save.disabled) save.click();
        return;
      }
      if (e.target.closest('textarea, input') || e.ctrlKey || e.metaKey || e.altKey) return;
      const chips = [...card.querySelectorAll('.crm-chip-pick')];
      if (/^[1-9]$/.test(e.key)) {
        const chip = chips[+e.key - 1];
        if (chip) { e.preventDefault(); pickDisposition(m, chip.dataset.value, { toggle: false, focus: true }); }
        return;
      }
      const i = chips.indexOf(e.target);
      if (i === -1) return;
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (step) {
        e.preventDefault();
        const next = chips[(i + step + chips.length) % chips.length];
        pickDisposition(m, next.dataset.value, { toggle: false, focus: true });
      }
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
    card.className = 'settings-card crm-card crm-sp-card';
    card.innerHTML = screenPopCardHTML();
    const wrap = document.createElement('div');
    wrap.id = 'crmWrapUpCard';
    wrap.className = 'settings-card crm-card';
    wrap.innerHTML = wrapUpCardHTML();
    // Export diagnostics lives in Help and support (its own card when that mount is missing).
    const diag = document.createElement('div');
    diag.id = 'crmDiagnosticsCard';
    const diagMount = document.getElementById('supportDiagnosticsMount');
    diag.className = diagMount ? 'crm-diag' : 'settings-card crm-card';
    diag.innerHTML = (diagMount ? '<div class="setting-divider"></div>' : '') + diagnosticsCardHTML();
    // Settings pages: Screen pop and After-call wrap-up each have their own mount.
    const wrapMount = document.getElementById('crmWrapUpSettingsMount');
    if (els.settings) els.settings.append(card);
    if (wrapMount) wrapMount.append(wrap); else if (els.settings) els.settings.append(wrap);
    if (diagMount) diagMount.append(diag); else if (els.settings) els.settings.append(diag);

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
    historyItemHTML,
    csvRows,
    displayNumber,
    formatDuration
  };
})();
