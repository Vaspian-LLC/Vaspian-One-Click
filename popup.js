// Popup script for Vaspian One Click

let currentTab = 'dial';
// One Click only runs in Chrome's side panel (the toolbar popup is gone).
const isSidebarMode = true;
let currentCallNumber = null;
let currentCallTimestamp = null;

// Track if event listeners have been added (for event delegation)
let historyListenersAdded = false;
let historyInlineListenersAdded = false;

document.addEventListener('DOMContentLoaded', async () => {
  {
    document.body.classList.add('sidebar-mode');
    // History is shown inline under the dialer in the sidebar.
    const historyTab = document.querySelector('.tab-btn[data-tab="history"]');
    if (historyTab) historyTab.hidden = true;
    // In sidebar mode, ensure dial tab is active
    currentTab = 'dial';
  }

  initializeTabs();
  await loadSettings();
  await loadCallHistory();
  await updateLoginStatus();

  // Check if logging is enabled and show/hide logs tab
  const settings = await chrome.storage.sync.get(['debugLogging']);
  updateLogsTabVisibility(settings.debugLogging);

  if (settings.debugLogging) {
    loadLogs();
  }

  // Set up event listeners
  document.getElementById('settingsForm').addEventListener('submit', saveCredentials);
  document.getElementById('dialForm').addEventListener('submit', makeCall);
  document.getElementById('clearPhone').addEventListener('click', clearPhoneNumber);
  document.getElementById('phoneNumber').addEventListener('input', handlePhoneInput);
  document.getElementById('copyLogs').addEventListener('click', copyLogs);
  document.getElementById('refreshLogs').addEventListener('click', loadLogs);
  document.getElementById('clearLogs').addEventListener('click', clearLogs);
  document.getElementById('clearHistoryInline').addEventListener('click', clearCallHistory);
  document.getElementById('exportHistoryInline').addEventListener('click', exportCallHistory);
  document.getElementById('logoutBtnLoggedIn').addEventListener('click', logout);
  document.getElementById('goToSettings').addEventListener('click', () => chrome.tabs.create({ url: 'welcome.html' }));
  document.getElementById('openLogs').addEventListener('click', () => switchTab('logs'));
  document.getElementById('logsBack').addEventListener('click', () => { switchTab('settings'); window.OneClickSettings?.open('help'); });
  document.getElementById('pinFixSave').addEventListener('click', savePinFix);
  document.getElementById('pinFixInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); savePinFix(); }
  });
  document.getElementById('dialNotice').addEventListener('click', onDialNoticeClick);
  setupConnectionNotices();

  // Logout modal buttons
  document.getElementById('cancelLogout').addEventListener('click', hideLogoutModal);
  document.getElementById('logoutWithoutExport').addEventListener('click', performLogout);
  document.getElementById('exportAndLogout').addEventListener('click', async () => {
    await exportCallHistory();
    await performLogout();
  });

  // Close modal when clicking overlay
  document.querySelector('.modal-overlay')?.addEventListener('click', hideLogoutModal);
  document.getElementById('helpToggle').addEventListener('click', toggleHelp);
  setupOnboardingHook();

  // Auto-save settings
  document.getElementById('dialPrefix').addEventListener('change', autoSaveDialPrefix);
  document.getElementById('ringPhone').addEventListener('change', saveRingPhone);
  document.getElementById('debugLogging').addEventListener('change', autoSaveDebugLogging);
  document.getElementById('clickToCallEnabled').addEventListener('change', autoSaveClickToCall);
  setupMissedCallAlerts();

  // Disabled sites management
  document.getElementById('addDisabledSite').addEventListener('click', addDisabledSite);
  document.getElementById('newDisabledSite').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addDisabledSite();
    }
  });

  // Handle support phone number clicks
  document.querySelectorAll('.support-phone-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const phoneNumber = link.dataset.phone;
      if (phoneNumber) {
        // Populate the phone input field
        const phoneInput = document.getElementById('phoneNumber');
        phoneInput.value = formatPhoneNumber(phoneNumber);

        // Show the clear button
        document.getElementById('clearPhone').style.display = 'flex';

        // Switch to dial tab
        switchTab('dial');

        // Focus the phone input
        phoneInput.focus();
      }
    });
  });

  // Listen for log updates from background
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'logUpdate') {
      addLogToDisplay(request.log);
    }
  });

  // Listen for storage changes to update call history in real-time
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.callHistory) {
      // Call history was updated, reload it
      loadCallHistory();
    }
  });

  // Auto-refresh logs when on logs tab (check settings each time)
  setInterval(async () => {
    if (currentTab === 'logs') {
      const { debugLogging } = await chrome.storage.sync.get(['debugLogging']);
      if (debugLogging) {
        loadLogs();
      }
    }
  }, 3000); // Reduced frequency to 3 seconds for better performance
});

/**
 * Show or hide the logs tab based on debug logging setting
 * @param {boolean} enabled
 */
function updateLogsTabVisibility(enabled) {
  const openLogs = document.getElementById('openLogs');
  if (openLogs) openLogs.hidden = !enabled;

  // If logs tab is hidden and currently active, switch to dial tab
  if (!enabled && currentTab === 'logs') {
    switchTab('dial');
  }
}

/**
 * Initialize tab switching functionality
 */
function initializeTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tab;
      switchTab(tabName);
    });
  });
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const visible = [...document.querySelectorAll('.tab-btn')].filter((b) => !b.hidden && b.offsetParent !== null);
    const i = visible.findIndex((b) => b.dataset.tab === currentTab);
    if (i === -1) return;
    const next = visible[(i + (e.key === 'ArrowRight' ? 1 : visible.length - 1)) % visible.length];
    e.preventDefault();
    switchTab(next.dataset.tab);
    next.focus();
  });
  switchTab(currentTab);
}

/**
 * Switch to a different tab
 * @param {string} tabName
 */
function switchTab(tabName) {
  currentTab = tabName;
  // CSS keys off this (e.g. the compact call bar shows on every tab but Dial).
  document.body.dataset.tab = tabName;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const on = btn.dataset.tab === tabName;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });

  // Update tab panes
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabName);
  });

  // Load logs if switching to logs tab
  if (tabName === 'logs') {
    loadLogs();
  }
  // Phones sign in and out; refresh the phone picker whenever Settings opens.
  if (tabName === 'settings') {
    loadRingPhones();
  }
}

