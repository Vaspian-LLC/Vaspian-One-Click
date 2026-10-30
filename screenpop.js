// Screen pop for Vaspian One Click
//
// Listens for the logged-in extension's call events on the Silhouette Public
// API WebSocket and opens a CRM page for the caller's number.
//
// Flow:
//   1. GET /api/v1/ with Basic auth (<ext>@<webname>.URI or <ext>@<did>.DID)
//      to check the PIN and learn the numeric tenant ID. A 401 here stops all
//      retries: 3 failed logins in 30 minutes locks the extension for an hour.
//   2. Open wss://xtone.buf.vaspian.net/api/ws. A browser WebSocket cannot set
//      headers, so the Authorization header is added by a declarativeNetRequest
//      session rule; credentials in the URL are tried as a fallback.
//   3. On {"webSocketId"}, create a subscription set and subscribe to call
//      events for <ext>@<tenantId>.
//   4. offer -> remember the caller; answer (or offer, per setting) -> pop once
//      per callId. Outbound calls never get an offer, so they never pop.
//
// Loaded into background.js with importScripts(); uses its addLog().

const SP_HOST = 'xtone.buf.vaspian.net';
const SP_API = `https://${SP_HOST}/api/v1/`;
const SP_WS = `wss://${SP_HOST}/api/ws`;
const SP_DNR_RULE_ID = 7001;
const SP_KEEPALIVE_MS = 20 * 1000;
const SP_HELLO_EVERY = 15;     // keepalive ticks between "hello" messages (5 minutes)
const SP_BACKOFF_MS = [5000, 15000, 60000, 120000, 300000];

const SCREEN_POP_PRESETS = {
  simplicity: 'https://app.simplicitycollect.com/dialer/update.aspx?dialer=true&phone={phone10}'
};

let spSocket = null;
let spKeepalive = null;
let spRetryTimer = null;
let spAttempt = 0;
let spAuthMode = null;      // 'header' or 'url', whichever got us connected
let spAccount = null;       // <ext>@<tenantId>
let spCalls = {};           // callId -> { from, name, popped }
let spStopped = false;      // set after an auth failure; cleared when settings change
let spConnecting = null;    // in-flight connect, so callers never open two sockets
let spPending = false;      // a connect was requested while one was in flight
let spGeneration = 0;       // bumped by spDisconnect(); a connect from an older generation discards its socket

async function spSettings() {
  return chrome.storage.sync.get([
    'tenant', 'extension', 'password',
    'screenPopEnabled', 'screenPopCrm', 'screenPopUrl', 'screenPopTrigger'
  ]);
}

async function spSetStatus(state, detail = '') {
  await chrome.storage.local.set({ screenPopStatus: { state, detail, at: new Date().toISOString() } });
}

/**
 * Public API username for the tenant field: a phone number becomes
 * <ext>@<10 digits>.DID, a web name becomes <ext>@<webname>.URI.
 */
function spUsername(tenant, extension) {
  const raw = String(tenant || '').trim();
  const looksLikePhone = /^[\d\s()+.-]+$/.test(raw) && (raw.match(/\d/g) || []).length >= 10;
  if (looksLikePhone) {
    let digits = raw.replace(/\D/g, '');
    if (digits.length === 11 && digits.startsWith('1')) {
      digits = digits.slice(1);
    }
    return `${extension}@${digits}.DID`;
  }
  return `${extension}@${raw.replace(/^\/+/, '')}.URI`;
}

function spBasic(user, pass) {
  return 'Basic ' + btoa(`${user}:${pass}`);
}

async function spApi(method, path, authHeader) {
  return fetch(SP_API + path, {
    method,
    headers: { 'Authorization': authHeader, 'Accept': 'application/hal+json', 'Content-Type': 'application/json' },
    credentials: 'omit'
  });
}

/** Last 10 digits of a North American number; '' for internal callers. */
function spNormalize(number) {
  const raw = String(number || '');
  if (raw.includes('@')) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length === 10 ? digits : '';
}

function spBuildUrl(template, call) {
  const phone10 = spNormalize(call.from);
  return template
    .replaceAll('{phone10}', phone10)
    .replaceAll('{e164}', phone10 ? encodeURIComponent(`+1${phone10}`) : '')
    .replaceAll('{phone}', encodeURIComponent(call.from || ''))
    .replaceAll('{name}', encodeURIComponent(call.name || ''));
}

/**
 * Open the CRM page. Reuses only the tab the last pop opened, so a tab the
 * agent is working in (half-typed notes) is never navigated away.
 */
