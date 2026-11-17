# Chrome Web Store update: version 2.1.0

## Package

Build from `main` (2.x is `feat/ux` merged) with `manifest.json` at the zip root and tests, promo, screenshots, store notes, `test-click-to-call.html`, `PRODUCT.md`, `DESIGN.md` and `.impeccable/` left out:

```
git archive HEAD | tar -x -C stage && cd stage && rm -rf tests promo screenshots .impeccable PRODUCT.md DESIGN.md STORE_LISTING.md CHROME_STORE_UPDATE.md test-click-to-call.html .gitignore && zip -qr -X ../vaspian-one-click-2.1.0.zip .
```

Updating from 1.x is silent (no new permission warnings) and keeps sign-in, settings and call history. The 1.x synced PIN is left in place through 2.1 so other computers stay signed in; a later release removes it.

## Release notes (for the store submission)

```
Version 2.1.0

- New: screen pop for InterProse ACE. Enter your company's InterProse address and One Click finds the caller's accounts.
- New: screen pop can open for calls you make, not only calls you answer. Turn on "Also for calls I make".
- Phone numbers a page already made into links now look callable and call through One Click.
- Clicking a number shows a message right away. If the call can't start, it says why and what to do.
- New: Keep my account on this computer only, for Chrome profiles you share with other people. It's on the sign-in screen and in Settings > Account.
- If someone signs in with a different account on your Chrome profile, One Click now asks you to sign in. It no longer tries their extension with your PIN.
- Share and Import settings moved to Settings > Advanced, and first-run setup no longer asks for a settings file.
- Fixed a call card that could stay on screen after a call ended.
```

The `accountLocalOnly`, `interproseHost` and `screenPopOutbound` policies are new in `managed_schema.json` since 2.0.1 (2.0.2 was never published). 2.1.0 adds no permissions.

## Permissions added since 1.x

`alarms`, `contextMenus`, optional `notifications`, and managed storage. Explain them with the table in PRIVACY_POLICY.md. The toolbar popup is gone; `sidePanel` is now how One Click opens.

## Privacy fields

Update the store's privacy answers to match PRIVACY_POLICY.md: the Extension handles personal communications (call history) and authentication information (PIN, kept on the device), does not sell data, and uses data only for its single purpose.
