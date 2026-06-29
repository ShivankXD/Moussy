/**
 * MOUSSY — Launch Bridge  (popup.js)
 * ════════════════════════════════════
 * Execution flow
 * ──────────────
 *  1. DOMContentLoaded fires  (popup.html is parsed)
 *  2. chrome.tabs.create()    (opens settings.html in a brand-new foreground tab)
 *  3. window.close()          (destroys the popup window immediately after)
 *
 * The result feels like the extension icon is a direct launcher button —
 * no cramped dropdown, no secondary click required.
 *
 * Why NOT type="module"?
 * ───────────────────────
 * ES module scripts are deferred: they execute AFTER the browser has finished
 * parsing AND rendering the first frame. That adds a visible delay before the
 * tab opens. Using a classic script (loaded synchronously at end of <body>)
 * fires as early as possible, minimising the popup-visible window to ~1 frame.
 *
 * Why chrome.tabs.create instead of chrome.runtime.openOptionsPage?
 * ───────────────────────────────────────────────────────────────────
 * openOptionsPage() targets the file declared under "options_ui" in the manifest.
 * We are bypassing the Options page convention entirely and routing directly to
 * our custom settings panel — giving us full control over the URL and tab behaviour.
 *
 * Fallback safety
 * ────────────────
 * If the chrome.tabs API is somehow unavailable (e.g., running as a plain HTML
 * file during dev), we fall back to window.open() so the page still opens.
 */

'use strict';

(function launch() {
  /**
   * Resolve the extension-internal URL for the settings panel.
   * chrome.runtime.getURL() returns something like:
   *   chrome-extension://<id>/settings/settings.html
   */
  const SETTINGS_URL = chrome.runtime.getURL('settings/settings.html');

  /**
   * Open the settings panel in a new, active foreground tab.
   * Then immediately close the popup window so the user sees nothing
   * but the settings page snapping into view.
   */
  function openSettingsTab() {
    if (chrome?.tabs?.create) {
      // Primary path: use the tabs API (tabs permission is declared in manifest)
      chrome.tabs.create(
        {
          url:    SETTINGS_URL,
          active: true,    // bring the new tab into focus immediately
        },
        () => {
          // Close the popup as soon as the tab creation callback fires.
          // This is the earliest safe moment — the tab has been registered
          // with the browser even if it hasn't fully loaded yet.
          window.close();
        }
      );
    } else {
      // Fallback: plain window.open for dev/testing outside extension context
      window.open(SETTINGS_URL, '_blank');
      window.close();
    }
  }

  // Execute as soon as the DOM is ready.
  // Because this script is loaded at the end of <body> (not deferred / module),
  // DOMContentLoaded may already have fired — so we check readyState first.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', openSettingsTab, { once: true });
  } else {
    openSettingsTab();
  }
})();
