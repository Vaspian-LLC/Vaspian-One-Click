// Screen Pop settings card (popup and sidebar)
//
// The status line renders the shared connection status published by
// lib/vaspian-api.js in chrome.storage.local.apiStatus.

/**
 * @param {{state: string, reason: string|null, detail: string}|undefined} status
 */
function renderScreenPopStatus(status) {
  const el = document.getElementById('screenPopStatus');
  if (!status) { el.textContent = 'Not connected'; return; }
  const labels = {
    off: 'Not connected',
    connecting: 'Connecting\u2026',
    connected: '\u25CF Connected',
    retrying: 'Reconnecting\u2026',
    error: '\u26A0 Not connected'
  };
  el.textContent = `${labels[status.state] || status.state}${status.detail ? ' \u00B7 ' + status.detail : ''}`;
  el.dataset.state = status.state;
  // After a PIN rejection, Reconnect would resend the rejected PIN (3 failures
  // lock the extension); the way out is saving credentials again.
  const btn = document.getElementById('screenPopReconnect');
  const authStop = status.state === 'error' && status.reason === 'auth';
  btn.disabled = authStop;
  btn.title = authStop ? 'Your PIN was rejected. Log out and log in again with the correct PIN.' : 'Reconnect the live connection';
}

async function saveScreenPop() {
  await chrome.storage.sync.set({
    screenPopEnabled: document.getElementById('screenPopEnabled').checked,
    screenPopCrm: document.getElementById('screenPopCrm').value,
    screenPopUrl: document.getElementById('screenPopUrl').value.trim(),
    screenPopTrigger: document.getElementById('screenPopTrigger').value
  });
}

function updateScreenPopUrlField() {
  document.getElementById('screenPopUrlField').style.display =
    document.getElementById('screenPopCrm').value === 'custom' ? '' : 'none';
}

document.addEventListener('DOMContentLoaded', async () => {
  // Track C (crm-ui.js) rebuilds this card with CRM presets and a preview.
  if (window.OneClickUI && window.OneClickUI.crm && window.OneClickUI.crm.ownsScreenPop) return;
  const settings = await chrome.storage.sync.get(['screenPopEnabled', 'screenPopCrm', 'screenPopUrl', 'screenPopTrigger']);
  document.getElementById('screenPopEnabled').checked = settings.screenPopEnabled || false;
  document.getElementById('screenPopCrm').value = settings.screenPopCrm || 'simplicity';
  document.getElementById('screenPopUrl').value = settings.screenPopUrl || '';
  document.getElementById('screenPopTrigger').value = settings.screenPopTrigger || 'answer';
  updateScreenPopUrlField();

  const { apiStatus } = await chrome.storage.local.get(['apiStatus']);
  renderScreenPopStatus(apiStatus);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.apiStatus) renderScreenPopStatus(changes.apiStatus.newValue);
  });

  document.getElementById('screenPopEnabled').addEventListener('change', saveScreenPop);
  document.getElementById('screenPopCrm').addEventListener('change', async () => {
    updateScreenPopUrlField();
    await saveScreenPop();
  });
  document.getElementById('screenPopUrl').addEventListener('change', saveScreenPop);
  document.getElementById('screenPopTrigger').addEventListener('change', saveScreenPop);

  document.getElementById('screenPopTest').addEventListener('click', async () => {
    await saveScreenPop();
    const phoneNumber = document.getElementById('screenPopTestNumber').value.trim();
    if (!phoneNumber) return;
    chrome.runtime.sendMessage({ action: 'screenPopTest', phoneNumber });
  });
  document.getElementById('screenPopReconnect').addEventListener('click', () => {
    chrome.runtime.sendMessage({ action: 'apiReconnect' });
  });
});
