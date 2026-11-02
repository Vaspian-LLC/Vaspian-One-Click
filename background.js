// Background service worker for Vaspian One Click

// Logging system
const MAX_LOGS = 500;
let logs = [];
let loggingEnabled = false;
let sidebarEnabled = false;
let isLoggedIn = false;

// Set default preferences on first install
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Set defaults on first install
    await chrome.storage.sync.set({
      useSidebar: true,
      debugLogging: false,
      dialPrefix: '8',
      clickToCallEnabled: true,
      clickToCallDisabledSites: []
    });
    sidebarEnabled = true;
    updateActionBehavior();
    openFirstRunSetup(details.reason); // onboarding: welcome tab on a fresh install only
  } else {
    // v1 kept the PIN in chrome.storage.sync; v2 keeps it on this device only.
    self.OneClick.api.migratePin().catch(e => addLog('error', `PIN migration failed: ${e.message}`));
    // On update or other reasons, load existing preferences
    loadPreferences();
  }
});

// Load logging and sidebar preferences on startup
loadPreferences();

function loadPreferences() {
  chrome.storage.sync.get(['debugLogging', 'useSidebar', 'isLoggedIn'], (result) => {
    loggingEnabled = result.debugLogging || false;
    sidebarEnabled = result.useSidebar !== undefined ? result.useSidebar : true;
    isLoggedIn = result.isLoggedIn || false;
    updateActionBehavior();
  });
}

async function addLog(level, message, details = null) {
  // Skip logging if disabled (except for errors)
  if (!loggingEnabled && level !== 'error') {
    return;
  }

  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    level, // 'info', 'success', 'warning', 'error'
    message,
    details
  };

  logs.push(logEntry);

  // Keep only the last MAX_LOGS entries
  if (logs.length > MAX_LOGS) {
    logs = logs.slice(-MAX_LOGS);
  }

  // Store logs
  await chrome.storage.local.set({ logs });

  // Also log to console
  const consoleMsg = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
  if (level === 'error') {
    console.error(consoleMsg, details || '');
  } else if (level === 'warning') {
    console.warn(consoleMsg, details || '');
  } else {
    console.log(consoleMsg, details || '');
  }

  // Notify popup if open
  try {
    chrome.runtime.sendMessage({ action: 'logUpdate', log: logEntry });
  } catch (e) {
    // Popup not open, ignore
  }
}

// Load existing logs on startup
chrome.storage.local.get(['logs'], (result) => {
  if (result.logs) {
    logs = result.logs;
  }
});

// Flush old logs periodically (every hour, keep logs from last 24 hours)
const FLUSH_INTERVAL = 60 * 60 * 1000; // 1 hour
const LOG_RETENTION = 24 * 60 * 60 * 1000; // 24 hours

setInterval(() => {
  flushOldLogs();
}, FLUSH_INTERVAL);

// Also flush on startup
flushOldLogs();

/**
 * Remove logs older than LOG_RETENTION period
 */