/**
 * Format a phone number for display
 * @param {string} value - Raw phone number input
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(value) {
  // Strip all non-digit characters except +, and an access code a saved number already carries
  const trimmed = String(value || '').trim();
  const cleaned = (trimmed.startsWith('+') ? trimmed : self.OneClickPhone.stripAccessCode(trimmed)).replace(/[^\d+]/g, '');

  // Extract digits only for formatting
  const digits = cleaned.replace(/\+/g, '');

  // Check if it starts with + (international)
  const hasPlus = cleaned.startsWith('+');

  // Format based on length
  let formatted = '';

  // Extensions (6 digits or fewer) stay plain digits: "197", never "(197".
  if (!hasPlus && digits.length <= 6) return digits;

  if (hasPlus) {
    // International format: +1 (555) 123-4567
    if (digits.length <= 1) {
      formatted = '+' + digits;
    } else if (digits.length <= 4) {
      formatted = `+${digits[0]} (${digits.slice(1)}`;
    } else if (digits.length <= 7) {
      formatted = `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4)}`;
    } else {
      formatted = `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
    }
  } else {
    // US format: (555) 123-4567
    if (digits.length <= 3) {
      formatted = digits.length > 0 ? `(${digits}` : '';
    } else if (digits.length <= 6) {
      formatted = `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    } else {
      formatted = `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6, 10)}`;
    }
  }

  return formatted;
}

/**
 * Strip formatting from phone number to get raw dialable number
 * @param {string} formatted - Formatted phone number
 * @returns {string} Raw phone number with only digits and +
 */
function stripPhoneFormatting(formatted) {
  // Keep only digits and + sign
  return formatted.replace(/[^\d+]/g, '');
}

/**
 * Handle phone number input to show/hide clear button and format number
 */
function handlePhoneInput(event) {
  const input = event.target;
  const cursorPosition = input.selectionStart;
  const oldValue = input.value;
  const oldLength = oldValue.length;

  // Format the number
  const formatted = formatPhoneNumber(input.value);
  input.value = formatted;

  // Adjust cursor position after formatting
  const newLength = formatted.length;
  const lengthDiff = newLength - oldLength;

  // Try to keep cursor in a reasonable position
  if (lengthDiff > 0) {
    input.setSelectionRange(cursorPosition + lengthDiff, cursorPosition + lengthDiff);
  } else {
    input.setSelectionRange(cursorPosition, cursorPosition);
  }

  // Show/hide clear button
  const clearBtn = document.getElementById('clearPhone');
  clearBtn.style.display = formatted ? 'flex' : 'none';
}

/**
 * Clear the phone number input
 */
function clearPhoneNumber() {
  document.getElementById('phoneNumber').value = '';
  document.getElementById('clearPhone').style.display = 'none';
  document.getElementById('phoneNumber').focus();
}

/**
 * The PIN: chrome.storage.local since v2.0 (a v1 copy in sync is migrated by
 * the service worker; read it here too so the popup never shows "Not Ready"
 * during the migration).
 * @returns {Promise<string>}
 */
async function getStoredPin() {
  const { password } = await chrome.storage.local.get(['password']);
  if (password) return password;
  const legacy = await chrome.storage.sync.get(['password']);
  return legacy.password || '';
}

/**
 * Load saved settings from Chrome storage
 */