async function spOpen(url) {
  const { screenPopTabId } = await chrome.storage.session.get(['screenPopTabId']);
  let tab = null;
  if (screenPopTabId) {
    try { tab = await chrome.tabs.get(screenPopTabId); } catch (e) { tab = null; }
  }
  if (tab) {
    await chrome.tabs.update(tab.id, { url, active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    addLog('success', `Screen pop: reused pop tab ${tab.id}`);
  } else {
    tab = await chrome.tabs.create({ url, active: true });
    await chrome.storage.session.set({ screenPopTabId: tab.id });
    addLog('success', `Screen pop: opened new tab ${tab.id}`);
  }
}

async function spPop(callId) {
  const call = spCalls[callId];
  if (!call || call.popped) return;
  call.popped = true;

  if (!spNormalize(call.from)) {
    addLog('info', `Screen pop: skipped ${call.from} (internal or not a 10-digit number)`);
    return;
  }
  const settings = await spSettings();
  const template = settings.screenPopCrm === 'custom'
    ? settings.screenPopUrl
    : SCREEN_POP_PRESETS[settings.screenPopCrm || 'simplicity'];
  if (!template) {
    addLog('error', 'Screen pop: no URL configured');
    return;
  }
  const url = spBuildUrl(template, call);
  addLog('info', `Screen pop for ${call.from} (${call.name || 'no name'}): ${url}`);
  await chrome.storage.local.set({ screenPopLast: { from: call.from, name: call.name, url, at: new Date().toISOString() } });
  await spOpen(url);
}

async function spHandleEvent(event) {
  const settings = await spSettings();
  const trigger = settings.screenPopTrigger || 'answer';
  const { callId } = event;
  if (!callId) return;

  if (event.event === 'offer') {
    // offer can arrive more than once for the same call (seen on ring groups)
    if (!spCalls[callId]) {
      spCalls[callId] = { from: event.from, name: event.callingName || '', popped: false };
      addLog('info', `Screen pop: incoming call from ${event.from} (${event.callingName || 'no name'})`);
    }
    if (trigger === 'offer') await spPop(callId);
  } else if (event.event === 'answer') {
    if (trigger === 'answer' && spCalls[callId] && event.answeringParty === spAccount) {
      await spPop(callId);
    }
  } else if (event.event === 'end') {
    delete spCalls[callId];
  }
}

/** Session rule that adds the Authorization header to the WebSocket handshake. */
async function spSetHeaderRule(authHeader) {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [SP_DNR_RULE_ID],
    addRules: authHeader ? [{
      id: SP_DNR_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Authorization', operation: 'set', value: authHeader }]
      },
      condition: { urlFilter: `|${SP_WS}`, resourceTypes: ['websocket'] }
    }] : []
  });
}

/**
 * Open the socket with one auth mode. Resolves with the socket once the
 * server sends its webSocketId; rejects if the socket closes first.
 */
function spOpenSocket(mode, user, pass) {
  return new Promise((resolve, reject) => {
    const url = mode === 'url'
      ? `wss://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${SP_HOST}/api/ws`
      : SP_WS;
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      reject(new Error(`WebSocket constructor rejected ${mode} mode: ${e.message}`));
      return;
    }
    const timer = setTimeout(() => { ws.close(); reject(new Error(`${mode} mode: no webSocketId within 10 s`)); }, 10000);
    ws.onmessage = (msg) => {
      let data;
      try { data = JSON.parse(msg.data); } catch (e) { return; }
      if (data.webSocketId) {
        clearTimeout(timer);
        resolve({ ws, webSocketId: data.webSocketId });
      }
    };
    ws.onclose = (e) => { clearTimeout(timer); reject(new Error(`${mode} mode: closed (code ${e.code}) before connecting`)); };
  });
}

/**
 * Connect unless a connect is already running. The server allows one socket
 * per user and IP, so a second socket would kick the first. A request that
 * arrives mid-connect runs once the current attempt finishes.
 */
function spConnect() {
  if (spConnecting) {
    spPending = true;
    return spConnecting;
  }
  spConnecting = spConnectOnce().finally(() => {
    spConnecting = null;
    if (spPending) {
      spPending = false;
      spConnect();
    }
  });
  return spConnecting;
}

