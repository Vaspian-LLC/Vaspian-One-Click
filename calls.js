// Track A "callcard" owns this file. Call state machine (service worker).
//
// Scaffold from the foundation: loads and does nothing yet.
// Build on self.OneClick.api (see fleet/ARCHITECTURE.md):
//   api.on('call', ev => ...)         normalized call events (offer, ringing, dial,
//                                     ringback, answer, end, ...); ev.isNew, ev.isDuplicate,
//                                     ev.direction, ev.from/ev.to parties
//   api.callControl(callId, 'answerCall' | 'hangupCall' | 'holdCall' | 'resumeHeldCall' |
//                   'deflectCall' | 'transfer' | 'parkCall', extra)
//   api.getActiveCalls()              resync after a reconnect ('connected' event)
//   self.OneClick.dial(number)        place a call (3PCC, X-Tone fallback)
// Also owned here: chrome.commands 'answer', 'hangup', 'dial-selection', the
// "Call selected number" context menu, and the missed-call notification
// (optional "notifications" permission, requested from a user gesture in the UI).
// Publish UI state to chrome.storage.local under keys prefixed "callcard".
// Keep everything inside this IIFE; register the public surface on self.OneClick.calls.

(function () {
  'use strict';
  const api = self.OneClick.api; // eslint-disable-line no-unused-vars

  self.OneClick.calls = {
    track: 'callcard'
  };
})();