async function loadSettings() {
  try {
    const settings = await chrome.storage.sync.get(['tenant', 'extension', 'dialPrefix', 'debugLogging', 'clickToCallEnabled', 'clickToCallDisabledSites']);
    settings.password = await getStoredPin();

    if (settings.tenant) {
      document.getElementById('tenant').value = settings.tenant;
    }
    if (settings.extension) {
      document.getElementById('extension').value = settings.extension;
    }
    if (settings.password) {
      document.getElementById('password').value = settings.password;
    }

    // Set dial prefix (default to '8')
    document.getElementById('dialPrefix').value = settings.dialPrefix !== undefined ? settings.dialPrefix : '8';

    // Set debug logging checkbox (default to false)
    document.getElementById('debugLogging').checked = settings.debugLogging || false;


    // Set click-to-call enabled checkbox (default to true)
    document.getElementById('clickToCallEnabled').checked = settings.clickToCallEnabled !== false;

    // Load disabled sites list
    await loadDisabledSites();
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

/**
 * Save credentials to Chrome storage
 * @param {Event} event
 */
async function saveCredentials(event) {
  event.preventDefault();
  // While signed out the form is on Calls; the PIN fix lives in Settings › Account.
  const statusId = document.getElementById('notReadyMessage').style.display === 'none' ? 'settingsStatus' : 'signinStatus';

  const tenant = document.getElementById('tenant').value.trim();
  const extension = document.getElementById('extension').value.trim();
  const password = document.getElementById('password').value;

  // Check if any credentials are partially filled
  const hasAnyCredential = tenant || extension || password;
  const hasAllCredentials = tenant && extension && password;

  if (hasAnyCredential && !hasAllCredentials) {
    showStatus(statusId, 'Enter your company, extension and PIN.', 'error');
    return;
  }

  if (!hasAllCredentials) {
    showStatus(statusId, 'Enter your company, extension and PIN.', 'error');
    return;
  }

  try {
    showStatus(statusId, 'Checking…', 'info');

    // Shared with first-run setup (signin.js): one attempt, then save the
    // credentials (PIN on this device only) and tell the live connection.
    const result = await OneClickSignIn.signIn({ tenant, extension, pin: password });

    if (!result.ok) {
      let message = result.message || 'That didn’t work. Check your company, extension and PIN.';
      if (result.reason === 'rejected' && result.triesLeft === 1) message += ' One more wrong try locks your extension for an hour.';
      showStatus(statusId, message, 'error');
      renderSigninWarning();
      return;
    }

    document.getElementById('password').value = '';
    await updateLoginStatus();
    renderSigninWarning();
    showStatus('dialStatus', 'You’re signed in.', 'success');
    switchTab('dial');
  } catch (error) {
    console.error('Error saving credentials:', error);
    showStatus(statusId, 'Couldn’t save. Try again.', 'error');
  }
}

/**
 * Missed-call desktop alerts = the optional "notifications" permission.
 * chrome.permissions.request must run straight from the click (user gesture),
 * so nothing is awaited before it. calls.js reads the permission itself; the
 * message just lets it wire its notification listeners right away.
 */
function setupMissedCallAlerts() {
  const box = document.getElementById('missedCallAlerts');
  if (!box) return;
  const sync = () => {
    if (!chrome.permissions || !chrome.permissions.contains) { box.disabled = true; return; }
    chrome.permissions.contains({ permissions: ['notifications'] }, (granted) => {
      void chrome.runtime.lastError;
      box.checked = !!granted;
    });
  };
  box.addEventListener('change', () => {
    const want = box.checked;
    const done = (ok) => {
      void chrome.runtime.lastError;
      if (want && ok) showStatus('settingsStatus', 'Missed-call alerts are on.', 'success');
      sync();
      chrome.runtime.sendMessage({ action: 'callcard:notificationsChanged' }, () => { void chrome.runtime.lastError; });
    };
    if (want) chrome.permissions.request({ permissions: ['notifications'] }, done);
    else chrome.permissions.remove({ permissions: ['notifications'] }, done);
  });
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(sync);
    chrome.permissions.onRemoved.addListener(sync);
  }
  sync();
}

/**
 * Auto-save dial prefix
 */
async function autoSaveDialPrefix() {
  const dialPrefix = document.getElementById('dialPrefix').value;

  try {
    await chrome.storage.sync.set({ dialPrefix });
    console.log('Dial prefix saved:', dialPrefix || 'none');
  } catch (error) {
    console.error('Error saving dial prefix:', error);
  }
}

// ------------------------------------------------------------ ring phone ---
// Multi-desk: with a desk phone and a softphone signed in, the user picks which
// one rings first for calls One Click starts (click to call, call back,
// transfers, park pickup). Incoming calls still ring every phone.
let ringPhones = [];

const RING_HINT = 'Calls you start in One Click ring this phone. Incoming calls still ring all your phones.';

async function loadRingPhones() {
  const field = document.getElementById('ringPhoneField');
  const select = document.getElementById('ringPhone');
  const hint = document.getElementById('ringPhoneHint');
  if (!field || !select) return;
  let r;
  try { r = await chrome.runtime.sendMessage({ action: 'apiGetPhones' }); } catch (e) { r = null; }
  const signedIn = document.getElementById('credentialsLoggedInCard').style.display !== 'none';
  const phones = (r && r.ok && r.phones) || [];
  const choice = (r && r.choice) || null;
  const show = signedIn && (phones.length > 1 || !!choice);
  field.hidden = !show;
  document.getElementById('ringPhoneDivider').hidden = !show;
  if (!show) return;
  ringPhones = phones;

  const def = phones.find((p) => p.isDefault);
  const options = [{ value: '', text: def ? `Default (${def.label})` : 'Default phone' }];
  for (const p of phones) options.push({ value: p.phoneId, text: p.label });
  // Re-matched by model in the service worker, so match the same way here.
  const current = choice
    ? (phones.find((p) => p.phoneId === choice.phoneId) || phones.find((p) => choice.model && p.model === choice.model) || null)
    : null;
  if (choice && !current) options.push({ value: choice.phoneId, text: `${choice.label || 'Chosen phone'} (signed out)` });
  select.replaceChildren(...options.map((o) => Object.assign(document.createElement('option'), { value: o.value, textContent: o.text })));
  select.value = choice ? (current ? current.phoneId : choice.phoneId) : '';

  hint.textContent = choice && !current
    ? `${choice.label || 'That phone'} isn't signed in, so calls ring your default phone until it is.`
    : RING_HINT;
  hint.classList.toggle('crm-hint-warn', !!(choice && !current));
}

async function saveRingPhone() {
  const id = document.getElementById('ringPhone').value;
  const p = ringPhones.find((x) => x.phoneId === id);
  // The "(signed out)" entry keeps the saved choice as it is.
  if (id && !p) return;
  try {
    await chrome.runtime.sendMessage({ action: 'apiSetRingPhone', choice: p ? { phoneId: p.phoneId, model: p.model, label: p.label } : null });
  } catch (e) { console.error('Error saving phone choice:', e); }
  loadRingPhones();
}

/**
 * Auto-save debug logging
 */
async function autoSaveDebugLogging() {
  const debugLogging = document.getElementById('debugLogging').checked;

  try {
    await chrome.storage.sync.set({ debugLogging });

    // Update logs tab visibility
    updateLogsTabVisibility(debugLogging);

    // Notify background script about logging preference change
    chrome.runtime.sendMessage({ action: 'setLogging', enabled: debugLogging });

    console.log('Debug logging:', debugLogging ? 'enabled' : 'disabled');
  } catch (error) {
    console.error('Error saving debug logging setting:', error);
  }
}

/**
 * Auto-save click-to-call enabled setting
 */
async function autoSaveClickToCall() {
  const clickToCallEnabled = document.getElementById('clickToCallEnabled').checked;

  try {
    await chrome.storage.sync.set({ clickToCallEnabled });
    console.log('Click-to-call:', clickToCallEnabled ? 'enabled' : 'disabled');

    showStatus('settingsStatus', clickToCallEnabled ? 'Click to call is on. Reload open pages to use it.' : 'Click to call is off. Reload open pages to remove it.', 'success');
  } catch (error) {
    console.error('Error saving click-to-call setting:', error);
  }
}

/**
 * Load disabled sites list
 */
async function loadDisabledSites() {
  try {
    const settings = await chrome.storage.sync.get(['clickToCallDisabledSites']);
    const disabledSites = settings.clickToCallDisabledSites || [];

    const listContainer = document.getElementById('disabledSitesList');
    listContainer.innerHTML = '';

    if (!disabledSites.length) {
      const none = document.createElement('span');
      none.className = 'crm-empty-chips';
      none.textContent = 'None yet';
      listContainer.appendChild(none);
    }
    disabledSites.forEach(site => {
      const chip = document.createElement('span');
      chip.className = 'crm-chip crm-chip-static';
      const label = document.createElement('span');
      label.textContent = site;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'crm-chip-x';
      remove.dataset.site = site;
      remove.setAttribute('aria-label', `Turn click to call back on for ${site}`);
      remove.innerHTML = '<svg aria-hidden="true"><use href="#i-x"/></svg>';
      remove.addEventListener('click', () => removeDisabledSite(site));
      chip.append(label, remove);
      listContainer.appendChild(chip);
    });
  } catch (error) {
    console.error('Error loading disabled sites:', error);
  }
}

/**
 * Add a site to the disabled list
 */
async function addDisabledSite() {
  const input = document.getElementById('newDisabledSite');
  let site = input.value.trim();

  if (!site) {
    return;
  }

  // Normalize the site URL
  site = site.replace(/^https?:\/\//, '').replace(/\/$/, '');

  try {
    const settings = await chrome.storage.sync.get(['clickToCallDisabledSites']);
    const disabledSites = settings.clickToCallDisabledSites || [];

    // Check if site already exists
    if (disabledSites.includes(site)) {
      showStatus('settingsStatus', 'That site is already on the list.', 'error');
      return;
    }

    // Add to list
    disabledSites.push(site);
    await chrome.storage.sync.set({ clickToCallDisabledSites: disabledSites });

    // Clear input and reload list
    input.value = '';
    await loadDisabledSites();

    showStatus('settingsStatus', `Click to call is off on ${site}. Reload it to apply.`, 'success');
  } catch (error) {
    console.error('Error adding disabled site:', error);
    showStatus('settingsStatus', 'Couldn’t add that site. Try again.', 'error');
  }
}

/**
 * Remove a site from the disabled list
 */
async function removeDisabledSite(site) {
  try {
    const settings = await chrome.storage.sync.get(['clickToCallDisabledSites']);
    const disabledSites = settings.clickToCallDisabledSites || [];

    // Remove from list
    const updatedSites = disabledSites.filter(s => s !== site);
    await chrome.storage.sync.set({ clickToCallDisabledSites: updatedSites });

    // Reload list
    await loadDisabledSites();

    showStatus('settingsStatus', `Click to call is back on for ${site}. Reload it to apply.`, 'success');
  } catch (error) {
    console.error('Error removing disabled site:', error);
    showStatus('settingsStatus', 'Couldn’t remove that site. Try again.', 'error');
  }
}

/**
 * Make a call to the specified phone number
 * @param {Event} event
 */
async function makeCall(event) {
  event.preventDefault();

  const phoneNumberFormatted = document.getElementById('phoneNumber').value.trim();

  if (!phoneNumberFormatted) {
    showStatus('dialStatus', 'Enter a phone number.', 'error');
    return;
  }

  // Strip formatting for dialing
  const phoneNumber = stripPhoneFormatting(phoneNumberFormatted);

  showStatus('dialStatus', 'Calling…', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'makeCall',
      phoneNumber: phoneNumber
    });

    if (response.success) {
      const via = response.result && response.result.via === '3pcc'
        ? ' Your phone will ring first.'
        : '';
      const digitsOnly = phoneNumber.replace(/\D/g, '');
      const target = !phoneNumber.startsWith('+') && digitsOnly.length <= 6 ? `extension ${digitsOnly}` : phoneNumberFormatted;
      // With no phone signed in the call can't ring anywhere: say so instead of a green "Calling".
      if (lastPresenceKey === 'nodevice' && !(response.result && response.result.via === '3pcc')) {
        const ext = document.getElementById('loggedInExtension').textContent.trim();
        showStatus('dialStatus', `No phone is signed in to extension ${ext}, so this call may not ring. Sign in to your desk phone or softphone, then try again.`, 'warning');
      } else {
        showStatus('dialStatus', `Calling ${target}.${via}`, 'success');
      }

      // Update login status (we're now logged in)
      await updateLoginStatus();

      // Reload call history to show the new call
      await loadCallHistory();

      // Clear the phone number field
      document.getElementById('phoneNumber').value = '';
      document.getElementById('clearPhone').style.display = 'none';
    } else {
      showStatus('dialStatus', response.error, 'error');
    }
  } catch (error) {
    console.error('Error making call:', error);
    showStatus('dialStatus', 'Couldn’t place the call. Try again.', 'error');
  }
}

