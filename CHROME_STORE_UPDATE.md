# Chrome Web Store Update - Version 1.1.0

## Package Location
`/Users/chris/src/vaspian-one-click-v1.1.0.zip` (51 KB)

## What's New in Version 1.1.0

### Click-to-Call Control Options
We've added powerful new settings to give you complete control over the click-to-call feature:

**Global Toggle**
- Enable or disable click-to-call across all websites with a single toggle
- Find it in Settings > Options > "Enable Click-to-Call on Web Pages"

**Per-Site Control**
- Disable click-to-call for specific websites where it might interfere with existing functionality
- Manage your disabled sites list in Settings > Advanced Settings > Disabled Sites
- Simply enter a website URL (e.g., "example.com") and click Add
- Remove sites anytime with the remove button

**Improved Settings Organization**
- Settings page has been reorganized for better clarity
- "Display" section renamed to "Options" for clearer categorization
- All click-to-call and display preferences consolidated in one place

### How It Works
1. **Global control**: Turn off click-to-call everywhere with one toggle
2. **Site-specific control**: Keep it enabled globally but disable for specific sites
3. **Automatic updates**: Pages reload automatically when you change settings
4. **Smart URL handling**: Works with both "example.com" and "https://example.com" formats
5. **Subdomain support**: Disabling a domain also disables all its subdomains

## Release Notes (for Chrome Web Store submission)

```
Version 1.1.0 - Click-to-Call Control Options

NEW FEATURES:
• Global toggle to enable/disable click-to-call on all web pages
• Per-site disabled list for granular control of click-to-call behavior
• Reorganized settings for improved usability

IMPROVEMENTS:
• Consolidated "Options" section for better settings organization
• Automatic page reload when settings change
• Smart URL normalization and subdomain support

Perfect for users who need more control over when and where click-to-call activates!
```

## Steps to Update Chrome Web Store

1. **Go to Chrome Web Store Developer Dashboard**
   - Visit: https://chrome.google.com/webstore/devconsole
   - Sign in with your developer account

2. **Select the Vaspian One Click Extension**
   - Click on the extension in your dashboard

3. **Upload New Package**
   - Click "Package" in the left sidebar
   - Click "Upload new package"
   - Upload: `/Users/chris/src/vaspian-one-click-v1.1.0.zip`

4. **Update Store Listing**
   - Go to "Store listing" section
   - Scroll to "What's new in this version" section
   - Paste the release notes from above

5. **Review Changes**
   - Review all changes in the preview
   - Make sure the version number shows as 1.1.0

6. **Submit for Review**
   - Click "Submit for review"
   - Chrome will review the update (typically takes 1-3 days)

7. **Monitor Status**
   - Check back to see when the update is approved and published

## Optional: Update Description (if needed)

If you want to highlight the new control features in the main description:

```
Vaspian One Click makes calling from your browser effortless. Click any phone number on a webpage to instantly dial through your Vaspian Phone System.

KEY FEATURES:
• One-click calling from any phone number on any webpage
• Manual dialing with built-in phone pad
• Call history tracking with notes
• Sidebar mode for easy access while browsing
• Full control over click-to-call behavior (NEW!)
  - Global toggle to enable/disable on all sites
  - Per-site control to disable on specific websites
• Automatic phone number detection
• Support for all phone formats including vanity numbers (1-800-FLOWERS)

Perfect for sales teams, customer support, and anyone who makes frequent calls from web-based CRMs, contact lists, or other online tools.
```

## Testing Before Submission

Before submitting to the Chrome Web Store, verify:
- [x] Version updated to 1.1.0 in manifest.json
- [x] All files committed and pushed to GitHub
- [x] Package created and tested locally
- [ ] Load unpacked extension in Chrome and test:
  - [ ] Global toggle works
  - [ ] Per-site disable works
  - [ ] Adding/removing sites from disabled list works
  - [ ] Pages reload when settings change
  - [ ] Existing features still work (login, calling, history)

## Support

If you encounter any issues during the update process, the extension source code is available at:
https://github.com/ctaloi/Vaspian-One-Click
