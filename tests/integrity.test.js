// Integrity checks for the extension package (no browser needed).
// - every service-worker and popup script parses (node --check), so a syntax
//   error in one feature file cannot brick the whole service worker
// - every file the manifest, background.js importScripts and popup.html
//   reference exists
// - track files keep to the IIFE rule (no top-level const/let/function that
//   could collide in the shared global scope)
// Run: node tests/integrity.test.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
let failed = 0;
const check = (ok, label, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' ' + extra}`); if (!ok) failed++; };

const bg = fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8');
const imports = [...(bg.match(/importScripts\(([\s\S]*?)\);/) || ['', ''])[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
const popupScripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const popupStyles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

check(JSON.stringify(imports) === JSON.stringify(['lib/phone.js', 'lib/vaspian-api.js', 'screenpop.js', 'calls.js', 'presence.js', 'crm.js', 'operator.js']),
  'background.js imports the client first, then screenpop, the three track modules and the team view engine', JSON.stringify(imports));
check(['lib/phone.js', 'popup.js', 'callcard-ui.js', 'status-ui.js', 'crm-ui.js', 'operator-ui.js'].every((s) => popupScripts.includes(s)), 'popup.html loads every UI script', JSON.stringify(popupScripts));
check(['popup.css', 'callcard.css', 'status.css', 'crm.css'].every((s) => popupStyles.includes(s)), 'popup.html loads every stylesheet', JSON.stringify(popupStyles));

const consoleHtml = fs.readFileSync(path.join(ROOT, 'operator.html'), 'utf8');
const consoleScripts = [...consoleHtml.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
check(consoleScripts.includes('operator-console.js'), 'operator.html loads the console script', JSON.stringify(consoleScripts));
check(!/<script>(?!\s*<\/script>)/.test(consoleHtml) && !/\son[a-z]+="/.test(consoleHtml), 'operator.html has no inline script or handlers (extension CSP)');
for (const f of [...consoleHtml.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1])) check(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
const files = new Set(['background.js', 'content.js', ...imports, ...popupScripts, ...consoleScripts]);
for (const f of files) {
  const p = path.join(ROOT, f);
  if (!fs.existsSync(p)) { check(false, `${f} exists`); continue; }
  try { execFileSync(process.execPath, ['--check', p], { stdio: 'pipe' }); check(true, `${f} parses`); } catch (e) { check(false, `${f} parses`, String(e.stderr)); }
}
for (const f of [...popupStyles, manifest.storage.managed_schema, manifest.background.service_worker, manifest.side_panel.default_path.split('?')[0],
  ...manifest.content_scripts.flatMap((c) => [...c.js, ...c.css]), ...Object.values(manifest.icons)]) {
  check(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
}
try { JSON.parse(fs.readFileSync(path.join(ROOT, manifest.storage.managed_schema), 'utf8')); check(true, 'managed schema is JSON'); } catch (e) { check(false, 'managed schema is JSON', e.message); }

// No install-time permission that adds a warning (see BRIEF.md permissions policy).
const allowed = new Set(['storage', 'cookies', 'sidePanel', 'alarms', 'contextMenus']);
check(manifest.permissions.every((p) => allowed.has(p)), 'no new install-time permissions', JSON.stringify(manifest.permissions));
check(JSON.stringify(manifest.optional_permissions) === '["notifications"]', 'notifications is optional only');
const suggested = Object.values(manifest.commands || {}).filter((c) => c.suggested_key).length;
check(suggested <= 4, 'at most 4 commands with suggested keys (Chrome limit)', String(suggested));

// Track files: everything inside one IIFE.
for (const f of ['lib/phone.js', 'lib/vaspian-api.js', 'screenpop.js', 'calls.js', 'presence.js', 'crm.js', 'operator.js', 'callcard-ui.js', 'status-ui.js', 'crm-ui.js', 'operator-ui.js', 'operator-console.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n').trim();
  const topLevel = code.split('\n').filter((l) => /^(const|let|var|function|async function|class)\b/.test(l));
  check(code.startsWith('(function') && topLevel.length === 0, `${f} keeps to the IIFE rule`, JSON.stringify(topLevel));
}

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
