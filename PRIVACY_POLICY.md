# Privacy Policy for Vaspian One Click

Last updated: October 30, 2026 (version 2.0.0)

## Overview

Vaspian One Click ("the Extension") connects Chrome to your Vaspian phone system. This policy explains what the Extension stores, where it sends data and how to remove it.

## What the Extension stores

In your browser:

- **Account**: your company name or main number and your extension (Chrome sync storage), and your PIN (Chrome local storage on this device only; it is never synced).
- **Call history**: your last 500 calls with number, caller name, direction, time, duration and outcome, plus any notes, wrap-up choices and dispositions you add.
- **Team directory**: your coworkers' names and extensions and your company's shared contacts, cached for up to an hour.
- **Live status**: your own status, and, for administrators who turn on Team view, your coworkers' status and current calls. Coworker status is kept in memory and in Chrome session storage only and is cleared when you sign out or close the browser.
- **Settings**: outside line prefix, click to call options, side panel, missed-call alerts, screen pop settings (including a Zoho Desk access key if you enter one) and the activity log preference.
- **Activity log**: only when you turn it on, for up to 24 hours. PINs are never written to it.

## Where data goes

- **Your Vaspian phone system** (`xtone.buf.vaspian.net`, HTTPS): to sign in, place and control your calls, and receive live call and status updates.
- **Your CRM, when screen pop opens**: the Extension opens a browser tab at the address you configured with the caller's number and name in it. If you choose Google Contacts or Google search, that address is on Google, so Google receives the caller's number.
- **Vaspian's Zoho Desk screen pop service** (`zoho-screenpop.vaspian.me`), only if you choose Zoho Desk: it receives the caller's number and your access key to find the matching contact.
- **Vaspian support, only when you send it**: Export diagnostics saves a file to your computer with your version, settings, connection status, recent call events and log. It never includes your PIN or keys.

The Extension does not use analytics, advertising or tracking, and does not sell or share your data.

Phone numbers on web pages are found on your computer. Page content is never sent anywhere.

## Permissions

| Permission | Why |
|---|---|
| `storage` | Save your account, settings and call history |
| `cookies` | Keep your session with the Vaspian phone system |
| `sidePanel` | Open One Click in Chrome's side panel |
| `alarms` | Keep the live connection healthy and refresh status |
| `contextMenus` | "Call with Vaspian" when you right-click a number |
| `notifications` (optional, asked when you turn on missed-call alerts) | Show missed-call alerts |
| Managed storage | Let your company's IT set One Click settings through Chrome policy |
| Access to `xtone.buf.vaspian.net` | Talk to your Vaspian phone system |
| Content script on web pages | Make phone numbers clickable |

## Keeping and removing data

- Sign out (Settings, Account) clears your PIN, call history and notes. You can download your history first.
- History keeps the newest 500 calls.
- The activity log can be cleared from the Logs tab and keeps at most 24 hours.
- Uninstalling the Extension removes everything it stored.

## Children

The Extension is a business tool and is not meant for children under 13.

## Changes

We'll update the date above when this policy changes.

## Contact

support@vaspian.com, (716) 961-2120