async function flushOldLogs() {
  const now = Date.now();
  const cutoffTime = now - LOG_RETENTION;

  // Filter out old logs
  const originalCount = logs.length;
  logs = logs.filter(log => {
    const logTime = new Date(log.timestamp).getTime();
    return logTime > cutoffTime;
  });

  const removedCount = originalCount - logs.length;

  if (removedCount > 0) {
    await chrome.storage.local.set({ logs });
    addLog('info', `Flushed ${removedCount} old log entries (keeping last 24 hours)`);
  }
}

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'makeCall') {
    addLog('info', `Call request received for: ${request.phoneNumber}`);
    handleClickToCall(request.phoneNumber)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  } else if (request.action === 'getLogs') {
    sendResponse({ logs });
    return true;
  } else if (request.action === 'clearLogs') {
    logs = [];
    chrome.storage.local.set({ logs: [] });
    addLog('info', 'Logs cleared');
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'setLogging') {
    loggingEnabled = request.enabled;
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'setSidebarMode') {
    sidebarEnabled = request.enabled;
    updateActionBehavior();
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'getCallHistory') {
    chrome.storage.local.get(['callHistory'], (result) => {
      sendResponse({ callHistory: result.callHistory || [] });
    });
    return true;
  } else if (request.action === 'clearCallHistory') {
    chrome.storage.local.set({ callHistory: [] });
    addLog('info', 'Call history cleared');
    sendResponse({ success: true });
    return true;
  } else if (request.action === 'logout') {
    handleLogout()
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (request.action === 'getLoginStatus') {
    sendResponse({ isLoggedIn });
    return true;
  } else if (request.action === 'testLogin') {
    testLogin(request.tenant, request.extension, request.password)
      .then(result => sendResponse({ success: true, isValid: result.isValid, reason: result.reason, message: result.message }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (request.action === 'updateCallNote') {
    updateCallNote(request.phoneNumber, request.timestamp, request.note)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
});

/**
 * Main function to handle click-to-call.
 *
 * Tries 3PCC makeCall first (the platform rings the user's phone, then the
 * destination). Falls back to the X-Tone ProcessLogin/ProcessClickToCall flow
 * only when makeCall was never sent or was refused for lack of a 3PCC device
 * or permission. Never falls back after a PIN rejection (a second failed
 * login would count toward the lockout) or when the call may already have
 * been placed (5xx, timeout, 409), to avoid ringing twice.
 *
 * @param {string} phoneNumber - The destination phone number (digits)
 * @returns {Promise<{via: '3pcc'|'xtone', destination: string, callId?: string, fallbackReason?: string, extension: string}>}
 */
async function handleClickToCall(phoneNumber) {
  try {
    addLog('info', `Starting click-to-call for: ${phoneNumber}`);
    const api = self.OneClick.api;
    const creds = await api.getCredentials();
    // Track C: an IT-managed (locked) dial prefix wins over the user's setting.
    const prefix = await api.dialPrefix();
    addLog('info', `Retrieved settings: tenant=${creds.tenant}, extension=${creds.extension}, prefix=${prefix || 'none'}`);

    if (!creds.complete) {
      const error = 'Please configure your Vaspian credentials in the extension popup';
      addLog('error', error);
      throw new Error(error);
    }

    const destination = api.dialString(phoneNumber, prefix);
    if (!destination) throw new Error('That does not look like a phone number');

    const decision = await tryMakeCall(destination);
    let result;
    if (decision.done) {
      result = { via: '3pcc', destination, callId: decision.callId || null };
      addLog('success', `Call placed with 3PCC makeCall to ${destination}`);
    } else if (decision.fallback) {
      addLog('info', `Using X-Tone click-to-call (${decision.reason})`);
      result = { ...(await xtoneDial(creds, destination)), via: 'xtone', fallbackReason: decision.reason };
    } else {
      throw new Error(decision.message);
    }

    await addToCallHistory(phoneNumber);
    return { ...result, extension: creds.extension };
  } catch (error) {
    addLog('error', `Click-to-call failed: ${error.message}`, error.stack);
    throw error;
  }
}

/**
 * Decide between 3PCC and the X-Tone fallback, placing the 3PCC call if possible.
 * @param {string} destination - digits to dial (dial prefix applied)
 * @returns {Promise<{done?: boolean, callId?: string, fallback?: boolean, reason?: string, message?: string}>}
 */
async function tryMakeCall(destination) {
  const api = self.OneClick.api;

  // 1. The session check (GET /api/v1/) also learns the tenant ID.
  const s = await api.ensureSession();
  if (!s.ok) {
    // 'stopped' also covers a PIN the X-Tone fallback was refused with
    // (api.markAuthRejected), so a further click never sends it again.
    if (s.errorClass === 'auth' || s.errorClass === 'stopped') {
      return { message: "Your PIN wasn't accepted. Update it in Settings (calls are paused so your extension doesn't get locked)." };
    }
    return { fallback: true, reason: `Public API unavailable: ${s.message}` };
  }

  // 2. makeCall only works with a registered phone; skip it when there is none.
  const phones = await api.getMyPhones();
  if (phones.errorClass === 'auth' || phones.errorClass === 'stopped') {
    return { message: 'Your PIN was rejected by the phone system. Check your PIN in Settings.' };
  }
  if (phones.ok && phones.phones.length === 0) return { fallback: true, reason: 'no registered phone for 3PCC' };

  // 3. Place the call.
  const r = await api.makeCall(destination);
  if (r.ok) return { done: true, callId: r.callId };
  addLog('warning', `makeCall returned ${r.status} ${r.errorCode || ''} (${r.errorClass})`.trim());
  if (r.notSent) return { fallback: true, reason: `makeCall not sent: ${r.message}` };
  if (r.errorClass === 'auth' || r.errorClass === 'stopped') {
    return { message: 'Your PIN was rejected by the phone system. Check your PIN in Settings.' };
  }
  if (r.errorClass === 'device' || r.errorClass === 'forbidden') {
    return { fallback: true, reason: `makeCall refused (${r.errorCode || r.status})` };
  }
  if (r.errorClass === 'invalid' && !(phones.ok && phones.phones.length > 0)) {
    return { fallback: true, reason: `makeCall refused (${r.errorCode || r.status}) and no phone is known` };
  }
  return { message: `The phone system could not place the call (${r.message || r.errorCode || r.status}).` };
}

/**
 * Legacy X-Tone click-to-call: log in to webadmin, then ProcessClickToCall.
 * @param {{tenant: string, extension: string, password: string}} creds
 * @param {string} destination - digits to dial (dial prefix applied)
 */
async function xtoneDial(creds, destination) {
  addLog('info', 'Attempting login to Vaspian...');
  if (await self.OneClick.api.isAuthStopped()) {
    throw new Error("Your PIN wasn't accepted. Update it in Settings.");
  }
  const loginResult = await login(creds.tenant, creds.extension, creds.password);
  if (!loginResult.ok) {
    isLoggedIn = false;
    await chrome.storage.sync.set({ isLoggedIn: false });
    // A wrong or expired PIN counts toward the lockout: stop like a REST 401.
    if (loginResult.reason === 'rejected' || loginResult.reason === 'expired_pin') {
      await self.OneClick.api.markAuthRejected(`X-Tone login ${loginResult.reason}`);
    }
    addLog('error', loginResult.message);
    throw new Error(loginResult.message);
  }
  addLog('success', 'Login successful');
  isLoggedIn = true;
  await chrome.storage.sync.set({ isLoggedIn: true });
  addLog('info', `Initiating call to: ${destination} from extension: ${creds.extension}`);
  const callResult = await xtoneClickToCall(creds.extension, destination);
  addLog('success', `Call successfully initiated to ${destination}`);
  return callResult;
}

/**
 * Add a call to the click history
 * @param {string} phoneNumber - The phone number that was called
 * @param {string} note - Optional note for the call
 */
async function addToCallHistory(phoneNumber, note = '') {
  try {
    const result = await chrome.storage.local.get(['callHistory']);
    let callHistory = result.callHistory || [];

    // Add new call with timestamp and note
    callHistory.unshift({
      phoneNumber,
      timestamp: new Date().toISOString(),
      note: note
    });

    // Keep only last 500 calls
    callHistory = callHistory.slice(0, 500);

    await chrome.storage.local.set({ callHistory });
    addLog('info', `Added ${phoneNumber} to call history`);
  } catch (error) {
    addLog('error', `Failed to save call history: ${error.message}`);
  }
}

/**
 * Interpret the outcome of a ProcessLogin.jsp request.
 *
 * X-Tone always answers login with a redirect, and the redirect target is the
 * only reliable signal of what happened. Every target loads with HTTP 200, so
 * response.ok alone cannot tell success from failure:
 *   /webadmin/user/usr_portal or /webadmin/mySettings/usr_portal -> logged in
 *   /webadmin/expired_pin/<tenant>?UserID=...                    -> PIN expired
 *   /webadmin/login/<tenant>?...   (tenant path present)         -> wrong ext/PIN
 *   /webadmin/login?...            (tenant path absent)          -> tenant not recognized
 *
 * @param {string} finalUrl - response.url after redirects were followed
 * @param {number} status - response.status
 * @returns {{ok: boolean, reason: string, message: string}}
 */
function classifyLoginResponse(finalUrl, status) {
  const url = finalUrl || '';
  let pathname = url;
  try { pathname = new URL(url).pathname; } catch (e) { /* keep raw string */ }

  if (pathname.includes('/expired_pin/')) {
    return {
      ok: false,
      reason: 'expired_pin',
      message: 'Your Vaspian PIN has expired. Reset it in the Vaspian portal (or ask your administrator), then update the password in the extension settings.'
    };
  }
  if (/\/webadmin\/login\/[^/?]+/.test(pathname)) {
    return {
      ok: false,
      reason: 'rejected',
      message: 'Login rejected. Check your extension and PIN in the extension settings.'
    };
  }
  if (/\/webadmin\/login(\/)?$/.test(pathname)) {
    return {
      ok: false,
      reason: 'bad_tenant',
      message: 'Login rejected. The tenant name was not recognized. Check the tenant in the extension settings.'
    };
  }
  // ProcessDIDLogin.jsp (phone number used as the tenant) fails back to
  // /webadmin/en; here only the MessageID separates the two failure causes.
  if (/\/webadmin\/en(\/)?$/.test(pathname)) {
    let messageId = '';
    try { messageId = new URL(url).searchParams.get('MessageID') || ''; } catch (e) { /* ignore */ }
    if (messageId === '41') {
      return {
        ok: false,
        reason: 'bad_tenant',
        message: 'Login rejected. That phone number is not recognized as a Vaspian tenant. Enter one of your company\'s Vaspian phone numbers (10 digits) or your tenant name.'
      };
    }
    return {
      ok: false,
      reason: 'rejected',
      message: 'Login rejected. Check your extension and PIN in the extension settings.'
    };
  }
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      reason: 'http',
      message: `Login failed with status ${status}.`
    };
  }
  if (pathname.includes('usr_portal')) {
    return { ok: true, reason: 'ok', message: 'Login successful' };
  }
  // 2xx to an unrecognized page: treat as success so an unexpected portal
  // path does not block calls, but note it in the log.
  return { ok: true, reason: 'ok', message: `Login returned an unexpected page: ${pathname}` };
}

/**
 * Build the X-Tone login URL for the given tenant field value.
 *
 * The tenant field accepts either the tenant web name (e.g. "vaspian") or one
 * of the tenant's phone numbers (e.g. "716-961-2115"). A phone number is sent
 * to ProcessDIDLogin.jsp as a 10-digit DID (formatting and a leading country
 * code 1 are stripped); anything else goes to ProcessLogin.jsp as tenantWebName.
 *
 * @param {string} tenant - Tenant web name or company phone number
 * @param {string} extension - User extension/ID
 * @param {string} password - User PIN
 * @returns {string}
 */
function buildLoginUrl(tenant, extension, password) {
  const base = 'https://xtone.buf.vaspian.net/webadmin/en/user/jsp';
  const raw = String(tenant || '').trim();
  const looksLikePhone = /^[\d\s()+.-]+$/.test(raw) && (raw.match(/\d/g) || []).length >= 10;

  if (looksLikePhone) {
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      digits = digits.slice(1);
    }
    return `${base}/ProcessDIDLogin.jsp?DID=${digits}&UserID=${encodeURIComponent(extension)}&Password=${encodeURIComponent(password)}`;
  }

  const webName = raw.replace(/^\/+/, '');
  return `${base}/ProcessLogin.jsp?tenantWebName=/${webName}&UserID=${encodeURIComponent(extension)}&Password=${encodeURIComponent(password)}`;
}

