# Vaspian One Click

A Chrome extension (Manifest V3) that turns Chrome into a phone panel for the Vaspian phone system: click to call, a live call card, your team's status, ring groups, park, screen pop to your CRM, history with wrap-up, and a Team view for receptionists.

Version 2.0.0. License: MIT.

## Features

- **Calling**: click a phone number on any page, select one and press Alt+Shift+C, right-click and choose Call with Vaspian, or use the Dial tab. Your phone rings first, then connects.
- **Call card**: caller name and number while it rings; answer, hold, transfer, park and hang up. A compact bar keeps the call in view on other tabs.
- **Team tab**: People (status, call, transfer), Groups (join or leave ring groups) and Park (parked calls, retrieve).
- **Status**: Do not disturb, forwarding and queue sign-in at a glance, with Alt+Shift+D for Do not disturb.
- **Screen pop**: Simplicity Collect, Zoho Desk (through Vaspian's screen pop service), SecureCRM or any web address, on ring or on answer.
- **History**: the last 500 calls with filters, notes, optional after-call wrap-up and CSV download.
- **Team view**: a full-page live view of the whole office for extensions with administrator access.
- **Managed settings**: IT can set defaults or lock settings through Chrome policy (`managed_schema.json`).

## Install from source

1. Open `chrome://extensions` and turn on Developer mode.
2. Select Load unpacked and choose this folder (the one with `manifest.json`).
3. Pin One Click from the puzzle-piece menu, open it and sign in under Settings with your company name or main number, extension and PIN.

## Settings

- **Account**: sign in or out, connection status.
- **Calling**: outside line prefix (None, 8 or 9; most offices use 8), click to call on web pages and sites where it's off, missed-call alerts, side panel.
- **Team view**: admins only.
- **Screen pop** and **After-call wrap-up** (off by default).
- **Help and support**: how to use One Click, contact details, Activity log, Export diagnostics.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+A | Answer the ringing call |
| Alt+Shift+H | Hang up |
| Alt+Shift+D | Do not disturb on or off |
| Alt+Shift+C | Call the selected number |

Change them at `chrome://extensions/shortcuts`.

## Project layout

| Path | What it is |
|---|---|
| `manifest.json` | Extension manifest |
| `background.js` | Service worker: loads the modules below, click to call, logging |
| `lib/vaspian-api.js` | Public API client, live connection, event bus, call control |
| `lib/phone.js` | Phone number helpers (access code, display form) |
| `calls.js` | Call state for the call card, context menu, shortcuts |
| `presence.js` | Status, Do not disturb, forwarding, groups, park, directory |
| `crm.js` / `screenpop.js` | Screen pop, history from call events, wrap-up, managed settings |
| `operator.js` | Team view engine (admins) |
| `popup.html` / `popup.js` / `popup.css` | Popup and side panel shell |
| `callcard-ui.js`, `status-ui.js`, `crm-ui.js`, `operator-ui.js` | Popup and side panel features |
| `operator.html` / `operator-console.js` / `operator.css` | Full-page Team view |
| `content.js` / `content.css` | Makes phone numbers clickable on web pages |
| `tests/` | Node tests (`node tests/<name>.test.js`) |

## Privacy and security

Your PIN stays in Chrome's local storage on this device and is never synced, logged or included in diagnostics. One Click talks to the Vaspian phone system (`xtone.buf.vaspian.net`), opens your CRM when screen pop runs, and uses Vaspian's Zoho Desk screen pop service only if you choose it. No analytics or tracking. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Troubleshooting

- **Calls don't go through**: check the outside line prefix in Settings, Calling, and that your desk phone or softphone is online.
- **Numbers on a page aren't clickable**: check Click to call on web pages and the list of sites where it's off, then reload the page.
- **"Connection lost" or "Reconnecting"**: One Click reconnects on its own; if it doesn't, use Reconnect in Settings, Account.
- **Anything else**: turn on the Activity log, reproduce the problem, then use Export diagnostics and send the file to support@vaspian.com.

## Changelog

### 2.0.0

Call card, Team tab, status, screen pop presets, history with wrap-up, Team view for admins, keyboard shortcuts, managed settings, reorganized Settings.

### 1.1.2

Clearer login errors (expired PIN, wrong PIN, unknown company); company phone number accepted in place of the company name.

### 1.1.1

Phone number detection inside iframes.

### 1.1.0

Click to call on or off, globally and per site.

### 1.0.0

First release: click to call, dialer, history with notes, CSV export, side panel, dial prefix.

## Support

support@vaspian.com, (716) 961-2120. Usage help: [HELP.md](HELP.md).
