// Where the signed-in account lives: the one place that decides.
//
// By default the account (tenant, extension, isLoggedIn) is in
// chrome.storage.sync and follows the user's Chrome profile. Customers who
// share a Chrome profile or Google account can keep it on this computer only:
// the account then lives under its own keys in chrome.storage.local, and this
// computer neither reads nor writes the synced copy.
//
// That matters for more than convenience. In sync mode a coworker's sign-in
// changes tenant/extension here too, and this computer then tries their
// extension with this computer's PIN: a rejected login against their account.
//
// The switch itself is in local storage on purpose. If it synced, one person's
// choice would change every computer on the profile. Sync is left alone when a
// computer turns this on, so the others stay signed in. IT can force it on with
// the managed policy key accountLocalOnly.
//
// The PIN stays on this computer, so it remembers whose it is (pinOwner). When
// sync moves to another account, this computer stops and asks for a sign-in
// instead of sending its own PIN to a coworker's extension. A PIN from before
// 2.0.2 has no owner yet: it gets one the first time it works.
//
// Never read chrome.storage.managed on a path that loads the account: that read
// can stay pending for minutes after Chrome starts. The service worker applies
// the policy in the background (applyPolicy) and keeps the answer in local storage.
//
// Loaded by the service worker and by the extension pages. Reads mirror
// chrome.storage: a key that was never set is absent from the result.

(function () {
  'use strict';

  const FLAG = 'accountLocalOnly';
  const MANAGED_KEY = 'accountLocalOnly';
  const FORCED = 'accountLocalOnlyForced';
  /** account field -> its chrome.storage.local key. Sync uses the field name itself. */
  const LOCAL_KEYS = { tenant: 'accountTenant', extension: 'accountExtension', isLoggedIn: 'accountIsLoggedIn' };
  const FIELDS = Object.keys(LOCAL_KEYS);
  /** chrome.storage.local key: {tenant, extension} the saved PIN belongs to. */
  const PIN_OWNER = 'pinOwner';

  function toLocal(fields) {
    const out = {};
    for (const f of FIELDS) if (fields[f] !== undefined) out[LOCAL_KEYS[f]] = fields[f];
    return out;
  }

  function fromLocal(stored) {
    const out = {};
    for (const f of FIELDS) if (stored[LOCAL_KEYS[f]] !== undefined) out[f] = stored[LOCAL_KEYS[f]];
    return out;
  }

  /** The value to keep in PIN_OWNER, saved in the same write as the PIN. */
  function ownerFor(tenant, extension) {
    return { tenant: String(tenant || '').trim(), extension: String(extension || '').trim() };
  }

  function sameAccount(a, b) {
    const x = ownerFor(a.tenant, a.extension);
    const y = ownerFor(b.tenant, b.extension);
    return x.extension === y.extension && x.tenant.toLowerCase() === y.tenant.toLowerCase();
  }

  /**
   * The PIN saved here, for an account from get().
   * elsewhere = the account has moved away from the one this PIN belongs to, so
   * this computer counts as signed out and pin is empty.
   * @returns {Promise<{pin:string, elsewhere:boolean, owner:?{tenant:string, extension:string}}>}
   */
  async function pinState(account) {
    const l = await chrome.storage.local.get(['password', PIN_OWNER]);
    const owner = l[PIN_OWNER] || null;
    const hasAccount = !!(account && account.tenant && account.extension);
    const elsewhere = !!(l.password && owner && hasAccount && !sameAccount(owner, account));
    return { pin: elsewhere ? '' : (l.password || ''), elsewhere, owner };
  }

  /** A PIN from before 2.0.2 just worked for this account: remember that. */
  async function claimPin(tenant, extension, pin) {
    const l = await chrome.storage.local.get(['password', PIN_OWNER]);
    if (!l[PIN_OWNER] && l.password === pin) await chrome.storage.local.set({ [PIN_OWNER]: ownerFor(tenant, extension) });
  }

  /** True when the IT policy requires the account to stay on this computer. */
  async function isForced() {
    return (await chrome.storage.local.get(FORCED))[FORCED] === true;
  }

  /** Copy the synced account here and switch, in one write. Sync stays as it is. */
  async function turnOn() {
    const synced = await chrome.storage.sync.get(FIELDS);
    await chrome.storage.local.set({ ...toLocal(synced), [FLAG]: true });
  }

  /** True when this computer keeps the account to itself. */
  async function isLocalOnly() {
    return (await chrome.storage.local.get(FLAG))[FLAG] === true;
  }

  /**
   * Service worker only: read the IT policy and apply it. May take minutes to
   * finish. When the policy goes away the switch stays where it is, unlocked.
   */
  async function applyPolicy() {
    let forced = false;
    try {
      forced = (await chrome.storage.managed.get(MANAGED_KEY))[MANAGED_KEY] === true;
    } catch (e) {
      return; // no managed storage here
    }
    await chrome.storage.local.set({ [FORCED]: forced });
    if (forced && !(await isLocalOnly())) await turnOn(); // keep whoever is signed in here
  }

  /**
   * Turn local-only on or off.
   * Off publishes this computer's account to sync, which replaces what other
   * computers on this profile show unless they are local-only too. A signed-out
   * computer publishes nothing. The PIN never goes to sync.
   * @returns {Promise<boolean>} false when IT policy refused the change
   */
  async function setLocalOnly(on) {
    if (on) {
      if ((await chrome.storage.local.get(FLAG))[FLAG] !== true) await turnOn();
      return true;
    }
    if (await isForced()) return false;
    const account = fromLocal(await chrome.storage.local.get(Object.values(LOCAL_KEYS)));
    if (account.tenant && account.extension) await chrome.storage.sync.set(account);
    await chrome.storage.local.remove([FLAG, ...Object.values(LOCAL_KEYS)]);
    return true;
  }

  /** @returns {Promise<{tenant?:string, extension?:string, isLoggedIn?:boolean}>} */
  async function get() {
    if (await isLocalOnly()) return fromLocal(await chrome.storage.local.get(Object.values(LOCAL_KEYS)));
    return chrome.storage.sync.get(FIELDS);
  }

  /** Save account fields wherever the account lives. */
  async function set(fields) {
    if (await isLocalOnly()) await chrome.storage.local.set(toLocal(fields));
    else await chrome.storage.sync.set(fields);
  }

  /** Sign this computer's local account out. The switch stays on, and sync is not touched. */
  async function clearLocal() {
    await chrome.storage.local.remove(Object.values(LOCAL_KEYS));
  }

  /**
   * For chrome.storage.onChanged: did the account in use change?
   * Synced changes don't count while this computer is local-only.
   */
  async function changed(changes, area) {
    if (area === 'local') return !!(changes[FLAG] || changes[LOCAL_KEYS.tenant] || changes[LOCAL_KEYS.extension]);
    if (area === 'sync') return !!(changes.tenant || changes.extension) && !(await isLocalOnly());
    return false;
  }

  self.OneClickAccount = { FLAG, FORCED, MANAGED_KEY, LOCAL_KEYS, PIN_OWNER, ownerFor, pinState, claimPin, isForced, isLocalOnly, applyPolicy, setLocalOnly, get, set, clearLocal, changed };
})();
