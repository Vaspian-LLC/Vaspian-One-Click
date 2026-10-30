// Popup script for Vaspian One Click

let currentTab = 'dial';
let logUpdateInterval;
let isSidebarMode = false;
let currentCallNumber = null;
let currentCallTimestamp = null;

// Track if event listeners have been added (for event delegation)
let historyListenersAdded = false;
let historyInlineListenersAdded = false;

document.addEventListener('DOMContentLoaded', async () => {
  // Detect sidebar mode from URL parameter
  const urlParams = new URLSearchParams(window.location.search);
  isSidebarMode = urlParams.get('mode') === 'sidebar';

  if (isSidebarMode) {
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
  document.getElementById('populateTestData').addEventListener('click', populateTestData);
  document.getElementById('copyLogs').addEventListener('click', copyLogs);
  document.getElementById('refreshLogs').addEventListener('click', loadLogs);
  document.getElementById('clearLogs').addEventListener('click', clearLogs);
  document.getElementById('clearHistory').addEventListener('click', clearCallHistory);
  document.getElementById('clearHistoryInline').addEventListener('click', clearCallHistory);
  document.getElementById('exportHistory').addEventListener('click', exportCallHistory);
  document.getElementById('exportHistoryInline').addEventListener('click', exportCallHistory);
  document.getElementById('logoutBtnLoggedIn').addEventListener('click', logout);
  document.getElementById('goToSettings').addEventListener('click', () => switchTab('settings'));

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
  document.getElementById('advancedToggle').addEventListener('click', toggleAdvanced);

  // Auto-save settings
  document.getElementById('useSidebar').addEventListener('change', autoSaveSidebar);
  document.getElementById('dialPrefix').addEventListener('change', autoSaveDialPrefix);
  document.getElementById('debugLogging').addEventListener('change', autoSaveDebugLogging);
  document.getElementById('clickToCallEnabled').addEventListener('change', autoSaveClickToCall);

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
  const logsTab = document.querySelector('.tab-btn[data-tab="logs"]');
  if (logsTab) {
    logsTab.hidden = !enabled;
  }

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
}

/**
 * Switch to a different tab
 * @param {string} tabName
 */
function switchTab(tabName) {
  currentTab = tabName;

  // Update tab buttons
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });

  // Update tab panes
  document.querySelectorAll('.tab-pane').forEach(pane => {
    pane.classList.toggle('active', pane.id === tabName);
  });

  // Load logs if switching to logs tab
  if (tabName === 'logs') {
    loadLogs();
  }
}

/**
 * Format a phone number for display
 * @param {string} value - Raw phone number input
 * @returns {string} Formatted phone number
 */
function formatPhoneNumber(value) {
  // Strip all non-digit characters except +
  const cleaned = value.replace(/[^\d+]/g, '');

  // Extract digits only for formatting
  const digits = cleaned.replace(/\+/g, '');

  // Check if it starts with + (international)
  const hasPlus = cleaned.startsWith('+');

  // Format based on length
  let formatted = '';

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
    const settings = await chrome.storage.sync.get(['tenant', 'extension', 'dialPrefix', 'debugLogging', 'useSidebar', 'clickToCallEnabled', 'clickToCallDisabledSites']);
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

    // Set sidebar checkbox (default to false)
    document.getElementById('useSidebar').checked = settings.useSidebar || false;

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

  const tenant = document.getElementById('tenant').value.trim();
  const extension = document.getElementById('extension').value.trim();
  const password = document.getElementById('password').value;

  // Check if any credentials are partially filled
  const hasAnyCredential = tenant || extension || password;
  const hasAllCredentials = tenant && extension && password;

  if (hasAnyCredential && !hasAllCredentials) {
    showStatus('settingsStatus', 'All credential fields are required', 'error');
    return;
  }

  if (!hasAllCredentials) {
    showStatus('settingsStatus', 'Please enter your credentials', 'error');
    return;
  }

  try {
    showStatus('settingsStatus', 'Testing credentials...', 'info');

    const testResult = await chrome.runtime.sendMessage({
      action: 'testLogin',
      tenant,
      extension,
      password
    });

    if (!testResult.success || !testResult.isValid) {
      const message = testResult.message || testResult.error
        || 'Invalid credentials. Please check your tenant, extension, and password.';
      showStatus('settingsStatus', message, 'error');
      return;
    }

    // Credentials are valid, save them. Tenant and extension sync across the
    // user's browsers; the PIN stays on this device (chrome.storage.local).
    await chrome.storage.local.set({ password });
    await chrome.storage.sync.remove('password');
    await chrome.storage.sync.set({
      tenant,
      extension
    });
    // A deliberate re-login: lets the live connection retry even when the
    // same PIN was rejected before (e.g. re-saved after a lockout expired).
    chrome.runtime.sendMessage({ action: 'apiCredentialsSaved' }).catch(() => {});

    // Update login status
    await updateLoginStatus();

    showStatus('settingsStatus', 'Login successful! Switch to Dial tab to make calls.', 'success');

    // Switch to dial tab after saving credentials
    setTimeout(() => {
      switchTab('dial');
    }, 1500);
  } catch (error) {
    console.error('Error saving credentials:', error);
    showStatus('settingsStatus', 'Failed to save credentials', 'error');
  }
}

