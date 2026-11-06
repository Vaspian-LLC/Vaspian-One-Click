# Chrome Web Store update: version 2.0.2

## Package

Build from `main` (2.0.x is `feat/ux` merged) with `manifest.json` at the zip root and tests, promo, screenshots, store notes, `test-click-to-call.html`, `PRODUCT.md`, `DESIGN.md` and `.impeccable/` left out:

```
git archive HEAD | tar -x -C stage && cd stage && rm -rf tests promo screenshots .impeccable PRODUCT.md DESIGN.md STORE_LISTING.md CHROME_STORE_UPDATE.md test-click-to-call.html .gitignore && zip -qr -X ../vaspian-one-click-2.0.2.zip .
```

Updating from 1.x is silent (no new permission warnings) and keeps sign-in, settings and call history. The 1.x synced PIN is left in place in 2.0 so other computers stay signed in; 2.1 removes it.

## Release notes (for the store submission)

```
Version 2.0.2

- New: Keep my account on this computer only, for Chrome profiles you share with other people. It's on the sign-in screen and in Settings > Account.
- If someone signs in with a different account on your Chrome profile, One Click now asks you to sign in. It no longer tries their extension with your PIN.
- Share and Import settings moved to Settings > Advanced, and first-run setup no longer asks for a settings file.
- Fixed a call card that could stay on screen after a call ended.
```

The `accountLocalOnly` policy is new in `managed_schema.json`. 2.0.2 adds no permissions.

## Permissions added since 1.x

`alarms`, `contextMenus`, optional `notifications`, and managed storage. Explain them with the table in PRIVACY_POLICY.md. The toolbar popup is gone; `sidePanel` is now how One Click opens.

## Privacy fields

Update the store's privacy answers to match PRIVACY_POLICY.md: the Extension handles personal communications (call history) and authentication information (PIN, kept on the device), does not sell data, and uses data only for its single purpose.