async function spConnectOnce() {
  clearTimeout(spRetryTimer);
  const generation = spGeneration;
  const stale = () => generation !== spGeneration;
  const settings = await spSettings();
  if (!settings.screenPopEnabled) {
    await spSetStatus('off');
    return;
  }
  if (spStopped) return;
  if (!settings.tenant || !settings.extension || !settings.password) {
    await spSetStatus('error', 'Log in first (Tenant, Extension and Password)');
    return;
  }
  if (spSocket && spSocket.readyState <= WebSocket.OPEN) return;

  const user = spUsername(settings.tenant, settings.extension);
  const authHeader = spBasic(user, settings.password);
  await spSetStatus('connecting', `as ${user}`);
  addLog('info', `Screen pop: connecting as ${user}`);

  // 1. Check credentials once over REST and learn the tenant ID.
  let tenantId;
  try {
    const res = await spApi('GET', '', authHeader);
    if (res.status === 401 || res.status === 403) {
      spStopped = true;
      await spSetStatus('error', 'Login rejected by the Public API. Check Tenant, Extension and PIN. Not retrying (3 failures lock the extension).');
      addLog('error', `Screen pop: Public API returned ${res.status}; stopped to avoid a lockout`);
      return;
    }
    if (!res.ok) throw new Error(`Public API returned ${res.status}`);
    const root = await res.json();
    const href = root?._links?.['v1:extensions']?.href || '';
    tenantId = (href.match(/\/tenants\/(\d+)\//) || [])[1];
    if (!tenantId) throw new Error('could not find the tenant ID in the API root');
  } catch (e) {
    addLog('error', `Screen pop: ${e.message}`);
    if (!stale()) spScheduleRetry(e.message);
    return;
  }
  if (stale()) return;
  spAccount = `${settings.extension}@${tenantId}`;

  // 2. Open the socket: header injection first, then credentials in the URL.
  let opened = null;
  const failures = [];
  for (const mode of ['header', 'url']) {
    try {
      if (mode === 'header') await spSetHeaderRule(authHeader);
      opened = await spOpenSocket(mode, user, settings.password);
      spAuthMode = mode;
      break;
    } catch (e) {
      failures.push(e.message);
      addLog('warning', `Screen pop: ${e.message}`);
    } finally {
      if (mode === 'header' && !opened) await spSetHeaderRule(null);
    }
  }
  if (!opened) {
    if (!stale()) spScheduleRetry(`WebSocket would not connect (${failures.join('; ')})`);
    return;
  }
  if (stale()) {
    opened.ws.onclose = null;
    opened.ws.close();
    return;
  }

  spSocket = opened.ws;
  addLog('success', `Screen pop: WebSocket connected (${spAuthMode} auth), wsId ${opened.webSocketId}`);

  // 3. Subscribe to our own call events.
  try {
    const setRes = await spApi('POST', `subscriptions/ws/${opened.webSocketId}/subscriptionsets`, authHeader);
    if (!setRes.ok) throw new Error(`create subscription set returned ${setRes.status}`);
    const setId = (await setRes.json()).subscriptionSetId;
    const subRes = await spApi('PUT', `subscriptions/ws/${opened.webSocketId}/subscriptionsets/${setId}/calleventaccounts/${spAccount}`, authHeader);
    if (!subRes.ok) throw new Error(`subscribe to ${spAccount} returned ${subRes.status}`);
  } catch (e) {
    addLog('error', `Screen pop: ${e.message}`);
    opened.ws.onclose = null;
    opened.ws.close();
    if (spSocket === opened.ws) spSocket = null;
    if (!stale()) spScheduleRetry(e.message);
    return;
  }
  if (stale()) {
    opened.ws.onclose = null;
    opened.ws.close();
    return;
  }

  spAttempt = 0;
  await spSetStatus('connected', `Listening for calls to ${spAccount} (${spAuthMode} auth)`);
  addLog('success', `Screen pop: subscribed to call events for ${spAccount}`);

  spSocket.onmessage = (msg) => {
    let data;
    try { data = JSON.parse(msg.data); } catch (e) { return; }
    if (data.event) {
      addLog('info', `Screen pop event: ${data.event}`, data);
      spHandleEvent(data).catch(err => addLog('error', `Screen pop: ${err.message}`));
    }
  };
  spSocket.onclose = (e) => {
    addLog('warning', `Screen pop: WebSocket closed (code ${e.code})`);
    spSocket = null;
    clearInterval(spKeepalive);
    spScheduleRetry(`connection closed (code ${e.code})`);
  };

  // Calling an extension API resets the service worker's idle timer, so the
  // worker (and the socket) stays alive between calls. The server drops a
  // socket after an hour without traffic; its docs say to send "hello".
  clearInterval(spKeepalive);
  let ticks = 0;
  spKeepalive = setInterval(() => {
    chrome.runtime.getPlatformInfo();
    if (++ticks % SP_HELLO_EVERY === 0 && spSocket?.readyState === WebSocket.OPEN) spSocket.send('hello');
  }, SP_KEEPALIVE_MS);
}

function spScheduleRetry(reason) {
  if (spStopped) return;
  const delay = SP_BACKOFF_MS[Math.min(spAttempt, SP_BACKOFF_MS.length - 1)];
  spAttempt++;
  spSetStatus('retrying', `${reason}. Retrying in ${Math.round(delay / 1000)} s`);
  clearTimeout(spRetryTimer);
  spRetryTimer = setTimeout(spConnect, delay);
}

function spDisconnect() {
  spGeneration++;
  clearTimeout(spRetryTimer);
  clearInterval(spKeepalive);
  if (spSocket) {
    spSocket.onclose = null;
    spSocket.close();
    spSocket = null;
  }
  spCalls = {};
}

// Reconnect when credentials or screen pop settings change; a settings change
// also clears the stop flag set by an auth failure.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  const keys = ['tenant', 'extension', 'password', 'screenPopEnabled'];
  if (keys.some(k => k in changes)) {
    spStopped = false;
    spAttempt = 0;
    spDisconnect();
    spConnect();
  }
});

// Wake up once a minute in case Chrome stopped the worker anyway.
chrome.alarms.create('screenPopWatchdog', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'screenPopWatchdog') spConnect();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'screenPopTest') {
    spCalls.test = { from: request.phoneNumber, name: 'Test call', popped: false };
    spPop('test')
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  } else if (request.action === 'screenPopReconnect') {
    spStopped = false;
    spAttempt = 0;
    spDisconnect();
    spConnect().then(() => sendResponse({ success: true }));
    return true;
  }
});

spConnect();
