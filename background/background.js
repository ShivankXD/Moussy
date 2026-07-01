/**
 * MOUSSY — Background Control Tower  (background.js)
 * ════════════════════════════════════════════════════
 * Manifest V3 service worker — type: "module"
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Architecture map                                                   │
 * │                                                                     │
 * │  content.js  ──GESTURE──────────────▶  GestureRouter               │
 * │                                           │  navigation action      │
 * │                                           │  OffscreenManager ──▶  │
 * │  content.js  ──PREMIUM_SCREENSHOT──▶  ScreenshotManager            │
 * │                                           │  isPremium gate         │
 * │                                           │  captureVisibleTab      │
 * │                                           └──▶ inject download      │
 * │  settings.js ──GET_STATE────────────▶  StateManager                │
 * │  premium.js  ──(writes moussy_plan)─▶  StateManager (derives gate)  │
 * │  background  ──PLAY_SOUND───────────▶  OffscreenManager            │
 * │                                           └──▶ offscreen.js        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Storage schema (chrome.storage.local)
 * ──────────────────────────────────────
 *  moussy_plan            : 'free' | 'monthly' | 'legend'  (premium gate)
 *  moussy_gesture_slots   : Array<{gesture, url}>
 *  moussy_gesture_mode    : 'omni' | 'freehand'
 *  moussy_sound_enabled   : boolean
 *  moussy_hud_clock       : boolean
 *  moussy_paused_global   : boolean
 *  moussy_paused_hosts    : string[]
 *  moussy_install_date    : ISO-8601 string
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ── Constants
// ═══════════════════════════════════════════════════════════════════════════════

const STORAGE_PLAN        = 'moussy_plan';            // 'free' | 'monthly' | 'legend'
const STORAGE_SLOTS       = 'moussy_gesture_slots';
const STORAGE_SOUND       = 'moussy_sound_enabled';
const STORAGE_HUD         = 'moussy_hud_clock';
const STORAGE_INSTALL     = 'moussy_install_date';
const STORAGE_PAUSE_GLOBAL = 'moussy_paused_global';  // boolean
const STORAGE_PAUSE_HOSTS  = 'moussy_paused_hosts';   // string[]
const STORAGE_DIAL_SIZE    = 'moussy_dial_size';      // number (scale ~0.82)
const STORAGE_DIAL_OPACITY = 'moussy_dial_opacity';   // number (band alpha 0..1)
const STORAGE_DIAL_DELAY   = 'moussy_dial_delay';     // number (hold ms, default 500)
const STORAGE_DIAL_COLOR   = 'moussy_dial_color';     // key into DIAL_COLORS (free)
const STORAGE_DIAL_THEME   = 'moussy_dial_theme';     // key into DIAL_THEMES (premium)
const STORAGE_SOUND_ID     = 'moussy_sound_id';       // key into SOUND_CATALOG
const STORAGE_SOUND_CUSTOM = 'moussy_sound_custom';   // { dataUrl } trimmed clip (premium)

const OFFSCREEN_URL       = 'offscreen/offscreen.html';
// NOTE: chrome.offscreen.Reason.AUDIO_PLAYBACK is used directly in createDocument().

/** Default sound clip played on successful navigation gesture */
const DEFAULT_GESTURE_CLIP = 'metal_slash.mp3';
const DEFAULT_GESTURE_VOL  = 0.5;   // 50% comfortable mix volume