/**
 * Auto-save sidebar preference
 */
async function autoSaveSidebar() {
  const useSidebar = document.getElementById('useSidebar').checked;

  try {
    await chrome.storage.sync.set({ useSidebar });

    // Notify background script about sidebar preference change
    chrome.runtime.sendMessage({ action: 'setSidebarMode', enabled: useSidebar });

    showStatus('settingsStatus', 'Sidebar setting changed! Closing to apply changes...', 'success');

    // Close the window/sidebar after a brief delay
    setTimeout(() => {
      window.close();
    }, 1500);
  } catch (error) {
    console.error('Error saving sidebar setting:', error);
  }
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

    showStatus('settingsStatus', `Click-to-call ${clickToCallEnabled ? 'enabled' : 'disabled'}. Reload pages to apply.`, 'success');
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

    disabledSites.forEach(site => {
      const item = document.createElement('div');
      item.className = 'disabled-site-item';
      item.innerHTML = `
        <span class="disabled-site-url">${site}</span>
        <button class="btn-remove" data-site="${site}">Remove</button>
      `;

      // Add remove button listener
      item.querySelector('.btn-remove').addEventListener('click', () => removeDisabledSite(site));

      listContainer.appendChild(item);
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
      showStatus('settingsStatus', 'Site already in disabled list', 'error');
      return;
    }

    // Add to list
    disabledSites.push(site);
    await chrome.storage.sync.set({ clickToCallDisabledSites: disabledSites });

    // Clear input and reload list
    input.value = '';
    await loadDisabledSites();

    showStatus('settingsStatus', `Added ${site} to disabled list. Reload page to apply.`, 'success');
  } catch (error) {
    console.error('Error adding disabled site:', error);
    showStatus('settingsStatus', 'Failed to add site', 'error');
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

    showStatus('settingsStatus', `Removed ${site} from disabled list. Reload page to apply.`, 'success');
  } catch (error) {
    console.error('Error removing disabled site:', error);
    showStatus('settingsStatus', 'Failed to remove site', 'error');
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
    showStatus('dialStatus', 'Please enter a phone number', 'error');
    return;
  }

  // Strip formatting for dialing
  const phoneNumber = stripPhoneFormatting(phoneNumberFormatted);

  showStatus('dialStatus', 'Initiating call...', 'info');

  try {
    const response = await chrome.runtime.sendMessage({
      action: 'makeCall',
      phoneNumber: phoneNumber
    });

    if (response.success) {
      const via = response.result && response.result.via === '3pcc'
        ? ' Your phone will ring first.'
        : '';
      showStatus('dialStatus', `Calling ${phoneNumberFormatted}.${via}`, 'success');

      // Update login status (we're now logged in)
      await updateLoginStatus();

      // Reload call history to show the new call
      await loadCallHistory();

      // Clear the phone number field
      document.getElementById('phoneNumber').value = '';
      document.getElementById('clearPhone').style.display = 'none';
    } else {
      showStatus('dialStatus', `Error: ${response.error}`, 'error');
    }
  } catch (error) {
    console.error('Error making call:', error);
    showStatus('dialStatus', 'Failed to initiate call', 'error');
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
        <svg width="48" height="48" viewBox="0 0 48 48" fill="currentColor" opacity="0.3">
          <path d="M6 6h36v6H6V6zm0 12h36v6H6v-6zm0 12h24v6H6v-6z"/>
        </svg>
        <p>No logs yet</p>
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
      const originalTitle = copyBtn.title;
      copyBtn.title = 'Copied!';
      copyBtn.style.color = '#4ade80';

      setTimeout(() => {
        copyBtn.title = originalTitle;
        copyBtn.style.color = '';
      }, 2000);

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
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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
  const container = document.getElementById('historyContainer');
  const clearBtn = document.getElementById('clearHistory');
  const exportBtn = document.getElementById('exportHistory');
  const inlineContainer = document.getElementById('historyContainerInline');
  const clearBtnInline = document.getElementById('clearHistoryInline');
  const exportBtnInline = document.getElementById('exportHistoryInline');

  const emptyHTML = `
    <div class="history-empty">
      <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
      <p>No call history yet</p>
      <span>Calls you make will appear here</span>
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
async function clearCallHistory() {
  try {
    await chrome.runtime.sendMessage({ action: 'clearCallHistory' });
    displayCallHistory([]);
  } catch (error) {
    console.error('Error clearing click history:', error);
  }
}

/**
 * Populate test call data (50 calls with various notes)
 */
async function populateTestData() {
  const sampleNotes = [
    "Follow up next week about enterprise pricing",
    "Customer interested in upgrading to Pro plan. Send proposal by Friday.",
    "",
    "Tech support - resolved connection issue. Check back in 24hrs.",
    "Demo scheduled for next Tuesday at 2pm EST",
    "",
    "Billing question - updated payment method",
    "Partnership opportunity - very interested! Send info packet.",
    "",
    "Voicemail - needs callback ASAP re: service outage",
    "Sales call - wants quote for 50 user licenses",
    "Support ticket #1234 - escalated to engineering",
    "",
    "Annual contract renewal discussion",
    "New feature request - custom reporting dashboard",
    "Left voicemail about upcoming webinar",
    "",
    "Technical integration questions answered",
    "Requested demo of mobile app features",
    "Feedback call - very positive experience!",
    "",
    "Cancellation request - retention attempt scheduled",
    "Emergency support - database connection issues",
    "Training session scheduled for next Monday",
    "",
    "Pricing negotiation - waiting on approval",
  ];

  const areaCodes = ["716", "212", "310", "415", "617", "305", "512", "206", "858", "619"];
  const callHistory = [];

  for (let i = 0; i < 50; i++) {
    const areaCode = areaCodes[Math.floor(Math.random() * areaCodes.length)];
    const phoneNumber = areaCode + Math.floor(1000000 + Math.random() * 9000000).toString();
    const note = sampleNotes[i % sampleNotes.length];
    const timestamp = new Date(Date.now() - 1000 * 60 * (i * 12)).toISOString();

    callHistory.push({
      phoneNumber,
      timestamp,
      note
    });
  }

  try {
    await chrome.storage.local.set({ callHistory });
    await loadCallHistory();
    console.log('Test call data populated - 50 calls added');
  } catch (error) {
    console.error('Error populating test data:', error);
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
      showStatus('settingsStatus', 'Logged out successfully - credentials and history cleared', 'success');

      // Hide modal if it's open
      hideLogoutModal();
    }
  } catch (error) {
    console.error('Error logging out:', error);
    showStatus('settingsStatus', 'Failed to logout', 'error');
  }
}

/**
 * Toggle help section visibility
 */
function toggleHelp() {
  const helpContent = document.getElementById('helpContent');
  const helpToggle = document.getElementById('helpToggle');

  if (helpContent.style.display === 'none') {
    helpContent.style.display = 'block';
    helpToggle.classList.add('active');
  } else {
    helpContent.style.display = 'none';
    helpToggle.classList.remove('active');
  }
}

/**
 * Toggle advanced settings visibility
 */
function toggleAdvanced() {
  const advancedContent = document.getElementById('advancedContent');
  const advancedToggle = document.getElementById('advancedToggle');

  if (advancedContent.style.display === 'none') {
    advancedContent.style.display = 'block';
    advancedToggle.classList.add('active');
  } else {
    advancedContent.style.display = 'none';
    advancedToggle.classList.remove('active');
  }
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
    const statusDot = statusIndicator.querySelector('.status-dot');
    const phoneInput = document.getElementById('phoneNumber');
    const dialButton = document.querySelector('.btn-call');
    const dialContainer = document.querySelector('.dial-container');
    const notReadyMessage = document.getElementById('notReadyMessage');
    const dialForm = document.getElementById('dialForm');
    const credentialsLoginCard = document.getElementById('credentialsLoginCard');
    const credentialsLoggedInCard = document.getElementById('credentialsLoggedInCard');

    const hasCredentials = settings.tenant && settings.extension && settings.password;
    const isValidated = settings.isLoggedIn === true;
    const isReady = hasCredentials && isValidated;

    if (isReady) {
      statusText.textContent = 'Ready';
      statusDot.style.background = '#4ade80';
      statusDot.style.boxShadow = '0 0 0 2px rgba(74, 222, 128, 0.3)';

      // Enable dial form
      phoneInput.disabled = false;
      dialButton.disabled = false;
      dialContainer.classList.remove('disabled');
      notReadyMessage.style.display = 'none';
      dialForm.style.display = 'block';

      // Show logged-in card, hide login card
      credentialsLoginCard.style.display = 'none';
      credentialsLoggedInCard.style.display = 'block';

      // Update logged-in account info
      document.getElementById('loggedInTenant').textContent = settings.tenant;
      document.getElementById('loggedInExtension').textContent = settings.extension;
    } else {
      statusText.textContent = 'Not Ready';
      statusDot.style.background = '#9ca3af';
      statusDot.style.boxShadow = '0 0 0 2px rgba(156, 163, 175, 0.3)';

      // Disable dial form and show not ready message
      phoneInput.disabled = true;
      dialButton.disabled = true;
      dialContainer.classList.add('disabled');
      notReadyMessage.style.display = 'block';
      dialForm.style.display = 'none';

      // Show login card, hide logged-in card
      credentialsLoginCard.style.display = 'block';
      credentialsLoggedInCard.style.display = 'none';
    }
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
      <textarea class="note-textarea" placeholder="Enter notes about this call..." rows="3">${escapedNote}</textarea>
      <div class="note-actions">
        ${hasNote ? '<button type="button" class="btn btn-secondary btn-delete-note">Delete Note</button>' : ''}
        <button type="button" class="btn btn-primary btn-save-note">Save Note</button>
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