/**
 * Load and display logs
 */
async function loadLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getLogs' });

    if (response && response.logs) {
      displayLogs(response.logs);
    }
  } catch (error) {
    console.error('Error loading logs:', error);
  }
}

/**
 * Display logs in the UI
 * @param {Array} logs
 */
function displayLogs(logs) {
  const logsContainer = document.getElementById('logsContainer');

  if (!logs || logs.length === 0) {
    logsContainer.innerHTML = `
      <div class="logs-empty">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.3" aria-hidden="true">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
        <p>Nothing logged yet</p>
      </div>
    `;
    return;
  }

  // Display logs in reverse order (newest first)
  const reversedLogs = [...logs].reverse();
  logsContainer.innerHTML = reversedLogs.map(log => createLogEntry(log)).join('');

  // Scroll to top (newest log)
  logsContainer.scrollTop = 0;
}

/**
 * Create HTML for a single log entry
 * @param {Object} log
 * @returns {string}
 */
function createLogEntry(log) {
  const time = new Date(log.timestamp).toLocaleTimeString();
  const details = log.details ? `<div class="log-details">${escapeHtml(JSON.stringify(log.details, null, 2))}</div>` : '';

  return `
    <div class="log-entry">
      <div class="log-time">${time}</div>
      <div class="log-message">
        <span class="log-level log-level-${log.level}">${log.level}</span>
        ${escapeHtml(log.message)}
      </div>
      ${details}
    </div>
  `;
}

/**
 * Add a single log to the display (real-time update)
 * @param {Object} log
 */
function addLogToDisplay(log) {
  const logsContainer = document.getElementById('logsContainer');

  // Remove empty state if present
  const emptyState = logsContainer.querySelector('.logs-empty');
  if (emptyState) {
    logsContainer.innerHTML = '';
  }

  // Add new log at the top
  const logHtml = createLogEntry(log);
  logsContainer.insertAdjacentHTML('afterbegin', logHtml);
}

/**
 * Copy logs to clipboard
 */
async function copyLogs() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getLogs' });

    if (response && response.logs && response.logs.length > 0) {
      // Format logs as text
      const logsText = response.logs.map(log => {
        const timestamp = new Date(log.timestamp).toLocaleString();
        const details = log.details ? `\n  Details: ${JSON.stringify(log.details)}` : '';
        return `[${timestamp}] [${log.level.toUpperCase()}] ${log.message}${details}`;
      }).join('\n\n');

      // Copy to clipboard
      await navigator.clipboard.writeText(logsText);

      // Show visual feedback
      const copyBtn = document.getElementById('copyLogs');
      const original = copyBtn.innerHTML;
      copyBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
      copyBtn.classList.add('is-done');
      copyBtn.setAttribute('aria-label', 'Copied');
      setTimeout(() => {
        copyBtn.innerHTML = original;
        copyBtn.classList.remove('is-done');
        copyBtn.setAttribute('aria-label', 'Copy the log');
      }, 1500);

      console.log('Logs copied to clipboard');
    } else {
      console.log('No logs to copy');
    }
  } catch (error) {
    console.error('Error copying logs:', error);
  }
}

