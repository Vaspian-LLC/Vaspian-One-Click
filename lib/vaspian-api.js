// Vaspian Public API client for One Click (service worker).
//
// The single owner of: credentials (incl. the PIN migration from sync to
// local storage), the REST helper (max 3 concurrent requests), the one shared
// WebSocket, event subscriptions, the internal event bus, the connection
// status object, and the 3PCC helpers (makeCall / callControl).
//
// Loaded by background.js with importScripts() before any feature module.
// Everything is exposed as self.OneClick.api; nothing else is global.
// See fleet/ARCHITECTURE.md for the full contract.
//
// Lockout safety (3 failed logins in 30 min locks the extension for 1 h):
//   - A REST 401 (or 403 with WWW-Authenticate) stops ALL traffic: REST
//     requests are refused locally and the socket is closed. The stop is
//     persisted with a fingerprint of the credentials, so service-worker
//     restarts and the watchdog alarm never retry the same bad PIN. It clears
//     only when the credentials change or the user presses Reconnect.
//   - If REST accepts the PIN but the WebSocket closes before sending its
//     webSocketId, that counts as a WS rejection. After WS_MAX_REJECTIONS in
//     a row the socket stops (REST keeps working) with reason 'ws_rejected'.
//   - 403/404 permission errors never count: they are "not permitted".
//
// Never log the WebSocket URL: in URL-credential mode it contains the PIN.

