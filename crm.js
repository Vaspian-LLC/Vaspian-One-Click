// Track C "crm" owns this file. CRM presets, call history built from events,
// after-call notes and dispositions, managed settings (service worker).
//
// Scaffold from the foundation: loads and does nothing yet.
// Build on self.OneClick.api (see fleet/ARCHITECTURE.md):
//   api.on('call', ev => ...)         build history from answer/end (ev.callDurationMs,
//                                     ev.smdrCallId ties legs together; no server CDR)
//   self.OneClick.screenpop           { PRESETS, buildUrl, normalize, pop } (screenpop.js)
//   chrome.storage.managed            schema in managed_schema.json (owned by this track)
// Publish UI state to chrome.storage.local under keys prefixed "crm".
// Keep everything inside this IIFE; register the public surface on self.OneClick.crm.

(function () {
  'use strict';
  const api = self.OneClick.api; // eslint-disable-line no-unused-vars

  self.OneClick.crm = {
    track: 'crm'
  };
})();
