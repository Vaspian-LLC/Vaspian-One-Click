// First-run setup ("onboarding") state: pure functions, no DOM and no network.
// Loaded by the service worker (install hook in background.js), by welcome.html
// and popup.html, and by node (tests/onboarding.test.js).
//
// Storage: chrome.storage.local.onboardingState (this device only, never sync):
//   { v: 1, status: 'pending' | 'done', step, skipped: bool, at: ISO }
// It never holds credentials. A missing key means "never show": only a fresh
// install writes 'pending', so an update (including v1 -> v2) never shows it.

(function () {
  'use strict';

  const KEY = 'onboardingState';
  /** The screens, in order. */
  const STEPS = ['welcome', 'signin', 'phone', 'screenpop', 'done'];

  function now() { return new Date().toISOString(); }

  /** What chrome.runtime.onInstalled should do. Only a fresh install shows setup. */
  function installAction(reason) {
    if (reason !== 'install') return { write: null, open: false };
    return { write: { v: 1, status: 'pending', step: 'welcome', skipped: false, at: now() }, open: true };
  }

  /** A stored value cleaned up; null when there is none or it is unusable. */
  function normalize(state) {
    if (!state || typeof state !== 'object') return null;
    const status = state.status === 'done' ? 'done' : state.status === 'pending' ? 'pending' : null;
    if (!status) return null;
    return { v: 1, status, step: STEPS.includes(state.step) ? state.step : 'welcome', skipped: !!state.skipped, at: state.at || now() };
  }

  /** True while setup was started on this install and not finished or skipped. */
  function isPending(state) {
    const s = normalize(state);
    return !!(s && s.status === 'pending');
  }

  /**
   * Where the flow opens. A pending setup resumes at its saved step; anything
   * else (finished, skipped, never shown) starts again at Welcome.
   */
  function resumeStep(state) {
    const s = normalize(state);
    return s && s.status === 'pending' ? s.step : 'welcome';
  }

  /** The state to save when the flow opens (Run setup again makes it pending). */
  function open(state) {
    const s = normalize(state);
    if (s && s.status === 'pending') return s;
    return { v: 1, status: 'pending', step: 'welcome', skipped: false, at: now() };
  }

  /** Move to a step. Reaching Done finishes setup. */
  function go(state, step) {
    if (!STEPS.includes(step)) throw new Error(`unknown step ${step}`);
    const s = normalize(state) || open(null);
    return { ...s, step, status: step === 'done' ? 'done' : 'pending', at: now() };
  }

  /** "Skip setup" / "Skip the rest": finished, straight to Done. */
  function skip(state) {
    return { ...go(state, 'done'), skipped: true };
  }

  /** The step after `step`. */
  function nextStep(step) {
    const i = STEPS.indexOf(step);
    if (i < 0) return 'welcome';
    return STEPS[Math.min(i + 1, STEPS.length - 1)];
  }

  /** The step before `step` (Back). */
  function prevStep(step) {
    const i = STEPS.indexOf(step);
    return i <= 0 ? 'welcome' : STEPS[i - 1];
  }

  const api = { KEY, STEPS, installAction, normalize, isPending, resumeStep, open, go, skip, nextStep, prevStep };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else self.OneClickOnboardingState = api;
})();