/**
 * Clear all logs
 */
async function clearLogs() {
  try {
    await chrome.runtime.sendMessage({ action: 'clearLogs' });
    displayLogs([]);
  } catch (error) {
    console.error('Error clearing logs:', error);
  }
}

/**
 * Escape HTML to prevent XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Show a status message
 * @param {string} elementId - ID of the status element
 * @param {string} message - Message to display
 * @param {string} type - Type of message (success, error, info)
 */
function showStatus(elementId, message, type) {
  const statusElement = document.getElementById(elementId);
  statusElement.textContent = message;
  statusElement.className = `status ${type}`;

  // Clear the message after 5 seconds
  setTimeout(() => {
    statusElement.textContent = '';
    statusElement.className = 'status';
  }, 5000);
}

/**
 * Load and display click history
 */
async function loadCallHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getCallHistory' });

    if (response && response.callHistory) {
      displayCallHistory(response.callHistory);
    }
  } catch (error) {
    console.error('Error loading click history:', error);
  }
}

/**
 * Display click history in the UI
 * @param {Array} callHistory
 */
function displayCallHistory(callHistory) {
  // One list now (under the dialer); the old History tab ids may be absent.
  const container = document.getElementById('historyContainer') || document.createElement('div');
  const clearBtn = document.getElementById('clearHistory') || document.createElement('button');
  const exportBtn = document.getElementById('exportHistory') || document.createElement('button');
  const inlineContainer = document.getElementById('historyContainerInline');
  const clearBtnInline = document.getElementById('clearHistoryInline');
  const exportBtnInline = document.getElementById('exportHistoryInline');

  const emptyHTML = `
    <div class="history-empty">
      <p>No calls yet</p>
      <span>Calls you make and take show up here.</span>
    </div>
  `;

  if (!callHistory || callHistory.length === 0) {
    container.innerHTML = emptyHTML;
    clearBtn.style.display = 'none';
    exportBtn.style.display = 'none';

    if (isSidebarMode) {
      inlineContainer.innerHTML = emptyHTML;
      clearBtnInline.style.display = 'none';
      exportBtnInline.style.display = 'none';
    }
    return;
  }

  const historyHTML = callHistory.map(call => createCallHistoryItem(call)).join('');

  clearBtn.style.display = 'flex';
  exportBtn.style.display = 'flex';
  container.innerHTML = historyHTML;

  if (isSidebarMode) {
    clearBtnInline.style.display = 'flex';
    exportBtnInline.style.display = 'flex';
    inlineContainer.innerHTML = historyHTML;
  }

  // Use event delegation for better performance - single listener per container
  // Only add listeners once to avoid duplicates
  if (!historyListenersAdded) {
    container.addEventListener('click', (e) => {
      // Handle redial button clicks
      const redialBtn = e.target.closest('.redial-btn');
      if (redialBtn) {
        e.stopPropagation();
        const phoneNumber = redialBtn.dataset.number;
        const phoneInput = document.getElementById('phoneNumber');
        phoneInput.value = formatPhoneNumber(phoneNumber);
        document.getElementById('clearPhone').style.display = 'flex';
        if (!isSidebarMode) {
          switchTab('dial');
        } else {
          phoneInput.focus();
        }
        return;
      }

      // Handle call history item clicks (for notes)
      const historyItem = e.target.closest('.call-history-item');
      if (historyItem) {
        const phoneNumber = historyItem.dataset.phone;
        const timestamp = historyItem.dataset.timestamp;
        const note = historyItem.dataset.note || '';
        viewCallNote(phoneNumber, timestamp, note, historyItem);
      }
    });
    historyListenersAdded = true;
  }

  if (isSidebarMode && !historyInlineListenersAdded) {
    inlineContainer.addEventListener('click', (e) => {
      // Handle redial button clicks
      const redialBtn = e.target.closest('.redial-btn');
      if (redialBtn) {
        e.stopPropagation();
        const phoneNumber = redialBtn.dataset.number;
        const phoneInput = document.getElementById('phoneNumber');
        phoneInput.value = formatPhoneNumber(phoneNumber);
        document.getElementById('clearPhone').style.display = 'flex';
        phoneInput.focus();
        return;
      }

      // Handle call history item clicks (for notes)
      const historyItem = e.target.closest('.call-history-item');
      if (historyItem) {
        const phoneNumber = historyItem.dataset.phone;
        const timestamp = historyItem.dataset.timestamp;
        const note = historyItem.dataset.note || '';
        viewCallNote(phoneNumber, timestamp, note, historyItem);
      }
    });
    historyInlineListenersAdded = true;
  }
}

/**
 * Create HTML for a click history item
 * @param {Object} call
 * @returns {string}
 */
function createCallHistoryItem(call) {
  // Track C (crm-ui.js) renders direction, status, name, duration and disposition.
  const crmUi = window.OneClickUI && window.OneClickUI.crm;
  if (crmUi && crmUi.historyItemHTML) return crmUi.historyItemHTML(call, { getTimeAgo });

  const date = new Date(call.timestamp);
  const timeAgo = getTimeAgo(date);
  const formattedNumber = formatPhoneNumber(call.phoneNumber);
  const hasNote = call.note && call.note.trim().length > 0;
  const noteClass = hasNote ? 'has-note' : '';

  // Truncate long notes for display (max 100 chars)
  const displayNote = hasNote && call.note.length > 100
    ? call.note.substring(0, 100) + '...'
    : call.note;

  return `
    <div class="call-history-item ${noteClass}" data-phone="${escapeHtml(call.phoneNumber)}" data-timestamp="${escapeHtml(call.timestamp)}" data-note="${escapeHtml(call.note || '')}">
      <div class="call-info">
        <div class="call-number">
          ${escapeHtml(formattedNumber)}
          ${hasNote ? `<svg class="note-indicator" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" title="Has note - click to view/edit">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="12" y1="18" x2="12" y2="12"/>
            <line x1="9" y1="15" x2="15" y2="15"/>
          </svg>` : ''}
        </div>
        <div class="call-time">${timeAgo}</div>
        ${hasNote ? `<div class="call-note" title="${escapeHtml(call.note)}">${escapeHtml(displayNote)}</div>` : ''}
      </div>
      <button class="redial-btn" data-number="${escapeHtml(call.phoneNumber)}" title="Redial">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
        </svg>
      </button>
    </div>
  `;
}

