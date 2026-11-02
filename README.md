# Vaspian One Click

A Chrome extension (Manifest V3) that turns Chrome's side panel into a control panel for the Vaspian phone you already have: click to call, a live call card, screen pop into your CRM, your team at a glance, after-call wrap-up and a Team view for receptionists.

Version 2.0.0. Requires Chrome 116 or later. License: MIT.

## Features

- **Side panel**: click the One Click icon in the toolbar and One Click opens in Chrome's side panel, beside the page you're working on. The header shows your status and a DND button. The tabs are Calls, Team and Settings (Team appears once you're signed in).
- **First-run setup**: on install a welcome tab walks you through it. Import a settings file from your admin (optional), sign in, choose your phone, set up screen pop (optional), done.
- **Calling**: click a phone number on any web page, select one and press Alt+Shift+C, right-click and choose Call with Vaspian, or type a number on Calls. Your phone rings first, then connects.
- **Recent calls**: under the dialer on Calls, with All, Missed, Inbound and Outbound filters, notes and CSV download. An orange badge on Calls counts missed calls you haven't seen yet.
- **Call card**: Answer or Send to voicemail while it rings, then Hold or Resume, Transfer, Park and Hang up. Transfer has a person picker with Transfer now and Talk first. On Team and Settings a compact call bar keeps the call in view.
- **Your status**: click the status pill in the header for Do not disturb, Forward my calls and call queues. Alt+Shift+D turns Do not disturb on or off.
- **Team tab**: People (favorites, recent, everyone, search), Groups (join or leave) and Park (parked calls, Retrieve).
- **Screen pop**: a guided four-step setup for Simplicity Collect, Zoho Desk, Zoho CRM, SecureCRM, Google Contacts, Google search or your own link. Opens when you answer, or only when you click Open on the call card.
- **After-call wrap-up**: pick a call outcome and add a note after each answered call (off by default).
- **Team view**: live status for everyone in the office, in the Team tab and in a full-page view, for extensions with administrator access.
- **Share settings**: admins save the company setup to a file, and coworkers import it in one step.
- **Managed settings**: IT can set defaults or lock settings through Chrome policy (`managed_schema.json`). Locked settings show "Set by your IT team".

## Install from source

1. Open `chrome://extensions` and turn on Developer mode.
2. Select Load unpacked and choose this folder (the one with `manifest.json`).
3. The welcome tab opens. Follow the setup, or skip it and sign in on the Calls tab with your company’s main number, your extension and your PIN.
4. Click the One Click icon in the toolbar to open the side panel. To keep the icon handy, pin it from the puzzle-piece menu.

## Settings

Settings is a list of rows, each showing its current value. Select a row to open its page.

- **Account**: company, extension, live call updates, Reconnect, Share settings (admins only), Import settings, Sign out.
- **Calling**: outside line prefix (None, 8 or 9; most offices use 8), Phone for your calls (when you have more than one phone signed in), missed-call alerts.
- **Click to call**: on or off, and the sites where it's off.
- **Screen pop**: which app, connect it, when it opens, try it.
- **After-call wrap-up**: on or off, and your call outcomes.
- **Team view**: admins only.
- **Shortcuts**: your Chrome shortcuts for One Click, with a Change shortcuts button.
- **Help & diagnostics**: how to use One Click, contact details, guided setup (Run setup again or Continue setup), Activity log, Download diagnostics.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| Alt+Shift+A | Answer the ringing call |
| Alt+Shift+H | Hang up |
| Alt+Shift+D | Do not disturb on or off |
| Alt+Shift+C | Call the selected number |

These work anywhere in Chrome. Change them with Settings, Shortcuts, Change shortcuts, or at `chrome://extensions/shortcuts`. In the wrap-up prompt, 1 to 9 pick an outcome and Ctrl+Enter saves.

## For maintainers

Plain JavaScript and CSS with no build step and no runtime dependencies. One Click drives the Vaspian line over the Silhouette Public API (`xtone.buf.vaspian.net`): calls are placed with third-party call control (your phone rings first), and a WebSocket carries live call and status events. The toolbar icon opens the side panel through `chrome.sidePanel.setPanelBehavior`; there is no popup.

| Path | What it is |
|---|---|
| `manifest.json` | Extension manifest |
| `background.js` | Service worker: loads the modules below, click to call, logging, first-run setup |
| `lib/vaspian-api.js` | Public API client, live connection, event bus, call control |
| `lib/phone.js` | Phone number helpers (access code, display form) |
| `calls.js` | Call state for the call card, context menu, shortcuts, missed-call alerts |
| `presence.js` | Status, Do not disturb, forwarding, queues, groups, park, directory |
| `crm.js` / `screenpop.js` | Screen pop, history from call events, wrap-up, managed settings |
| `operator.js` | Team view engine (admins) |
| `settings-transfer.js` | Settings file export and import (allowlisted keys only) |
| `popup.html` / `popup.js` / `popup.css` / `tokens.css` | Side panel shell and design tokens |
| `settings-index.js` | Settings list and page navigation |
| `callcard-ui.js`, `status-ui.js`, `crm-ui.js`, `operator-ui.js`, `settings-transfer-ui.js` | Side panel features |
| `signin.js` | Shared sign-in for the side panel and setup (one try per attempt, lockout warning) |
| `welcome.html` / `welcome.js` / `onboarding.js` / `onboarding-state.js` | First-run setup |
| `operator.html` / `operator-console.js` / `operator.css` | Full-page Team view |
| `content.js` / `content.css` | Makes phone numbers clickable on web pages |
| `tests/` | Node tests (`node tests/<name>.test.js`) |

Sign-in is never retried: three rejected PINs within 30 minutes lock your phone extension for an hour, so `signin.js` counts rejections and warns before the third.

## Privacy and security

Your PIN stays in Chrome's local storage on this device and is never synced, logged, put in a settings file or included in diagnostics. One Click talks to the Vaspian phone system (`xtone.buf.vaspian.net`), opens your CRM when screen pop runs, and uses Vaspian's Zoho Desk screen pop service only if you choose Zoho Desk. No analytics or tracking. See [PRIVACY_POLICY.md](PRIVACY_POLICY.md).

## Troubleshooting

- **Calls don't go through**: check the outside line prefix in Settings, Calling, and that your desk phone or softphone is on. If you dial from Calls while no phone is signed in, One Click warns that the call may not ring.
- **Numbers on a page aren't clickable**: check Settings, Click to call, and the list of sites where it's off, then reload the page.
- **Live updates paused or reconnecting**: One Click reconnects on its own. If it doesn't, use Reconnect in Settings, Account.
- **Anything else**: turn on the Activity log in Settings, Help & diagnostics, reproduce the problem, then use Download diagnostics and send the file to support@vaspian.com.

## Changelog

### 2.0.0

A redesigned One Click that lives in Chrome's side panel: a new header with your status and DND, Calls, Team and Settings tabs, Recent calls on Calls with a missed-call badge, a status sheet for Do not disturb, forwarding and queues, the Team tab with People, Groups and Park, a call card with transfer picker and park, guided screen pop setup for seven apps, after-call wrap-up with call outcomes, first-run setup, settings files you can share, keyboard shortcuts, Chrome policy settings, and a Team view for admins.

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
