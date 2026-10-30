// Screen Pop settings card (popup and sidebar)

function renderScreenPopStatus(status) {
  const el = document.getElementById('screenPopStatus');
  if (!status) { el.textContent = 'Off'; return; }
  const labels = { off: 'Off', connecting: 'Connecting…', connected: '● Connected', retrying: 'Reconnecting…', error: '⚠ Not connected' };
  el.textContent = `${labels[status.state] || status.state}${status.detail ? ' · ' + status.detail : ''}`;
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
  const settings = await chrome.storage.sync.get(['screenPopEnabled', 'screenPopCrm', 'screenPopUrl', 'screenPopTrigger']);
  document.getElementById('screenPopEnabled').checked = settings.screenPopEnabled || false;
  document.getElementById('screenPopCrm').value = settings.screenPopCrm || 'simplicity';
  document.getElementById('screenPopUrl').value = settings.screenPopUrl || '';
  document.getElementById('screenPopTrigger').value = settings.screenPopTrigger || 'answer';
  updateScreenPopUrlField();

  const { screenPopStatus } = await chrome.storage.local.get(['screenPopStatus']);
  renderScreenPopStatus(screenPopStatus);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.screenPopStatus) renderScreenPopStatus(changes.screenPopStatus.newValue);
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
    chrome.runtime.sendMessage({ action: 'screenPopReconnect' });
  });
});
