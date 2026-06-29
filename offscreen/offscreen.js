/**
 * MOUSSY — Offscreen Audio Engine  (offscreen.js)
 * ══════════════════════════════════════════════════
 * Runs inside offscreen/offscreen.html — spawned by background.js.
 *
 * This file owns the Web Audio API pipeline. It receives PLAY_SOUND
 * messages from background.js and plays audio clips without touching
 * the active tab's thread or AudioContext.
 *
 * Audio pipeline per clip
 * ────────────────────────
 *
 *  fetch(URL)
 *    └─▶ arrayBuffer()
 *          └─▶ AudioContext.decodeAudioData()
 *                └─▶ AudioBufferSourceNode
 *                      └─▶ GainNode  (volume control)
 *                            └─▶ AudioContext.destination  (speakers)
 *
 * Caching strategy
 * ──────────────────
 *  Decoded AudioBuffer objects are cached by clip name in a Map.
 *  On the first play of a clip, we fetch + decode it (async).
 *  On subsequent plays, the cached buffer is used instantly — zero latency.
 *  AudioBufferSourceNode is a one-shot node; we create a new one per play
 *  (this is the correct Web Audio API pattern — source nodes cannot be reused).
 *
 * Error handling
 * ───────────────
 *  • Network / decode errors are caught and logged; they never crash the worker.
 *  • Autoplay policy: the AudioContext is created on the first message, which
 *    is user-gesture-adjacent (the user just performed a mouse gesture in the tab).
 *    Chrome's autoplay policy allows audio started within ~5s of a user gesture
 *    in ANY tab. If the context is suspended, we call resume() before playing.
 */

'use strict';

// ─── Audio Context (singleton) ────────────────────────────────────────────────
/**
 * We lazily initialise the AudioContext on the first PLAY_SOUND message.
 * Creating it at module evaluation time can trigger Chrome's autoplay guard.
 * @type {AudioContext|null}
 */
let _ctx = null;

function getAudioContext() {
  if (!_ctx) {
    _ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 44100 });
    console.log('[MOUSSY:offscreen] AudioContext created. State:', _ctx.state);
  }
  return _ctx;
}

// ─── Buffer Cache ─────────────────────────────────────────────────────────────
/** @type {Map<string, AudioBuffer>}  clip filename → decoded AudioBuffer */
const _bufferCache = new Map();

// ─── In-flight fetch tracker ──────────────────────────────────────────────────
/**
 * Prevents duplicate fetches when the same clip is requested twice before
 * the first fetch resolves.
 * @type {Map<string, Promise<AudioBuffer>>}
 */
const _inflight = new Map();

// ─── Audio Loader ─────────────────────────────────────────────────────────────
/**
 * Fetch, decode, and cache an audio clip.
 * Returns the decoded AudioBuffer (from cache on subsequent calls).
 *
 * @param {string} clip    Filename inside assets/sounds/ (e.g. 'metal_slash.mp3')
 * @returns {Promise<AudioBuffer>}
 */
async function loadClip(clip) {
  // 1. Return from cache if available
  if (_bufferCache.has(clip)) return _bufferCache.get(clip);

  // 2. Return the in-flight promise if a fetch is already running
  if (_inflight.has(clip)) return _inflight.get(clip);

  // 3. Start a new fetch
  const promise = (async () => {
    const url = chrome.runtime.getURL(`assets/sounds/${clip}`);
    console.log(`[MOUSSY:offscreen] Fetching clip: ${url}`);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} fetching ${clip}`);
    }

    const arrayBuffer  = await response.arrayBuffer();
    const ctx          = getAudioContext();
    const audioBuffer  = await ctx.decodeAudioData(arrayBuffer);

    _bufferCache.set(clip, audioBuffer);
    _inflight.delete(clip);

    console.log(`[MOUSSY:offscreen] Clip cached: ${clip} (${audioBuffer.duration.toFixed(2)}s)`);
    return audioBuffer;
  })();

  _inflight.set(clip, promise);
  return promise;
}

// ─── Playback ─────────────────────────────────────────────────────────────────
/**
 * Play a decoded AudioBuffer at the specified gain level.
 * Creates a fresh AudioBufferSourceNode each time (one-shot API requirement).
 *
 * @param {AudioBuffer} buffer
 * @param {number}      volume   0.0 – 1.0
 */
function playBuffer(buffer, volume) {
  const ctx    = getAudioContext();

  // Resume suspended context (may happen after tab loses focus)
  if (ctx.state === 'suspended') {
    ctx.resume().then(() =>
      console.log('[MOUSSY:offscreen] AudioContext resumed.')
    );
  }

  const source = ctx.createBufferSource();
  const gain   = ctx.createGain();

  source.buffer    = buffer;
  gain.gain.value  = Math.max(0, Math.min(1, volume));   // clamp 0–1

  // Wire pipeline: source → gain → speakers
  source.connect(gain);
  gain.connect(ctx.destination);

  source.start(0);   // play immediately (offset from ctx.currentTime = 0)

  // Log when the clip finishes playing
  source.onended = () => {
    console.log(`[MOUSSY:offscreen] Clip finished playing.`);
    source.disconnect();
    gain.disconnect();
  };
}

// ─── Main play function ───────────────────────────────────────────────────────
/**
 * Load (or retrieve from cache) and play a sound clip.
 *
 * @param {string} clip    e.g. 'metal_slash.mp3'
 * @param {number} volume  0.0 – 1.0
 */
async function playSound(clip, volume) {
  try {
    const buffer = await loadClip(clip);
    playBuffer(buffer, volume);
  } catch (err) {
    // Non-fatal: log and continue — a missing sound file shouldn't break gestures
    console.error(`[MOUSSY:offscreen] Failed to play "${clip}":`, err.message);
  }
}

// ─── Message Listener ─────────────────────────────────────────────────────────
/**
 * Listens for messages from background.js.
 * Only processes messages tagged with target: 'offscreen' to avoid
 * responding to messages intended for content scripts.
 *
 * Expected message shape:
 * {
 *   target:  'offscreen',
 *   type:    'PLAY_SOUND',
 *   payload: { clip: string, volume: number }
 * }
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  // Ignore messages not addressed to this document
  if (message.target !== 'offscreen') return false;

  if (message.type === 'PLAY_SOUND') {
    const { clip = 'metal_slash.mp3', volume = 0.5 } = message.payload ?? {};

    playSound(clip, volume)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));

    return true;   // keep channel open for async sendResponse
  }

  // Unknown message type to offscreen — ignore
  console.warn('[MOUSSY:offscreen] Unknown message type:', message.type);
  return false;
});

// ─── Ready ────────────────────────────────────────────────────────────────────
console.log('[MOUSSY:offscreen] Audio engine ready and listening.');
