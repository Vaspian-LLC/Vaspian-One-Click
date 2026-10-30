// Track A "callcard" owns this file. Live call card UI (popup and sidebar).
//
// Scaffold from the foundation: loads and renders nothing yet.
// Mount point: <div id="callCardMount"> at the top of the Dial tab.
// It is display:none while empty (.mount:empty), so render into it freely.
// Read state from chrome.storage.local (keys prefixed "callcard", plus
// "apiStatus" for the connection) and send commands to calls.js with
// chrome.runtime.sendMessage({ action: 'callcard:<verb>', ... }).
// Styles go in callcard.css, scoped under #callCardMount or .cc-*.
// Keep everything inside this IIFE; register on window.OneClickUI.callcard.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  function mount(el) { // eslint-disable-line no-unused-vars
  }

  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('callCardMount');
    if (el) mount(el);
  });

  window.OneClickUI.callcard = { mount };
})();
