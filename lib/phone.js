// Phone number helpers shared by the service worker and every extension page.
// One place decides what a number "is" (access code stripped, 10-digit US form)
// and how it looks ((315) 555-0100), so dialing, history, contacts, the call
// card and screen pop all agree.
//
// Access codes: numbers saved in the phone system (tenant contacts, speed dials)
// and numbers seen in call events often already carry the outside-line code
// (8 or 9, e.g. 813155550100). One Click adds its own dial prefix, so a stored
// code would be dialed twice (8813155550100). stripAccessCode() removes leading
// 8/9 codes, but only while what follows is still a complete US number, so a
// real 10-digit number in area code 8xx/9xx is never touched.
(function (root) {
  'use strict';

  /** Digits only, keeping * and # for feature codes. */
  function digitsOf(raw) {
    return String(raw === undefined || raw === null ? '' : raw).replace(/[^\d*#]/g, '');
  }

  const fullUs = (d) => d.length === 10 || (d.length === 11 && d[0] === '1');

  /** '813155550100' -> '13155550100', '8813155550100' -> '13155550100'; others unchanged. */
  function stripAccessCode(raw) {
    const d = digitsOf(raw);
    if (d.length <= 10) return d;
    // Strip the fewest leading 8/9s that leave a complete US number.
    for (let i = 1; i < d.length && (d[i - 1] === '8' || d[i - 1] === '9'); i++) {
      if (fullUs(d.slice(i))) return d.slice(i);
    }
    return d;
  }

  /** The 10-digit US number, or '' when it isn't one. */
  function tenDigits(raw) {
    const d = stripAccessCode(raw);
    if (d.length === 10) return d;
    if (d.length === 11 && d[0] === '1') return d.slice(1);
    return '';
  }

  /** Friendly form: '(315) 555-0100' for US numbers, extensions as-is, other numbers as digits. */
  function display(raw) {
    const ten = tenDigits(raw);
    if (ten) return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
    const d = stripAccessCode(raw);
    return d || String(raw === undefined || raw === null ? '' : raw);
  }

  root.OneClickPhone = { digitsOf, stripAccessCode, tenDigits, display };
})(typeof self !== 'undefined' ? self : globalThis);