/**
 * Get relative time string
 * @param {Date} date
 * @returns {string}
 */
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);

  if (seconds < 60) return 'Just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return date.toLocaleDateString();
}

/**
 * Clear click history
 */
async function clearCallHistory(e) {
  // Ask inline first (never a browser dialog): "Clear all calls?  Clear  Cancel".
  const header = e && e.currentTarget ? e.currentTarget.closest('.history-header') : null;
  if (header && !header.querySelector('.history-confirm')) {
    const box = document.createElement('div');
    box.className = 'history-confirm';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Clear history');
    box.innerHTML = '<span>Clear all calls?</span><button type="button" class="btn btn-sm btn-danger" data-act="yes">Clear</button><button type="button" class="btn btn-sm btn-outline" data-act="no">Cancel</button>';
    header.append(box);
    box.querySelector('[data-act="no"]').focus();
    box.addEventListener('click', async (ev) => {
      const act = ev.target.closest('button') && ev.target.closest('button').dataset.act;
      if (!act) return;
      box.remove();
      if (act === 'yes') await clearCallHistoryNow();
    });
    return;
  }
  if (!header) await clearCallHistoryNow();
}

async function clearCallHistoryNow() {
  try {
    await chrome.runtime.sendMessage({ action: 'clearCallHistory' });
    displayCallHistory([]);
  } catch (error) {
    console.error('Error clearing call history:', error);
  }
}


/**
 * Show logout confirmation modal
 */
async function logout() {
  // Check if there's any call history
  const response = await chrome.runtime.sendMessage({ action: 'getCallHistory' });
  const callHistory = response.callHistory || [];

  // If no history, logout directly without confirmation
  if (callHistory.length === 0) {
    await performLogout();
    return;
  }

  // Show confirmation modal
  const modal = document.getElementById('logoutModal');
  modal.style.display = 'flex';
}

/**
 * Hide logout confirmation modal
 */
function hideLogoutModal() {
  const modal = document.getElementById('logoutModal');
  modal.style.display = 'none';
}

/**
 * Perform the actual logout
 */
async function performLogout() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'logout' });
    if (response.success) {
      // Clear the credential fields (but preserve dialPrefix)
      document.getElementById('tenant').value = '';
      document.getElementById('extension').value = '';
      document.getElementById('password').value = '';
      // dialPrefix is preserved - don't clear it

      // Clear the click history display
      displayCallHistory([]);

      await updateLoginStatus();
      showStatus('settingsStatus', 'Signed out. Your history was cleared.', 'success');

      // Hide modal if it's open
      hideLogoutModal();
    }
  } catch (error) {
    console.error('Error logging out:', error);
    showStatus('settingsStatus', 'Couldn’t sign out. Try again.', 'error');
  }
}

/**
 * Toggle help section visibility
 */
function toggleHelp() {
  const helpContent = document.getElementById('helpContent');
  const helpToggle = document.getElementById('helpToggle');
  const open = helpContent.hidden;
  helpContent.hidden = !open;
  helpToggle.classList.toggle('active', open);
  helpToggle.setAttribute('aria-expanded', String(open));
}


/**
 * Update login status indicator
 */
async function updateLoginStatus() {
  try {
    // Check if credentials are configured and validated
    const settings = await chrome.storage.sync.get(['tenant', 'extension', 'isLoggedIn']);
    settings.password = await getStoredPin();
    const statusIndicator = document.getElementById('connectionStatus');
    const statusText = statusIndicator.querySelector('span');
    const phoneInput = document.getElementById('phoneNumber');
    const dialButton = document.querySelector('.btn-call');
    const notReadyMessage = document.getElementById('notReadyMessage');
    const dialForm = document.getElementById('dialForm');
    const credentialsLoginCard = document.getElementById('credentialsLoginCard');
    const credentialsLoggedInCard = document.getElementById('credentialsLoggedInCard');

    const hasCredentials = settings.tenant && settings.extension && settings.password;
    const isValidated = settings.isLoggedIn === true;
    const isReady = hasCredentials && isValidated;

    if (isReady) {
      statusText.textContent = 'Ready';
      statusIndicator.dataset.state = 'ready';
      document.body.classList.add('signed-in');
      document.body.classList.remove('signed-out');

      // Enable dial form
      phoneInput.disabled = false;
      dialButton.disabled = false;
      notReadyMessage.style.display = 'none';
      dialForm.style.display = 'block';

      // Show logged-in card, hide login card
      credentialsLoginCard.style.display = 'none';
      credentialsLoggedInCard.style.display = 'block';

      // Update logged-in account info
      document.getElementById('loggedInTenant').textContent = settings.tenant;
      document.getElementById('loggedInExtension').textContent = settings.extension;
    } else {
      statusText.textContent = 'Signed out';
      statusIndicator.dataset.state = 'signed-out';
      document.body.classList.add('signed-out');
      document.body.classList.remove('signed-in');

      // Disable dial form and show not ready message
      phoneInput.disabled = true;
      dialButton.disabled = true;
      notReadyMessage.style.display = 'block';
      dialForm.style.display = 'none';

      // Show login card, hide logged-in card
      credentialsLoginCard.style.display = 'block';
      credentialsLoggedInCard.style.display = 'none';
    }
    if (typeof renderConnectionNotices === 'function') renderConnectionNotices();
  } catch (error) {
    console.error('Error updating login status:', error);
  }
}

/**
 * Create inline note editor HTML
 * @param {string} note - The existing note (if any)
 * @returns {string} HTML for the note editor
 */
function createNoteEditorHTML(note) {
  const hasNote = note && note.trim().length > 0;
  const escapedNote = escapeHtml(note || '');

  return `
    <div class="call-note-editor-inline" id="inlineNoteEditor">
      <textarea class="note-textarea" placeholder="Add a note…" rows="3">${escapedNote}</textarea>
      <div class="note-actions">
        ${hasNote ? '<button type="button" class="btn btn-outline btn-delete-note">Delete</button>' : ''}
        <button type="button" class="btn btn-primary btn-save-note">Save</button>
      </div>
    </div>
  `;
}