/**
 * Login to Vaspian system
 * @param {string} tenant - Tenant web name (e.g., "vaspian") or a company phone number
 * @param {string} extension - User extension/ID
 * @param {string} password - User password
 * @returns {Promise<{ok: boolean, reason: string, message: string}>}
 */
async function login(tenant, extension, password) {
  const loginUrl = buildLoginUrl(tenant, extension, password);

  addLog('info', `Login URL: ${loginUrl.replace(/Password=[^&]+/, 'Password=***')}`);

  try {
    // Check cookies before login
    // Cookie NAMES only: values are session secrets and would reach the
    // diagnostics export through the log.
    const cookiesBefore = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });
    addLog('info', `Cookies before login: ${cookiesBefore.length} (${cookiesBefore.map(c => c.name).join(', ') || 'none'})`);

    addLog('info', 'Sending login request...');
    const response = await fetch(loginUrl, {
      method: 'POST',
      credentials: 'include', // Important: this maintains cookies
      redirect: 'follow'
    });

    // Path only: the redirect's query string can echo the user ID, and the
    // body is a portal page we don't need in support logs.
    let responsePath = '';
    try { responsePath = new URL(response.url).pathname; } catch (e) { responsePath = '(unparsed)'; }
    addLog('info', `Login response: ${response.status} ${response.statusText}, landed on ${responsePath}`);

    const cookiesAfter = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });
    addLog('info', `Cookies after login: ${cookiesAfter.length} (${cookiesAfter.map(c => c.name).join(', ') || 'none'})`);
    await response.text().catch(() => ''); // drain

    const result = classifyLoginResponse(response.url, response.status);
    if (!result.ok) {
      addLog('error', `Login failed (${result.reason}): ${result.message}`);
      return result;
    }

    addLog('success', `Login request completed successfully (${result.message})`);
    return result;
  } catch (error) {
    addLog('error', `Login network error: ${error.message}`, error.stack);
    return { ok: false, reason: 'network', message: `Could not reach the Vaspian login server: ${error.message}` };
  }
}

