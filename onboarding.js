// First-run setup ("onboarding"): Welcome (with the optional settings file from
// an admin) -> Sign in -> Test your phone -> Screen pop (optional) -> Done.
//
// A mountable sub-page: window.OneClickUI.onboarding.mount(el). welcome.html is
// a thin shell around it, opened in a tab on a fresh install (background.js)
// and from Settings > Help and support.
//
// It saves nothing of its own: it uses the same messages and storage as the
// Settings screen, so a setting changed here and in Settings is one setting.
//   sign in      OneClickSignIn.signIn (signin.js, shared with Settings)
//   phone        apiGetPhones / apiSetRingPhone (the phone picker), apiStatus
//   screen pop   crm:getSettings / crm:saveSettings
//   import       settings:importPreview / settings:import (settings-transfer;
//                the import is hidden when those messages don't exist)
// State (step, done) lives in onboarding-state.js. No network call happens
// until the user signs in or reaches the phone step.

(function () {
  'use strict';

  // ------------------------------------------------------------ strings ---
  // Every user-facing string, in one place for the UX lead.
  const S = {
    product: 'Vaspian One Click',
    stepNames: { signin: 'Sign in', phone: 'Your phone', screenpop: 'Screen pop', done: 'Done' },
    stepOf: (n, total) => `Step ${n} of ${total}`,
    back: 'Back',
    lockedNote: 'Set by your IT team',

    welcomeTitle: 'Welcome to One Click',
    welcomeLead: 'Call any number on a web page with one click, and see who’s calling before you answer.',
    welcomeTime: 'Setup takes about two minutes. You can skip it and come back any time.',
    getStarted: 'Get started',
    skipSetup: 'Skip setup',

    importTitle: 'Have a settings file from your admin?',
    importLead: 'It sets up calling, screen pop and wrap-up in one go.',
    importChoose: 'Choose file',
    importReading: 'Reading the file…',
    importChanges: 'This file will change:',
    importNoChanges: 'Nothing in this file is different from what you have.',
    importSkipped: 'Not changed:',
    importConfirm: 'Import these settings',
    importCancel: 'Cancel',
    importApplying: 'Importing…',
    importDone: (n) => (n === 1 ? 'Imported 1 setting.' : `Imported ${n} settings.`),
    importFailed: 'That file couldn’t be imported. Ask your admin for a new one.',
    importTooBig: 'That file is too big to be a One Click settings file.',
    skipReasons: { locked: 'Set by your IT team' },
    skipReasonOther: 'Not used here',

    signinTitle: 'Sign in',
    signinLead: 'Use the extension and PIN from your Vaspian phone.',
    tenantLabel: 'Company name or main number',
    tenantHint: 'For example, acme or (716) 555-0100',
    tenantFromFile: 'Filled in from your admin’s settings file. Change it if it’s not your company.',
    extensionLabel: 'Extension',
    pinLabel: 'PIN',
    show: 'Show',
    hide: 'Hide',
    signinButton: 'Sign in',
    signinChecking: 'Checking…',
    signinSkip: 'Skip for now',
    signedInAs: (ext, tenant) => `You’re signed in as Ext ${ext} at ${tenant}.`,
    continue: 'Continue',
    switchUser: 'Sign in as someone else',
    signinOk: 'You’re signed in.',
    signinErrors: {
      missing: 'Enter your company, extension and PIN.',
      rejected: 'That extension and PIN didn’t match. Check them and try again.',
      bad_tenant: 'We couldn’t find that company. Check the name or main number and try again.',
      expired_pin: 'Your PIN has expired. Reset it in the Vaspian portal or ask your admin, then sign in here.',
      other: 'We couldn’t reach the phone system. Check your internet connection and try again.'
    },
    lockWarnOne: 'One more wrong try locks your extension for an hour. If you’re not sure of your PIN, ask your admin first.',
    lockWarnNone: 'After three wrong tries your extension is locked for an hour. Wait before trying again, or call Vaspian support at (716) 961-2120.',

    phoneTitle: 'Test your phone',
    phoneLead: 'When you place a call, One Click rings your desk phone or softphone first. Let’s check that it’s on.',
    phoneChecking: 'Looking for your phone…',
    phoneReady: 'Your phone is ready',
    phoneReadyMany: (n) => `You have ${n} phones signed in`,
    phonePickLabel: 'Ring this phone for calls you start',
    phonePickHint: 'Incoming calls still ring all your phones.',
    phoneDefault: (label) => (label ? `Default (${label})` : 'Default phone'),
    phoneNone: (ext) => `No phone is signed in to Ext ${ext}`,
    phoneNoneHelp: 'Turn on your desk phone or open your softphone, then check again. You can finish setup now; One Click uses your phone as soon as it’s on.',
    phonePin: 'Your PIN wasn’t accepted',
    phonePinHelp: 'Sign in again with your current PIN.',
    phoneUnknown: 'We couldn’t check your phone right now',
    phoneUnknownHelp: 'Check your internet connection, then check again.',
    phoneSignedOut: 'Sign in first so we can find your phone.',
    goSignIn: 'Go to sign in',
    checkAgain: 'Check again',
    skipRest: 'Skip the rest, I’ll set it up later',

    spTitle: 'Screen pop',
    spLead: 'When a call comes in, One Click can open the caller’s record in your CRM, so you know who it is before you say hello.',
    spEnable: 'Open the caller’s record',
    spCrm: 'Your CRM',
    spWhen: 'Open it',
    spWhenAnswer: 'When I answer',
    spWhenOffer: 'When it starts ringing',
    spZohoKey: 'Access key',
    spZohoKeyHint: 'Your Zoho Desk admin gets this key when they connect Zoho Desk to Vaspian. Ask them or Vaspian support.',
    spZohoKeyPlaceholder: 'Paste your access key',
    spZohoCrmOrg: 'Zoho CRM org ID',
    spZohoCrmOrgHint: 'Open Zoho CRM and copy the part after /crm/ in the address bar, or paste the whole address.',
    spSecureCrm: 'Dialer address',
    spSecureCrmHint: 'Leave it empty unless SecureCRM gave you a different address.',
    spCustom: 'Page address',
    spCustomHint: 'Put {phone10} where the caller’s number goes.',
    spSave: 'Save and continue',
    spSaving: 'Saving…',
    spSkip: 'Skip for now',
    spRefusedUrl: 'That address isn’t a valid https:// web address, so it wasn’t saved.',
    spRefusedOrg: 'That doesn’t look like a Zoho CRM org ID. Copy it from the Zoho CRM address bar, like org123456789.',
    spRefused: 'Some settings couldn’t be saved. Check them and try again.',
    spNoReply: 'One Click isn’t responding. Close this tab and open it again from Settings.',

    doneTitle: 'You’re all set',
    doneTitleSkipped: 'Set it up whenever you like',
    doneAccount: 'Account',
    donePhone: 'Phone',
    doneScreenPop: 'Screen pop',
    doneSignedIn: (ext, tenant) => `Ext ${ext} at ${tenant}`,
    doneSignedOut: 'Not signed in yet. Sign in from Settings.',
    donePhoneReady: (label) => (label ? `Ready (${label})` : 'Ready'),
    donePhoneNone: 'Not found yet',
    doneOff: 'Off',
    doneSpOn: (crm, trigger) => `${crm}, ${trigger === 'offer' ? 'when it rings' : 'when you answer'}`,
    doneLater: 'Calling, click to call, wrap-up and alerts can be changed any time in Settings.',
    doneOpen: 'Open One Click',
    doneOpened: 'One Click is open in the side panel.',
    doneOpenFailed: 'Click the One Click icon in your Chrome toolbar to open it.',
    donePin: 'Keep it handy: click the puzzle piece in your Chrome toolbar, then the pin next to Vaspian One Click.',
    doneRerun: 'To run setup again, go to Settings, then Help and support.',
    doneClose: 'Close this tab'
  };

  const State = self.OneClickOnboardingState;
  const SignIn = self.OneClickSignIn;
  const PHONE_WAIT_MS = 20000;
  const MAX_FILE_BYTES = 256 * 1024;

  // ------------------------------------------------------------ helpers ---
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
  }
  async function send(msg) {
    try { return await chrome.runtime.sendMessage(msg); } catch (e) { return undefined; }
  }
  const ICON = {
    ok: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    warn: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M12 4l9 16H3z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4M12 17.2v.1" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    lock: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2"/></svg>',
    back: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };
  const lockNote = (id) => `<p class="onb-locked" id="${id}">${ICON.lock}<span>${esc(S.lockedNote)}</span></p>`;

  // -------------------------------------------------------------- model ---
  const m = {
    root: null,
    state: null,
    step: 'welcome',
    windowId: null,
    importAvailable: false,
    screenPopImported: false,
    crm: null,          // crm:getSettings answer
    account: null,      // {tenant, extension, signedIn}
    phone: null,        // last phone check {kind, phones, choice}
    fileTenant: '',     // company from an imported settings file: sign-in prefill only
    signedInAt: 0,      // ms of a sign-in in this page: older connection status is stale
    showForm: false
  };

  async function loadAccount() {
    const s = await chrome.storage.sync.get(['tenant', 'extension', 'isLoggedIn']);
    m.account = { tenant: s.tenant || '', extension: s.extension || '', signedIn: !!(s.isLoggedIn && s.tenant && s.extension) };
  }
  async function loadCrm() {
    // The service worker may be waking up: a few tries, like crm-ui.js.
    for (let i = 0; i < 4; i++) {
      const r = await send({ action: 'crm:getSettings' });
      if (r && r.values) { m.crm = r; return; }
      await new Promise((res) => setTimeout(res, 300));
    }
  }
  const locked = (k) => !!(m.crm && Array.isArray(m.crm.locked) && m.crm.locked.includes(k));

  async function save(step) {
    m.state = step === 'skip' ? State.skip(m.state) : State.go(m.state, step);
    m.state.imported = m.screenPopImported;
    m.state.fileTenant = m.fileTenant;
    await chrome.storage.local.set({ [State.KEY]: m.state });
  }

  // ------------------------------------------------------------- render ---
  function flowSteps() {
    return ['signin', 'phone', 'screenpop', 'done'].filter((s) => !(s === 'screenpop' && m.screenPopImported));
  }

  function stepperHTML() {
    if (m.step === 'welcome') return '';
    const steps = flowSteps();
    const at = steps.indexOf(m.step);
    return `
      <nav class="onb-stepper" aria-label="${esc(S.stepOf(at + 1, steps.length))}">
        <ol>${steps.map((s, i) => `<li class="${i < at ? 'is-done' : i === at ? 'is-current' : ''}"${i === at ? ' aria-current="step"' : ''}>
          <span class="onb-dot" aria-hidden="true">${i < at ? ICON.ok : i + 1}</span><span class="onb-step-name">${esc(S.stepNames[s])}</span></li>`).join('')}</ol>
      </nav>`;
  }

  function backHTML() {
    if (m.step === 'welcome') return '';
    return `<button type="button" class="onb-back" id="onb-back">${ICON.back}<span>${esc(S.back)}</span></button>`;
  }

  const views = {};

  async function render({ focus = true } = {}) {
    const v = views[m.step];
    m.root.dataset.step = m.step;
    m.root.innerHTML = `
      <header class="onb-header">
        <img class="onb-logo" src="vaspian-just-logo.png" alt="" width="28" height="28">
        <span class="onb-product">${esc(S.product)}</span>
      </header>
      ${stepperHTML()}
      <section class="onb-card" id="onb-step-${m.step}" aria-labelledby="onb-title">
        ${backHTML()}
        ${v.html()}
      </section>`;
    const back = document.getElementById('onb-back');
    if (back) back.addEventListener('click', () => goTo(State.prevStep(m.step, { screenPopImported: m.screenPopImported })));
    await v.wire();
    if (focus) {
      const h = document.getElementById('onb-title');
      if (h) h.focus();
    }
  }

  async function goTo(step) {
    m.step = step;
    m.showForm = false;
    await save(step);
    await render();
  }
  async function skipAll() {
    m.step = 'done';
    await save('skip');
    await render();
  }

  // ----------------------------------------------------------- welcome ---
  views.welcome = {
    html: () => `
      <h1 id="onb-title" tabindex="-1">${esc(S.welcomeTitle)}</h1>
      <p class="onb-lead">${esc(S.welcomeLead)}</p>
      <p class="onb-muted">${esc(S.welcomeTime)}</p>
      <div class="onb-import" id="onb-import" ${m.importAvailable ? '' : 'hidden'}>
        <h2 id="onb-import-title">${esc(S.importTitle)}</h2>
        <p class="onb-muted">${esc(S.importLead)}</p>
        <input type="file" id="onb-import-file" class="onb-visually-hidden" accept=".json,application/json" aria-labelledby="onb-import-title onb-import-choose">
        <button type="button" class="onb-btn onb-btn-secondary" id="onb-import-choose">${esc(S.importChoose)}</button>
        <div id="onb-import-preview" class="onb-import-preview" hidden></div>
        <p class="onb-result" id="onb-import-result" role="status" aria-live="polite"></p>
      </div>
      <div class="onb-actions">
        <button type="button" class="onb-btn onb-btn-primary" id="onb-start">${esc(S.getStarted)}</button>
        <button type="button" class="onb-btn onb-btn-quiet" id="onb-skip">${esc(S.skipSetup)}</button>
      </div>`,
    async wire() {
      document.getElementById('onb-start').addEventListener('click', () => goTo(State.nextStep('welcome')));
      document.getElementById('onb-skip').addEventListener('click', skipAll);
      if (m.importAvailable) wireImport();
    }
  };

  function wireImport() {
    const file = document.getElementById('onb-import-file');
    const choose = document.getElementById('onb-import-choose');
    const preview = document.getElementById('onb-import-preview');
    const result = document.getElementById('onb-import-result');
    let text = null;
    const say = (msg, tone) => { result.textContent = msg; result.dataset.tone = tone || ''; };
    const reset = () => { text = null; preview.hidden = true; preview.innerHTML = ''; file.value = ''; choose.hidden = false; };

    choose.addEventListener('click', () => file.click());
    file.addEventListener('change', async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      if (f.size > MAX_FILE_BYTES) { say(S.importTooBig, 'error'); reset(); return; }
      say(S.importReading);
      text = await f.text();
      const r = await send({ action: 'settings:importPreview', text });
      if (!r || !r.ok) { say((r && r.error) || S.importFailed, 'error'); reset(); return; }
      const fileTenant = typeof r.fileTenant === 'string' ? r.fileTenant.trim() : '';
      say('');
      preview.innerHTML = previewHTML(r);
      preview.hidden = false;
      choose.hidden = true;
      document.getElementById('onb-import-cancel').addEventListener('click', () => { reset(); say(''); choose.focus(); });
      const confirm = document.getElementById('onb-import-confirm');
      confirm.addEventListener('click', async () => {
        confirm.disabled = true;
        confirm.textContent = S.importApplying;
        const res = await send({ action: 'settings:import', text });
        if (!res || !res.ok) {
          say((res && res.error) || S.importFailed, 'error');
          confirm.disabled = false;
          confirm.textContent = S.importConfirm;
          return;
        }
        const applied = Array.isArray(res.applied) ? res.applied : [];
        // Before sign-in, the file's company becomes the sign-in prefill (still editable, saved only by signing in).
        if (fileTenant && !m.account.signedIn) m.fileTenant = fileTenant;
        m.screenPopImported = m.screenPopImported || State.importSetScreenPop(applied);
        // Later steps start from the imported values.
        await Promise.all([loadAccount(), loadCrm()]);
        reset();
        const warn = (res.warnings || []).join(' ');
        say([S.importDone(applied.length), warn].filter(Boolean).join(' '), 'ok');
        document.getElementById('onb-start').focus();
      });
      preview.querySelector('h3').focus();
    });
  }

  function previewHTML(r) {
    const rows = (r.summary || []).map((x) => `
      <li><span class="onb-k">${esc(x.label || x.key)}</span>
        <span class="onb-v">${x.from ? `<span class="onb-from">${esc(x.from)}</span> <span aria-hidden="true">→</span><span class="onb-visually-hidden"> to </span> ` : ''}${esc(x.to)}</span></li>`).join('');
    const skipped = (r.skipped || []).map((x) => `
      <li><span class="onb-k">${esc(x.label || x.key)}</span>
        <span class="onb-v">${x.reason === 'locked' ? ICON.lock : ''}${esc(S.skipReasons[x.reason] || S.skipReasonOther)}</span></li>`).join('');
    const warnings = (r.warnings || []).map((w) => `<li>${ICON.warn}<span>${esc(w)}</span></li>`).join('');
    return `
      <h3 tabindex="-1">${esc(rows ? S.importChanges : S.importNoChanges)}</h3>
      ${rows ? `<ul class="onb-kv" id="onb-import-changes">${rows}</ul>` : ''}
      ${skipped ? `<h4>${esc(S.importSkipped)}</h4><ul class="onb-kv" id="onb-import-skipped">${skipped}</ul>` : ''}
      ${warnings ? `<ul class="onb-warnings" id="onb-import-warnings">${warnings}</ul>` : ''}
      <div class="onb-actions onb-actions-inline">
        ${rows ? `<button type="button" class="onb-btn onb-btn-primary" id="onb-import-confirm">${esc(S.importConfirm)}</button>` : ''}
        <button type="button" class="onb-btn onb-btn-secondary" id="onb-import-cancel">${esc(S.importCancel)}</button>
      </div>`;
  }

  // ------------------------------------------------------------ sign in ---
  views.signin = {
    html() {
      const a = m.account;
      if (a.signedIn && !m.showForm) {
        return `
          <h1 id="onb-title" tabindex="-1">${esc(S.signinTitle)}</h1>
          <p class="onb-banner onb-banner-ok" id="onb-signedin">${ICON.ok}<span>${esc(S.signedInAs(a.extension, a.tenant))}</span></p>
          <div class="onb-actions">
            <button type="button" class="onb-btn onb-btn-primary" id="onb-signin-continue">${esc(S.continue)}</button>
            <button type="button" class="onb-btn onb-btn-quiet" id="onb-signin-switch">${esc(S.switchUser)}</button>
          </div>`;
      }
      const tLocked = locked('tenant');
      const effective = (m.crm && m.crm.values && m.crm.values.tenant) || a.tenant || '';
      const tenant = tLocked ? effective : (m.fileTenant || effective);
      const fromFile = !tLocked && !!m.fileTenant && tenant === m.fileTenant;
      return `
        <h1 id="onb-title" tabindex="-1">${esc(S.signinTitle)}</h1>
        <p class="onb-lead">${esc(S.signinLead)}</p>
        <form id="onb-signin-form" novalidate>
          <div class="onb-field">
            <label for="onb-tenant">${esc(S.tenantLabel)}</label>
            <input id="onb-tenant" name="tenant" type="text" autocomplete="organization" spellcheck="false" value="${esc(tenant)}"
              ${tLocked ? `readonly aria-describedby="onb-tenant-locked"` : 'aria-describedby="onb-tenant-hint"'}>
            ${tLocked ? lockNote('onb-tenant-locked') : `<p class="onb-hint" id="onb-tenant-hint">${esc(fromFile ? S.tenantFromFile : S.tenantHint)}</p>`}
          </div>
          <div class="onb-field">
            <label for="onb-extension">${esc(S.extensionLabel)}</label>
            <input id="onb-extension" name="extension" type="text" inputmode="numeric" autocomplete="username" spellcheck="false" value="${esc(a.extension)}">
          </div>
          <div class="onb-field">
            <label for="onb-pin">${esc(S.pinLabel)}</label>
            <input id="onb-pin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" spellcheck="false">
          </div>
          <p class="onb-banner onb-banner-warn" id="onb-lock-warning" hidden>${ICON.warn}<span></span></p>
          <p class="onb-result" id="onb-signin-result" role="status" aria-live="polite"></p>
          <div class="onb-actions">
            <button type="submit" class="onb-btn onb-btn-primary" id="onb-signin-submit">${esc(S.signinButton)}</button>
            <button type="button" class="onb-btn onb-btn-quiet" id="onb-signin-skip">${esc(S.signinSkip)}</button>
          </div>
        </form>`;
    },
    async wire() {
      const cont = document.getElementById('onb-signin-continue');
      if (cont) {
        cont.addEventListener('click', () => goTo('phone'));
        document.getElementById('onb-signin-switch').addEventListener('click', () => { m.showForm = true; render(); });
        return;
      }
      const form = document.getElementById('onb-signin-form');
      const submit = document.getElementById('onb-signin-submit');
      const result = document.getElementById('onb-signin-result');
      const pin = document.getElementById('onb-pin');
      document.getElementById('onb-signin-skip').addEventListener('click', skipAll);
      showLockWarning(SignIn.triesLeft(await SignIn.failures()));

      let busy = false;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (busy) return; // a double click must not be two attempts
        const values = {
          tenant: document.getElementById('onb-tenant').value,
          extension: document.getElementById('onb-extension').value,
          pin: pin.value
        };
        if (!values.tenant.trim() || !values.extension.trim() || !values.pin) {
          result.dataset.tone = 'error';
          result.textContent = S.signinErrors.missing;
          return;
        }
        busy = true;
        submit.disabled = true;
        submit.textContent = S.signinChecking;
        result.dataset.tone = '';
        result.textContent = S.signinChecking;
        const r = await SignIn.signIn(values);
        busy = false;
        submit.disabled = false;
        submit.textContent = S.signinButton;
        if (r.ok) {
          pin.value = '';
          result.dataset.tone = 'ok';
          result.textContent = S.signinOk;
          m.signedInAt = Date.now();
          await loadAccount();
          m.phone = null;
          await goTo('phone');
          return;
        }
        result.dataset.tone = 'error';
        result.textContent = S.signinErrors[r.reason] || S.signinErrors.other;
        showLockWarning(r.triesLeft);
        (r.reason === 'bad_tenant' ? document.getElementById('onb-tenant') : pin).focus();
      });
    }
  };

  function showLockWarning(left) {
    const box = document.getElementById('onb-lock-warning');
    if (!box) return;
    const msg = left === 1 ? S.lockWarnOne : left === 0 ? S.lockWarnNone : '';
    box.hidden = !msg;
    box.querySelector('span').textContent = msg;
  }

  // -------------------------------------------------------------- phone ---
  views.phone = {
    html: () => `
      <h1 id="onb-title" tabindex="-1">${esc(S.phoneTitle)}</h1>
      <p class="onb-lead">${esc(S.phoneLead)}</p>
      <div class="onb-phone" id="onb-phone-result" role="status" aria-live="polite" aria-busy="true">
        <p class="onb-checking"><span class="onb-spinner" aria-hidden="true"></span>${esc(S.phoneChecking)}</p>
      </div>
      <div class="onb-actions">
        <button type="button" class="onb-btn onb-btn-primary" id="onb-phone-continue">${esc(S.continue)}</button>
        <button type="button" class="onb-btn onb-btn-secondary" id="onb-phone-again" hidden>${esc(S.checkAgain)}</button>
        <button type="button" class="onb-btn onb-btn-quiet" id="onb-skip-rest">${esc(S.skipRest)}</button>
      </div>`,
    async wire() {
      document.getElementById('onb-phone-continue').addEventListener('click', () => goTo(State.nextStep('phone', { screenPopImported: m.screenPopImported })));
      document.getElementById('onb-skip-rest').addEventListener('click', skipAll);
      document.getElementById('onb-phone-again').addEventListener('click', () => checkPhone());
      checkPhone();
    }
  };

  /**
   * Resolve with apiStatus once it settles (connected / error), or after a
   * timeout. Right after a sign-in, a status from before it (the previous
   * user's, or an old PIN rejection) doesn't count.
   */
  function settledStatus(timeoutMs, notBefore = 0) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (st) => {
        if (done) return;
        done = true;
        chrome.storage.onChanged.removeListener(onChange);
        clearTimeout(timer);
        resolve(st || null);
      };
      const fresh = (st) => !notBefore || Date.parse(st.at || st.since || 0) >= notBefore - 1000;
      const settled = (st) => st && (st.state === 'connected' || st.state === 'error') && fresh(st);
      const onChange = (c, area) => { if (area === 'local' && c.apiStatus && settled(c.apiStatus.newValue)) finish(c.apiStatus.newValue); };
      const timer = setTimeout(async () => {
        const st = (await chrome.storage.local.get('apiStatus')).apiStatus;
        finish(st && fresh(st) ? st : null);
      }, timeoutMs);
      chrome.storage.onChanged.addListener(onChange);
      chrome.storage.local.get('apiStatus').then((r) => { if (settled(r.apiStatus)) finish(r.apiStatus); });
    });
  }

  /** One honest check: never a polling loop, only again when the user asks. */
  async function checkPhone() {
    const box = document.getElementById('onb-phone-result');
    const again = document.getElementById('onb-phone-again');
    if (!box) return;
    box.setAttribute('aria-busy', 'true');
    box.innerHTML = `<p class="onb-checking"><span class="onb-spinner" aria-hidden="true"></span>${esc(S.phoneChecking)}</p>`;
    again.hidden = true;
    await loadAccount();
    let kind;
    let phones = [];
    let choice = null;
    if (!m.account.signedIn) {
      kind = 'signedout';
    } else {
      const st = await settledStatus(PHONE_WAIT_MS, m.signedInAt);
      if (st && st.reason === 'auth') kind = 'pin';
      else {
        const r = await send({ action: 'apiGetPhones' });
        if (r && r.ok) {
          phones = r.phones || [];
          choice = r.choice || null;
          kind = phones.length ? 'ready' : 'none';
        } else {
          const st2 = (await chrome.storage.local.get('apiStatus')).apiStatus;
          const fresh2 = st2 && (!m.signedInAt || Date.parse(st2.at || st2.since || 0) >= m.signedInAt - 1000);
          kind = fresh2 && st2.reason === 'auth' ? 'pin' : 'unknown';
        }
      }
    }
    if (!document.getElementById('onb-phone-result')) return; // left the step meanwhile
    m.phone = { kind, phones, choice };
    box.innerHTML = phoneResultHTML(m.phone);
    box.dataset.kind = kind;
    box.setAttribute('aria-busy', 'false');
    again.hidden = !(kind === 'none' || kind === 'unknown');
    const fix = document.getElementById('onb-phone-signin');
    if (fix) fix.addEventListener('click', () => { m.showForm = true; goTo('signin'); });
    const pick = document.getElementById('onb-ring-phone');
    if (pick) {
      pick.addEventListener('change', async () => {
        const p = phones.find((x) => x.phoneId === pick.value);
        await send({ action: 'apiSetRingPhone', choice: p ? { phoneId: p.phoneId, model: p.model, label: p.label } : null });
        m.phone.choice = p ? { phoneId: p.phoneId, model: p.model, label: p.label } : null;
      });
    }
  }

  function phoneResultHTML(p) {
    if (p.kind === 'signedout') {
      return `<p class="onb-banner">${esc(S.phoneSignedOut)}</p>
        <button type="button" class="onb-btn onb-btn-secondary" id="onb-phone-signin">${esc(S.goSignIn)}</button>`;
    }
    if (p.kind === 'pin') {
      return `<p class="onb-banner onb-banner-error">${ICON.warn}<span><strong>${esc(S.phonePin)}</strong><br>${esc(S.phonePinHelp)}</span></p>
        <button type="button" class="onb-btn onb-btn-secondary" id="onb-phone-signin">${esc(S.goSignIn)}</button>`;
    }
    if (p.kind === 'none') {
      return `<p class="onb-banner onb-banner-warn">${ICON.warn}<span><strong>${esc(S.phoneNone(m.account.extension))}</strong><br>${esc(S.phoneNoneHelp)}</span></p>`;
    }
    if (p.kind === 'unknown') {
      return `<p class="onb-banner onb-banner-warn">${ICON.warn}<span><strong>${esc(S.phoneUnknown)}</strong><br>${esc(S.phoneUnknownHelp)}</span></p>`;
    }
    if (p.phones.length === 1) {
      return `<p class="onb-banner onb-banner-ok">${ICON.ok}<span><strong>${esc(S.phoneReady)}</strong><br>${esc(p.phones[0].label)}</span></p>`;
    }
    const def = p.phones.find((x) => x.isDefault);
    const current = p.choice ? (p.phones.find((x) => x.phoneId === p.choice.phoneId) || p.phones.find((x) => p.choice.model && x.model === p.choice.model)) : null;
    return `<p class="onb-banner onb-banner-ok">${ICON.ok}<span><strong>${esc(S.phoneReadyMany(p.phones.length))}</strong></span></p>
      <div class="onb-field">
        <label for="onb-ring-phone">${esc(S.phonePickLabel)}</label>
        <select id="onb-ring-phone" aria-describedby="onb-ring-phone-hint">
          <option value="">${esc(S.phoneDefault(def && def.label))}</option>
          ${p.phones.map((x) => `<option value="${esc(x.phoneId)}"${current && current.phoneId === x.phoneId ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}
        </select>
        <p class="onb-hint" id="onb-ring-phone-hint">${esc(S.phonePickHint)}</p>
      </div>`;
  }

  // --------------------------------------------------------- screen pop ---
  /** Per-preset fields shown here. Zoho Desk asks only for the access key, never a service address. */
  const SP_FIELDS = {
    crmZohoKey: { id: 'onb-sp-zoho-key', label: 'spZohoKey', hint: 'spZohoKeyHint', secret: true },
    crmZohoCrmOrg: { id: 'onb-sp-zoho-org', label: 'spZohoCrmOrg', hint: 'spZohoCrmOrgHint' },
    crmSecureCrmBaseUrl: { id: 'onb-sp-securecrm', label: 'spSecureCrm', hint: 'spSecureCrmHint' },
    screenPopUrl: { id: 'onb-sp-url', label: 'spCustom', hint: 'spCustomHint' }
  };

  views.screenpop = {
    html() {
      if (!m.crm) {
        return `<h1 id="onb-title" tabindex="-1">${esc(S.spTitle)}</h1>
          <p class="onb-result" data-tone="error" role="status">${esc(S.spNoReply)}</p>
          <div class="onb-actions"><button type="button" class="onb-btn onb-btn-primary" id="onb-sp-skip">${esc(S.spSkip)}</button></div>`;
      }
      const v = m.crm.values;
      const presets = m.crm.presets || {};
      const lockOn = locked('screenPopEnabled');
      const lockCrm = locked('screenPopCrm');
      const lockWhen = locked('screenPopTrigger');
      const fieldHTML = (key) => {
        const f = SP_FIELDS[key];
        const isLocked = locked(key);
        let value = v[key] || '';
        if (key === 'crmSecureCrmBaseUrl' && m.crm.defaults && value === m.crm.defaults.crmSecureCrmBaseUrl) value = '';
        if (key === 'crmZohoCrmOrg' && value) value = `org${value}`;
        const placeholder = key === 'crmZohoKey' ? (m.crm.zohoKeyManaged ? S.lockedNote : S.spZohoKeyPlaceholder) : '';
        const input = `<input id="${f.id}" data-key="${key}" type="${f.secret ? 'password' : 'text'}" spellcheck="false" autocomplete="off"
            value="${esc(f.secret && m.crm.zohoKeyManaged ? '' : value)}" placeholder="${esc(placeholder)}"
            aria-describedby="${f.id}-hint"${isLocked ? ' readonly' : ''}>`;
        return `<div class="onb-field" data-preset-field="${key}">
          <label for="${f.id}">${esc(S[f.label])}</label>
          ${f.secret && !isLocked ? `<div class="onb-input-row">${input}<button type="button" class="onb-btn onb-btn-secondary onb-reveal" id="${f.id}-reveal" aria-pressed="false" aria-controls="${f.id}">${esc(S.show)}</button></div>` : input}
          ${isLocked ? lockNote(`${f.id}-hint`) : `<p class="onb-hint" id="${f.id}-hint">${esc(S[f.hint])}</p>`}
        </div>`;
      };
      return `
        <h1 id="onb-title" tabindex="-1">${esc(S.spTitle)}</h1>
        <p class="onb-lead">${esc(S.spLead)}</p>
        <form id="onb-sp-form" novalidate>
          <div class="onb-switch-row">
            <input type="checkbox" role="switch" id="onb-sp-enabled" ${v.screenPopEnabled ? 'checked' : ''} ${lockOn ? 'disabled aria-describedby="onb-sp-enabled-locked"' : ''}>
            <label for="onb-sp-enabled">${esc(S.spEnable)}</label>
          </div>
          ${lockOn ? lockNote('onb-sp-enabled-locked') : ''}
          <div id="onb-sp-details" ${v.screenPopEnabled ? '' : 'hidden'}>
            <div class="onb-field">
              <label for="onb-sp-crm">${esc(S.spCrm)}</label>
              <select id="onb-sp-crm" ${lockCrm ? 'disabled aria-describedby="onb-sp-crm-locked"' : 'aria-describedby="onb-sp-crm-hint"'}>
                ${Object.entries(presets).map(([id, p]) => `<option value="${esc(id)}"${id === v.screenPopCrm ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}
              </select>
              ${lockCrm ? lockNote('onb-sp-crm-locked') : ''}
              <p class="onb-hint" id="onb-sp-crm-hint"></p>
            </div>
            ${Object.keys(SP_FIELDS).map(fieldHTML).join('')}
            <fieldset class="onb-field onb-radios" ${lockWhen ? 'disabled aria-describedby="onb-sp-when-locked"' : ''}>
              <legend>${esc(S.spWhen)}</legend>
              <label><input type="radio" name="onb-sp-when" id="onb-sp-when-answer" value="answer"${v.screenPopTrigger !== 'offer' ? ' checked' : ''}><span>${esc(S.spWhenAnswer)}</span></label>
              <label><input type="radio" name="onb-sp-when" id="onb-sp-when-offer" value="offer"${v.screenPopTrigger === 'offer' ? ' checked' : ''}><span>${esc(S.spWhenOffer)}</span></label>
              ${lockWhen ? lockNote('onb-sp-when-locked') : ''}
            </fieldset>
          </div>
          <p class="onb-result" id="onb-sp-result" role="status" aria-live="polite"></p>
          <div class="onb-actions">
            <button type="submit" class="onb-btn onb-btn-primary" id="onb-sp-save">${esc(S.spSave)}</button>
            <button type="button" class="onb-btn onb-btn-quiet" id="onb-sp-skip">${esc(S.spSkip)}</button>
          </div>
        </form>`;
    },
    async wire() {
      document.getElementById('onb-sp-skip').addEventListener('click', () => goTo('done'));
      const form = document.getElementById('onb-sp-form');
      if (!form) return;
      const enabled = document.getElementById('onb-sp-enabled');
      const crm = document.getElementById('onb-sp-crm');
      const details = document.getElementById('onb-sp-details');
      const keyInput = document.getElementById('onb-sp-zoho-key');
      const showFields = () => {
        const p = (m.crm.presets || {})[crm.value] || { fields: [] };
        form.querySelectorAll('[data-preset-field]').forEach((f) => { f.hidden = !p.fields.includes(f.dataset.presetField); });
        document.getElementById('onb-sp-crm-hint').textContent = p.description || '';
      };
      enabled.addEventListener('change', () => { details.hidden = !enabled.checked; });
      crm.addEventListener('change', showFields);
      showFields();
      if (keyInput) keyInput.addEventListener('input', () => { keyInput.dataset.dirty = '1'; });
      const reveal = document.getElementById('onb-sp-zoho-key-reveal');
      if (reveal) {
        reveal.addEventListener('click', () => {
          const showing = keyInput.type === 'text';
          keyInput.type = showing ? 'password' : 'text';
          reveal.textContent = showing ? S.show : S.hide;
          reveal.setAttribute('aria-pressed', String(!showing));
        });
      }
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const save = document.getElementById('onb-sp-save');
        const result = document.getElementById('onb-sp-result');
        const values = { screenPopEnabled: enabled.checked };
        if (enabled.checked) {
          values.screenPopCrm = crm.value;
          values.screenPopTrigger = form.querySelector('input[name="onb-sp-when"]:checked').value;
          const fields = ((m.crm.presets || {})[crm.value] || { fields: [] }).fields;
          for (const key of fields) {
            const input = form.querySelector(`[data-key="${key}"]`);
            if (!input) continue;
            // Send the key only when typed, so an empty field never wipes a saved or IT-provided key.
            if (key === 'crmZohoKey' && input.dataset.dirty !== '1') continue;
            values[key] = input.value.trim();
          }
        }
        for (const k of Object.keys(values)) if (locked(k)) delete values[k];
        save.disabled = true;
        save.textContent = S.spSaving;
        const r = await send({ action: 'crm:saveSettings', values });
        save.disabled = false;
        save.textContent = S.spSave;
        if (!r) { result.dataset.tone = 'error'; result.textContent = S.spNoReply; return; }
        if (!r.ok) {
          result.dataset.tone = 'error';
          const refused = r.refused || [];
          result.textContent = refused.some((k) => /BaseUrl$|screenPopUrl/.test(k)) ? S.spRefusedUrl
            : refused.includes('crmZohoCrmOrg') ? S.spRefusedOrg : S.spRefused;
          return;
        }
        await loadCrm();
        await goTo('done');
      });
    }
  };

  // --------------------------------------------------------------- done ---
  views.done = {
    html() {
      const a = m.account;
      const skipped = m.state && m.state.skipped;
      const rows = [[S.doneAccount, a.signedIn ? S.doneSignedIn(a.extension, a.tenant) : S.doneSignedOut]];
      if (m.phone && a.signedIn) {
        const p = m.phone;
        const chosen = p.choice && p.phones.find((x) => x.phoneId === p.choice.phoneId);
        if (p.kind === 'ready') rows.push([S.donePhone, S.donePhoneReady((chosen || p.phones.find((x) => x.isDefault) || p.phones[0] || {}).label)]);
        else if (p.kind === 'none') rows.push([S.donePhone, S.donePhoneNone]);
      }
      if (m.crm) {
        const v = m.crm.values;
        const label = ((m.crm.presets || {})[v.screenPopCrm] || {}).label || '';
        rows.push([S.doneScreenPop, v.screenPopEnabled ? S.doneSpOn(label, v.screenPopTrigger) : S.doneOff]);
      }
      return `
        <h1 id="onb-title" tabindex="-1">${esc(skipped ? S.doneTitleSkipped : S.doneTitle)}</h1>
        <dl class="onb-summary" id="onb-summary">
          ${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
        </dl>
        <p class="onb-muted">${esc(S.doneLater)}</p>
        <div class="onb-actions">
          <button type="button" class="onb-btn onb-btn-primary" id="onb-open-panel">${esc(S.doneOpen)}</button>
          <button type="button" class="onb-btn onb-btn-quiet" id="onb-close">${esc(S.doneClose)}</button>
        </div>
        <p class="onb-result" id="onb-open-result" role="status" aria-live="polite"></p>
        <p class="onb-muted" id="onb-pin-hint" hidden>${esc(S.donePin)}</p>
        <p class="onb-muted">${esc(S.doneRerun)}</p>`;
    },
    async wire() {
      const result = document.getElementById('onb-open-result');
      document.getElementById('onb-open-panel').addEventListener('click', () => {
        // Must run inside the click (user gesture): nothing is awaited before it.
        try {
          chrome.sidePanel.open({ windowId: m.windowId })
            .then(() => { result.dataset.tone = 'ok'; result.textContent = S.doneOpened; })
            .catch(() => { result.dataset.tone = ''; result.textContent = S.doneOpenFailed; });
        } catch (e) {
          result.textContent = S.doneOpenFailed;
        }
      });
      document.getElementById('onb-close').addEventListener('click', async () => {
        const tab = await chrome.tabs.getCurrent().catch(() => null);
        if (tab) chrome.tabs.remove(tab.id); else window.close();
      });
      try {
        const us = chrome.action && chrome.action.getUserSettings ? await chrome.action.getUserSettings() : null;
        document.getElementById('onb-pin-hint').hidden = !!(us && us.isOnToolbar);
      } catch (e) {
        document.getElementById('onb-pin-hint').hidden = false;
      }
    }
  };

  // -------------------------------------------------------------- mount ---
  /** Is the settings-file import there? Unknown action (or no answer) = hidden. */
  async function probeImport() {
    const r = await send({ action: 'settings:importPreview', text: '' });
    return !!(r && typeof r.ok === 'boolean' && !/unknown action/i.test(String(r.error || '')));
  }

  async function mount(el) {
    m.root = el;
    el.classList.add('onb');
    const stored = (await chrome.storage.local.get(State.KEY))[State.KEY];
    m.state = State.open(stored);
    m.step = State.resumeStep(m.state);
    m.screenPopImported = !!m.state.imported;
    m.fileTenant = m.state.fileTenant || '';
    await chrome.storage.local.set({ [State.KEY]: m.state });
    const [tab, importAvailable] = await Promise.all([
      chrome.tabs && chrome.tabs.getCurrent ? chrome.tabs.getCurrent().catch(() => null) : null,
      probeImport(),
      loadAccount(),
      loadCrm()
    ]);
    m.windowId = tab ? tab.windowId : null;
    m.importAvailable = importAvailable;
    await render();
  }

  window.OneClickUI = window.OneClickUI || {};
  window.OneClickUI.onboarding = { mount, STRINGS: S };
})();
