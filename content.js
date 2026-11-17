// Content script for Vaspian One Click
// Detects phone numbers on web pages and makes them clickable

(function() {
  'use strict';

  // Phone number regex patterns
  const phonePatterns = [
    /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g,           // 123-456-7890, 123.456.7890, 123 456 7890
    /\(\d{3}\)\s?\d{3}[-.\s]?\d{4}\b/g,            // (123) 456-7890, (716) 923-4121
    /\(\d{3}\)[-.\s]?\d{3}[-.\s]?\d{4}\b/g,        // (123)-456-7890
    /\b\d{1,3}[-.\s]?(?:\d{3}|\([A-Za-z0-9]{3}\))[-.\s]?[A-Za-z][A-Za-z0-9\-.\s]{4,}\b/g,  // 1-855-VASPIAN, 1-800-FLOWERS, 1-800-GO-FEDEX
    /\([A-Za-z0-9]{3}\)\s?[A-Za-z][A-Za-z0-9\-.\s]{4,}\b/g,  // (800) MATTRESS
    /\b\d{10,11}\b/g,                                // 1234567890, 12345678901 (10-11 digits only)
    /\+\d{1,3}\s?\d{10,11}\b/g                       // +1 1234567890 (international with 10-11 digits)
  ];

  /**
   * Convert letters to phone digits based on phone keypad mapping
   * @param {string} text - Text containing letters and/or digits
   * @returns {string} - Text with letters converted to digits
   */
  function convertLettersToDigits(text) {
    const letterMap = {
      'a': '2', 'b': '2', 'c': '2',
      'd': '3', 'e': '3', 'f': '3',
      'g': '4', 'h': '4', 'i': '4',
      'j': '5', 'k': '5', 'l': '5',
      'm': '6', 'n': '6', 'o': '6',
      'p': '7', 'q': '7', 'r': '7', 's': '7',
      't': '8', 'u': '8', 'v': '8',
      'w': '9', 'x': '9', 'y': '9', 'z': '9'
    };

    return text.toLowerCase().split('').map(char => {
      return letterMap[char] || char;
    }).join('');
  }

  /**
   * Validate that a phone number has exactly 10 or 11 digits
   * @param {string} phoneNumber - Phone number text (may contain letters/formatting)
   * @returns {boolean} - True if valid 10 or 11 digit number
   */
  function isValidPhoneNumber(phoneNumber) {
    // Convert letters to digits
    const withDigits = convertLettersToDigits(phoneNumber);
    // Remove all non-digit characters except +
    const digitsOnly = withDigits.replace(/[^\d+]/g, '').replace(/\+/g, '');
    // Must be exactly 10 or 11 digits
    return digitsOnly.length === 10 || digitsOnly.length === 11;
  }

  /**
   * Initialize the click-to-call functionality
   */
  async function init() {
    // Check if click-to-call is enabled for this site
    const enabled = await isClickToCallEnabled();
    if (!enabled) {
      console.log('Vaspian One Click: Click-to-call disabled for this site');
      return;
    }

    // One listener for every number on the page (ours and the page's own tel: links).
    window.addEventListener('click', onPageClick, true);

    // Find and wrap phone numbers
    wrapPhoneNumbers();

    // Watch for dynamic content changes
    observePageChanges();
  }

  /**
   * Check if click-to-call is enabled globally and for the current site
   * @returns {Promise<boolean>}
   */
  async function isClickToCallEnabled() {
    try {
      const settings = await chrome.storage.sync.get(['clickToCallEnabled', 'clickToCallDisabledSites']);

      // Default to enabled if setting doesn't exist
      const globalEnabled = settings.clickToCallEnabled !== false;

      if (!globalEnabled) {
        return false;
      }

      // Check if current site is in the disabled list
      const disabledSites = settings.clickToCallDisabledSites || [];
      const currentHostname = window.location.hostname;

      // Check if any disabled site matches the current hostname
      const isDisabled = disabledSites.some(site => {
        // Normalize the site URL (remove protocol, trailing slash, etc.)
        const normalizedSite = site.replace(/^https?:\/\//, '').replace(/\/$/, '');
        return currentHostname === normalizedSite || currentHostname.endsWith('.' + normalizedSite);
      });

      return !isDisabled;
    } catch (error) {
      console.error('Error checking click-to-call settings:', error);
      // Default to enabled on error
      return true;
    }
  }

  /**
   * Check if an element or its ancestors have a Vaspian class
   * @param {Element} element
   * @returns {boolean}
   */
  function isVaspianElement(element) {
    let current = element;
    while (current && current !== document.body) {
      if (current.classList && (
          current.classList.contains('vaspian-phone') ||
          current.classList.contains('vaspian-notification') ||
          current.classList.contains('vaspian-notification-content') ||
          current.classList.contains('vaspian-notification-body')
      )) {
        return true;
      }
      current = current.parentElement;
    }
    return false;
  }

  /**
   * Find phone numbers in the page and make them clickable
   */
  function wrapPhoneNumbers() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode: function(node) {
          // Skip script and style tags, and our own elements
          if (node.parentElement.tagName === 'SCRIPT' ||
              node.parentElement.tagName === 'STYLE' ||
              isVaspianElement(node.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodesToReplace = [];
    let node;

    while (node = walker.nextNode()) {
      const text = node.nodeValue;
      let hasPhone = false;

      // Check if text contains any phone number pattern
      for (const pattern of phonePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(text)) {
          hasPhone = true;
          break;
        }
      }

      if (hasPhone) {
        nodesToReplace.push(node);
      }
    }

    // Replace text nodes with clickable phone numbers
    nodesToReplace.forEach(replacePhoneNumbers);
  }

  /**
   * Replace phone numbers in a text node with clickable elements
   * @param {Node} textNode
   */
  function replacePhoneNumbers(textNode) {
    const text = textNode.nodeValue;
    // The page already made this number a link: it needs a look of its own at rest.
    const linked = !!(textNode.parentElement && textNode.parentElement.closest('a[href]'));
    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    let matches = [];

    // Find all phone number matches
    phonePatterns.forEach(pattern => {
      const regex = new RegExp(pattern);
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          text: match[0],
          index: match.index
        });
      }
    });

    // Remove duplicates, validate digit count, and sort by index
    matches = matches
      .filter((match, index, self) =>
        index === self.findIndex(m => m.index === match.index)
      )
      .filter(match => isValidPhoneNumber(match.text))  // Only keep 10-11 digit numbers
      .sort((a, b) => a.index - b.index);

    // Create the fragment with clickable phone numbers
    matches.forEach(match => {
      // Add text before the phone number
      if (match.index > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.substring(lastIndex, match.index))
        );
      }

      // Create clickable phone number element
      const phoneLink = createPhoneLink(match.text, linked);
      fragment.appendChild(phoneLink);

      lastIndex = match.index + match.text.length;
    });

    // Add remaining text
    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    // Replace the text node with the fragment
    if (matches.length > 0) {
      textNode.parentNode.replaceChild(fragment, textNode);
    }
  }

  /**
   * Create a clickable phone number element. Clicks are handled by one
   * listener on the window (onPageClick), not per element.
   * @param {string} phoneNumber
   * @param {boolean} linked the number sits inside a link the page made
   * @returns {HTMLElement}
   */
  function createPhoneLink(phoneNumber, linked) {
    const span = document.createElement('span');
    span.textContent = phoneNumber;
    span.className = linked ? 'vaspian-phone vaspian-phone-linked' : 'vaspian-phone';
    span.title = `Click to call ${phoneNumber}`;
    return span;
  }

  /**
   * The number in a tel: link, or '' when it is not a 10 or 11 digit number
   * we can dial (short codes, other countries: the browser handles those).
   * @param {string} href
   */
  function numberFromTelHref(href) {
    let s;
    try { s = decodeURIComponent(String(href || '').replace(/^tel:/i, '')); } catch (e) { return ''; }
    s = s.split(/[;,]/)[0].trim(); // drop ;ext=204 and pause digits
    if (!/^\+?[\d\s().-]+$/.test(s)) return '';
    const digits = s.replace(/\D/g, '');
    return digits.length === 10 || (digits.length === 11 && digits[0] === '1') ? s : '';
  }

  /**
   * A click anywhere on the page. Runs in the capture phase on the window so
   * a page script can't swallow the click first, and so a number inside a
   * tel: link calls through One Click instead of opening another phone app.
   * Only a real, plain left click dials: a page script calling .click() on a
   * number it planted must not place a call, and Ctrl/Shift clicks stay the page's.
   */
  function onPageClick(e) {
    if (!e.isTrusted || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const target = e.target instanceof Element ? e.target : (e.target && e.target.parentElement);
    if (!target) return;
    const span = target.closest('.vaspian-phone');
    let number = span ? span.textContent : '';
    if (!number) {
      const link = target.closest('a[href]');
      const href = link ? link.getAttribute('href') : '';
      if (/^tel:/i.test(href || '')) number = numberFromTelHref(href);
    }
    if (!number) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    makeCall(number);
  }

  /**
   * Format phone number for display
   * @param {string} phoneNumber
   * @returns {string}
   */
  function formatPhoneForDisplay(phoneNumber) {
    // Remove all non-digit characters except +
    const cleaned = phoneNumber.replace(/[^\d+]/g, '');
    const digits = cleaned.replace(/\+/g, '');
    const hasPlus = cleaned.startsWith('+');

    if (hasPlus && digits.length >= 11) {
      // International: +1 (555) 123-4567
      return `+${digits[0]} (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 11)}`;
    } else if (digits.length === 10) {
      // US: (555) 123-4567
      return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
    }
    // Return as-is if doesn't match expected format
    return phoneNumber;
  }

  let dialing = ''; // the number being requested right now: a second click on it does nothing

  /**
   * Initiate a call to the phone number. Says so at once, then says how it went.
   * @param {string} phoneNumber
   */
  async function makeCall(phoneNumber) {
    // Convert any letters to digits (for vanity numbers like 1-855-VASPIAN)
    const withDigits = convertLettersToDigits(phoneNumber);

    // Clean the phone number (remove formatting, but keep +)
    const cleanNumber = withDigits.replace(/[\s.\-()]/g, '');
    if (dialing === cleanNumber) return;
    dialing = cleanNumber;
    const shown = formatPhoneForDisplay(cleanNumber);
    toast({ type: 'pending', title: 'Starting your call\u2026', number: shown, ms: 20000 });

    try {
      // After One Click updates, a page that was already open keeps this old script, which can no longer reach it.
      if (!chrome.runtime || !chrome.runtime.id) throw new Error('Extension context invalidated');
      const response = await chrome.runtime.sendMessage({
        action: 'makeCall',
        phoneNumber: cleanNumber
      });

      if (response && response.success) {
        const ext = (response.result && response.result.extension) || response.extension;
        toast({
          type: 'success',
          title: ext ? `Calling from ext ${ext} \u00B7 your phone rings first` : 'Calling \u00B7 your phone rings first',
          number: shown
        });
      } else if (response && response.error) {
        toast({ type: 'error', title: 'Call not started', detail: response.error, ms: 9000 });
      } else {
        toast({ type: 'error', title: 'Call not started', detail: 'One Click didn\u2019t answer. Open it from the toolbar and try again.', ms: 9000 });
      }
    } catch (error) {
      console.error('Error making call:', error);
      const stale = !chrome.runtime || !chrome.runtime.id || /context invalidated/i.test(String(error && error.message));
      toast({
        type: 'error',
        title: stale ? 'Refresh this page' : 'Call not started',
        detail: stale ? 'One Click was updated while this page was open. Refresh the page, then click the number again.'
          : 'Couldn\u2019t reach One Click. Open it from the toolbar and try again.',
        ms: 9000
      });
    } finally {
      dialing = '';
    }
  }

  const TOAST_ICONS = {
    phone: '<svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
    alert: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
  };
  let toastEl = null;
  let toastTimer = null;

  /**
   * Show the one toast (a new one replaces the last).
   * @param {{type: 'pending'|'success'|'error', title: string, number?: string, detail?: string, ms?: number}} t
   */
  function toast({ type, title, number = '', detail = '', ms = 3500 }) {
    clearTimeout(toastTimer);
    if (toastEl) toastEl.remove();
    const notification = document.createElement('div');
    notification.className = `vaspian-notification vaspian-notification-${type}`;
    notification.setAttribute('role', type === 'error' ? 'alert' : 'status');

    const content = document.createElement('div');
    content.className = 'vaspian-notification-content';
    const icon = document.createElement('div');
    icon.className = 'vaspian-notification-icon';
    icon.innerHTML = type === 'error' ? TOAST_ICONS.alert : TOAST_ICONS.phone;
    const body = document.createElement('div');
    body.className = 'vaspian-notification-body';

    // A quiet line saying what is happening, then the number large (or the reason, for an error).
    const titleEl = document.createElement('div');
    titleEl.className = 'vaspian-notification-title';
    titleEl.textContent = title;
    body.appendChild(titleEl);
    if (number) {
      const numberEl = document.createElement('div');
      numberEl.className = 'vaspian-notification-number';
      numberEl.textContent = number;
      body.appendChild(numberEl);
    }
    if (detail) {
      const detailEl = document.createElement('div');
      detailEl.className = 'vaspian-notification-detail';
      detailEl.textContent = detail;
      body.appendChild(detailEl);
    }

    content.appendChild(icon);
    content.appendChild(body);
    notification.appendChild(content);
    document.body.appendChild(notification);
    toastEl = notification;

    toastTimer = setTimeout(() => {
      notification.style.animation = 'vaspian-slide-out 0.3s ease-in forwards';
      setTimeout(() => { notification.remove(); if (toastEl === notification) toastEl = null; }, 300);
    }, ms);
  }

  /** A plain message toast (the dial-selection shortcut uses this). */
  function showNotification(message, type) {
    toast({ type: type === 'error' ? 'error' : 'success', title: message, ms: type === 'error' ? 6000 : 3500 });
  }

  /**
   * Observe page changes and wrap new phone numbers
   */
  function observePageChanges() {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.addedNodes.length > 0) {
          mutation.addedNodes.forEach((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              // Process the new element
              const walker = document.createTreeWalker(
                node,
                NodeFilter.SHOW_TEXT,
                {
                  acceptNode: function(n) {
                    if (n.parentElement.tagName === 'SCRIPT' ||
                        n.parentElement.tagName === 'STYLE' ||
                        isVaspianElement(n.parentElement)) {
                      return NodeFilter.FILTER_REJECT;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                  }
                }
              );

              const nodesToReplace = [];
              let textNode;

              while (textNode = walker.nextNode()) {
                const text = textNode.nodeValue;
                let hasPhone = false;

                for (const pattern of phonePatterns) {
                  pattern.lastIndex = 0;
                  if (pattern.test(text)) {
                    hasPhone = true;
                    break;
                  }
                }

                if (hasPhone) {
                  nodesToReplace.push(textNode);
                }
              }

              nodesToReplace.forEach(replacePhoneNumbers);
            }
          });
        }
      });
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  // Initialize when the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }

  // Track A "callcard": the dial-selection shortcut (calls.js). Only the
  // focused frame with a selection answers (all_frames is on), and it dials
  // through makeCall above so the usual on-page toast shows.
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (!request || request.action !== 'callcard:dialSelection') return false;
    const text = String(window.getSelection() || '').trim();
    if (!text || !document.hasFocus()) return false;
    const digits = text.replace(/\D/g, '');
    if (text.length > 40 || /[a-z]/i.test(text.replace(/\b(ext|x)\.?\s*\d+$/i, '')) || digits.length < 2 || digits.length > 15) {
      sendResponse({ text, invalid: true });
      showNotification('Select a phone number to call it', 'error');
      return false;
    }
    sendResponse({ text });
    makeCall(text.replace(/\b(ext|x)\.?\s*\d+$/i, ''));
    return false;
  });

  // Listen for settings changes to enable/disable click-to-call
  chrome.storage.onChanged.addListener(async (changes, area) => {
    if (area === 'sync' && (changes.clickToCallEnabled || changes.clickToCallDisabledSites)) {
      // Reload the page to apply changes
      console.log('Vaspian One Click: Settings changed, reloading page...');
      window.location.reload();
    }
  });
})();