/**
 * Make an X-Tone click-to-call request (session cookie from login()).
 * @param {string} origExt - Origin extension (your extension)
 * @param {string} destExt - Destination extension/phone number
 * @returns {Promise<object>}
 */
async function xtoneClickToCall(origExt, destExt) {
  const callUrl = `https://xtone.buf.vaspian.net/webadmin/en/user/jsp/ProcessClickToCall.jsp?origExt=${origExt}&destExt=${destExt}`;

  addLog('info', `Call URL: ${callUrl}`);

  try {
    // Check cookies before call
    const cookiesBefore = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });
    if (cookiesBefore.length > 0) {
      addLog('info', `Cookies before call: ${cookiesBefore.length} (${cookiesBefore.map(c => c.name).join(', ')})`);
    } else {
      addLog('warning', 'No cookies found! This will likely fail.');
    }

    addLog('info', 'Sending click-to-call request...');
    const response = await fetch(callUrl, {
      method: 'POST',
      credentials: 'include', // Use cookies from login
      redirect: 'follow'
    });

    let callPath = '';
    try { callPath = new URL(response.url).pathname; } catch (e) { callPath = '(unparsed)'; }
    addLog('info', `Call response: ${response.status} ${response.statusText}, landed on ${callPath}`);

    // Headers (Set-Cookie) and the body are not logged: they can carry the session.
    const result = await response.text();
    addLog('info', `Call response body: ${result ? `${result.length} chars` : '(empty)'}`);

    if (!response.ok) {
      const error = `Call failed: ${response.status} ${response.statusText}`;
      addLog('error', error);
      throw new Error(error);
    }

    // Check if we got redirected to login (would indicate session expired)
    if (response.url.includes('ProcessLogin') || response.url.includes('login')) {
      const error = 'Session expired or cookies not sent properly';
      addLog('error', error);
      throw new Error(error);
    }

    addLog('success', `Call request completed successfully`);

    return {
      success: true,
      message: 'Call initiated',
      destination: destExt,
      response: result
    };
  } catch (error) {
    addLog('error', `Call network error: ${error.message}`, error.stack);
    throw error;
  }
}