/**
 * Close the inline note editor
 */
function closeInlineNoteEditor() {
  const editor = document.getElementById('inlineNoteEditor');
  if (editor) {
    // Remove active class from all call items
    document.querySelectorAll('.call-history-item').forEach(item => {
      item.classList.remove('note-editing');
    });

    editor.remove();
  }

  currentCallNumber = null;
  currentCallTimestamp = null;
}

/**
 * Save the note with the specific call
 */
async function saveInlineNote() {
  const editor = document.getElementById('inlineNoteEditor');
  if (!editor) return;

  const textarea = editor.querySelector('.note-textarea');
  const note = textarea.value.trim();

  if (!currentCallNumber || !currentCallTimestamp) {
    console.error('No current call to associate note with');
    closeInlineNoteEditor();
    return;
  }

  try {
    // Send message to background to update the specific call with the note
    await chrome.runtime.sendMessage({
      action: 'updateCallNote',
      phoneNumber: currentCallNumber,
      timestamp: currentCallTimestamp,
      note: note
    });

    // Reload call history to show the updated note
    await loadCallHistory();

    closeInlineNoteEditor();
  } catch (error) {
    console.error('Error saving call note:', error);
    closeInlineNoteEditor();
  }
}

/**
 * Delete the note from the specific call
 */
async function deleteInlineNote() {
  if (!currentCallNumber || !currentCallTimestamp) {
    console.error('No current call to delete note from');
    closeInlineNoteEditor();
    return;
  }

  try {
    // Send message to background to remove the note (set it to empty string)
    await chrome.runtime.sendMessage({
      action: 'updateCallNote',
      phoneNumber: currentCallNumber,
      timestamp: currentCallTimestamp,
      note: ''
    });

    // Reload call history to show the updated note
    await loadCallHistory();

    closeInlineNoteEditor();
  } catch (error) {
    console.error('Error deleting call note:', error);
    closeInlineNoteEditor();
  }
}

/**
 * View and edit a call note from history
 * @param {string} phoneNumber - The phone number
 * @param {string} timestamp - The call timestamp (unique identifier)
 * @param {string} note - The existing note
 * @param {HTMLElement} clickedItem - The call history item that was clicked
 */
function viewCallNote(phoneNumber, timestamp, note, clickedItem) {
  // If clicking the same item that's already being edited, close it
  if (clickedItem.classList.contains('note-editing')) {
    closeInlineNoteEditor();
    return;
  }

  // Set the current call identifiers
  currentCallNumber = phoneNumber;
  currentCallTimestamp = timestamp;

  // Remove any existing editor
  const existingEditor = document.getElementById('inlineNoteEditor');
  if (existingEditor) {
    existingEditor.remove();
  }

  // Remove active class from all items
  document.querySelectorAll('.call-history-item').forEach(item => {
    item.classList.remove('note-editing');
  });

  // Add active class to clicked item
  clickedItem.classList.add('note-editing');

  // Create and insert the editor
  const editorHTML = createNoteEditorHTML(note);
  clickedItem.insertAdjacentHTML('afterend', editorHTML);

  // Get the newly inserted editor
  const editor = document.getElementById('inlineNoteEditor');

  // Attach event listeners
  const saveBtn = editor.querySelector('.btn-save-note');
  const deleteBtn = editor.querySelector('.btn-delete-note');
  const textarea = editor.querySelector('.note-textarea');

  saveBtn.addEventListener('click', saveInlineNote);
  if (deleteBtn) {
    deleteBtn.addEventListener('click', deleteInlineNote);
  }

  // Focus the textarea
  textarea.focus();

  // Scroll to the editor
  setTimeout(() => {
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 100);
}

/**
 * Export call history as CSV
 */
async function exportCallHistory() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getCallHistory' });
    const callHistory = response.callHistory || [];

    if (callHistory.length === 0) {
      console.log('No call history to export');
      return;
    }

    // Get tenant and extension from storage
    const credentials = await chrome.storage.sync.get(['tenant', 'extension']);
    const tenant = credentials.tenant || 'vaspian';
    const extension = credentials.extension || 'ext';

    // Make tenant and extension filename-safe (remove special chars, spaces, etc)
    const safeTenant = tenant.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const safeExtension = extension.replace(/[^a-z0-9]/gi, '-').toLowerCase();

    // Create CSV content (Track C adds direction, status, name, duration, disposition)
    const crmUi = window.OneClickUI && window.OneClickUI.crm;
    const headers = ['DateTime', 'Phone Number', 'Note'];
    const csvRows = crmUi && crmUi.csvRows ? crmUi.csvRows(callHistory) : [headers.join(',')];

    if (!(crmUi && crmUi.csvRows)) callHistory.forEach(call => {
      const dateTime = new Date(call.timestamp).toLocaleString();
      const phoneNumber = call.phoneNumber;
      const note = (call.note || '').replace(/"/g, '""'); // Escape quotes in notes

      // Quote fields that might contain commas
      csvRows.push(`"${dateTime}","${phoneNumber}","${note}"`);
    });

    const csvContent = csvRows.join('\n');

    // Create a blob and download
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;

    // Format: {tenant}-{extension}-{YYYY-MM-DD}.csv
    const date = new Date().toISOString().split('T')[0];
    link.download = `${safeTenant}-${safeExtension}-${date}.csv`;

    link.click();
    URL.revokeObjectURL(url);

    console.log('Call history exported successfully');
  } catch (error) {
    console.error('Error exporting call history:', error);
  }
}


// --------------------------------------------- sign-in and connection notices

/** "Sign in" on the Dial tab: go straight to the sign-in fields. */
function goToSignIn() {
  switchTab('dial');
  const tenant = document.getElementById('tenant');
  if (tenant) tenant.focus({ preventScroll: true });
}

/** Open Settings at the Account card with the PIN field ready. */
function goToPinFix() {
  switchTab('settings');
  if (window.OneClickSettings) window.OneClickSettings.open('account');
  const input = document.getElementById('pinFixInput');
  if (input && !input.closest('[hidden]')) input.focus({ preventScroll: true });
}

/**
 * Save a corrected PIN from the Account card. Same path as the sign-in form
 * (X-Tone login test first, then apiCredentialsSaved), with the saved
 * tenant and extension.
 */
