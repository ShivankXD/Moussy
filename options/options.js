/**
 * MOUSSY — Options Page Script
 * ==============================
 * Controls the full configuration tab (options/options.html).
 *
 * NOTE: This page is currently an orphaned stub. The manifest's options_ui now
 * points to settings/settings.html (the real dashboard); this folder is kept
 * only as a placeholder for a future dedicated gesture-map editor.
 *
 * Responsibilities (to be implemented):
 *  - Load all settings from chrome.storage.local on page open
 *  - Render interactive gesture-map editor
 *  - Save changes back to chrome.storage.local with live validation
 *  - Handle import / export of gesture profiles (JSON blobs)
 *  - Manage per-domain allow/block rules
 */

console.log('[MOUSSY] Options page script loaded.');