/**
 * Handle extension icon clicks (only for sidebar mode)
 */
function handleActionClick(tab) {
  if (sidebarEnabled) {
    chrome.sidePanel.open({ windowId: tab.windowId });
  }
}

// Set up the click listener once
chrome.action.onClicked.addListener(handleActionClick);

/**
 * Update the action behavior based on sidebar preference
 */
function updateActionBehavior() {
  if (sidebarEnabled) {
    // When sidebar is enabled, disable the popup and use the click listener
    chrome.action.setPopup({ popup: '' });
  } else {
    // When sidebar is disabled, enable the popup (click listener is ignored)
    chrome.action.setPopup({ popup: 'popup.html' });
  }
}

/**
 * Test login credentials
 * @param {string} tenant - Tenant name
 * @param {string} extension - User extension/ID
 * @param {string} password - User password
 * @returns {Promise<{isValid: boolean, message: string}>}
 */
async function testLogin(tenant, extension, password) {
  try {
    addLog('info', 'Testing login credentials...');

    const loginResult = await login(tenant, extension, password);

    if (loginResult.ok) {
      addLog('success', 'Credential test successful');
      isLoggedIn = true;
      await chrome.storage.sync.set({ isLoggedIn: true });
      return { isValid: true, reason: loginResult.reason, message: loginResult.message };
    } else {
      addLog('error', `Credential test failed: ${loginResult.message}`);
      isLoggedIn = false;
      await chrome.storage.sync.set({ isLoggedIn: false });
      return { isValid: false, reason: loginResult.reason, message: loginResult.message };
    }
  } catch (error) {
    addLog('error', `Credential test error: ${error.message}`, error.stack);
    isLoggedIn = false;
    await chrome.storage.sync.set({ isLoggedIn: false });
    return { isValid: false, message: `Credential test error: ${error.message}` };
  }
}