async function savePinFix() {
  const input = document.getElementById('pinFixInput');
  const pin = input.value;
  if (!pin) { showStatus('settingsStatus', 'Enter your PIN.', 'error'); input.focus(); return; }
  document.getElementById('password').value = pin;
  await saveCredentials({ preventDefault() {} });
  input.value = '';
}

let lastApiStatus = null;
let lastPresenceKey = null;

/**
 * Dial-tab banner and Account-card PIN field from the connection status:
 *  - PIN rejected (reason 'auth'): explain and offer "Update PIN"
 *  - live updates refused / connection down: say so, offer Reconnect
 */
function renderConnectionNotices() {
  const box = document.getElementById('dialNotice');
  const pinFix = document.getElementById('pinFix');
  if (!box || !pinFix) return;
  const st = lastApiStatus || {};
  const signedIn = document.getElementById('credentialsLoggedInCard').style.display !== 'none';
  const auth = signedIn && st.state === 'error' && st.reason === 'auth';
  const paused = signedIn && !auth && ((st.state === 'error' && st.reason === 'ws_rejected')
    || (st.state === 'retrying' && st.attempt >= 2));
  pinFix.hidden = !auth;
  document.body.classList.toggle('pin-rejected', auth);
  const callBtn = document.querySelector('.btn-call');
  if (callBtn) callBtn.setAttribute('aria-disabled', auth ? 'true' : 'false');
  let html = '';
  if (auth) {
    html = `<div class="notice notice-error" role="alert">
      <div class="notice-text"><strong>Your PIN wasn't accepted.</strong> Calls and live updates are paused.</div>
      <button type="button" class="btn btn-primary btn-sm" data-act="fix-pin">Update PIN</button>
    </div>`;
  } else if (paused) {
    html = `<div class="notice notice-warn" role="status">
      <div class="notice-text"><strong>Live call updates are paused.</strong> You can still make calls.</div>
      <button type="button" class="btn btn-outline btn-sm" data-act="reconnect">Reconnect</button>
    </div>`;
  }
  if (box.dataset.sig !== html) { box.innerHTML = html; box.dataset.sig = html; }

  // No phone signed in: say what Make a Call can't do yet.
  const hint = document.getElementById('dialHint');
  if (hint) {
    const ext = document.getElementById('loggedInExtension').textContent.trim();
    const show = signedIn && !auth && lastPresenceKey === 'nodevice';
    hint.hidden = !show;
    hint.textContent = show
      ? `No phone is signed in to extension ${ext}. Calls can't ring here until your desk phone or softphone is online.`
      : '';
  }
}

function onDialNoticeClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  if (btn.dataset.act === 'fix-pin') goToPinFix();
  if (btn.dataset.act === 'reconnect') {
    btn.disabled = true;
    chrome.runtime.sendMessage({ action: 'apiReconnect' }).catch(() => {}).finally(() => { btn.disabled = false; });
  }
}

async function setupConnectionNotices() {
  try {
    const l = await chrome.storage.local.get(['apiStatus', 'statusState']);
    lastApiStatus = l.apiStatus || null;
    lastPresenceKey = l.statusState && l.statusState.view ? l.statusState.view.key : null;
  } catch (e) { /* keep defaults */ }
  renderConnectionNotices();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    let dirty = false;
    if (changes.apiStatus) { lastApiStatus = changes.apiStatus.newValue || null; dirty = true; }
    if (changes.statusState) {
      const v = changes.statusState.newValue && changes.statusState.newValue.view;
      const key = v ? v.key : null;
      if (key !== lastPresenceKey) { lastPresenceKey = key; dirty = true; }
    }
    if (dirty) renderConnectionNotices();
  });
}

// temporary mount until the redesign: "Run setup again" in Help and support.
// Says "Continue setup" while first-run setup is unfinished (it resumes there).
async function setupOnboardingHook() {
  const btn = document.getElementById('onb-rerun');
  if (!btn || !self.OneClickOnboardingState) return;
  const S = self.OneClickOnboardingState;
  const label = (st) => { btn.textContent = S.isPending(st) ? 'Continue setup' : 'Run setup again'; };
  label((await chrome.storage.local.get(S.KEY))[S.KEY]);
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c[S.KEY]) label(c[S.KEY].newValue); });
  btn.addEventListener('click', () => { chrome.tabs.create({ url: 'welcome.html' }); });
}

/**
 * Before the last allowed try, say so on the sign-in form every time it shows
 * (3 wrong PINs lock the extension for an hour). Uses the shared counter in signin.js.
 */
async function renderSigninWarning() {
  const el = document.getElementById('signinWarn');
  if (!el || !self.OneClickSignIn || !OneClickSignIn.failures) return;
  try {
    const left = OneClickSignIn.triesLeft(await OneClickSignIn.failures());
    el.hidden = left !== 1;
    el.textContent = left === 1 ? 'One more wrong try locks your extension for an hour. Check your PIN carefully, or call Vaspian support.' : '';
  } catch (e) { el.hidden = true; }
}
document.addEventListener('DOMContentLoaded', () => { renderSigninWarning(); });
window.goToSignIn = goToSignIn;

// While a call card is showing, the dialer steps back (CSS: body.oc-in-call).
document.addEventListener('DOMContentLoaded', () => {
  const mount = document.getElementById('callCardMount');
  if (!mount) return;
  // Ringing keeps the dialer (you might still place a call); connected, held or calling hides it.
  const sync = () => document.body.classList.toggle('oc-in-call', !!mount.querySelector('.cc-card.cc-connected, .cc-card.cc-held, .cc-card.cc-calling'));
  new MutationObserver(sync).observe(mount, { childList: true, subtree: true });
  sync();
});

// Calls tab badge: unseen missed calls (calls.js keeps the count; Calls on screen marks them seen).
document.addEventListener('DOMContentLoaded', async () => {
  const badge = document.getElementById('callsBadge');
  if (!badge) return;
  const render = (n) => {
    const count = Number(n) || 0;
    badge.hidden = count === 0;
    badge.textContent = count > 9 ? '9+' : String(count);
    document.getElementById('tab-dial').setAttribute('aria-label', count ? `Calls, ${count} missed` : 'Calls');
  };
  try { render((await chrome.storage.local.get('callcardMissedUnseen')).callcardMissedUnseen); } catch (e) { /* none */ }
  chrome.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.callcardMissedUnseen) render(c.callcardMissedUnseen.newValue); });
});