(function () {
  'use strict';

  const HOST = 'xtone.buf.vaspian.net';
  const API_BASE = `https://${HOST}/api/v1/`;
  const STATUS_KEY = 'apiStatus';
  const GUARD_KEY = 'apiGuard';
  const WATCHDOG_ALARM = 'vaspianApiWatchdog';

  const CONFIG = {
    restConcurrency: 3,          // server limit: 3 concurrent REST requests per user+IP
    restTimeoutMs: 15000,        // GET calls/{id}?expand=all has been seen to hang > 20 s
    wsOpenTimeoutMs: 10000,      // no webSocketId within this -> counts as a rejection
    wsMaxRejections: 2,          // consecutive close-before-webSocketId after REST 200
    keepaliveMs: 20 * 1000,      // SW keepalive tick (extension API call resets idle timer)
    helloEvery: 15,              // ticks between "hello" frames (5 min; server idle timeout 1 h)
    backoffMs: [5000, 15000, 60000, 120000, 300000],
    stableMs: 60 * 1000,         // a socket must stay up this long before backoff resets
    phonesTtlMs: 60 * 1000,      // cache for myphones (makeCall pre-check)
    credentialDebounceMs: 300
  };

  /** Subscription kinds -> URL segment under .../subscriptionsets/{setId}/ */
  const SUB_KINDS = {
    call: 'calleventaccounts',
    presence: 'presenceeventaccounts',
    parklocation: 'parklocationeventaccounts'
  };

  // ------------------------------------------------------------- logging ---
  function log(level, message, details) {
    try {
      if (typeof addLog === 'function') addLog(level, `API: ${message}`, details); // eslint-disable-line no-undef
      else console.log(`[API] [${level}] ${message}`);
    } catch (e) { /* logging must never throw */ }
  }

  // ----------------------------------------------------------- event bus ---
  const handlers = new Map(); // eventName -> Set<fn>

  /**
   * Subscribe to a bus event. '*' receives every event as (name, payload).
   * @param {string} name
   * @param {Function} fn
   * @returns {Function} unsubscribe
   */
  function on(name, fn) {
    if (!handlers.has(name)) handlers.set(name, new Set());
    handlers.get(name).add(fn);
    return () => off(name, fn);
  }
  function off(name, fn) {
    const set = handlers.get(name);
    if (set) set.delete(fn);
  }
  function once(name, fn) {
    const un = on(name, (payload) => { un(); fn(payload); });
    return un;
  }
  /** Emit synchronously; a throwing or rejecting handler is logged, never propagated. */
  function emit(name, payload) {
    const run = (fn, args) => {
      try {
        const r = fn(...args);
        if (r && typeof r.catch === 'function') r.catch((e) => log('error', `handler for "${name}" failed: ${e.message}`));
      } catch (e) {
        log('error', `handler for "${name}" failed: ${e.message}`);
      }
    };
    for (const fn of [...(handlers.get(name) || [])]) run(fn, [payload]);
    if (name !== '*') for (const fn of [...(handlers.get('*') || [])]) run(fn, [name, payload]);
  }

  // --------------------------------------------------------- credentials ---
  /**
   * Public API username for the tenant field: a phone number becomes
   * <ext>@<10 digits>.DID, a web name becomes <ext>@<webname>.URI.
   */
  function usernameFor(tenant, extension) {
    const raw = String(tenant || '').trim();
    const looksLikePhone = /^[\d\s()+.-]+$/.test(raw) && (raw.match(/\d/g) || []).length >= 10;
    if (looksLikePhone) {
      let digits = raw.replace(/\D/g, '');
      if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
      return `${extension}@${digits}.DID`;
    }
    return `${extension}@${raw.replace(/^\/+/, '')}.URI`;
  }

  /**
   * One-time (and idempotent) PIN migration: chrome.storage.sync -> local.
   * A non-empty PIN in sync always wins (it can only be there if a v1 client
   * wrote it after our last migration), then it is removed from sync.
   * @returns {Promise<boolean>} true if sync held a password key
   */
  async function migratePin() {
    const s = await chrome.storage.sync.get(['password']);
    if (s.password === undefined) return false;
    if (s.password) await chrome.storage.local.set({ password: s.password });
    await chrome.storage.sync.remove('password');
    log('info', 'Moved the PIN from synced storage to this device only');
    return true;
  }

  /**
   * @returns {Promise<{tenant:string, extension:string, password:string, username:string|null, complete:boolean}>}
   */
  async function getCredentials() {
    await migratePin();
    const s = await chrome.storage.sync.get(['tenant', 'extension']);
    const l = await chrome.storage.local.get(['password']);
    const tenant = String(s.tenant || '').trim();
    const extension = String(s.extension || '').trim();
    const password = l.password || '';
    const complete = !!(tenant && extension && password);
    return { tenant, extension, password, username: complete ? usernameFor(tenant, extension) : null, complete };
  }

  /** SHA-256 of user:pin (hex). Identifies a credential set without storing the PIN. */
  async function fingerprint(username, password) {
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function basic(user, pass) {
    return 'Basic ' + btoa(unescape(encodeURIComponent(`${user}:${pass}`)));
  }

  // ------------------------------------------------- party normalization ---
  /**
   * Normalize a party as it appears in events: '196', '196@4', '13155694033',
   * '3155694033', '+1 315-569-4033'.
   * @param {string} raw
   * @param {{tenantId?:string, selfExt?:string}} [ctx]
   * @returns {null|{raw:string, ext:string|null, tenantId:string|null, digits:string, number:string|null,
   *   e164:string|null, isInternal:boolean, isSelf:boolean, display:string}}
   */
  function normalizeParty(raw, ctx = {}) {
    if (raw === undefined || raw === null || raw === '') return null;
    const str = String(raw).trim();
    const selfExt = ctx.selfExt !== undefined ? ctx.selfExt : (session && session.extension);
    const m = str.match(/^([^@]+)@(.+)$/);
    if (m) {
      const ext = m[1];
      return {
        raw: str, ext, tenantId: m[2], digits: ext.replace(/\D/g, ''), number: null, e164: null,
        isInternal: true, isSelf: !!selfExt && ext === String(selfExt), display: ext
      };
    }
    const digits = str.replace(/\D/g, '');
    if (digits && digits.length <= 6 && /^[\d*#]+$/.test(str)) {
      return {
        raw: str, ext: str, tenantId: null, digits, number: null, e164: null,
        isInternal: true, isSelf: !!selfExt && str === String(selfExt), display: str
      };
    }
    let number = null;
    if (digits.length === 10) number = digits;
    else if (digits.length === 11 && digits.startsWith('1')) number = digits.slice(1);
    return {
      raw: str, ext: null, tenantId: null, digits, number,
      e164: number ? `+1${number}` : (digits ? `+${digits}` : null),
      isInternal: false, isSelf: false,
      display: number ? `(${number.slice(0, 3)}) ${number.slice(3, 6)}-${number.slice(6)}` : str
    };
  }

  /** True if two raw parties refer to the same extension or number. */
  function sameParty(a, b) {
    const pa = typeof a === 'object' && a !== null ? a : normalizeParty(a);
    const pb = typeof b === 'object' && b !== null ? b : normalizeParty(b);
    if (!pa || !pb) return false;
    if (pa.isInternal && pb.isInternal) return pa.ext === pb.ext;
    if (pa.number && pb.number) return pa.number === pb.number;
    return pa.digits !== '' && pa.digits === pb.digits;
  }

  /** ISO 8601 duration (PT6.3S, PT1M2S) -> ms; null if absent. */
  function durationMs(iso) {
    const m = String(iso || '').match(/^P(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/);
    if (!m || !iso) return null;
    return Math.round(((+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0)) * 1000);
  }

  // Per-call memory for direction and duplicate detection. Cleared on 'end'.
  let callMemo = new Map(); // callId -> { direction, offers, firstAt }

  const PRESENCE_EVENTS = new Set(['dndOn', 'dndOff', 'busy', 'idle', 'available', 'unavailable',
    'signedInAcd', 'signedOutAcd', 'joinedGroup', 'leftGroup']);

  /** Turn one raw WS frame into a normalized bus payload (see ARCHITECTURE.md). */
  function normalizeEvent(raw) {
    const ctx = { selfExt: session && session.extension, tenantId: session && session.tenantId };
    if (raw.callId) {
      let memo = callMemo.get(raw.callId);
      const isNew = !memo;
      const from = normalizeParty(raw.from, ctx);
      if (!memo) {
        let direction = 'unknown';
        if (raw.event === 'offer' || raw.event === 'ringing') direction = 'inbound';
        else if (raw.event === 'dial' || raw.event === 'ringback') direction = 'outbound';
        else if (from) direction = from.isSelf ? 'outbound' : 'inbound';
        memo = { direction, offers: 0, firstAt: Date.now() };
        callMemo.set(raw.callId, memo);
      }
      if (raw.event === 'offer') memo.offers++;
      const out = {
        kind: 'call',
        type: raw.event,
        callId: raw.callId,
        smdrCallId: raw.smdrCallId || null,
        sipCallId: raw.sipCallId || null,
        observedParty: raw.observedParty || null,
        from,
        to: normalizeParty(raw.to, ctx),
        answeringParty: normalizeParty(raw.answeringParty, ctx),
        endingParty: normalizeParty(raw.endingParty, ctx),
        callingName: raw.callingName || '',
        dialedDigits: raw.dialedDigits || '',
        direction: memo.direction,
        isNew,
        isDuplicate: raw.event === 'offer' && memo.offers > 1,
        endReason: raw.endReason || null,
        callDurationMs: durationMs(raw.callDuration),
        deviceId: raw.ringingDeviceId || raw.answeringDeviceId || raw.dialingDeviceId || null,
        timestamp: raw.timestamp || new Date().toISOString(),
        raw
      };
      if (raw.event === 'end') callMemo.delete(raw.callId);
      return out;
    }
    const observed = String(raw.observedParty || '');
    if (/^PL\d+@/i.test(observed) || raw.parkLocationNumber !== undefined) {
      return {
        kind: 'parklocation', type: raw.event, accountId: observed || null,
        parkLocationNumber: raw.parkLocationNumber || (observed.match(/^PL(\d+)@/i) || [])[1] || null,
        timestamp: raw.timestamp || new Date().toISOString(), raw
      };
    }
    const party = normalizeParty(observed, ctx);
    return {
      kind: 'presence', type: raw.event, account: observed || null,
      isSelf: !!(party && party.isSelf),
      known: PRESENCE_EVENTS.has(raw.event),
      groupJoined: raw.groupJoined || null,
      groupLeft: raw.groupLeft || null,
      timestamp: raw.timestamp || new Date().toISOString(), raw
    };
  }

  // ------------------------------------------------------------- status ---
  let status = { state: 'off', reason: null, detail: '' };

  /**
   * Publish the one connection status object the UI renders
   * (chrome.storage.local.apiStatus) and emit 'status'.
   */
  async function setStatus(state, patch = {}) {
    status = {
      state,                                  // off | connecting | connected | retrying | error
      reason: patch.reason || null,           // no_credentials | auth | ws_rejected | network | server | subscribe | null
      detail: patch.detail || '',
      account: session ? session.account : null,
      tenantId: session ? session.tenantId : null,
      extension: session ? session.extension : null,
      isAdmin: session ? session.isAdmin : false,
      wsConnected: state === 'connected',
      authMode: state === 'connected' ? 'url' : null,
      attempt,
      nextRetryAt: patch.nextRetryAt || null,
      since: state === status.state ? (status.since || new Date().toISOString()) : new Date().toISOString(),
      at: new Date().toISOString()
    };
    try { await chrome.storage.local.set({ [STATUS_KEY]: status }); } catch (e) { /* ignore */ }
    emit('status', status);
  }

  // --------------------------------------------------------------- guard ---
  // Persisted lockout guard: { fp, stopped: null|'auth'|'ws_rejected', wsRejections, at }
  async function readGuard() {
    return (await chrome.storage.local.get([GUARD_KEY]))[GUARD_KEY] || null;
  }
  async function writeGuard(g) {
    await chrome.storage.local.set({ [GUARD_KEY]: { ...g, at: new Date().toISOString() } });
  }
  /** Guard for this fingerprint (a guard for other credentials is discarded). */
  async function guardFor(fp) {
    const g = await readGuard();
    if (g && g.fp === fp) return g;
    return { fp, stopped: null, wsRejections: 0 };
  }

  // ---------------------------------------------------------------- REST ---
  let inFlight = 0;
  const queue = [];
  function acquire() {
    if (inFlight < CONFIG.restConcurrency) { inFlight++; return Promise.resolve(); }
    return new Promise((resolve) => queue.push(resolve));
  }
  function release() {
    const next = queue.shift();
    if (next) next(); else inFlight--;
  }

  /**
   * Classify a failed response so callers never guess from status codes.
   * @returns {'auth'|'device'|'invalid'|'forbidden'|'notFound'|'state'|'busy'|'server'|'network'|'timeout'|'stopped'|'unknown'}
   */
  function classifyError(status, errorCode, headers) {
    if (status === 401) return 'auth';
    if (status === 403 && headers && /basic/i.test(headers.get ? (headers.get('www-authenticate') || '') : '')) return 'auth';
    if (status === 400) return errorCode === 'RequestNotValidForSpecifiedDevice' ? 'device' : 'invalid';
    if (status === 403) return 'forbidden';
    if (status === 404) return (errorCode === 'RestrictedDataAccessAttempt' || errorCode === 'FeatureNotEnabled') ? 'forbidden' : 'notFound';
    if (status === 405) return 'forbidden';
    if (status === 409) return 'state';
    if (status === 503) return 'busy';
    if (status >= 500) return 'server';
    return 'unknown';
  }

  /** Low-level request; ignores the stop flag. Only connect/ensureSession use it directly. */
  async function rawRequest(method, path, { body, authHeader, timeoutMs } = {}) {
    const url = /^https:/.test(path) ? path : API_BASE + String(path || '').replace(/^\/?(api\/v1\/)?/, '');
    await acquire();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || CONFIG.restTimeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: { Authorization: authHeader, Accept: 'application/hal+json', 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        signal: ctrl.signal
      });
      const text = await res.text();
      let data = null;
      try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }
      const errorCode = data && typeof data === 'object' ? (data.errorCode || null) : null;
      const message = data && typeof data === 'object'
        ? ((data.localizedUserMessage && data.localizedUserMessage.renderedMessage) || data.message || '')
        : '';
      return {
        ok: res.ok, status: res.status, body: data, errorCode, message,
        errorClass: res.ok ? null : classifyError(res.status, errorCode, res.headers)
      };
    } catch (e) {
      const timeout = e && e.name === 'AbortError';
      return { ok: false, status: 0, body: null, errorCode: null, message: timeout ? 'request timed out' : e.message, errorClass: timeout ? 'timeout' : 'network' };
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /**
   * REST helper for feature modules. Never throws for HTTP errors.
   * Refused locally (errorClass 'stopped') while stopped for bad credentials.
   * A 401 stops everything (lockout safety).
   * @param {string} method
   * @param {string} path relative to /api/v1/ (e.g. 'calls' or `tenants/${tid}/users/${ext}/dnd`)
   * @param {{body?:any, timeoutMs?:number}} [opts]
   * @returns {Promise<{ok:boolean,status:number,body:any,errorCode:string|null,message:string,errorClass:string|null}>}
   */
  async function request(method, path, opts = {}) {
    const creds = await getCredentials();
    if (!creds.complete) return { ok: false, status: 0, body: null, errorCode: null, message: 'not logged in', errorClass: 'stopped' };
    const fp = await fingerprint(creds.username, creds.password);
    const guard = await guardFor(fp);
    if (guard.stopped === 'auth') {
      return { ok: false, status: 0, body: null, errorCode: null, message: 'stopped after the PIN was rejected', errorClass: 'stopped' };
    }
    const res = await rawRequest(method, path, { ...opts, authHeader: basic(creds.username, creds.password) });
    if (res.errorClass === 'auth') await stopForAuth(fp, `${method} ${String(path).split('?')[0]} returned ${res.status}`);
    return res;
  }

  // ------------------------------------------------------------- session ---
  let session = null;          // { account, tenantId, extension, username, isAdmin, links, fp }
  let sessionPromise = null;

  /** First link href containing /tenants/<id>/ in the API root. */
  function tenantIdFromRoot(root) {
    const links = (root && root._links) || {};
    const preferred = links['v1:extensions'] && links['v1:extensions'].href;
    const hrefs = [preferred, ...Object.values(links).map((l) => (l && l.href) || '')];
    for (const h of hrefs) {
      const m = String(h || '').match(/\/tenants\/(\d+)(\/|$|\{)/);
      if (m) return m[1];
    }
    return null;
  }

  /**
   * Check the PIN once over REST (GET /api/v1/) and learn the tenant ID.
   * Cached per credential fingerprint; concurrent callers share one request.
   * @returns {Promise<{ok:boolean, session?:object, errorClass?:string, message?:string}>}
   */
  function ensureSession() {
    if (sessionPromise) return sessionPromise;
    sessionPromise = (async () => {
      const creds = await getCredentials();
      if (!creds.complete) return { ok: false, errorClass: 'stopped', message: 'Log in first (Tenant, Extension and PIN)' };
      const fp = await fingerprint(creds.username, creds.password);
      if (session && session.fp === fp) return { ok: true, session };
      const guard = await guardFor(fp);
      if (guard.stopped === 'auth') return { ok: false, errorClass: 'stopped', message: 'stopped after the PIN was rejected' };
      const res = await rawRequest('GET', '', { authHeader: basic(creds.username, creds.password) });
      if (res.errorClass === 'auth') {
        await stopForAuth(fp, `GET /api/v1/ returned ${res.status}`);
        return { ok: false, errorClass: 'auth', message: 'Login rejected by the Public API' };
      }
      if (!res.ok) return { ok: false, errorClass: res.errorClass, message: res.status ? `Public API returned ${res.status}` : res.message };
      const tenantId = tenantIdFromRoot(res.body);
      if (!tenantId) return { ok: false, errorClass: 'server', message: 'could not find the tenant ID in the API root' };
      const links = (res.body && res.body._links) || {};
      session = {
        account: `${creds.extension}@${tenantId}`, tenantId, extension: creds.extension, username: creds.username,
        isAdmin: !!links['v1:presenceStatusTenantAccounts'], links, fp
      };
      emit('session', publicSession());
      return { ok: true, session };
    })().finally(() => { sessionPromise = null; });
    return sessionPromise;
  }

  function publicSession() {
    if (!session) return null;
    const { account, tenantId, extension, username, isAdmin, links } = session;
    return { account, tenantId, extension, username, isAdmin, links };
  }

  // ----------------------------------------------------------- WebSocket ---
  let socket = null;
  let socketOpenedAt = 0;
  let webSocketId = null;
  let subscriptionSetId = null;
  let keepaliveTimer = null;
  let retryTimer = null;
  let attempt = 0;
  let connecting = null;   // in-flight connect promise (connect guard)
  let pending = false;     // a connect was requested while one was running
  let generation = 0;      // bumped by disconnect(); stale connects discard their socket
  let manualStop = false;  // stop() from tests/devtools; cleared by reconnect()

  /** Desired subscriptions: key `${kind}|${account}` -> { kind, account, result } */
  const desired = new Map();

  /**
   * Open the socket with credentials in the URL (the only mode that works
   * from an MV3 service worker). Resolves once the server sends webSocketId.
   */
  function openSocket(user, pass) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(`wss://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${HOST}/api/ws`);
      } catch (e) {
        // The constructor's message can contain the URL (and so the PIN): never log it.
        reject(Object.assign(new Error('WebSocket could not be created'), { beforeId: true }));
        return;
      }
      const timer = setTimeout(() => {
        ws.onclose = null;
        try { ws.close(); } catch (e) { /* ignore */ }
        reject(Object.assign(new Error(`no webSocketId within ${CONFIG.wsOpenTimeoutMs / 1000} s`), { beforeId: true }));
      }, CONFIG.wsOpenTimeoutMs);
      ws.onmessage = (msg) => {
        let data;
        try { data = JSON.parse(msg.data); } catch (e) { return; }
        if (data && data.webSocketId) {
          clearTimeout(timer);
          ws.onmessage = null;
          ws.onclose = null;
          resolve({ ws, webSocketId: data.webSocketId });
        }
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(Object.assign(new Error(`closed (code ${e.code}) before the server sent a webSocketId`), { beforeId: true }));
      };
    });
  }

  function resolveAccount(kind, account) {
    if (!session) return null;
    if (!account || account === 'self') return session.account;
    let a = String(account);
    if (kind === 'parklocation' && /^\d+$/.test(a)) a = `PL${a}`;
    if (!a.includes('@')) a = `${a}@${session.tenantId}`;
    return a;
  }

  async function putSubscription(entry) {
    const account = resolveAccount(entry.kind, entry.account);
    const res = await request('PUT', `subscriptions/ws/${webSocketId}/subscriptionsets/${subscriptionSetId}/${SUB_KINDS[entry.kind]}/${account}`);
    entry.result = { ok: res.ok, status: res.status, errorCode: res.errorCode, errorClass: res.errorClass, account };
    if (res.ok) log('info', `subscribed to ${entry.kind} events for ${account}`);
    else log('warning', `subscribe to ${entry.kind} events for ${account} returned ${res.status} ${res.errorCode || ''}`.trim());
    emit('subscription', { kind: entry.kind, account, ok: res.ok, status: res.status, errorCode: res.errorCode, errorClass: res.errorClass });
    return entry.result;
  }

  /**
   * Ask for events of one kind for one account. Remembered across reconnects.
   * @param {'call'|'presence'|'parklocation'} kind
   * @param {string} [account] 'self' (default), '<ext>', '<ext>@<tid>', 'PL1', 'PL1@<tid>' or '1' for park
   * @returns {Promise<{ok:boolean,status:number,errorCode:string|null,errorClass:string|null,account:string}|{ok:false,pending:true}>}
   *   resolves immediately with {pending:true} if not connected; the PUT happens on connect.
   */
  async function subscribe(kind, account = 'self') {
    if (!SUB_KINDS[kind]) throw new Error(`unknown subscription kind ${kind}`);
    const key = `${kind}|${account}`;
    let entry = desired.get(key);
    if (!entry) { entry = { kind, account, result: null }; desired.set(key, entry); }
    if (socket && webSocketId && subscriptionSetId) return putSubscription(entry);
    return { ok: false, pending: true };
  }

  /** Stop asking for events; DELETEs the account from the live set if connected. */
  async function unsubscribe(kind, account = 'self') {
    const key = `${kind}|${account}`;
    desired.delete(key);
    if (socket && webSocketId && subscriptionSetId && session) {
      const acct = resolveAccount(kind, account);
      return request('DELETE', `subscriptions/ws/${webSocketId}/subscriptionsets/${subscriptionSetId}/${SUB_KINDS[kind]}/${acct}`);
    }
    return { ok: true };
  }

  function listSubscriptions() {
    return [...desired.values()].map((e) => ({ kind: e.kind, account: e.account, result: e.result }));
  }

  // Core subscriptions every feature relies on.
  desired.set('call|self', { kind: 'call', account: 'self', result: null });
  desired.set('presence|self', { kind: 'presence', account: 'self', result: null });

  function handleFrame(msg) {
    let data;
    try { data = JSON.parse(msg.data); } catch (e) { return; }
    if (!data || typeof data !== 'object') return;
    emit('raw', data);
    if (!data.event) return;
    log('info', `event ${data.event}${data.callId ? ' ' + data.callId : ''}`, data);
    const ev = normalizeEvent(data);
    emit(ev.kind, ev);
    emit(`${ev.kind}:${ev.type}`, ev);
    if (ev.kind === 'call' && ev.isNew) emit('call:new', ev);
  }

  /**
   * Connect unless already connected or connecting (one socket per user+IP).
   * A request that arrives mid-connect runs once the current attempt ends.
   */
  function connect() {
    if (connecting) { pending = true; return connecting; }
    connecting = connectOnce().catch((e) => log('error', `connect failed: ${e.message}`)).finally(() => {
      connecting = null;
      if (pending) { pending = false; connect(); }
    });
    return connecting;
  }

  async function connectOnce() {
    clearTimeout(retryTimer);
    retryTimer = null;
    const gen = generation;
    const stale = () => gen !== generation;
    if (manualStop) return;
    if (socket && socket.readyState <= WebSocket.OPEN) return;

    const creds = await getCredentials();
    if (!creds.complete) {
      session = null;
      await setStatus('off', { reason: 'no_credentials', detail: 'Log in first (Tenant, Extension and PIN)' });
      return;
    }
    const fp = await fingerprint(creds.username, creds.password);
    const guard = await guardFor(fp);
    if (guard.stopped) { await publishStopped(guard.stopped); return; }
    if (stale()) return;

    await setStatus('connecting', { detail: `as ${creds.username}` });
    log('info', `connecting as ${creds.username}`);

    // 1. Check credentials once over REST and learn the tenant ID.
    const s = await ensureSession();
    if (stale()) return;
    if (!s.ok) {
      if (s.errorClass === 'auth' || s.errorClass === 'stopped') return; // stopForAuth already published
      log('error', s.message);
      scheduleRetry(s.message, s.errorClass === 'server' || s.errorClass === 'busy' ? 'server' : 'network');
      return;
    }

    // 2. Open the socket (URL credentials).
    let opened;
    try {
      opened = await openSocket(creds.username, creds.password);
    } catch (e) {
      if (stale()) return;
      const g = await guardFor(fp);
      g.wsRejections = (g.wsRejections || 0) + 1;
      log('warning', `WebSocket ${e.message} (rejection ${g.wsRejections} of ${CONFIG.wsMaxRejections})`);
      if (g.wsRejections >= CONFIG.wsMaxRejections) {
        g.stopped = 'ws_rejected';
        await writeGuard(g);
        log('error', `WebSocket refused ${g.wsRejections} times in a row after the PIN was accepted; stopped to avoid a lockout`);
        await publishStopped('ws_rejected');
        return;
      }
      await writeGuard(g);
      scheduleRetry(`WebSocket ${e.message}`, 'network');
      return;
    }
    if (stale()) { opened.ws.close(); return; }
    // A webSocketId arrived: the handshake is good, so the rejection count resets.
    const g = await guardFor(fp);
    if (g.wsRejections) await writeGuard({ ...g, wsRejections: 0 });

    socket = opened.ws;
    socketOpenedAt = Date.now();
    webSocketId = opened.webSocketId;
    socket.onmessage = handleFrame;
    socket.onclose = (e) => onSocketClosed(socket, e);
    log('success', `WebSocket connected (url auth), wsId ${webSocketId}`);

    // 3. One subscription set; every desired subscription goes into it.
    const setRes = await request('POST', `subscriptions/ws/${webSocketId}/subscriptionsets`, { body: {} });
    if (stale()) return;
    if (!setRes.ok || !setRes.body || !setRes.body.subscriptionSetId) {
      const why = `create subscription set returned ${setRes.status}`;
      log('error', why);
      dropSocket();
      if (setRes.errorClass !== 'auth' && setRes.errorClass !== 'stopped') scheduleRetry(why, 'subscribe');
      return;
    }
    subscriptionSetId = setRes.body.subscriptionSetId;
    const results = [];
    for (const entry of desired.values()) results.push(await putSubscription(entry));
    if (stale()) return;
    const callSub = desired.get('call|self');
    if (callSub && callSub.result && !callSub.result.ok) {
      const why = `subscribe to call events returned ${callSub.result.status}`;
      dropSocket();
      if (callSub.result.errorClass !== 'auth' && callSub.result.errorClass !== 'stopped') scheduleRetry(why, 'subscribe');
      return;
    }

    await setStatus('connected', { detail: `Listening for calls to extension ${session.extension}` });
    log('success', `subscribed (${results.filter((r) => r.ok).length}/${results.length}) for ${session.account}`);
    emit('connected', { webSocketId, subscriptionSetId, account: session.account, tenantId: session.tenantId });
    startKeepalive();
  }

  function onSocketClosed(ws, e) {
    if (ws !== socket) return;
    const upFor = Date.now() - socketOpenedAt;
    log('warning', `WebSocket closed (code ${e.code}) after ${Math.round(upFor / 1000)} s`);
    socket = null;
    webSocketId = null;
    subscriptionSetId = null;
    stopKeepalive();
    // Only a socket that stayed up resets the backoff; otherwise two clients
    // sharing the one-socket-per-user limit would kick each other every 5 s.
    if (upFor >= CONFIG.stableMs) attempt = 0;
    emit('disconnected', { code: e.code, upForMs: upFor });
    scheduleRetry(`connection closed (code ${e.code})`, 'network');
  }

  function dropSocket() {
    if (socket) {
      socket.onclose = null;
      try { socket.close(); } catch (e) { /* ignore */ }
    }
    socket = null;
    webSocketId = null;
    subscriptionSetId = null;
    stopKeepalive();
  }

  function startKeepalive() {
    stopKeepalive();
    let ticks = 0;
    keepaliveTimer = setInterval(() => {
      // Any extension API call resets the service worker's idle timer.
      try { chrome.runtime.getPlatformInfo(); } catch (e) { /* ignore */ }
      if (++ticks % CONFIG.helloEvery === 0 && socket && socket.readyState === WebSocket.OPEN) socket.send('hello');
    }, CONFIG.keepaliveMs);
  }
  function stopKeepalive() {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }

  function scheduleRetry(reason, kind) {
    if (manualStop) return;
    const delay = CONFIG.backoffMs[Math.min(attempt, CONFIG.backoffMs.length - 1)];
    attempt++;
    const nextRetryAt = new Date(Date.now() + delay).toISOString();
    setStatus('retrying', { reason: kind || 'network', detail: `${reason}. Retrying in ${Math.round(delay / 1000)} s`, nextRetryAt });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  }

  async function publishStopped(why) {
    if (why === 'auth') {
      await setStatus('error', {
        reason: 'auth',
        detail: 'Login rejected by the Public API. Check Tenant, Extension and PIN. Not retrying (3 failures lock the extension for an hour).'
      });
    } else {
      await setStatus('error', {
        reason: 'ws_rejected',
        detail: 'The live connection was refused although the PIN was accepted. Stopped retrying to protect the account; press Reconnect to try again.'
      });
    }
  }

  async function stopForAuth(fp, why) {
    const g = await guardFor(fp);
    g.stopped = 'auth';
    await writeGuard(g);
    session = null;
    generation++;
    clearTimeout(retryTimer);
    retryTimer = null;
    dropSocket();
    log('error', `${why}; stopped all Public API traffic to avoid a lockout`);
    await publishStopped('auth');
    emit('auth-failed', { reason: why });
  }

  /** Close the socket and cancel retries (does not stop future connects). */
  function disconnect() {
    generation++;
    clearTimeout(retryTimer);
    retryTimer = null;
    dropSocket();
    callMemo = new Map();
  }

  /** Stop until reconnect() (tests, devtools, logout). Not persisted. */
  async function stop(detail = 'Stopped') {
    manualStop = true;
    disconnect();
    await setStatus('off', { reason: 'stopped', detail });
  }

  /**
   * User-initiated reconnect (the Reconnect button): resets backoff, clears a
   * 'ws_rejected' stop and connects once. It REFUSES while the current
   * credentials are stopped for 'auth': pressing it repeatedly would send the
   * rejected PIN again and lock the extension. The way out of an auth stop is
   * saving credentials again (credentialsSaved) or changing them.
   * @returns {Promise<{ok:boolean, refused?:'auth'}>}
   */
  async function reconnect() {
    const creds = await getCredentials();
    if (creds.complete) {
      const fp = await fingerprint(creds.username, creds.password);
      const g = await guardFor(fp);
      if (g.stopped === 'auth') {
        log('warning', 'Reconnect refused: the PIN was rejected; save your credentials again in Settings');
        await publishStopped('auth');
        return { ok: false, refused: 'auth' };
      }
    }
    manualStop = false;
    attempt = 0;
    session = null;
    if (await readGuard()) await chrome.storage.local.remove(GUARD_KEY);
    disconnect();
    await connect();
    return { ok: true };
  }

  /**
   * The user saved credentials in Settings and the X-Tone login test passed:
   * a deliberate re-login, so clear any stop (also 'auth', e.g. the same PIN
   * re-saved after a lockout expired) and connect once.
   */
  async function credentialsSaved() {
    manualStop = false;
    attempt = 0;
    session = null;
    phonesCache = null;
    if (await readGuard()) await chrome.storage.local.remove(GUARD_KEY);
    disconnect();
    await connect();
    return { ok: true };
  }

  // ---------------------------------------------------------------- 3PCC ---
  /** callIds look like 1007-0-1793318237661-12303338:188@4 */
  function validCallId(callId) {
    return typeof callId === 'string' && /^[\w.\-:@]+$/.test(callId);
  }

  /**
   * 3PCC click-to-dial: the platform rings the user's default C2C phone,
   * then dials `to`. `to` goes through the user's dial plan like digits
   * dialed on the phone (see dialString()).
   * @param {string} to digits to dial (already prefixed if needed)
   * @param {object} [extra] e.g. { deviceIdType, deviceId, playPrompt }
   * @returns {Promise<{ok:boolean,status:number,errorClass:string|null,errorCode:string|null,message:string,callId:string|null,body:any}>}
   */
  async function makeCall(to, extra = {}) {
    const s = await ensureSession();
    if (!s.ok) return { ok: false, status: 0, errorClass: s.errorClass || 'network', errorCode: null, message: s.message, callId: null, body: null, notSent: true };
    const res = await request('POST', 'calls', { body: { request: 'makeCall', from: session.account, to: String(to), ...extra } });
    const b = res.body && typeof res.body === 'object' ? res.body : {};
    return { ...res, callId: b.callId || b.callObserverId || null };
  }

  /**
   * Call control on an existing call (callId from events or GET /calls).
   * @param {string} callId
   * @param {'answerCall'|'hangupCall'|'holdCall'|'resumeHeldCall'|'deflectCall'|'transfer'|'parkCall'} callRequest
   * @param {object} [extra] e.g. { otherCallId } for transfer, { featureData: '4' } for park
   */
  async function callControl(callId, callRequest, extra = {}) {
    if (!validCallId(callId)) return { ok: false, status: 0, errorClass: 'invalid', errorCode: null, message: 'invalid callId', body: null };
    const s = await ensureSession();
    if (!s.ok) return { ok: false, status: 0, errorClass: s.errorClass || 'network', errorCode: null, message: s.message, body: null, notSent: true };
    return request('POST', `calls/${callId}`, { body: { callRequest, myPartyId: session.account, ...extra } });
  }

  /** Active calls for this user (GET /calls is fast; use events for state). */
  async function getActiveCalls() {
    const res = await request('GET', 'calls');
    if (!res.ok) return { ...res, calls: [] };
    const emb = (res.body && res.body._embedded) || {};
    return { ...res, calls: emb.call || emb.calls || [] };
  }

  let phonesCache = null; // { at, fp, phones }
  /**
   * The user's registered phones (users/{ext}/myphones?expand=item), cached.
   * @returns {Promise<{ok:boolean, phones:Array, status:number, errorClass:string|null}>}
   */
  async function getMyPhones({ force = false } = {}) {
    const s = await ensureSession();
    if (!s.ok) return { ok: false, phones: [], status: 0, errorClass: s.errorClass || 'network' };
    if (!force && phonesCache && phonesCache.fp === session.fp && Date.now() - phonesCache.at < CONFIG.phonesTtlMs) {
      return { ok: true, phones: phonesCache.phones, status: 200, errorClass: null, cached: true };
    }
    const res = await request('GET', `tenants/${session.tenantId}/users/${session.extension}/myphones?expand=item`);
    if (!res.ok) return { ok: false, phones: [], status: res.status, errorClass: res.errorClass };
    const list = phonesFromHal(res.body);
    if (!list) return { ok: false, phones: [], status: res.status, errorClass: 'unknown' }; // unrecognized shape: count unknown
    phonesCache = { at: Date.now(), fp: session.fp, phones: list };
    return { ok: true, phones: list, status: res.status, errorClass: null };
  }

  /**
   * Phones from a HAL collection. The live shape of myphones?expand=item with
   * phones has not been captured yet, so accept an embedded array, a lone
   * embedded object, or _links.item. An empty collection (only _links.self,
   * as seen live) is []. Anything else is null ("unknown"), so callers try
   * makeCall instead of assuming there is no phone.
   */
  function phonesFromHal(body) {
    if (!body || typeof body !== 'object') return null;
    const emb = body._embedded;
    if (emb && typeof emb === 'object') {
      const values = Object.values(emb);
      const arr = values.find((v) => Array.isArray(v));
      if (arr) return arr;
      const obj = values.find((v) => v && typeof v === 'object');
      if (obj) return [obj];
    }
    const item = body._links && body._links.item;
    if (Array.isArray(item)) return item;
    if (item && typeof item === 'object') return [item];
    if (!emb && body._links) return [];
    return null;
  }

  /** Own presence snapshot (presencestatus/tenants/{tid}/extensions/{ext}). */
  async function getPresence() {
    const s = await ensureSession();
    if (!s.ok) return { ok: false, status: 0, errorClass: s.errorClass, body: null };
    return request('GET', `presencestatus/tenants/${session.tenantId}/extensions/${session.extension}`);
  }

  /**
   * Digits to send for a dial request, shared by 3PCC and X-Tone so both
   * paths behave the same: internal extensions (6 digits or fewer) are
   * dialed as-is; anything longer gets the user's dial prefix (Settings ->
   * Advanced -> Dial Prefix, default "8").
   * UNVERIFIED on the live platform for makeCall: see ARCHITECTURE.md.
   */
  function dialString(number, prefix) {
    const digits = String(number || '').replace(/[^\d*#]/g, '');
    if (!digits) return '';
    if (digits.length <= 6) return digits;
    return `${prefix || ''}${digits}`;
  }

  // -------------------------------------------------------------- wiring ---
  let credTimer = null;
  function credentialsChanged() {
    clearTimeout(credTimer);
    credTimer = setTimeout(async () => {
      const creds = await getCredentials();
      const fp = creds.complete ? await fingerprint(creds.username, creds.password) : null;
      if (session && fp && session.fp === fp && socket) return; // nothing really changed
      log('info', 'credentials changed; reconnecting');
      manualStop = false;
      attempt = 0;
      session = null;
      phonesCache = null;
      disconnect();
      emit('credentials', { complete: creds.complete, extension: creds.extension || null });
      connect();
    }, CONFIG.credentialDebounceMs);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      if (changes.password && changes.password.newValue !== undefined) migratePin().catch(() => {});
      if (changes.tenant || changes.extension) credentialsChanged();
    } else if (area === 'local' && changes.password) {
      credentialsChanged();
    }
  });

  // Wake up once a minute in case Chrome stopped the worker anyway.
  try { chrome.alarms.clear('screenPopWatchdog'); } catch (e) { /* v1 alarm name */ }
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== WATCHDOG_ALARM) return;
    if (socket || retryTimer || connecting) return;
    connect();
  });

  chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
    if (req.action === 'apiGetStatus') {
      sendResponse({ status, session: publicSession() });
      return true;
    }
    if (req.action === 'apiReconnect') {
      reconnect().then((r) => sendResponse({ success: r.ok, refused: r.refused || null }));
      return true;
    }
    if (req.action === 'apiCredentialsSaved') {
      credentialsSaved().then(() => sendResponse({ success: true }));
      return true;
    }
    return undefined;
  });

  self.OneClick = self.OneClick || {};
  self.OneClick.api = {
    CONFIG, HOST, API_BASE, STATUS_KEY,
    // bus
    on, off, once, emit,
    // credentials
    getCredentials, migratePin, usernameFor,
    // REST
    request, classifyError,
    // session / connection
    ensureSession, getSession: publicSession, getStatus: () => status,
    connect, disconnect, reconnect, credentialsSaved, stop,
    isConnected: () => !!(socket && subscriptionSetId),
    // subscriptions
    subscribe, unsubscribe, listSubscriptions,
    // 3PCC
    makeCall, callControl, getActiveCalls, getMyPhones, getPresence, dialString,
    // helpers
    normalizeParty, sameParty, durationMs
  };

  // Migrate at load (covers browsers that never fire onInstalled for us), then connect.
  migratePin().catch(() => {}).finally(() => connect());
})();
