/**
 * MOUSSY — Popup Script
 * ======================
 * Controls the compact action-toolbar popup (popup.html).
 *
 * Responsibilities (to be implemented):
 *  - Read current enabled/disabled state from chrome.storage.sync
 *  - Toggle gesture engine on/off and persist to storage
 *  - Quick-adjust sensitivity via a range slider
 *  - Toggle audio feedback on/off
 *  - Open the full options page (chrome.runtime.openOptionsPage)
 *  - Display last triggered gesture + timestamp
 */

document.getElementById('open-options')?.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

console.log('[MOUSSY] Popup script loaded.');
