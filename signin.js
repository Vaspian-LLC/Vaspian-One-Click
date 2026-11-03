// Shared sign-in for extension pages: the Settings sign-in form (popup.js) and
// the first-run setup (onboarding.js) both call OneClickSignIn.signIn, so the
// two can't drift.
//
// One attempt per call, never retried: three rejected sign-ins in 30 minutes
// lock the extension for an hour. Rejections are counted (timestamps only, in
// chrome.storage.local.signinFailures) so the pages can warn before the third.
// The PIN is only passed to the existing testLogin message and stored where
// v2 keeps it (chrome.storage.local.password). It is never logged.

(function () {
  'use strict';

  const FAILURES_KEY = 'signinFailures';
  const WINDOW_MS = 30 * 60 * 1000;
  const LOCK_AFTER = 3;

  /** Rejection timestamps (ms) still inside the 30-minute window. */
  function recentFailures(list, nowMs = Date.now()) {
    return (Array.isArray(list) ? list : []).filter((t) => typeof t === 'number' && nowMs - t >= 0 && nowMs - t < WINDOW_MS);
  }

  /** How many more rejections the server allows before the lock (0..3). */
  function triesLeft(list, nowMs = Date.now()) {
    return Math.max(0, LOCK_AFTER - recentFailures(list, nowMs).length);
  }

  /** Only a rejected extension or PIN counts toward the lock (not an unknown company or a network error). */
  function countsTowardLock(reason) { return reason === 'rejected'; }

  async function failures() {
    const r = await chrome.storage.local.get(FAILURES_KEY);
    return recentFailures(r[FAILURES_KEY]);
  }

  /**
   * Check the credentials with the existing X-Tone login (testLogin) and, if
   * they work, save them exactly like Settings always has.
   * @returns {Promise<{ok:boolean, reason?:string, message?:string, triesLeft:number}>}
   */
  async function signIn({ tenant, extension, pin }) {
    tenant = String(tenant || '').trim();
    extension = String(extension || '').trim();
    pin = String(pin || '');
    if (!tenant || !extension || !pin) return { ok: false, reason: 'missing', triesLeft: triesLeft(await failures()) };

    let r;
    try {
      r = await chrome.runtime.sendMessage({ action: 'testLogin', tenant, extension, password: pin });
    } catch (e) {
      r = null;
    }
    if (!r || !r.success || !r.isValid) {
      const reason = (r && r.reason) || (r && r.success === false ? 'error' : 'unknown');
      let list = await failures();
      if (countsTowardLock(reason)) {
        list = [...list, Date.now()];
        await chrome.storage.local.set({ [FAILURES_KEY]: list });
      }
      return { ok: false, reason, message: (r && (r.message || r.error)) || '', triesLeft: triesLeft(list) };
    }

    // Tenant and extension sync across the user's browsers; the PIN stays on this device.
    await chrome.storage.local.set({ password: pin, pinMigrated: true });
    await chrome.storage.local.remove(FAILURES_KEY);
    // v2.0 keeps a v1 synced PIN for the user's other computers (still on v1).
    // Keep that copy current so they never retry an old PIN into a lockout;
    // never create one.
    const legacy = await chrome.storage.sync.get(['password']);
    if (legacy.password !== undefined) await chrome.storage.sync.set({ password: pin });
    await chrome.storage.sync.set({ tenant, extension });
    // A deliberate sign-in lets the live connection retry even after an earlier rejection.
    chrome.runtime.sendMessage({ action: 'apiCredentialsSaved' }).catch(() => {});
    return { ok: true, triesLeft: LOCK_AFTER };
  }

  const api = { FAILURES_KEY, WINDOW_MS, LOCK_AFTER, recentFailures, triesLeft, countsTowardLock, failures, signIn };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else self.OneClickSignIn = api;
})();
