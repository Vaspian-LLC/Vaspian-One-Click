// Unit test for classifyLoginResponse() in background.js.
// background.js is a service worker that touches chrome.* at load, so we
// extract just the pure function's source and evaluate it here.
// Run: node tests/login-classify.test.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const m = src.match(/function classifyLoginResponse\([\s\S]*?\n}\n/);
assert(m, 'classifyLoginResponse() not found in background.js');
const classifyLoginResponse = new Function(`${m[0]}; return classifyLoginResponse;`)();

const X = 'https://xtone.buf.vaspian.net/webadmin';
const cases = [
  // [finalUrl, httpStatus, expected ok, expected reason]
  [`${X}/user/usr_portal`, 200, true, 'ok'],
  [`${X}/mySettings/usr_portal?MessageID=-1`, 200, true, 'ok'],
  [`${X}/expired_pin/vaspian?UserID=188&LangCode=en&MessageID=-1`, 200, false, 'expired_pin'],
  [`${X}/login/vaspian?LangCode=en&MessageID=6`, 200, false, 'rejected'],
  [`${X}/login?LangCode=en&MessageID=41`, 200, false, 'bad_tenant'],
  [`${X}/en/user/jsp/ProcessLogin.jsp?tenantWebName=/vaspian`, 500, false, 'http'],
  // ProcessDIDLogin.jsp (phone number instead of tenant web name) redirects
  // to /webadmin/en with a MessageID: 6 = bad ext/PIN, 41 = DID not recognized.
  [`${X}/en?LangCode=en&MessageID=6`, 200, false, 'rejected'],
  [`${X}/en?LangCode=en&MessageID=41`, 200, false, 'bad_tenant'],
  [`${X}/en?LangCode=en`, 200, false, 'rejected'],
];

let failed = 0;
for (const [url, status, ok, reason] of cases) {
  const r = classifyLoginResponse(url, status);
  const pass = r.ok === ok && r.reason === reason && typeof r.message === 'string' && r.message.length > 0;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${reason.padEnd(12)} ${url.replace(X, '')}` + (pass ? '' : `  got ${JSON.stringify(r)}`));
  if (!pass) failed++;
}
// The expired-PIN message must tell the user what to do.
const exp = classifyLoginResponse(`${X}/expired_pin/vaspian?UserID=188`, 200);
if (!/expired/i.test(exp.message) || !/reset/i.test(exp.message)) { console.log('FAIL expired_pin message should mention expired + reset:', exp.message); failed++; }

// buildLoginUrl(): a phone number in the tenant field uses ProcessDIDLogin.jsp
const mb = src.match(/function buildLoginUrl\([\s\S]*?\n}\n/);
assert(mb, 'buildLoginUrl() not found in background.js');
const buildLoginUrl = new Function(`${mb[0]}; return buildLoginUrl;`)();
const urlCases = [
  ['vaspian', 'ProcessLogin.jsp?tenantWebName=/vaspian&UserID=188&Password=p%26w'],
  ['/vaspian', 'ProcessLogin.jsp?tenantWebName=/vaspian&UserID=188&Password=p%26w'],
  ['7169612115', 'ProcessDIDLogin.jsp?DID=7169612115&UserID=188&Password=p%26w'],
  ['(716) 961-2115', 'ProcessDIDLogin.jsp?DID=7169612115&UserID=188&Password=p%26w'],
  ['+1 716-961-2115', 'ProcessDIDLogin.jsp?DID=7169612115&UserID=188&Password=p%26w'],
  ['17169612115', 'ProcessDIDLogin.jsp?DID=7169612115&UserID=188&Password=p%26w'],
];
for (const [tenant, tail] of urlCases) {
  const u = buildLoginUrl(tenant, '188', 'p&w');
  const pass = u === `https://xtone.buf.vaspian.net/webadmin/en/user/jsp/${tail}`;
  console.log(`${pass ? 'PASS' : 'FAIL'} buildLoginUrl(${JSON.stringify(tenant)})` + (pass ? '' : `  got ${u}`));
  if (!pass) failed++;
}

console.log(failed ? `\n${failed} failing` : '\nall passing');
process.exit(failed ? 1 : 0);
