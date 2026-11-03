// Unit tests for first-run setup: onboarding-state.js (first-run detection,
// resume, skip, step order) and signin.js (one attempt, saved like Settings,
// rejections counted for the lockout warning, PIN never in the counter).
// Run: node tests/onboarding.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' ' + extra}`); if (!ok) failed++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const State = require(path.join(ROOT, 'onboarding-state.js'));

// ----------------------------------------------------- first-run detection ---
{
  const a = State.installAction('install');
  check(a.open === true && a.write && a.write.status === 'pending' && a.write.step === 'welcome', 'fresh install opens setup at Welcome, pending');
  check(!JSON.stringify(a.write).match(/pin|password/i), 'state has no credential fields');
  for (const reason of ['update', 'chrome_update', 'shared_module_update', undefined]) {
    const u = State.installAction(reason);
    check(u.open === false && u.write === null, `"${reason}" does not show setup or touch state`);
  }
  check(State.isPending(undefined) === false, 'no stored state (an updated v1 user) is not pending');
  check(State.isPending({ status: 'pending', step: 'phone' }) === true, 'pending state is pending');
  check(State.isPending({ status: 'done', step: 'done' }) === false, 'done is never shown again on its own');
  check(State.normalize({ status: 'pending', step: 'signin', fileTenant: 'acme' }).fileTenant === 'acme', 'the imported file\'s company is kept as a sign-in prefill across a resume');
  check(State.open({ status: 'done', fileTenant: 'acme' }).fileTenant === '', 'Run setup again forgets an old file\'s company');
  check(State.normalize({ status: 'weird' }) === null && State.normalize('x') === null, 'junk state is ignored');
}

// ------------------------------------------------------------------ resume ---
{
  check(State.resumeStep({ status: 'pending', step: 'phone' }) === 'phone', 'closed mid-way resumes at the saved step');
  check(State.resumeStep({ status: 'pending', step: 'nope' }) === 'welcome', 'unknown saved step falls back to Welcome');
  check(State.resumeStep({ status: 'done', step: 'done' }) === 'welcome', 'Run setup again after finishing starts at Welcome');
  check(State.resumeStep(null) === 'welcome', 'no state starts at Welcome');
  const reopened = State.open({ status: 'done', step: 'done', skipped: true });
  check(reopened.status === 'pending' && reopened.step === 'welcome' && reopened.skipped === false, 'opening after done makes it pending again from Welcome');
  const kept = State.open({ status: 'pending', step: 'screenpop', imported: false });
  check(kept.step === 'screenpop', 'opening while pending keeps the step');
  const moved = State.go(kept, 'phone');
  check(moved.step === 'phone' && moved.status === 'pending', 'go() moves and stays pending');
  check(State.go(kept, 'done').status === 'done', 'reaching Done finishes setup');
  let threw = false;
  try { State.go(kept, 'calling'); } catch (e) { threw = true; }
  check(threw, 'go() refuses a step that does not exist (calling was dropped)');
}

// -------------------------------------------------------------------- skip ---
{
  const s = State.skip({ status: 'pending', step: 'welcome' });
  check(s.status === 'done' && s.step === 'done' && s.skipped === true, 'Skip setup goes to Done, finished, marked skipped');
  const r = State.skip({ status: 'pending', step: 'phone' });
  check(r.status === 'done' && r.skipped, 'Skip the rest from the phone step finishes setup');
  check(State.isPending(r) === false, 'after a skip, setup is not offered again on its own');
}

