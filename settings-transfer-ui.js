// Settings transfer UI: the "Share settings" (export) and "Import settings"
// sub-page bodies. Self-contained so the redesign can move them anywhere:
//
//   window.OneClickUI.settingsTransfer.mount(el, { mode: 'export' | 'import' })
//   (also window.mountSettingsTransfer). Returns { reset }.
//
// The work happens in the service worker (settings-transfer.js) through
// settings:export / settings:importPreview / settings:import. The page only
// reads the chosen file and saves the export with a Blob and <a download>
// (no downloads permission). Ids are prefixed xfer- and stable (rig tests).
// Every string the user sees is in COPY.

(function () {
  'use strict';

  const COPY = {
    exportTitle: 'Share settings',
    exportLead: 'Save your setup to a file and send it to your coworkers. They import it to get the same setup in one step.',
    exportIncludesTitle: 'In the file',
    exportIncludes: ['Screen pop and where it opens', 'After-call wrap-up and call outcomes', 'Outside line prefix', 'Click to call and the sites where it’s off'],
    exportNever: 'Never your PIN, extension, call history or which phone you use.',
    includeKeys: 'Include access keys',
    keysWarning: 'Anyone with this file can use your access keys. Share it privately.',
    keysOff: 'Access keys stay out of the file. Coworkers enter their own.',
    download: 'Download settings file',
    downloading: 'Saving…',
    exported: (name) => `Saved ${name}. Send it to your coworkers privately.`,
    exportedNoKeys: (name) => `Saved ${name}. It has no access keys.`,
    exportFailed: 'Couldn’t create the file. Try again.',

    importTitle: 'Import settings',
    importLead: 'Use the settings file your admin sent you. You’ll see what changes before anything is saved.',
    choose: 'Choose settings file',
    chooseAnother: 'Choose another file',
    noFile: 'No file chosen',
    reading: 'Checking the file…',
    tooBig: 'This file is too big to be a One Click settings file. Choose the .json file your admin sent you.',
    unreadable: 'Couldn’t read that file. Choose the .json file your admin sent you.',
    noReply: 'One Click didn’t respond. Close and reopen it, then try again.',
    changesTitle: (n) => `What changes (${n})`,
    skippedTitle: 'Not changed',
    appliedTitle: 'Changed',
    from: 'from',
    to: 'to',
    reasons: { locked: 'Set by your IT team', invalid: 'Not a valid value in this file' },
    noChanges: 'Your settings already match this file.',
    apply: (n) => `Import ${n} ${n === 1 ? 'setting' : 'settings'}`,
    applyAnyway: (n) => `Import ${n} anyway`,
    applying: 'Importing…',
    cancel: 'Cancel',
    done: 'Done',
    applied: (n) => (n ? `Imported ${n} ${n === 1 ? 'setting' : 'settings'}.` : 'Nothing needed to change.'),
    applyFailed: 'Couldn’t import the file. Nothing was changed. Try again.'
  };

  const MAX_BYTES = 256 * 1024;

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve(undefined); else resolve(res);
        });
      } catch (e) { resolve(undefined); }
    });
  }

  // ---------------------------------------------------------------- export ---
  function mountExport(el) {
    const keys = h('input', { type: 'checkbox', id: 'xfer-export-keys', checked: true, 'aria-describedby': 'xfer-export-keys-note' });
    const note = h('p', { id: 'xfer-export-keys-note', class: 'xfer-callout' });
    const status = h('p', { id: 'xfer-export-status', class: 'xfer-muted', role: 'status', 'aria-live': 'polite' });
    const button = h('button', { type: 'button', id: 'xfer-export-download', class: 'xfer-btn xfer-btn-primary xfer-btn-block', text: COPY.download });

    const syncNote = () => {
      note.textContent = keys.checked ? COPY.keysWarning : COPY.keysOff;
      note.className = keys.checked ? 'xfer-callout' : 'xfer-muted';
    };
    keys.addEventListener('change', syncNote);
    syncNote();

    button.addEventListener('click', async () => {
      button.disabled = true;
      button.textContent = COPY.downloading;
      status.textContent = '';
      const r = await send({ action: 'settings:export', includeSecrets: keys.checked });
      button.disabled = false;
      button.textContent = COPY.download;
      if (!r || !r.ok) { status.textContent = COPY.exportFailed; return; }
      const url = URL.createObjectURL(new Blob([r.text], { type: 'application/json' }));
      const a = h('a', { href: url, download: r.filename, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      status.textContent = [r.includesSecrets ? COPY.exported(r.filename) : COPY.exportedNoKeys(r.filename), ...(r.warnings || [])].join(' ');
    });

    el.replaceChildren(h('section', { class: 'xfer', id: 'xfer-export', 'aria-labelledby': 'xfer-export-title' },
      h('h4', { class: 'xfer-title', id: 'xfer-export-title', text: COPY.exportTitle }),
      h('p', { class: 'xfer-lead', text: COPY.exportLead }),
      h('div', { class: 'xfer-box' },
        h('h5', { class: 'xfer-subtitle', text: COPY.exportIncludesTitle }),
        h('ul', { class: 'xfer-list', id: 'xfer-export-includes' }, COPY.exportIncludes.map((t) => h('li', { text: t }))),
        h('p', { class: 'xfer-muted', text: COPY.exportNever })),
      h('label', { class: 'xfer-check', for: 'xfer-export-keys' }, keys, h('span', { text: COPY.includeKeys })),
      note,
      button,
      status));
    return { reset() { keys.checked = true; syncNote(); status.textContent = ''; } };
  }

  // ---------------------------------------------------------------- import ---
  function mountImport(el, opts) {
    const input = h('input', { type: 'file', id: 'xfer-import-file', class: 'xfer-file-input', accept: '.json,application/json' });
    const chooseLabel = h('label', { for: 'xfer-import-file', id: 'xfer-import-choose', class: 'xfer-btn xfer-btn-block', text: COPY.choose });
    const fileName = h('p', { id: 'xfer-import-filename', class: 'xfer-muted', text: COPY.noFile });
    const result = h('div', { id: 'xfer-import-result', class: 'xfer-file', 'aria-live': 'polite' });
    let text = null;
    let lastSummary = [];

    function reset() {
      text = null;
      input.value = '';
      fileName.textContent = COPY.noFile;
      chooseLabel.textContent = COPY.choose;
      result.replaceChildren();
    }

    const callout = (msg, kind, id) => h('p', { class: `xfer-callout${kind ? ` xfer-callout-${kind}` : ''}`, id, text: msg });
    const errorBox = (msg) => h('p', { class: 'xfer-callout xfer-callout-danger', id: 'xfer-import-error', role: 'alert', text: msg });

    /** The service worker puts the different-company warning first and flags it with tenantMismatch. */
    function warningsList(warnings, tenantMismatch) {
      if (!warnings || !warnings.length) return null;
      return h('ul', { class: 'xfer-callouts', id: 'xfer-import-warnings' },
        warnings.map((w, i) => h('li', { class: `xfer-callout${tenantMismatch && i === 0 ? ' xfer-callout-danger' : ''}`, text: w })));
    }

    function changesList(id, title, rows) {
      return h('div', { id },
        h('h5', { class: 'xfer-subtitle', text: title }),
        h('ul', { class: 'xfer-changes' }, rows.map((c) => h('li', { 'data-key': c.key },
          h('span', { class: 'xfer-change-label', text: c.label }),
          h('span', { class: 'xfer-change-values' },
            h('span', { class: 'xfer-from' }, h('span', { class: 'xfer-sr', text: `${COPY.from} ` }), c.from),
            h('span', { class: 'xfer-arrow', 'aria-hidden': 'true', text: '→' }),
            h('span', { class: 'xfer-to' }, h('span', { class: 'xfer-sr', text: `${COPY.to} ` }), c.to))))));
    }

    function skippedList(skipped) {
      if (!skipped || !skipped.length) return null;
      return h('div', { id: 'xfer-import-skipped' },
        h('h5', { class: 'xfer-subtitle', text: COPY.skippedTitle }),
        h('ul', { class: 'xfer-changes' }, skipped.map((s) => h('li', { 'data-key': s.key, 'data-reason': s.reason },
          h('span', { class: 'xfer-change-label', text: s.label }),
          h('span', { class: 'xfer-reason', text: COPY.reasons[s.reason] || COPY.reasons.invalid })))));
    }

    function renderPreview(p) {
      const n = p.summary.length;
      const otherCompany = !!p.tenantMismatch;
      lastSummary = p.summary;
      const apply = h('button', {
        type: 'button', id: 'xfer-import-apply', class: 'xfer-btn xfer-btn-primary',
        text: otherCompany ? COPY.applyAnyway(n) : COPY.apply(n)
      });
      const cancel = h('button', { type: 'button', id: 'xfer-import-cancel', class: 'xfer-btn', text: n ? COPY.cancel : COPY.done, onclick: reset });
      apply.addEventListener('click', async () => {
        apply.disabled = true;
        cancel.disabled = true;
        apply.textContent = COPY.applying;
        const r = await send({ action: 'settings:import', text });
        if (!r || !r.ok) {
          result.replaceChildren(errorBox((r && r.error) || COPY.applyFailed), h('div', { class: 'xfer-actions' }, h('button', { type: 'button', id: 'xfer-import-cancel', class: 'xfer-btn', text: COPY.cancel, onclick: reset })));
          return;
        }
        renderApplied(r);
      });
      result.replaceChildren(...[
        warningsList(p.warnings, p.tenantMismatch),
        n ? changesList('xfer-import-summary', COPY.changesTitle(n), p.summary)
          : callout(COPY.noChanges, 'ok', 'xfer-import-nochanges'),
        skippedList(p.skipped),
        h('div', { class: 'xfer-actions' }, n ? apply : null, cancel)
      ].filter(Boolean));
    }

    function renderApplied(r) {
      result.replaceChildren(...[
        callout(COPY.applied(r.applied.length), 'ok', 'xfer-import-done'),
        r.applied.length ? changesList('xfer-import-applied', COPY.appliedTitle, r.applied.map((k) => lastSummary.find((c) => c.key === k)).filter(Boolean)) : null,
        warningsList((r.warnings || []).slice(r.tenantMismatch ? 1 : 0)),
        skippedList(r.skipped),
        h('div', { class: 'xfer-actions' }, h('button', { type: 'button', id: 'xfer-import-cancel', class: 'xfer-btn', text: COPY.done, onclick: reset }))
      ].filter(Boolean));
      const target = el.querySelector('#xfer-import-done');
      if (target) { target.setAttribute('tabindex', '-1'); target.focus(); }
      if (opts && typeof opts.onImported === 'function') { try { opts.onImported(r); } catch (e) { /* host page */ } }
      el.dispatchEvent(new CustomEvent('xfer:imported', { bubbles: true, detail: { applied: r.applied, skipped: r.skipped } }));
    }

    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      input.value = ''; // so choosing the same (fixed) file again fires change
      fileName.textContent = file.name;
      chooseLabel.textContent = COPY.chooseAnother;
      result.replaceChildren(h('p', { class: 'xfer-muted', text: COPY.reading }));
      if (file.size > MAX_BYTES) { text = null; result.replaceChildren(errorBox(COPY.tooBig)); return; }
      try { text = await file.text(); } catch (e) { text = null; result.replaceChildren(errorBox(COPY.unreadable)); return; }
      const p = await send({ action: 'settings:importPreview', text });
      if (!p) { result.replaceChildren(errorBox(COPY.noReply)); return; }
      if (!p.ok) { result.replaceChildren(errorBox(p.error)); return; }
      renderPreview(p);
    });

    el.replaceChildren(h('section', { class: 'xfer', id: 'xfer-import', 'aria-labelledby': 'xfer-import-title' },
      h('h4', { class: 'xfer-title', id: 'xfer-import-title', text: COPY.importTitle }),
      h('p', { class: 'xfer-lead', text: COPY.importLead }),
      h('div', { class: 'xfer-file' }, input, chooseLabel, fileName),
      result));
    return { reset };
  }

  /**
   * Mount a sub-page body into `el`.
   * @param {HTMLElement} el
   * @param {{mode: 'export'|'import', onImported?: function}} opts
   */
  function mount(el, opts = {}) {
    if (!el) return null;
    return opts.mode === 'import' ? mountImport(el, opts) : mountExport(el);
  }

  window.OneClickUI = window.OneClickUI || {};
  window.OneClickUI.settingsTransfer = { mount, COPY };
  window.mountSettingsTransfer = mount;

  // Settings › Account › Share or import settings.
  // Sharing is for the company's phone admins (the same isAdmin the Team view uses);
  // everyone can import the file their admin sends. The admin flag arrives with the
  // connection, so the export appears once connected and only goes away on a
  // connected status that says "not an admin" (a reconnect never hides it mid-use).
  document.addEventListener('DOMContentLoaded', () => {
    const byId = (a, b) => document.getElementById(a) || document.getElementById(b);
    const exportMount = byId('xferExportMount', 'xfer-temp-export');
    const group = document.getElementById('xferGroup');
    let exportUi = null;
    function applyAdmin(status, first) {
      if (!exportMount) return;
      const admin = !!(status && status.isAdmin);
      if (!first && !admin && !(status && status.state === 'connected')) return;
      if (admin && !exportUi) exportUi = mount(exportMount, { mode: 'export' });
      else if (!admin && exportUi) { exportMount.replaceChildren(); exportUi = null; }
      if (group) {
        group.classList.toggle('xfer-import-only', !admin);
        const title = group.querySelector('.set-group-title');
        if (title) title.textContent = admin ? 'Share or import settings' : 'Import settings';
      }
    }
    applyAdmin(null, true);
    try {
      chrome.storage.local.get(['apiStatus'], (r) => applyAdmin(r && r.apiStatus, true));
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.apiStatus) applyAdmin(changes.apiStatus.newValue, false);
      });
    } catch (e) { /* not an extension page */ }
    mount(byId('xferImportMount', 'xfer-temp-import'), {
      mode: 'import',
      // popup.js reads the Calling card only on load: refresh it after an import.
      onImported: () => { if (typeof window.loadSettings === 'function') window.loadSettings(); }
    });
  });
})();