/**
 * Handle logout - clear cookies and session state
 */
async function handleLogout() {
  try {
    addLog('info', 'Logging out...');

    // Clear all cookies for the Vaspian domain
    const cookies = await chrome.cookies.getAll({ domain: 'xtone.buf.vaspian.net' });

    for (const cookie of cookies) {
      await chrome.cookies.remove({
        url: `https://${cookie.domain}${cookie.path}`,
        name: cookie.name
      });
      addLog('info', `Removed cookie: ${cookie.name}`);
    }

    // Get current dialPrefix to preserve it
    const settings = await chrome.storage.sync.get(['dialPrefix']);

    // Clear credentials but preserve dialPrefix (including empty string for "no prefix").
    // The PIN lives in local storage (v2); remove any v1 copy from sync too.
    await chrome.storage.sync.set({
      tenant: '',
      extension: '',
      dialPrefix: settings.dialPrefix !== undefined ? settings.dialPrefix : '8',  // Preserve current setting or default to '8'
      isLoggedIn: false
    });
    await chrome.storage.sync.remove('password');
    await chrome.storage.local.remove('password');

    // Clear click history
    await chrome.storage.local.set({ callHistory: [] });

    // Mark as logged out
    isLoggedIn = false;

    addLog('success', 'Logged out successfully - credentials and history cleared');
  } catch (error) {
    addLog('error', `Logout failed: ${error.message}`, error.stack);
    throw error;
  }
}

/**
 * Update the note for a specific call identified by phone number and timestamp
 * @param {string} phoneNumber - The phone number
 * @param {string} timestamp - The call timestamp (unique identifier)
 * @param {string} note - The note to add
 */
async function updateCallNote(phoneNumber, timestamp, note) {
  try {
    const result = await chrome.storage.local.get(['callHistory']);
    let callHistory = result.callHistory || [];

    // Find the specific call using both phone number and timestamp
    const callIndex = callHistory.findIndex(call =>
      call.phoneNumber === phoneNumber && call.timestamp === timestamp
    );

    if (callIndex !== -1) {
      callHistory[callIndex].note = note;
      await chrome.storage.local.set({ callHistory });
      addLog('info', `Updated note for call to ${phoneNumber} at ${timestamp}`);
    } else {
      addLog('warning', `Could not find call to ${phoneNumber} at ${timestamp} to update note`);
    }
  } catch (error) {
    addLog('error', `Failed to update call note: ${error.message}`);
    throw error;
  }
}

// Shared core first, then feature modules. Loaded last so addLog and the
// globals above exist. Feature tracks own their files; do not edit this list
// in a feature branch (see fleet/ARCHITECTURE.md).
self.OneClick = self.OneClick || {};
/** Dial a number with the best available path (3PCC, else X-Tone). For feature modules. */
self.OneClick.dial = handleClickToCall;
importScripts(
  'lib/phone.js',       // Phone number helpers (access code, display form)
  'lib/vaspian-api.js', // Public API client, WebSocket, event bus, 3PCC (foundation)
  'screenpop.js',       // Screen pop to CRM (foundation; Track C may extend)
  'calls.js',           // Track A "callcard": call state machine
  'presence.js',        // Track B "status": presence, DND, groups, ACD, badge
  'crm.js',             // Track C "crm": presets, history from events, notes, managed settings
  'operator.js'         // Team view for tenant admins (operator panel engine)
);

// ------------------------------------------------------------ onboarding ---
// First-run setup (welcome.html). State rules live in onboarding-state.js;
// it is loaded on its own so the feature modules list above stays as it is.
importScripts('onboarding-state.js');

/** On a fresh install, mark setup pending and open the welcome tab. Updates never show it. */
async function openFirstRunSetup(reason) {
  try {
    const { write, open } = self.OneClickOnboardingState.installAction(reason);
    if (write) await chrome.storage.local.set({ [self.OneClickOnboardingState.KEY]: write });
    if (open) await chrome.tabs.create({ url: 'welcome.html' });
  } catch (e) {
    addLog('error', `Setup tab: ${e.message}`);
  }
}
