// Unit tests for lib/account.js: where the account lives on a shared Chrome
// profile. Plain node, fake storage. Run: node tests/account.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'lib', 'account.js'), 'utf8');

function makeStorage(data = {}) {
  return {
    data,
    async get(keys) {
      const out = {};
      for (const k of [].concat(keys)) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

function boot({ sync = {}, local = {}, managed } = {}) {
  const storage = { sync: makeStorage(sync), local: makeStorage(local) };
  if (managed) storage.managed = makeStorage(managed);
  else storage.managed = { get: async () => { throw new Error('no managed storage'); } };
  const sandbox = { chrome: { storage } };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return { A: sandbox.OneClickAccount, storage, sync: storage.sync.data, local: storage.local.data };
}

let failed = 0;
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `  ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
}

const ACCOUNT = { tenant: 'vaspian', extension: '196', isLoggedIn: true };

(async () => {
  {
    const owner = { tenant: 'vaspian', extension: '196' };
    const { A, local } = boot({ local: { password: 'p', pinOwner: owner } });
    check('pinState: the owner\'s account gets the PIN', (await A.pinState(ACCOUNT)).pin === 'p' && !(await A.pinState(ACCOUNT)).elsewhere);
    const other = await A.pinState({ tenant: 'vaspian', extension: '197' });
    check('pinState: another account gets no PIN, and says so', other.pin === '' && other.elsewhere && other.owner.extension === '196', other);
    check('pinState: a signed-out profile is not someone else', !(await A.pinState({})).elsewhere && !(await A.pinState({ tenant: '', extension: '' })).elsewhere);
    delete local.pinOwner;
    check('pinState: no owner yet keeps the old behaviour', (await A.pinState({ tenant: 'vaspian', extension: '197' })).pin === 'p');
    await A.claimPin('vaspian', '197', 'not-this-pin');
    check('claimPin: only for the PIN saved here', !local.pinOwner, local);
    await A.claimPin(' vaspian ', '196', 'p');
    check('claimPin: stamps a PIN that just worked', local.pinOwner.tenant === 'vaspian' && local.pinOwner.extension === '196', local);
    await A.claimPin('vaspian', '197', 'p');
    check('claimPin: never replaces an owner', local.pinOwner.extension === '196', local);
  }
  {
    const { A, sync } = boot({ sync: { ...ACCOUNT } });
    check('default: not local-only, nothing changes for existing users', !(await A.isLocalOnly()) && (await A.get()).extension === '196');
    await A.set({ isLoggedIn: false });
    check('default: writes go to sync', sync.isLoggedIn === false, sync);
  }
  {
    const { A, sync, local } = boot({ sync: { ...ACCOUNT } });
    await A.setLocalOnly(true);
    check('turning on keeps whoever is signed in', (await A.get()).extension === '196' && (await A.get()).isLoggedIn === true);
    check('turning on leaves sync alone, so other computers stay signed in', JSON.stringify(sync) === JSON.stringify(ACCOUNT), sync);
    sync.extension = '197';
    await A.setLocalOnly(true);
    check('turning on twice does not re-read sync', local.accountExtension === '196', local);
    check('a synced change is not an account change here', !(await A.changed({ extension: { newValue: '197' } }, 'sync')));
    await A.set({ extension: '500' });
    check('writes stay local', sync.extension === '197' && local.accountExtension === '500');
    await A.clearLocal();
    check('sign-out clears this computer only', Object.keys(await A.get()).length === 0 && sync.tenant === 'vaspian' && (await A.isLocalOnly()));
  }
  {
    const { A, sync, local } = boot({ sync: { tenant: 'other', extension: '197' }, local: { accountLocalOnly: true, accountTenant: 'vaspian', accountExtension: '196', accountIsLoggedIn: true } });
    await A.setLocalOnly(false);
    check('turning off publishes this account to sync', sync.extension === '196' && sync.isLoggedIn === true, sync);
    check('turning off leaves nothing behind locally', !Object.keys(local).length, local);
  }
  {
    const { A, sync } = boot({ sync: { tenant: 'other', extension: '197' }, local: { accountLocalOnly: true } });
    await A.setLocalOnly(false);
    check('turning off while signed out never blanks the shared account', sync.extension === '197', sync);
  }
  {
    const { A, sync, local } = boot({ sync: { ...ACCOUNT }, managed: { accountLocalOnly: true } });
    await A.applyPolicy();
    check('IT policy forces it on and keeps the signed-in account', (await A.isLocalOnly()) && (await A.get()).extension === '196' && local.accountLocalOnly === true);
    check('IT policy: the user can\'t turn it off', (await A.setLocalOnly(false)) === false && (await A.isLocalOnly()), local);
    check('IT policy leaves sync alone', sync.extension === '196');
  }
  {
    const { A } = boot({ sync: { ...ACCOUNT }, managed: { accountLocalOnly: false } });
    await A.applyPolicy();
    check('policy false is the same as no policy', !(await A.isLocalOnly()) && !(await A.isForced()));
  }
  {
    const { A } = boot({ sync: { ...ACCOUNT } });
    check('default: a synced extension change counts', await A.changed({ extension: { newValue: '197' } }, 'sync'));
    check('default: unrelated sync changes do not', !(await A.changed({ dialPrefix: { newValue: '9' } }, 'sync')));
    check('switching mode counts', await A.changed({ accountLocalOnly: { newValue: true } }, 'local'));
    check('reading the account never touches managed storage (it can hang after Chrome starts)', await (async () => {
      const hung = boot({ sync: { ...ACCOUNT } });
      hung.storage.managed.get = () => new Promise(() => {});
      hung.A.applyPolicy();
      const winner = await Promise.race([hung.A.get(), new Promise((r) => setTimeout(() => r('hung'), 200))]);
      return winner !== 'hung' && winner.extension === '196';
    })());
  }

  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})();
