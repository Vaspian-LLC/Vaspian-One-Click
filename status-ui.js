// Track B "status" owns this file. Status chip in the header and the
// Call Center tab (popup and sidebar).
//
// Scaffold from the foundation: loads and renders nothing yet.
// Mount points:
//   <div id="statusMount">     in the header, under the title row (display:none while empty)
//   <div id="callCenterMount"> the Call Center tab pane
// The Call Center tab button (.tab-btn[data-tab="callcenter"]) ships hidden;
// set its `hidden` property to false once this track renders real content.
// Read state from chrome.storage.local (keys prefixed "status", plus
// "apiStatus") and send commands to presence.js with
// chrome.runtime.sendMessage({ action: 'status:<verb>', ... }).
// Styles go in status.css, scoped under #statusMount / #callCenterMount or .st-*.
// Keep everything inside this IIFE; register on window.OneClickUI.status.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  function mount(statusEl, callCenterEl) { // eslint-disable-line no-unused-vars
  }

  document.addEventListener('DOMContentLoaded', () => {
    mount(document.getElementById('statusMount'), document.getElementById('callCenterMount'));
  });

  window.OneClickUI.status = { mount };
})();
