# Vaspian One Click

A modern, performant Chrome extension that integrates seamlessly with the Vaspian Phone System, providing one-click calling functionality with a beautiful, intuitive interface.

![Version](https://img.shields.io/badge/version-1.1.2-orange)
![Manifest](https://img.shields.io/badge/manifest-v3-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## ✨ Features

### 🎯 Core Functionality
- **One-Click Calling**: Click any phone number on any webpage to instantly dial
- **Smart Dialer**: Manual dialing with automatic number formatting
- **Call History**: Track your last 500 calls with timestamps and notes
- **Call Notes**: Add detailed notes to any call for better record-keeping
- **CSV Export**: Export call history with notes for CRM integration or record-keeping

### 🎨 Modern Interface
- **Sidebar Mode**: Pin the extension to your browser sidebar for quick access
- **Responsive Design**: Beautiful, polished UI that works in popup and sidebar modes
- **Real-time Status**: Visual feedback with connection indicators
- **Smooth Animations**: Carefully crafted transitions for a premium feel

### 🔧 Advanced Features
- **Dial Prefix Support**: Defaults to "8" prefix; configurable to "9" or no prefix for external dialing
- **Debug Logging**: Comprehensive logging system for troubleshooting
- **Auto-Detection**: Phone numbers on web pages are automatically detected with subtle hover effects
- **Secure Storage**: Tenant and extension sync with your Chrome profile; your PIN stays in local storage on this device only

## 📋 Requirements

- Google Chrome (version 88 or higher)
- Active Vaspian Phone System account
- Access to `xtone.buf.vaspian.net`

## 🚀 Installation

### From Source

1. **Clone or download this repository**
   ```bash
   git clone https://github.com/ctaloi/Vaspian-One-Click.git
   cd Vaspian-One-Click
   ```

2. **Open Chrome Extensions**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode" (toggle in top-right corner)

3. **Load the Extension**
   - Click "Load unpacked"
   - Select the `vaspian-chrome` directory
   - The extension icon will appear in your toolbar

## ⚙️ Configuration

### Initial Setup

1. **Click the extension icon** in your Chrome toolbar

2. **Go to Settings tab** and enter your credentials:
   - **Tenant**: Your Vaspian tenant name (e.g., `vaspian`) or one of your company's Vaspian phone numbers (e.g., `7169612115`)
   - **Extension**: Your extension number (e.g., `188`)
   - **Password**: Your Vaspian password

3. **Click "Login"** to verify your credentials

4. **Optional: Configure Advanced Settings**
   - Dial prefix is set to "8" by default (works for most configurations)
   - Change the prefix to "9" or "No prefix" if your system requires it
   - Enable debug logging for troubleshooting
   - Toggle sidebar mode for persistent access

### Sidebar Mode (Recommended)

For the best experience, enable sidebar mode:

1. Go to Settings → Display
2. Toggle "Open in Sidebar"
3. Click the extension icon to open the sidebar
4. The dialer and call history will remain accessible while you browse

## 📞 Usage

### Click-to-Call from Web Pages

1. Browse any webpage with phone numbers
2. Phone numbers are automatically highlighted in orange
3. Click any phone number to instantly dial
4. A notification confirms the call is being placed

### Manual Dialing

1. Open the extension (popup or sidebar)
2. Go to the **Dial** tab
3. Enter the phone number (formatting is automatic)
4. Click "Make a Call"
5. Your phone rings first, then connects to the destination

### Call History & Notes

**View History:**
- Click the **History** tab to see your recent calls
- Or scroll below the dialer in sidebar mode

**Add Notes:**
1. Click any call in your history
2. A note editor appears below the call
3. Type your notes and click "Save Note"
4. Notes are included in CSV exports

**Redial:**
- Click the phone icon (📞) next to any call to redial instantly

**Export:**
- Click the export button (↓) to download a CSV file
- Filename format: `{tenant}-{extension}-{YYYY-MM-DD}.csv`
- Includes: DateTime, Phone Number, and Notes

## 🎯 Supported Phone Number Formats

The extension recognizes various formats:

- `123-456-7890`
- `123.456.7890`
- `(123) 456-7890`
- `123 456 7890`
- `1234567890`
- `+1 123-456-7890`
- International formats (10-15 digits)

## 🗂️ Project Structure

```
vaspian-chrome/
├── manifest.json              # Extension manifest (Manifest V3)
├── background.js              # Service worker for API calls & session management
├── popup.html                 # Main UI (works in popup and sidebar)
├── popup.js                   # UI logic and state management
├── popup.css                  # Modern, performant styling
├── content.js                 # Content script for phone number detection
├── content.css                # Styling for detected phone numbers
├── HELP.md                    # Comprehensive user guide
├── icons/                     # Extension icons
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
├── vaspian-just-logo.png      # Logo asset
└── README.md                  # This file
```

## 🔒 Security

### Implemented Security Measures

✅ **XSS Prevention**: All user input is sanitized using `escapeHtml()` before rendering
✅ **Password Security**: Passwords are masked in all log outputs
✅ **HTTPS Only**: All API calls are made over HTTPS
✅ **Secure Storage**: PIN kept in local storage on this device only (never synced)
✅ **No Third-Party Services**: All data stays between you and Vaspian
✅ **CSP Compliant**: No inline scripts, follows Content Security Policy best practices
✅ **Minimal Permissions**: Only requests necessary Chrome API permissions

### Security Notes

- Tenant and extension are stored in Chrome's sync storage; the PIN is stored in Chrome's local storage on this device only (since 2.0.0; older versions synced it and are migrated automatically)
- API calls only go to `xtone.buf.vaspian.net` (no other domains)
- Session cookies are managed securely via Chrome's cookie API
- Debug logs can be cleared at any time
- Logout clears all stored credentials and session data

### Permissions Explained

- `storage`: Save your credentials and settings
- `cookies`: Manage session cookies for API authentication
- `sidePanel`: Enable sidebar mode
- `https://xtone.buf.vaspian.net/*`: Make API calls to Vaspian

## 🐛 Troubleshooting

### Calls Not Going Through

1. **Verify credentials** in Settings tab
2. **Enable Debug Logging** (Settings → Advanced Settings)
3. **Check the Logs tab** for error messages
4. **Verify dial prefix** setting (defaults to "8"; change if your system requires "9" or no prefix)
5. **Contact support** if issues persist

### Phone Numbers Not Detected

- The extension looks for common North American phone number patterns
- Some formats may not be recognized - use manual dial instead
- Disable and re-enable the extension to reload the content script

### Extension Not Loading

1. Ensure Developer mode is enabled in `chrome://extensions/`
2. Check that all files are present in the extension directory
3. Try removing and re-adding the extension
4. Check browser console for error messages

### Notes Not Saving

1. Ensure you click "Save Note" after typing
2. Notes are cleared when you logout
3. Export to CSV to keep permanent records

## 🚀 Performance

This extension is optimized for speed and efficiency:

- **Event Delegation**: Reduces memory usage by 99.6% for call history
- **Optimized Transitions**: Specific CSS properties for smooth 60fps animations
- **Lazy Loading**: Logs only load when debug mode is enabled
- **Minimal Reflows**: Efficient DOM manipulation patterns
- **Fast Rendering**: Call history with 500 items renders instantly

## 🛠️ Development

### Making Changes

1. Edit the source files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the extension card
4. Test your changes

### Debug Mode

Enable debug logging in Advanced Settings to see:
- API request/response details
- Cookie management
- Session handling
- Error stack traces

Access logs via:
- **Popup**: Logs tab (when debug logging enabled)
- **Service Worker**: `chrome://extensions/` → Service Worker → Console
- **Content Script**: Right-click page → Inspect → Console

### API Endpoints

The extension uses these Vaspian API endpoints:

**Login:**
```
POST https://xtone.buf.vaspian.net/webadmin/en/user/jsp/ProcessLogin.jsp
Parameters:
  - tenantWebName: /{tenant}
  (When a phone number is entered as the tenant, ProcessDIDLogin.jsp is used
   with DID={10-digit number} instead of tenantWebName.)
  - UserID: {extension}
  - Password: {password}
```

**Click-to-Call:**
```
POST https://xtone.buf.vaspian.net/webadmin/en/user/jsp/ProcessClickToCall.jsp
Parameters:
  - origExt: {your extension}
  - destExt: {destination number}
```

## 📝 Changelog

### Version 1.1.2 (2026-09-15)

**Login Feedback and Phone-Number Tenant**
- Expired PIN is now reported as such, with instructions to reset it, instead of a generic "Call failed: 500"
- Wrong extension/PIN and unrecognized tenant now show distinct messages in the settings test and on click-to-call
- Tenant field accepts one of your company's Vaspian phone numbers in place of the tenant name

### Version 1.1.1

- Fixed phone number detection inside iframes and intermittent regex matching

### Version 1.1.0

- Click-to-call disable controls, global and per-site

### Version 1.0.0 (2025-01-24)

**Initial Release**
- One-click calling from any webpage
- Manual dialer with number formatting
- Call history with notes support
- CSV export functionality
- Sidebar mode support
- Dial prefix configuration (defaults to "8")
- Debug logging system
- Optimized performance and animations
- Comprehensive security measures

## 🤝 Support

**For Extension Issues:**
- Check the [HELP.md](HELP.md) file for detailed usage instructions
- Enable debug logging and check the Logs tab
- Open an issue on GitHub (if applicable)

**For Vaspian API Issues:**
- Email: [support@vaspian.com](mailto:support@vaspian.com)
- Phone: [716-961-2120](tel:+17169612120)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

This is open source software. Contributions are welcome!

## 🙏 Acknowledgments

Built with modern web technologies:
- Manifest V3 for Chrome Extensions
- Vanilla JavaScript (no frameworks - keeping it lean!)
- CSS3 with performance-optimized transitions
- Chrome Storage API for secure credential management

---

**Made with ❤️ for Vaspian users**

*Version 1.1.2 - September 2026*
