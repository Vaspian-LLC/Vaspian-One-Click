// Settings index: one row per page, each row showing its current value, and the
// page navigation (index -> page -> back). Pages are plain sections in popup.html;
// the feature modules (crm-ui, operator-ui, settings-transfer-ui) render into them.
//   window.OneClickSettings.open('account' | 'calling' | ... )   opens a page
//   window.OneClickSettings.refresh()                             re-reads every row value
'use strict';

(() => {
  const $ = (id) => document.getElementById(id);
  const CRM_LABELS = {
    zoho: 'Zoho Desk', zohocrm: 'Zoho CRM', simplicity: 'Simplicity', securecrm: 'SecureCRM',
    googlecontacts: 'Google Contacts', google: 'Google search', custom: 'Your own link'
  };
  const LOCK_SELECTOR = '.crm-lock-note, .crm-lock-badge, [title="Set by your IT team"]';
  let current = null;

  function setText(id, text) { const el = $(id); if (el && el.textContent !== text) el.textContent = text; }

  /** Show one page (or the index when name is null) and move focus sensibly. */
  function open(name, { focus = true } = {}) {
    const index = $('settingsIndex');
    const pages = document.querySelectorAll('#settings .set-page');
    current = name || null;
    index.hidden = !!current;
    pages.forEach((p) => { p.hidden = p.dataset.page !== current; });
    const tc = document.querySelector('.tab-content');
    if (tc) tc.scrollTop = 0;
    if (!focus) return;
    if (current) {
      const h = document.querySelector(`#sp-${current} h2`);
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    } else {
      refresh();
    }
  }

  function back(fromPage) {
    open(null, { focus: false });
    const row = document.querySelector(`.set-row[data-page="${fromPage}"]`);
    if (row) row.focus({ preventScroll: true });
    refresh();
  }

  /** Re-read storage and the rendered pages, and update every row. */
  async function refresh() {
    let sync = {};
    let local = {};
    try {
      [sync, local] = await Promise.all([
        chrome.storage.sync.get(['tenant', 'extension', 'isLoggedIn', 'dialPrefix', 'clickToCallEnabled', 'clickToCallDisabledSites',
          'screenPopEnabled', 'screenPopCrm', 'screenPopTrigger', 'crmWrapUpEnabled', 'missedCallAlerts']),
        chrome.storage.local.get(['apiStatus', 'missedCallAlerts'])
      ]);
    } catch (e) { /* keep defaults */ }

    // Account
    const signedIn = sync.isLoggedIn === true && sync.extension;
    const st = local.apiStatus || {};
    const conn = st.state === 'connected' ? 'Connected'
      : st.state === 'error' && st.reason === 'auth' ? 'PIN not accepted'
        : st.state === 'error' || st.state === 'retrying' ? 'Live updates paused' : 'Connecting';
    setText('sv-account', signedIn ? `Ext ${sync.extension} · ${conn}` : 'Not signed in');

    // Calling: read the controls popup.js filled (they reflect managed policy too)
    const prefixEl = $('dialPrefix');
    const prefix = prefixEl ? prefixEl.value : (sync.dialPrefix || '');
    const alertsEl = $('missedCallAlerts');
    const alerts = alertsEl ? alertsEl.checked : false;
    setText('sv-calling', `${prefix ? `Outside line ${prefix}` : 'No outside line prefix'} · Missed-call alerts ${alerts ? 'on' : 'off'}`);

    // Click to call
    const c2c = sync.clickToCallEnabled !== false;
    const sites = Array.isArray(sync.clickToCallDisabledSites) ? sync.clickToCallDisabledSites.length : 0;
    setText('sv-clicktocall', c2c ? (sites ? `On · Off on ${sites} site${sites === 1 ? '' : 's'}` : 'On') : 'Off');

    // Screen pop: prefer what the page shows (managed policy can override storage)
    const spOn = $('screenPopEnabled') ? $('screenPopEnabled').checked : sync.screenPopEnabled === true;
    const crmSel = $('screenPopCrm');
    const crm = crmSel && crmSel.selectedOptions[0] ? crmSel.selectedOptions[0].textContent.trim() : (CRM_LABELS[sync.screenPopCrm] || '');
    const trigSel = $('screenPopTrigger');
    const trig = trigSel ? trigSel.value : sync.screenPopTrigger;
    setText('sv-screenpop', spOn && crm ? `${crm} · Opens when ${trig === 'offer' ? 'it rings' : 'you answer'}` : 'Off');

    // Wrap-up
    const wuEl = $('crmWrapUpEnabled');
    const wu = wuEl ? wuEl.checked : sync.crmWrapUpEnabled === true;
    setText('sv-wrapup', wu ? 'On · Asks after each answered call' : 'Off');

    // Shortcuts: the answer shortcut is the one people look for
    try {
      const cmds = await chrome.commands.getAll();
      const ans = cmds.find((c) => c.name === 'answer');
      setText('sv-shortcuts', ans && ans.shortcut ? `${ans.shortcut} answers a call` : 'Answer, hang up, DND and call a number');
    } catch (e) { setText('sv-shortcuts', 'Answer, hang up, DND and call a number'); }

    // Team view row only for admins (operator-ui renders a card when allowed)
    const tv = $('setRowTeamview');
    if (tv) tv.hidden = !($('operatorSettingsMount') && $('operatorSettingsMount').children.length);

    renderLocks();
  }

  /** "Set by IT" on rows whose page has a policy-locked field, plus the one-line note. */
  function renderLocks() {
    let any = false;
    document.querySelectorAll('#settingsIndex .set-row').forEach((row) => {
      const page = $(`sp-${row.dataset.page}`);
      const lock = row.querySelector('.set-lock');
      if (!page || !lock) return;
      const locked = !!page.querySelector(LOCK_SELECTOR);
      lock.hidden = !locked;
      any = any || locked;
    });
    const note = $('settingsItNote');
    if (note) note.hidden = !any;
  }

  async function renderShortcuts() {
    const list = $('shortcutList');
    if (!list) return;
    let cmds = [];
    try { cmds = await chrome.commands.getAll(); } catch (e) { /* none */ }
    const rows = cmds.filter((c) => c.description).map((c) => {
      const li = document.createElement('li');
      li.className = 'shortcut-row';
      const label = document.createElement('span');
      label.textContent = c.description;
      const keys = document.createElement('span');
      keys.className = 'shortcut-keys';
      if (c.shortcut) {
        c.shortcut.split('+').forEach((k) => { const kbd = document.createElement('kbd'); kbd.textContent = k; keys.append(kbd); });
      } else {
        keys.textContent = 'Not set';
        keys.classList.add('is-unset');
      }
      li.append(label, keys);
      return li;
    });
    list.replaceChildren(...rows);
  }

  function init() {
    const settings = $('settings');
    if (!settings) return;
    settings.addEventListener('click', (e) => {
      const row = e.target.closest('.set-row');
      if (row) {
        // Signed out, Account means "sign in", which lives on Calls.
        if (row.dataset.page === 'account' && document.body.classList.contains('signed-out') && typeof window.goToSignIn === 'function') {
          window.goToSignIn();
          return;
        }
        open(row.dataset.page);
        if (row.dataset.page === 'shortcuts') renderShortcuts();
        return;
      }
      const backBtn = e.target.closest('[data-back]');
      if (backBtn) back(backBtn.closest('.set-page').dataset.page);
    });
    // Escape goes back from a page to the index.
    settings.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && current && !e.target.closest('input, textarea, select')) { e.preventDefault(); back(current); }
    });
    // Opening the Settings tab always lands on the index.
    const tab = $('tab-settings');
    if (tab) tab.addEventListener('click', () => open(null, { focus: false }));
    const change = $('changeShortcuts');
    if (change) change.addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

    try {
      const m = chrome.runtime.getManifest();
      setText('settingsVersion', `Vaspian One Click ${m.version}`);
    } catch (e) { /* not in an extension page */ }

    // Values change from many places: storage, the controls themselves, and modules rendering late.
    chrome.storage.onChanged.addListener(() => refresh());
    settings.addEventListener('change', () => setTimeout(refresh, 50));
    const mo = new MutationObserver(() => { clearTimeout(mo.t); mo.t = setTimeout(refresh, 120); });
    ['crmSettingsMount', 'crmWrapUpSettingsMount', 'operatorSettingsMount'].forEach((id) => { if ($(id)) mo.observe($(id), { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'title', 'class'] }); });
    refresh();
    setTimeout(refresh, 600);
  }

  window.OneClickSettings = { open, refresh };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
