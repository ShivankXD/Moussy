/**
 * MOUSSY — Background Service Worker
 * ====================================
 * Manifest V3 service worker (module type).
 *
 * Responsibilities (to be implemented):
 *  - Listen for gesture events from content.js via chrome.runtime.onMessage
 *  - Route gesture → action mappings loaded from chrome.storage
 *  - Manage the Offscreen document lifecycle for audio playback
 *  - Handle activeTab / scripting API calls (screenshots, tab manipulation)
 *  - Maintain context menu entries
 *  - Orchestrate install / update lifecycle events
 */

// ─── Lifecycle ────────────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  console.log(`[MOUSSY] Service worker installed. Reason: ${reason}`);
  // TODO: seed default gesture map into chrome.storage.sync
});

// ─── Message Router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[MOUSSY] Message received:', message);
  // TODO: dispatch to gesture handler, audio manager, screenshot util, etc.
  sendResponse({ status: 'ok' });
});