// -------------------------------------------------------------- step order ---
{
  check(eq(State.STEPS, ['welcome', 'signin', 'phone', 'screenpop', 'done']), 'flow is Welcome, Sign in, Phone, Screen pop, Done', JSON.stringify(State.STEPS));
  check(State.nextStep('welcome') === 'signin' && State.nextStep('signin') === 'phone' && State.nextStep('phone') === 'screenpop' && State.nextStep('screenpop') === 'done', 'next steps in order');
  check(State.nextStep('phone', { screenPopImported: true }) === 'done', 'screen pop is left out when a settings file set it');
  check(State.prevStep('done', { screenPopImported: true }) === 'phone', 'Back from Done skips the left-out screen pop step');
  check(State.prevStep('done') === 'screenpop' && State.prevStep('signin') === 'welcome', 'Back steps');
  check(State.importSetScreenPop(['screenPopCrm', 'dialPrefix']) === true, 'import with screenPopCrm counts as screen pop set');
  check(State.importSetScreenPop(['crmZohoKey']) === true, 'import with the Zoho key counts as screen pop set');
  check(State.importSetScreenPop(['dialPrefix', 'crmWrapUpEnabled', 'clickToCallEnabled']) === false, 'import without screen pop keys keeps the step');
  check(State.importSetScreenPop(undefined) === false, 'no applied list keeps the step');
}

// ----------------------------------------------------------------- sign in ---
function makeStorage() {
  const data = {};
  return {
    data,
    async get(keys) { const out = {}; for (const k of [].concat(keys)) if (k in data) out[k] = JSON.parse(JSON.stringify(data[k])); return out; },
    async set(obj) { Object.assign(data, JSON.parse(JSON.stringify(obj))); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; }
  };
}

async function signInSuite() {
  const sync = makeStorage();
  const local = makeStorage();
  const sent = [];
  let reply = { success: true, isValid: false, reason: 'rejected', message: 'Login rejected.' };
  const sandbox = {
    console, Date,
    chrome: {
      storage: { sync, local },
      runtime: { async sendMessage(m) { sent.push(m); return m.action === 'testLogin' ? reply : { success: true }; } }
    }
  };
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'signin.js'), 'utf8'), sandbox, { filename: 'signin.js' });
  const SignIn = sandbox.OneClickSignIn;
  const PIN = 'mockpin-196';

  const missing = await SignIn.signIn({ tenant: 'vaspian', extension: '196', pin: '' });
  check(!missing.ok && missing.reason === 'missing' && sent.length === 0, 'missing PIN: no attempt is sent');

  const r1 = await SignIn.signIn({ tenant: 'vaspian', extension: '196', pin: 'wrong1' });
  check(!r1.ok && r1.reason === 'rejected' && r1.triesLeft === 2, 'first rejection: 2 tries left', JSON.stringify(r1));
  check(sent.filter((m) => m.action === 'testLogin').length === 1, 'exactly one attempt per call (never retried)');
  const r2 = await SignIn.signIn({ tenant: 'vaspian', extension: '196', pin: 'wrong2' });
  check(r2.triesLeft === 1, 'second rejection: 1 try left (pages warn before the third)');
  check(!JSON.stringify(local.data).includes('wrong') && !('password' in local.data), 'rejected PINs are never stored');
  check(Array.isArray(local.data.signinFailures) && local.data.signinFailures.every((t) => typeof t === 'number'), 'the counter holds timestamps only');

  reply = { success: true, isValid: false, reason: 'bad_tenant', message: 'not recognized' };
  const r3 = await SignIn.signIn({ tenant: 'nope', extension: '196', pin: 'x' });
  check(r3.reason === 'bad_tenant' && r3.triesLeft === 1, 'unknown company does not count toward the lock');
  reply = undefined;
  const r4 = await SignIn.signIn({ tenant: 'vaspian', extension: '196', pin: 'x' });
  check(!r4.ok && r4.triesLeft === 1, 'no answer from the worker does not count toward the lock');

  reply = { success: true, isValid: true, reason: 'ok', message: 'Login successful' };
  const ok = await SignIn.signIn({ tenant: ' vaspian ', extension: '196 ', pin: PIN });
  check(ok.ok === true, 'valid credentials sign in');
  check(local.data.password === PIN && !('password' in sync.data), 'PIN saved on this device only (local), not sync');
  check(sync.data.tenant === 'vaspian' && sync.data.extension === '196', 'tenant and extension saved (trimmed) to sync');
  check(!('signinFailures' in local.data), 'a successful sign-in clears the failure counter');
  check(sent.some((m) => m.action === 'apiCredentialsSaved'), 'the live connection is told (apiCredentialsSaved), same as Settings');

  // A v1 synced PIN (other computers still on 1.1.2) is kept current, never removed.
  sync.data.password = 'old-v1-pin';
  const ok2 = await SignIn.signIn({ tenant: 'vaspian', extension: '196', pin: 'new-pin-197' });
  check(ok2.ok && sync.data.password === 'new-pin-197' && local.data.password === 'new-pin-197', 'an existing v1 synced PIN is updated to the new PIN');

  const now = Date.now();
  check(SignIn.triesLeft([now - 31 * 60 * 1000, now - 1000], now) === 2, 'failures older than 30 minutes are forgotten');
  check(SignIn.triesLeft([now, now, now, now], now) === 0, 'never below zero');
}