/** Directions emitted by content.js GestureRecorder */
const Dir = Object.freeze({
  UP:    'UP',
  DOWN:  'DOWN',
  LEFT:  'LEFT',
  RIGHT: 'RIGHT',
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Promisified chrome.storage.local.get
 * @param {string|string[]} keys
 * @returns {Promise<Record<string, any>>}
 */
function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

/**
 * Promisified chrome.storage.local.set
 * @param {Record<string, any>} items
 * @returns {Promise<void>}
 */
function storageSet(items) {
  return new Promise((resolve) => chrome.storage.local.set(items, resolve));
}

/**
 * Promisified chrome.tabs.get
 * @param {number} tabId
 * @returns {Promise<chrome.tabs.Tab>}
 */
function tabGet(tabId) {
  return new Promise((resolve, reject) =>
    chrome.tabs.get(tabId, (tab) =>
      chrome.runtime.lastError ? reject(chrome.runtime.lastError) : resolve(tab)
    )
  );
}

/**
 * Returns the currently active tab in the focused window.
 * @returns {Promise<chrome.tabs.Tab|null>}
 */
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/**
 * Whether the gesture engine is paused for a given tab — global pause, or the
 * tab's hostname is in the per-host pause list. This is the authoritative gate:
 * even if a tab's content script is running a stale pause cache, the background
 * refuses to execute the navigation here.
 * @param {chrome.tabs.Tab} tab
 * @returns {Promise<boolean>}
 */
async function isTabPaused(tab) {
  const data   = await storageGet([STORAGE_PAUSE_GLOBAL, STORAGE_PAUSE_HOSTS]);
  if (data[STORAGE_PAUSE_GLOBAL] === true) return true;
  const hosts  = Array.isArray(data[STORAGE_PAUSE_HOSTS]) ? data[STORAGE_PAUSE_HOSTS] : [];
  try {
    return hosts.includes(new URL(tab.url).hostname);
  } catch {
    return false;
  }
}

/**
 * Send a fire-and-forget message to a tab's content script.
 * Silently swallows errors (tab may have navigated away).
 * @param {number} tabId
 * @param {object} message
 */
async function sendToTab(tabId, message) {
  try {
    await chrome.tabs.sendMessage(tabId, message);
  } catch {
    // Content script may not be injected on this tab (e.g., chrome:// pages)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── State Manager
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Thin wrapper around chrome.storage.local for the premium gate.
 *
 * The single source of truth is `moussy_plan` ('free'|'monthly'|'legend'),
 * written by premium.js / settings.js. `isPremium` is derived from it, so the
 * background gate and the purchase flow can never drift out of sync.
 */
const StateManager = {
  async getPlan() {
    const data = await storageGet(STORAGE_PLAN);
    return data[STORAGE_PLAN] ?? 'free';
  },

  async isPremium() {
    const plan = await this.getPlan();
    return plan === 'monthly' || plan === 'legend';
  },

  /** Set the active plan (dev/testing helper). */
  async setPlan(plan) {
    const valid = plan === 'monthly' || plan === 'legend' ? plan : 'free';
    await storageSet({ [STORAGE_PLAN]: valid });
    console.log(`[MOUSSY] plan set to: ${valid}`);
  },

  async getFullState() {
    return storageGet([
      STORAGE_PLAN,
      STORAGE_SLOTS,
      STORAGE_SOUND,
      STORAGE_HUD,
      STORAGE_INSTALL,
      STORAGE_PAUSE_GLOBAL,
      STORAGE_PAUSE_HOSTS,
      STORAGE_DIAL_COLOR,
      STORAGE_DIAL_THEME,
      STORAGE_SOUND_ID,
      STORAGE_SOUND_CUSTOM,
    ]);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Offscreen Manager
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Manages the singleton offscreen document lifecycle.
 *
 * MV3 offscreen documents are persistent until explicitly closed or the
 * service worker terminates. We create one on first audio need and reuse it.
 *
 * chrome.offscreen.hasDocument() is the idempotency guard — we never call
 * createDocument() if one already exists (would throw an error).
 */
const OffscreenManager = {
  _creating: false,   // prevents double-create race on rapid gestures

  /**
   * Ensure the offscreen document exists and is ready.
   * @returns {Promise<void>}
   */
  async ensureDocument() {
    // Guard: only one in-flight creation at a time
    if (this._creating) {
      await new Promise((r) => setTimeout(r, 120));
      return;
    }

    const exists = await chrome.offscreen.hasDocument();
    if (exists) return;

    this._creating = true;
    try {
      await chrome.offscreen.createDocument({
        url:           chrome.runtime.getURL(OFFSCREEN_URL),
        reasons:       [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Play mechanical audio feedback on gesture recognition events.',
      });
      console.log('[MOUSSY] Offscreen audio document created.');
    } finally {
      this._creating = false;
    }
  },

  /**
   * Send a PLAY_SOUND message to the offscreen document.
   * Creates the document if it doesn't exist yet.
   *
   * @param {string} clip      Filename inside assets/sounds/ (e.g. 'metal_slash.mp3')
   * @param {number} [volume]  0.0 – 1.0
   */
  async playSound(clip = DEFAULT_GESTURE_CLIP, volume = DEFAULT_GESTURE_VOL) {
    try {
      await this.ensureDocument();
      await chrome.runtime.sendMessage({
        target:  'offscreen',   // routing tag read by offscreen.js
        type:    'PLAY_SOUND',
        payload: { clip, volume },
      });
    } catch (err) {
      // Offscreen may have been garbage-collected between gestures — not fatal
      console.warn('[MOUSSY] Offscreen send failed:', err.message);
    }
  },

  /** Tear down the offscreen document (e.g., when sound is disabled). */
  async closeDocument() {
    const exists = await chrome.offscreen.hasDocument();
    if (exists) {
      await chrome.offscreen.closeDocument();
      console.log('[MOUSSY] Offscreen audio document closed.');
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Screenshot Manager
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Captures the visible area of the active tab and triggers a download
 * by injecting a transient <a> element into the page via chrome.scripting.
 *
 * Why chrome.scripting instead of chrome.downloads?
 * ──────────────────────────────────────────────────
 * chrome.downloads requires the "downloads" permission (not currently in
 * the manifest). The scripting injection approach works with permissions
 * we already have: "scripting" + "activeTab" + "host_permissions: <all_urls>".
 *
 * The injected function runs inside the page's context but the dataUrl is
 * passed in as a serialised argument — no cross-origin issues.
 */
const ScreenshotManager = {
  /**
   * @param {chrome.tabs.Tab} tab    The tab to capture
   * @param {number} senderId        Tab ID of the requesting content script
   */
  async capture(tab, senderId) {
    try {
      // captureVisibleTab requires the tab to be active in a normal window
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format:  'png',
        quality: 95,
      });

      const filename = `moussy-screenshot-${Date.now()}.png`;

      // Inject a self-cleaning downloader into the page
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (url, name) => {
          const a    = document.createElement('a');
          a.href     = url;
          a.download = name;
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          // Clean up after the browser has processed the click
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              document.body.removeChild(a);
              // Revoke object URL if one was used (not applicable here but good practice)
              URL.revokeObjectURL(url);
            });
          });
        },
        args: [dataUrl, filename],
      });

      console.log(`[MOUSSY] Screenshot saved: ${filename}`);
      return { success: true, filename };

    } catch (err) {
      console.error('[MOUSSY] Screenshot failed:', err);
      return { success: false, error: err.message };
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Gesture Router
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Maps a cardinal gesture direction to a Chrome tab action.
 * Also fires the offscreen audio feedback if sound is enabled.
 *
 * Action map (default — user-configurable via slot bindings in the future):
 *   LEFT  → history.back()      (navigate back in tab history)
 *   RIGHT → history.forward()   (navigate forward in tab history)
 *   UP    → scroll to top       (convenience scroll gesture)
 *   DOWN  → reload tab          (reload current tab)
 *
 * Custom slot bindings take priority over the defaults above.
 * If a matching slot is found, navigate to that URL instead.
 */
const GestureRouter = {
  /**
   * @param {string}           direction   'UP'|'DOWN'|'LEFT'|'RIGHT'
   * @param {chrome.tabs.Tab}  tab         Active tab that sent the gesture
   */
  async route(direction, tab) {
    console.log(`[MOUSSY] Routing gesture: ${direction} on tab ${tab.id}`);

    // 1. Check custom slot bindings first
    const handled = await this._trySlotBinding(direction, tab);
    if (handled) return;

    // 2. Fall back to built-in directional actions
    await this._builtinAction(direction, tab);
  },

  async _trySlotBinding(direction, tab) {
    const data  = await storageGet(STORAGE_SLOTS);
    const slots = data[STORAGE_SLOTS];
    if (!Array.isArray(slots)) return false;

    const match = slots.find((s) => s?.gesture === direction && s?.url?.trim());
    if (!match) return false;

    console.log(`[MOUSSY] Slot binding hit → ${match.url}`);
    await chrome.tabs.update(tab.id, { url: match.url });
    await this._triggerSound();
    return true;
  },

  async _builtinAction(direction, tab) {
    switch (direction) {
      case Dir.LEFT:
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func:   () => window.history.back(),
        });
        break;

      case Dir.RIGHT:
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func:   () => window.history.forward(),
        });
        break;

      case Dir.UP:
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func:   () => window.scrollTo({ top: 0, behavior: 'smooth' }),
        });
        break;

      case Dir.DOWN:
        await chrome.tabs.reload(tab.id);
        break;

      default:
        console.warn(`[MOUSSY] Unknown gesture direction: ${direction}`);
        return;
    }

    await this._triggerSound();
  },

  async _triggerSound() {
    const data    = await storageGet(STORAGE_SOUND);
    const enabled = data[STORAGE_SOUND] === true;
    if (!enabled) return;

    await OffscreenManager.playSound(DEFAULT_GESTURE_CLIP, DEFAULT_GESTURE_VOL);
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Upgrade Notifier
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Injects a brief neon toast notification into the active page
 * when a free-tier user attempts a premium action.
 *
 * The toast is fully self-contained (style + DOM + auto-remove)
 * and injected via chrome.scripting so it works on any page without
 * the content script needing to pre-define it.
 */
const UpgradeNotifier = {
  async showInTab(tabId) {
    // Resolve the extension URL HERE in background context (where chrome.runtime is available).
    // Injected page functions do NOT have access to chrome.runtime — it would throw.
    const premiumUrl = chrome.runtime.getURL('premium/premium.html');
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        args:   [premiumUrl],
        func: (PREMIUM_URL) => {
          // Avoid duplicate toasts
          if (document.getElementById('__moussy_upgrade_toast__')) return;

          const toast = document.createElement('div');
          toast.id    = '__moussy_upgrade_toast__';

          Object.assign(toast.style, {
            position:       'fixed',
            bottom:         '28px',
            left:           '50%',
            transform:      'translateX(-50%) translateY(20px)',
            zIndex:         '2147483646',
            background:     'linear-gradient(135deg, #0f0f18, #18121e)',
            border:         '1px solid rgba(168,85,247,0.55)',
            borderRadius:   '10px',
            padding:        '14px 20px',
            display:        'flex',
            alignItems:     'center',
            gap:            '14px',
            fontFamily:     "'Inter', system-ui, sans-serif",
            fontSize:       '13px',
            color:          '#e8e8f0',
            boxShadow:      '0 0 40px rgba(168,85,247,0.25), 0 12px 40px rgba(0,0,0,0.7)',
            opacity:        '0',
            transition:     'opacity 0.3s ease, transform 0.3s ease',
            pointerEvents:  'auto',
            maxWidth:       '380px',
            whiteSpace:     'nowrap',
          });

          const lockIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none"
            stroke="#a855f7" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
            style="flex-shrink:0">
            <rect x="3" y="11" width="18" height="11" rx="2"/>
            <path d="M7 11V7a5 5 0 0110 0v4"/>
          </svg>`;

          const link = `<a href="${PREMIUM_URL}" target="_blank"
            style="color:#a855f7;font-weight:600;text-decoration:none;
            letter-spacing:0.3px;border-bottom:1px solid rgba(168,85,247,0.4);
            padding-bottom:1px;white-space:nowrap">
            Upgrade →
          </a>`;

          toast.innerHTML = `
            ${lockIcon}
            <span>
              <strong style="color:#a855f7;letter-spacing:0.5px">PRIME LOCKED</strong>
              &nbsp;— This feature requires a Pro plan.&nbsp;${link}
            </span>`;

          document.body.appendChild(toast);

          // Trigger entrance animation
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              toast.style.opacity   = '1';
              toast.style.transform = 'translateX(-50%) translateY(0)';
            });
          });

          // Auto-remove after 5 seconds
          setTimeout(() => {
            toast.style.opacity   = '0';
            toast.style.transform = 'translateX(-50%) translateY(16px)';
            setTimeout(() => toast.remove(), 350);
          }, 5000);
        },
      });
    } catch (err) {
      console.warn('[MOUSSY] Could not inject upgrade toast:', err.message);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// ── Message Router — Central Dispatcher
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * All messages arriving from content scripts, settings pages, popup, and
 * the offscreen document are funnelled through this single listener.
 *
 * IMPORTANT: Returning `true` from the listener tells Chrome to keep the
 * message channel open for asynchronous sendResponse calls. We use a
 * self-invoking async IIFE inside the handler so we can await freely.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Route offscreen-bound messages (echoed back from background → offscreen)
  // We do NOT process them here — offscreen.js handles its own messages.
  if (message.target === 'offscreen') return false;

  // Dispatch to async handler; return true to signal async sendResponse
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error('[MOUSSY] Message handler error:', err);
      sendResponse({ ok: false, error: err.message });
    });

  return true;  // keep channel open for async response
});

/**
 * Central async message dispatcher.
 * @param {object} message
 * @param {chrome.runtime.MessageSender} sender
 * @returns {Promise<object>}  response object sent back to caller
 */
async function handleMessage(message, sender) {
  const { type, payload } = message;

  switch (type) {

    // ── Gesture from content.js ──────────────────────────────────────────
    case 'GESTURE': {
      const { direction } = payload ?? {};
      if (!direction) return { ok: false, error: 'No direction in payload' };

      const tab = sender.tab ?? await getActiveTab();
      if (!tab) return { ok: false, error: 'No active tab' };

      // Don't gesture-navigate on extension pages
      if (tab.url?.startsWith('chrome-extension://')) {
        return { ok: false, reason: 'Extension page — skipped' };
      }

      // Authoritative pause gate (mirrors content.js PauseState)
      if (await isTabPaused(tab)) {
        return { ok: false, reason: 'PAUSED' };
      }

      await GestureRouter.route(direction, tab);
      return { ok: true, direction };
    }

    // ── Show the upgrade toast (premium-locked radial slot) ──────────────
    case 'SHOW_UPGRADE': {
      const tabId = sender.tab?.id;
      if (tabId) await UpgradeNotifier.showInTab(tabId);
      return { ok: true };
    }

    // ── Radial-dial "Screenshot" slot (Slot 1 free, Slot 2 premium) ───────
    // Premium gating for this already happened client-side (the dial only
    // ever fires this for an unlocked slot), so no plan check here — this is
    // deliberately a different, ungated path from the legacy PREMIUM_SCREENSHOT
    // message below.
    case 'CAPTURE_SCREENSHOT': {
      const tab = sender.tab ?? await getActiveTab();
      if (!tab) return { ok: false, error: 'No active tab' };
      const result = await ScreenshotManager.capture(tab, sender.tab?.id);
      return { ok: result.success, ...result };
    }

    // ── Radial-dial "New Tab" slot ─────────────────────────────────────────
    case 'OPEN_NEW_TAB': {
      await chrome.tabs.create({});
      return { ok: true };
    }

    // ── Premium screenshot request ────────────────────────────────────────
    case 'PREMIUM_SCREENSHOT': {
      const premium = await StateManager.isPremium();

      if (!premium) {
        // Inject upgrade toast into the requesting tab
        const tabId = sender.tab?.id;
        if (tabId) await UpgradeNotifier.showInTab(tabId);
        return { ok: false, reason: 'NOT_PREMIUM' };
      }

      const tab = sender.tab ?? await getActiveTab();
      if (!tab) return { ok: false, error: 'No active tab' };

      const result = await ScreenshotManager.capture(tab, sender.tab?.id);
      return { ok: result.success, ...result };
    }

    // ── Query full extension state (used by settings.js) ─────────────────
    case 'GET_STATE': {
      const state = await StateManager.getFullState();
      return { ok: true, state };
    }

    // ── Set active plan (dev/testing only) ────────────────────────────────
    case 'SET_PLAN': {
      await StateManager.setPlan(payload?.plan);
      const isPremium = await StateManager.isPremium();
      return { ok: true, plan: await StateManager.getPlan(), isPremium };
    }

    // ── Manual sound trigger (e.g. from settings preview button) ─────────
    case 'PLAY_SOUND': {
      const { clip = DEFAULT_GESTURE_CLIP, volume = DEFAULT_GESTURE_VOL } = payload ?? {};
      await OffscreenManager.playSound(clip, volume);
      return { ok: true };
    }

    // ── Close offscreen document ──────────────────────────────────────────
    case 'CLOSE_OFFSCREEN': {
      await OffscreenManager.closeDocument();
      return { ok: true };
    }

    default:
      console.warn('[MOUSSY] Unknown message type:', type);
      return { ok: false, error: `Unknown type: ${type}` };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Install / Update Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════
chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  console.log(`[MOUSSY] onInstalled — reason: ${reason}${previousVersion ? `, prev: ${previousVersion}` : ''}`);

  if (reason === 'install') {
    // ── First install: seed default storage values ─────────────────────
    await storageSet({
      [STORAGE_PLAN]:          'free',   // always starts on free tier
      // 5 radial URL slots (Slot 1..5 → N, NE, SE, SW, NW). Slot 1 seeded so
      // the dial works out of the box; Slots 2-5 are premium-locked until upgrade.
      [STORAGE_SLOTS]:         [
        { url: 'https://www.wikipedia.org' },
        { url: '' }, { url: '' }, { url: '' }, { url: '' },
      ],
      [STORAGE_SOUND]:         false,
      [STORAGE_HUD]:           false,
      [STORAGE_PAUSE_GLOBAL]:  false,
      [STORAGE_PAUSE_HOSTS]:   [],
      [STORAGE_DIAL_SIZE]:     0.82,   // a touch smaller than base
      [STORAGE_DIAL_OPACITY]:  0.55,   // violet/black band mix
      [STORAGE_DIAL_DELAY]:    500,    // hold 0.5s before the dial opens
      [STORAGE_DIAL_COLOR]:    'violet',
      [STORAGE_DIAL_THEME]:    'classic',
      [STORAGE_SOUND_ID]:      'classic',
      [STORAGE_SOUND_CUSTOM]:  null,
      [STORAGE_INSTALL]:       new Date().toISOString(),
    });

    console.log('[MOUSSY] Default storage seeded. plan = free.');

    // Open the settings page on first install so the user sees the UI immediately
    chrome.tabs.create({ url: chrome.runtime.getURL('settings/settings.html') });

  } else if (reason === 'update') {
    // ── Update: migrate storage keys if needed (future-proofing) ──────
    const existing = await storageGet([
      STORAGE_PLAN, STORAGE_PAUSE_GLOBAL, STORAGE_PAUSE_HOSTS, STORAGE_DIAL_SIZE, STORAGE_DIAL_OPACITY,
      STORAGE_DIAL_DELAY, STORAGE_DIAL_COLOR, STORAGE_DIAL_THEME, STORAGE_SOUND_ID, STORAGE_SOUND_CUSTOM,
    ]);
    const seed = {};
    if (existing[STORAGE_PLAN]         === undefined) seed[STORAGE_PLAN]         = 'free';
    if (existing[STORAGE_PAUSE_GLOBAL] === undefined) seed[STORAGE_PAUSE_GLOBAL] = false;
    if (existing[STORAGE_PAUSE_HOSTS]  === undefined) seed[STORAGE_PAUSE_HOSTS]  = [];
    if (existing[STORAGE_DIAL_SIZE]    === undefined) seed[STORAGE_DIAL_SIZE]    = 0.82;
    if (existing[STORAGE_DIAL_OPACITY] === undefined) seed[STORAGE_DIAL_OPACITY] = 0.55;
    if (existing[STORAGE_DIAL_DELAY]   === undefined) seed[STORAGE_DIAL_DELAY]   = 500;
    if (existing[STORAGE_DIAL_COLOR]   === undefined) seed[STORAGE_DIAL_COLOR]   = 'violet';
    if (existing[STORAGE_DIAL_THEME]   === undefined) seed[STORAGE_DIAL_THEME]   = 'classic';
    if (existing[STORAGE_SOUND_ID]     === undefined) seed[STORAGE_SOUND_ID]     = 'classic';
    if (existing[STORAGE_SOUND_CUSTOM] === undefined) seed[STORAGE_SOUND_CUSTOM] = null;
    if (Object.keys(seed).length) await storageSet(seed);
    console.log(`[MOUSSY] Updated from ${previousVersion}. Storage migration complete.`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Service Worker Keepalive (development note)
// ═══════════════════════════════════════════════════════════════════════════════
// MV3 service workers are terminated after ~30s of inactivity.
// The offscreen document keeps the worker alive while audio is active.
// For gesture processing, the onMessage event re-activates the worker instantly
// on each gesture — no persistent keepalive mechanism is needed.

console.log('[MOUSSY] Background control tower online.');
