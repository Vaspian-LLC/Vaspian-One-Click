# Chrome Web Store update: version 2.0.0

## Package

Build from the `feat/v2` branch with tests, promo, screenshots, store notes, `test-click-to-call.html`, `PRODUCT.md`, `DESIGN.md` and `.impeccable/` left out of the zip. (The release branch is Chris's call; the redesign lives on `feat/ux`.)

## Release notes (for the store submission)

```
Version 2.0.0: a redesigned One Click

- Lives in Chrome's side panel. Click the toolbar icon to open it next to the page you're on. Needs Chrome 116 or later.
- A new look, with your status and a DND button at the top, and three tabs: Calls, Team and Settings.
- Recent calls under the dialer, with All, Missed, Inbound and Outbound filters. A badge counts missed calls you haven't seen.
- Call card: answer or send to voicemail, then hold, transfer, park or hang up. Pick who to transfer to by name, then transfer now or talk first.
- Your status: click it for Do not disturb, call forwarding to a coworker or any number, and call queues.
- Team tab: people with favorites and search, call groups, and parked calls.
- Screen pop in four guided steps for Simplicity Collect, Zoho Desk, Zoho CRM, SecureCRM, Google Contacts, Google search or your own link.
- After-call wrap-up with your own call outcomes. Number keys pick one and Ctrl+Enter saves.
- First-run setup: import your admin's settings file, sign in, test your phone and set up screen pop.
- Admins can share their setup as a settings file.
- A warning before a wrong PIN locks your extension.
- Keyboard shortcuts: Alt+Shift+A answer, Alt+Shift+H hang up, Alt+Shift+D Do not disturb, Alt+Shift+C call the selected number.
- Settings your IT team sets through Chrome policy show "Set by your IT team".
```

## Permissions added since 1.x

`alarms`, `contextMenus`, optional `notifications`, and managed storage. Explain them with the table in PRIVACY_POLICY.md. The toolbar popup is gone; `sidePanel` is now how One Click opens.

## Privacy fields

Update the store's privacy answers to match PRIVACY_POLICY.md: the Extension handles personal communications (call history) and authentication information (PIN, kept on the device), does not sell data, and uses data only for its single purpose.