// ------------------------------------------ the hooks in shared files ---
function hookSuite() {
  const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
  const install = bg.slice(bg.indexOf("if (details.reason === 'install')"), bg.indexOf('} else {', bg.indexOf("if (details.reason === 'install')")));
  check(/openFirstRunSetup\(details\.reason\)/.test(install), 'background.js opens setup only from the install branch');
  check(/importScripts\('onboarding-state\.js'\)/.test(bg), 'background.js loads the state module');
  const popupHtml = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  check(popupHtml.includes('id="onb-rerun"'), 'Settings > Help and support has Run setup again');
  const welcome = fs.readFileSync(path.join(ROOT, 'welcome.html'), 'utf8');
  check(!/<script>(?!\s*<\/script>)/.test(welcome) && !/\son[a-z]+="/.test(welcome), 'welcome.html has no inline script or handlers (extension CSP)');
  for (const f of [...welcome.matchAll(/(?:src|href)="([^"]+\.(?:js|css|png))"/g)].map((x) => x[1])) check(fs.existsSync(path.join(ROOT, f)), `welcome.html: ${f} exists`);
  const css = fs.readFileSync(path.join(ROOT, 'onboarding.css'), 'utf8');
  const outsideRoot = css.replace(/:root[^{]*\{[^}]*\}/g, '').replace(/@media \(prefers-color-scheme: dark\) \{\s*:root[^{]*\{[^}]*\}\s*\}/g, '');
  check(!/#[0-9a-fA-F]{3,8}\b/.test(outsideRoot), 'onboarding.css: no hex color outside the --oc-* token blocks');
  check(!/gradient/i.test(css), 'onboarding.css: no gradients');
  const ui = fs.readFileSync(path.join(ROOT, 'onboarding.js'), 'utf8');
  check(!/crmZohoBaseUrl/.test(ui.replace(/\/\/.*$/gm, '').replace(/&& k !== 'crmZohoBaseUrl'/g, '')), 'onboarding.js never shows or sends the Zoho service address');
  check(!/console\.(log|info|debug)\([^)]*pin/i.test(ui) && !/console\.(log|info|debug)\([^)]*pin/i.test(fs.readFileSync(path.join(ROOT, 'signin.js'), 'utf8')), 'no PIN logging');
  for (const f of ['onboarding.js', 'onboarding-state.js', 'signin.js', 'welcome.js']) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').trim();
    const top = code.split('\n').filter((l) => /^(const|let|var|function|async function|class)\b/.test(l));
    check(code.startsWith('(function') && top.length === 0, `${f} keeps to the IIFE rule`, JSON.stringify(top));
  }
}

(async () => {
  await signInSuite();
  hookSuite();
  console.log(failed ? `\n${failed} failing` : '\nall passing');
  process.exit(failed ? 1 : 0);
})();
