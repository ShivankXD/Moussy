/**
 * MOUSSY — Offscreen Audio Manager
 * ==================================
 * Runs inside offscreen/offscreen.html.
 * Receives messages from the background service worker and plays audio
 * via the Web Audio API without touching the active page's thread.
 *
 * Message contract (from background.js):
 *   { type: 'PLAY_SOUND', payload: { clip: String, volume: Number } }
 *
 * Responsibilities (to be implemented):
 *  - Initialise AudioContext once on first message (autoplay policy compliance)
 *  - Preload and cache audio buffers for all gesture sound clips
 *  - Play, stop, and cross-fade sounds on demand
 *  - Report playback errors back to background.js
 */

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'PLAY_SOUND') {
    console.log('[MOUSSY:offscreen] Play sound requested:', message.payload);
    // TODO: route to AudioManager.play(clip, volume)
  }
});

console.log('[MOUSSY] Offscreen audio document ready.');
