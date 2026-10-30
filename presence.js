// Track B "status" owns this file. Presence, DND, groups, ACD, toolbar badge
// (service worker).
//
// Scaffold from the foundation: loads and does nothing yet.
// Build on self.OneClick.api (see fleet/ARCHITECTURE.md):
//   api.on('presence', ev => ...)     own presence events (dndOn/dndOff, busy/idle,
//                                     signedInAcd/signedOutAcd, joinedGroup/leftGroup)
//   api.getPresence()                 snapshot; poll it for "no device" (availability)
//                                     because there are no WS available/unavailable events
//   api.subscribe('parklocation', 'PL1') park slot events
//   api.request('PUT', `tenants/${tid}/users/${ext}/dnd`, { body: { active } })
//   api.getSession()                  { account, tenantId, extension, isAdmin, links }
// Also owned here: chrome.commands 'toggle-dnd' and chrome.action badge text/color.
// Publish UI state to chrome.storage.local under keys prefixed "status".
// Keep everything inside this IIFE; register the public surface on self.OneClick.presence.

(function () {
  'use strict';
  const api = self.OneClick.api; // eslint-disable-line no-unused-vars

  self.OneClick.presence = {
    track: 'status'
  };
})();
