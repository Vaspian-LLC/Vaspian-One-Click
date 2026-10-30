# Privacy Policy for Vaspian One Click

**Last Updated: October 24, 2025**

## Overview

Vaspian One Click ("the Extension") is committed to protecting your privacy. This privacy policy explains how the Extension collects, uses, and protects your information.

## Information Collection and Use

### Information We Collect

The Extension collects and stores the following information locally in your browser:

1. **Vaspian Account Credentials**
   - Tenant name
   - Extension number
   - Password (PIN), stored in Chrome's local storage on this device only; it is never synced

2. **Call History**
   - Phone numbers you've dialed
   - Timestamps of calls
   - Notes you add to calls
   - Limited to your last 500 calls

3. **Settings and Preferences**
   - Dial prefix configuration
   - Debug logging preference
   - Sidebar mode preference

### How We Use Your Information

Your information is used solely to:

1. Authenticate with the Vaspian Phone System API
2. Place calls through your Vaspian account
3. Display your call history within the Extension
4. Provide debugging information when you enable debug mode
5. Export your call history when you request it

## Data Storage and Security

### Local Storage

All data is stored locally in your browser using Chrome's Storage API:

- **Credentials**: Tenant and extension in Chrome's sync storage; the PIN in Chrome's local storage on this device only
- **Call History**: Stored locally, limited to 500 most recent calls
- **Settings**: Stored locally in your browser

### Data Transmission

The Extension communicates ONLY with Vaspian servers:

- **Domain**: `xtone.buf.vaspian.net`
- **Protocol**: HTTPS only (encrypted)
- **Purpose**: Login authentication and placing calls

**We do NOT:**
- Send your data to any third-party services
- Use analytics or tracking tools
- Collect usage statistics
- Share your information with anyone

## Permissions Explained

The Extension requests the following Chrome permissions:

| Permission | Purpose |
|------------|---------|
| `storage` | Save your credentials, settings, and call history locally |
| `cookies` | Manage session cookies for Vaspian API authentication |
| `sidePanel` | Enable sidebar mode for the Extension |
| `https://xtone.buf.vaspian.net/*` | Make API calls to Vaspian Phone System |

## Data Retention

- **Credentials**: Stored until you logout or uninstall the Extension
- **Call History**: Limited to your last 500 calls; automatically removes older entries
- **Debug Logs**: Can be cleared at any time from the Logs tab

## Data Export and Deletion

### Exporting Your Data

You can export your call history at any time:
- Click the export button (↓) in the History tab
- Downloads a CSV file with your call history and notes

### Deleting Your Data

To delete all your data:
1. Click "Logout" in the Settings tab (clears credentials and call history)
2. Uninstall the Extension (removes all locally stored data)

## Third-Party Services

The Extension does NOT use any third-party services, analytics, or tracking tools. The only external communication is with Vaspian Phone System servers at `xtone.buf.vaspian.net`.

## Children's Privacy

The Extension is not intended for use by children under 13 years of age. We do not knowingly collect information from children.

## Changes to This Policy

We may update this privacy policy from time to time. Any changes will be reflected in the "Last Updated" date at the top of this document. Continued use of the Extension after changes constitutes acceptance of the updated policy.

## Open Source

This Extension is open source software. You can review the source code to verify our privacy practices at: https://github.com/ctaloi/Vaspian-One-Click

## Contact Us

For questions about this privacy policy or the Extension:

**Email**: support@vaspian.com
**Phone**: 716-961-2120

## Your Rights

You have the right to:

- Access your data (view in the Extension)
- Export your data (CSV export feature)
- Delete your data (logout or uninstall)
- Request information about data practices (contact us)

## Compliance

This Extension complies with:

- Chrome Web Store Developer Program Policies
- General Data Protection Regulation (GDPR) principles
- California Consumer Privacy Act (CCPA) principles

## Data Processing

- **Data Controller**: The user (you) controls your own data
- **Data Processor**: Vaspian Phone System processes calls on your behalf
- **Extension Role**: Facilitates communication between you and Vaspian

## Security Measures

We implement security best practices:

- ✅ XSS prevention with input sanitization
- ✅ Password masking in logs
- ✅ HTTPS-only communication
- ✅ PIN kept on this device only (Chrome local storage)
- ✅ No inline scripts (CSP compliant)
- ✅ Minimal permission requests

---

**Summary**: Vaspian One Click stores your credentials and call history locally in your browser, uses them only to communicate with Vaspian servers for making calls, and never shares your data with third parties or analytics services.
