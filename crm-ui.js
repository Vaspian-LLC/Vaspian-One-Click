// Track C "crm" owns this file. CRM settings and history enhancements
// (popup and sidebar).
//
// Scaffold from the foundation: loads and renders nothing yet.
// Mount points (all display:none while empty):
//   <div id="crmSettingsMount">   Settings tab, directly after the Screen Pop card
//                                 (this track may move #screenPopCard into it)
//   <div id="historyMount">       History tab, above the history list
//   <div id="historyInlineMount"> Sidebar Dial tab, above the inline history list
// Read state from chrome.storage.local (keys prefixed "crm") and send commands
// to crm.js with chrome.runtime.sendMessage({ action: 'crm:<verb>', ... }).
// Styles go in crm.css, scoped under the mounts or .crm-*.
// Keep everything inside this IIFE; register on window.OneClickUI.crm.

(function () {
  'use strict';
  window.OneClickUI = window.OneClickUI || {};

  function mount(els) { // eslint-disable-line no-unused-vars
  }

  document.addEventListener('DOMContentLoaded', () => {
    mount({
      settings: document.getElementById('crmSettingsMount'),
      history: document.getElementById('historyMount'),
      historyInline: document.getElementById('historyInlineMount')
    });
  });

  window.OneClickUI.crm = { mount };
})();
