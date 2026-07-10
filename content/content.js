/**
 * MOUSSY — Radial Dial Engine  (content.js)
 * ===========================================
 * Injected at document_idle into every tab.
 *
 * Interaction model (radial pie / "dial")
 * ───────────────────────────────────────
 *   1. Press + HOLD the right mouse button  → after the configured delay, an
 *      8-wedge dial appears centred on the cursor.
 *   2. Move the mouse outward toward a wedge → that wedge highlights, a sound
 *      fires on each slot change, and the centre shows the wedge's label.
 *   3. RELEASE the button                    → the highlighted wedge's action
 *      fires. Releasing inside the centre dead-zone cancels (no action).
 *
 * Wedge layout (clockwise from top) — IDENTICAL across every design
 * ───────────────────────────────────────────────────────────────────
 *   N  (top)    Slot 1   — URL / Screenshot / New Tab (FREE)
 *   NE          Slot 2   — URL / Screenshot / New Tab (PREMIUM)
 *   E  (right)  Forward  — page history forward    ►
 *   SE          Slot 3   — user URL (PREMIUM)
 *   S  (bottom) Reload   — reload page             ↻
 *   SW          Slot 4   — user URL (PREMIUM)
 *   W  (left)   Back     — page history back       ◄
 *   NW          Slot 5   — user URL (PREMIUM)
 *
 * Multi-design system
 * ─────────────────────
 * The dial has 9 visual "designs" (DESIGN_REGISTRY): Radial Dial (I, free,
 * default, user-customisable Colours & Themes) plus 8 premium reskins
 * (II-IX) with a fixed built-in palette each. ALL designs share the exact
 * same wedge geometry, hit-testing, hold-delay, tether, gating and slot
 * bindings — only the decorative rendering differs. This keeps the
 * interaction layer (MouseController, RadialDialHUD.track/dismiss/selected)
 * completely decoupled from — and untouched by — the visual skin system.
 *
 * Storage (chrome.storage.local)
 * ───────────────────────────────
 *   moussy_gesture_slots   : Array<{url, mode}>  — index 0..4 → Slot 1..5 (SHARED across all designs)
 *                            mode: 'url' | 'screenshot' | 'newtab' (1 & 2 only)
 *   moussy_plan            : 'free'|'monthly'|'legend'  — premium gate
 *   moussy_dial_color      : key into DIAL_COLORS        — free, any pick (design I only)
 *   moussy_dial_theme      : key into DIAL_THEMES         — premium only (design I only)
 *   moussy_sound_id        : key into SOUND_CATALOG       — some premium
 *   moussy_sound_custom    : { dataUrl } trimmed clip      — premium only
 *   moussy_paused_global   : boolean
 *   moussy_paused_hosts    : string[]
 *   moussy_active_design   : key into DESIGN_REGISTRY (which skin is live)
 *   moussy_design_settings : { [designId]: {size,opacity,delay,timezone} } — excludes 'radial'
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ── Constants
// ═══════════════════════════════════════════════════════════════════════════════

const CFG = Object.freeze({
  D:          280,   // SVG box size (px)
  RING_OUT:   120,   // outer ring radius
  RING_IN:    86,    // inner / dead-zone radius — large hole = thin ring band
  ICON_R:     103,   // radius at which wedge icons sit — band-centred: (RING_OUT+RING_IN)/2
  DEAD_ZONE:  64,    // px the cursor must travel before a wedge is selectable

  APPEAR_MS:  150,
  DISMISS_MS: 160,

  HOST_ID:    'moussy-radial-dial',

  ACCENT:        '#a855f7',
  ACCENT_BRIGHT: '#c084fc',

  STORAGE_SLOTS:        'moussy_gesture_slots',
  STORAGE_PLAN:         'moussy_plan',
  STORAGE_PAUSE_GLOBAL: 'moussy_paused_global',
  STORAGE_PAUSE_HOSTS:  'moussy_paused_hosts',
  STORAGE_SIZE:         'moussy_dial_size',      // scale multiplier (~0.5..1.6)
  STORAGE_OPACITY:      'moussy_dial_opacity',   // band fill alpha (0..1)
  STORAGE_DELAY:        'moussy_dial_delay',     // hold-to-open delay (ms)
  STORAGE_COLOR:        'moussy_dial_color',     // key into DIAL_COLORS
  STORAGE_THEME:        'moussy_dial_theme',     // key into DIAL_THEMES
  STORAGE_SOUND_ID:     'moussy_sound_id',       // key into SOUND_CATALOG
  STORAGE_SOUND_CUSTOM: 'moussy_sound_custom',   // { dataUrl }
  STORAGE_ACTIVE_DESIGN:   'moussy_active_design',
  STORAGE_DESIGN_SETTINGS: 'moussy_design_settings',

  DEFAULT_SIZE:         0.82,   // a touch smaller than base
  DEFAULT_OPACITY:      0.55,   // violet/black band mix
  DEFAULT_DELAY:        100,    // ms of right-hold before the dial opens
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Deterministic 0..1 hash-noise for repeatable skin decoration (no jitter). */
function prand(i) { const x = Math.sin(i * 127.1 + 3.7) * 43758.5453; return x - Math.floor(x); }

/** hex "#rrggbb" → "rgba(r,g,b,a)" */
function hexRgba(hex, a) {
  const h = (hex || '#a855f7').replace('#', '');
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Dial colours + themes + sound catalog + design registry
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Colours are cosmetic accent swaps — usable on ANY plan (free included).
 * Themes change the dial's structural rendering (ring/tick/wedge style) and
 * are premium-only; a free account is always forced back to 'classic'.
 * Both ONLY apply to the 'radial' design — every other design has its own
 * fixed built-in palette (see DESIGN_REGISTRY) that is not user-editable.
 */
const DIAL_COLORS = {
  violet:  { name: 'Violet',  accent: '#a855f7', bright: '#c084fc' },
  cyan:    { name: 'Cyan',    accent: '#22d3ee', bright: '#67e8f9' },
  crimson: { name: 'Crimson', accent: '#ef4444', bright: '#f87171' },
  emerald: { name: 'Emerald', accent: '#22c55e', bright: '#4ade80' },
  gold:    { name: 'Gold',    accent: '#f5c542', bright: '#fde68a' },
  magenta: { name: 'Magenta', accent: '#ec4899', bright: '#f9a8d4' },
  amber:   { name: 'Amber',   accent: '#f97316', bright: '#fdba74' },
  azure:   { name: 'Azure',   accent: '#3b82f6', bright: '#93c5fd' },
};
const DEFAULT_COLOR = 'violet';

/**
 * Themes 'occult' and 'aura' add decoration whose colour is intentionally
 * NOT tied to the chosen accent colour (e.g. an always-dark occult overlay),
 * per the design brief — everything else scales with the user's colour pick.
 */
const DIAL_THEME_LIST = ['classic', 'glass', 'hex', 'core', 'occult', 'aura'];
const DEFAULT_THEME = 'classic';

/**
 * Per-slot-change tick sounds. All are synthesised in-browser (no external
 * audio assets, no copyrighted material) — "arcade"/"cyber" are original
 * homages, not the actual game audio they're inspired by.
 */
const SOUND_CATALOG = {
  classic: { name: 'Classic Tick',      premium: false, synth: { type: 'square',   freq: 1550, dur: 0.045, gain: 0.16 } },
  crystal: { name: 'Crystal Chime',     premium: true,  synth: { type: 'triangle', freq: 2200, freq2: 3100, dur: 0.09,  gain: 0.14 } },
  pulse:   { name: 'Deep Pulse',        premium: true,  synth: { type: 'sine',     freq: 220,  dur: 0.07,  gain: 0.24 } },
  laser:   { name: 'Laser Zap',         premium: true,  synth: { type: 'sawtooth', freq: 2400, freqEnd: 600, dur: 0.06, gain: 0.13 } },
  arcade:  { name: 'Retro Arcade Blip', premium: true,  synth: { type: 'square',   freq: 900,  freq2: 1500, dur: 0.055, gain: 0.18 } },
  cyber:   { name: 'Cyber Alert',       premium: true,  synth: { type: 'sawtooth', freq: 1800, freq2: 2700, dur: 0.05, gain: 0.15 } },
  custom:  { name: 'Custom Sound',      premium: true,  custom: true },
};

/**
 * The 9 dial designs. 'radial' (I) is free + default + user-customisable
 * (Colours & Themes). II-IX are premium, each with a fixed built-in palette
 * (deliberately NOT tied to the radial colour picker) and bespoke decoration.
 * 'chrono' is an original energy-core design — NOT a reproduction of any
 * trademarked character/device.
 */
const DESIGN_REGISTRY = [
  { id: 'radial', roman: 'I',    name: 'Radial Dial',     free: true,  clock: false },
  { id: 'ghost',  roman: 'II',   name: 'Ghostly Phantom', free: false, clock: false, palette: { accent: '#8b5cf6', bright: '#d8c8ff' } },
  { id: 'magic',  roman: 'III',  name: 'Enchanted Magic', free: false, clock: false, palette: { accent: '#a855f7', bright: '#f3e5ff' } },
  { id: 'ninja',  roman: 'IV',   name: 'Ninja Shadow',    free: false, clock: false, palette: { accent: '#ef4444', bright: '#ffb4b4' } },
  { id: 'aclock', roman: 'V',    name: 'Analog Clock',    free: false, clock: true,  palette: { accent: '#c4b5fd', bright: '#f6f0ff' } },
  { id: 'dclock', roman: 'VI',   name: 'Digital Clock',   free: false, clock: true,  palette: { accent: '#22d3ee', bright: '#c3f7ff' } },
  { id: 'chrono', roman: 'VII',  name: 'Chrono Core',     free: false, clock: false, palette: { accent: '#4ade80', bright: '#d4ffe4' } },
  { id: 'ice',    roman: 'VIII', name: 'Ice Wraith',      free: false, clock: false, palette: { accent: '#38bdf8', bright: '#eafbff' } },
  { id: 'dragon', roman: 'IX',   name: 'Dragon Inferno',  free: false, clock: false, palette: { accent: '#f97316', bright: '#ffd9a8' } },
];
const DESIGN_MAP = Object.fromEntries(DESIGN_REGISTRY.map((d) => [d.id, d]));
const DESIGN_IDS = DESIGN_REGISTRY.map((d) => d.id);
const DEFAULT_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; }
})();

/** Curated timezone list for the clock designs' picker. */
const TIMEZONES = [
  { id: 'Asia/Kolkata',        label: 'India — Kolkata' },
  { id: 'Asia/Tokyo',          label: 'Japan — Tokyo' },
  { id: 'Asia/Shanghai',       label: 'China — Shanghai' },
  { id: 'Asia/Dubai',          label: 'UAE — Dubai' },
  { id: 'Asia/Singapore',      label: 'Singapore' },
  { id: 'Australia/Sydney',    label: 'Asia Pacific — Sydney' },
  { id: 'Pacific/Auckland',    label: 'New Zealand — Auckland' },
  { id: 'Europe/London',       label: 'UK — London' },
  { id: 'Europe/Paris',        label: 'Europe — Paris' },
  { id: 'America/New_York',    label: 'US East — New York' },
  { id: 'America/Chicago',     label: 'US Central — Chicago' },
  { id: 'America/Los_Angeles', label: 'US West — Los Angeles' },
  { id: 'UTC',                 label: 'UTC' },
];

/** Read the current time in a given IANA timezone, with a safe fallback. */
function getTZTime(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', day: '2-digit', month: 'short',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return {
      h: parseInt(get('hour'), 10) % 24 || 0,
      m: parseInt(get('minute'), 10) || 0,
      s: parseInt(get('second'), 10) || 0,
      weekday: get('weekday') || '', day: get('day') || '', month: get('month') || '',
    };
  } catch (_) {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), weekday: '', day: String(d.getDate()).padStart(2, '0'), month: d.toLocaleString('en-US', { month: 'short' }) };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Caches (slots + premium + pause + appearance + sound + design), primed from storage
// ═══════════════════════════════════════════════════════════════════════════════

const Store = (() => {
  let _slots = [];        // [{url, mode}] index 0..4 — SHARED across all designs
  let _plan  = 'free';
  let _pauseGlobal = false;
  let _pauseHosts  = [];
  let _size    = CFG.DEFAULT_SIZE;
  let _opacity = CFG.DEFAULT_OPACITY;
  let _delay   = CFG.DEFAULT_DELAY;
  let _color   = DEFAULT_COLOR;
  let _theme   = DEFAULT_THEME;
  let _soundId = 'classic';
  let _soundCustomUrl = '';
  let _activeDesign = 'radial';
  let _designSettings = {};   // { [designId]: {size,opacity,delay,timezone} } — excludes 'radial'
  const _host = (() => { try { return location.hostname; } catch { return ''; } })();

  (async () => {
    try {
      const d = await chrome.storage.local.get([
        CFG.STORAGE_SLOTS, CFG.STORAGE_PLAN, CFG.STORAGE_PAUSE_GLOBAL, CFG.STORAGE_PAUSE_HOSTS,
        CFG.STORAGE_SIZE, CFG.STORAGE_OPACITY, CFG.STORAGE_DELAY,
        CFG.STORAGE_COLOR, CFG.STORAGE_THEME, CFG.STORAGE_SOUND_ID, CFG.STORAGE_SOUND_CUSTOM,
        CFG.STORAGE_ACTIVE_DESIGN, CFG.STORAGE_DESIGN_SETTINGS,
      ]);
      setSlots(d[CFG.STORAGE_SLOTS]);
      _plan        = d[CFG.STORAGE_PLAN] ?? 'free';
      _pauseGlobal = d[CFG.STORAGE_PAUSE_GLOBAL] === true;
      _pauseHosts  = Array.isArray(d[CFG.STORAGE_PAUSE_HOSTS]) ? d[CFG.STORAGE_PAUSE_HOSTS] : [];
      if (typeof d[CFG.STORAGE_SIZE]    === 'number') _size    = d[CFG.STORAGE_SIZE];
      if (typeof d[CFG.STORAGE_OPACITY] === 'number') _opacity = d[CFG.STORAGE_OPACITY];
      if (typeof d[CFG.STORAGE_DELAY]   === 'number') _delay   = d[CFG.STORAGE_DELAY];
      if (typeof d[CFG.STORAGE_COLOR] === 'string' && DIAL_COLORS[d[CFG.STORAGE_COLOR]]) _color = d[CFG.STORAGE_COLOR];
      if (typeof d[CFG.STORAGE_THEME] === 'string' && DIAL_THEME_LIST.includes(d[CFG.STORAGE_THEME])) _theme = d[CFG.STORAGE_THEME];
      if (typeof d[CFG.STORAGE_SOUND_ID] === 'string' && SOUND_CATALOG[d[CFG.STORAGE_SOUND_ID]]) _soundId = d[CFG.STORAGE_SOUND_ID];
      const sc = d[CFG.STORAGE_SOUND_CUSTOM];
      if (sc && typeof sc === 'object' && typeof sc.dataUrl === 'string') _soundCustomUrl = sc.dataUrl;
      if (typeof d[CFG.STORAGE_ACTIVE_DESIGN] === 'string' && DESIGN_IDS.includes(d[CFG.STORAGE_ACTIVE_DESIGN])) _activeDesign = d[CFG.STORAGE_ACTIVE_DESIGN];
      if (d[CFG.STORAGE_DESIGN_SETTINGS] && typeof d[CFG.STORAGE_DESIGN_SETTINGS] === 'object') _designSettings = d[CFG.STORAGE_DESIGN_SETTINGS];
    } catch (_) { /* chrome:// or invalidated context */ }
  })();

  function setSlots(raw) {
    if (!Array.isArray(raw)) { _slots = []; return; }
    _slots = raw.map((s) => {
      if (typeof s === 'string') return { url: s.trim(), mode: 'url' };
      const url  = ((s && s.url) || '').trim();
      const mode = (s && (s.mode === 'screenshot' || s.mode === 'newtab')) ? s.mode : 'url';
      return { url, mode };
    });
  }

  return {
    slot(i)        { return _slots[i] || { url: '', mode: 'url' }; },
    isPremium()    { return _plan === 'monthly' || _plan === 'legend'; },
    isPaused()     { return _pauseGlobal || _pauseHosts.includes(_host); },
    dialSize()     { return clamp(_size, 0.5, 1.6); },
    dialOpacity()  { return clamp(_opacity, 0, 1); },
    dialDelay()    { return clamp(_delay, 0, 3000); },
    /** Colour is free-tier — any account may pick any swatch. Design I only. */
    dialColor()    { return DIAL_COLORS[_color] || DIAL_COLORS[DEFAULT_COLOR]; },
    /** Theme is premium-only — forced back to classic on a free account. Design I only. */
    dialTheme()    { return this.isPremium() ? _theme : DEFAULT_THEME; },
    soundId()      { return _soundId; },
    soundCustomUrl() { return _soundCustomUrl; },

    /** Which design actually renders — 'radial' unless premium AND a valid non-radial id is stored. */
    activeDesign() {
      if (_activeDesign === 'radial') return 'radial';
      if (!this.isPremium()) return 'radial';
      return DESIGN_IDS.includes(_activeDesign) ? _activeDesign : 'radial';
    },
    /** Per-design settings (size/opacity/delay/timezone). 'radial' uses the legacy flat keys above. */
    designSettingsFor(id) {
      if (id === 'radial' || !DESIGN_MAP[id]) {
        return { size: this.dialSize(), opacity: this.dialOpacity(), delay: this.dialDelay(), timezone: DEFAULT_TIMEZONE };
      }
      const s = _designSettings[id] || {};
      return {
        size:     typeof s.size === 'number'    ? clamp(s.size, 0.5, 1.6) : CFG.DEFAULT_SIZE,
        opacity:  typeof s.opacity === 'number' ? clamp(s.opacity, 0, 1)  : CFG.DEFAULT_OPACITY,
        delay:    typeof s.delay === 'number'   ? clamp(s.delay, 0, 3000) : CFG.DEFAULT_DELAY,
        timezone: (typeof s.timezone === 'string' && s.timezone) ? s.timezone : DEFAULT_TIMEZONE,
        numerals: s.numerals === 'english' ? 'english' : 'roman',
      };
    },

    _onChange(changes) {
      if (CFG.STORAGE_SLOTS in changes)        setSlots(changes[CFG.STORAGE_SLOTS].newValue);
      if (CFG.STORAGE_PLAN in changes)         _plan = changes[CFG.STORAGE_PLAN].newValue ?? 'free';
      if (CFG.STORAGE_PAUSE_GLOBAL in changes) _pauseGlobal = changes[CFG.STORAGE_PAUSE_GLOBAL].newValue === true;
      if (CFG.STORAGE_PAUSE_HOSTS in changes)  _pauseHosts = Array.isArray(changes[CFG.STORAGE_PAUSE_HOSTS].newValue) ? changes[CFG.STORAGE_PAUSE_HOSTS].newValue : [];
      if (CFG.STORAGE_SIZE in changes    && typeof changes[CFG.STORAGE_SIZE].newValue === 'number')    _size = changes[CFG.STORAGE_SIZE].newValue;
      if (CFG.STORAGE_OPACITY in changes && typeof changes[CFG.STORAGE_OPACITY].newValue === 'number') _opacity = changes[CFG.STORAGE_OPACITY].newValue;
      if (CFG.STORAGE_DELAY in changes   && typeof changes[CFG.STORAGE_DELAY].newValue === 'number')   _delay = changes[CFG.STORAGE_DELAY].newValue;
      if (CFG.STORAGE_COLOR in changes && DIAL_COLORS[changes[CFG.STORAGE_COLOR].newValue]) _color = changes[CFG.STORAGE_COLOR].newValue;
      if (CFG.STORAGE_THEME in changes && DIAL_THEME_LIST.includes(changes[CFG.STORAGE_THEME].newValue)) _theme = changes[CFG.STORAGE_THEME].newValue;
      if (CFG.STORAGE_SOUND_ID in changes && SOUND_CATALOG[changes[CFG.STORAGE_SOUND_ID].newValue]) _soundId = changes[CFG.STORAGE_SOUND_ID].newValue;
      if (CFG.STORAGE_SOUND_CUSTOM in changes) {
        const v = changes[CFG.STORAGE_SOUND_CUSTOM].newValue;
        _soundCustomUrl = (v && typeof v.dataUrl === 'string') ? v.dataUrl : '';
      }
      if (CFG.STORAGE_ACTIVE_DESIGN in changes && DESIGN_IDS.includes(changes[CFG.STORAGE_ACTIVE_DESIGN].newValue)) {
        _activeDesign = changes[CFG.STORAGE_ACTIVE_DESIGN].newValue;
      }
      if (CFG.STORAGE_DESIGN_SETTINGS in changes) {
        const v = changes[CFG.STORAGE_DESIGN_SETTINGS].newValue;
        _designSettings = (v && typeof v === 'object') ? v : {};
      }
    },
  };
})();

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') Store._onChange(changes);
  });
} catch (_) { /* chrome:// pages */ }

// ═══════════════════════════════════════════════════════════════════════════════
// ── Wedge model
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Build the 8 wedge descriptors in clockwise order starting at North.
 * Slot 1 (N) and Slot 2 (NE) may be bound to a URL, a Screenshot action, or a
 * New Tab action; Slots 3-5 are always URL wedges. Identical for every design
 * — slot bindings are shared, not per-design.
 * @returns {Array<object>}
 */
function buildWedges() {
  const premium = Store.isPremium();

  const slotWedge = (slotNo, sIdx) => {
    const { url, mode } = Store.slot(sIdx);
    const locked = slotNo >= 2 && !premium;   // Slots 2..5 require premium

    if (!locked && mode === 'screenshot') return { kind: 'screenshot', slotNo, locked: false, label: 'Screenshot' };
    if (!locked && mode === 'newtab')     return { kind: 'newtab',     slotNo, locked: false, label: 'New Tab'    };

    const host = hostOf(url);
    return {
      kind: 'url', slotNo, url, host, locked,
      label: locked ? `Slot ${slotNo} 🔒` : (host || `Slot ${slotNo}`),
    };
  };

  // clockwise from North
  return [
    slotWedge(1, 0),                                     // N
    slotWedge(2, 1),                                     // NE
    { kind: 'nav', action: 'forward', label: 'Forward' }, // E
    slotWedge(3, 2),                                     // SE
    { kind: 'nav', action: 'reload',  label: 'Reload'  }, // S
    slotWedge(4, 3),                                     // SW
    { kind: 'nav', action: 'back',    label: 'Back'    }, // W
    slotWedge(5, 4),                                     // NW
  ];
}

function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Ticker — per-slot selection sound (synthesised catalog + custom clip)
// ═══════════════════════════════════════════════════════════════════════════════
class Ticker {
  constructor() {
    this._ctx = null;
    this._customBuffer = null;
    this._loadedFor = '';
  }

  _ensure() {
    if (!this._ctx) {
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { this._ctx = null; }
    }
    if (this._ctx && this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  }

  /** Fixed-tone blip — used for the dial open / action-fire cues. */
  tick(freq = 1500, gain = 0.16, dur = 0.045) {
    this._playRecipe({ type: 'square', freq, gain, dur });
  }

  _playRecipe(r) {
    this._ensure();
    if (!this._ctx) return;
    const ctx = this._ctx, t = ctx.currentTime, dur = r.dur ?? 0.05;
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = r.type || 'square';
    osc.frequency.setValueAtTime(r.freq, t);
    if (r.freq2 != null)   osc.frequency.linearRampToValueAtTime(r.freq2, t + dur * 0.6);
    if (r.freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(40, r.freqEnd), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(r.gain ?? 0.16, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
  }

  /** Lazily decode + cache a custom base64 clip. Fire-and-forget. */
  async loadCustom(dataUrl) {
    if (!dataUrl || this._loadedFor === dataUrl) return;
    this._ensure();
    if (!this._ctx) return;
    try {
      const res = await fetch(dataUrl);
      const buf = await res.arrayBuffer();
      this._customBuffer = await this._ctx.decodeAudioData(buf);
      this._loadedFor = dataUrl;
    } catch (_) { this._customBuffer = null; }
  }

  _playCustom() {
    if (!this._ctx || !this._customBuffer) return;
    const src = this._ctx.createBufferSource();
    const g   = this._ctx.createGain();
    src.buffer   = this._customBuffer;
    g.gain.value = 0.6;
    src.connect(g).connect(this._ctx.destination);
    src.start(0);
  }

  /**
   * Play the user's configured per-slot-change sound.
   * Falls back to the classic tick if the chosen sound is premium-gated and
   * the account isn't premium (defence in depth — settings already enforces this).
   */
  playSelected(soundId, customUrl, isPremium) {
    let entry = SOUND_CATALOG[soundId] || SOUND_CATALOG.classic;
    if (entry.premium && !isPremium) entry = SOUND_CATALOG.classic;
    if (entry.custom) {
      if (!this._customBuffer) { this.loadCustom(customUrl); return; }
      this._playCustom();
      return;
    }
    this._playRecipe(entry.synth);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── RadialDialHUD — the on-screen dial
// ═══════════════════════════════════════════════════════════════════════════════
class RadialDialHUD {
  constructor() {
    this._host    = null;
    this._shadow  = null;
    this._wedges  = [];      // descriptors
    this._wedgeEls = [];     // <path> per wedge
    this._labelEl = null;    // centre <text>
    this._active  = -1;      // active wedge index, -1 = none
    this._dismissTimer = null;
    this._clockInterval = null;
    this._design = 'radial';
    this._color = DIAL_COLORS[DEFAULT_COLOR];
    this._theme = DEFAULT_THEME;
  }

  get isOpen() { return !!this._host; }

  /** Effective dead-zone radius in screen px (scales with dial size). */
  deadZone() { return this.dim ? this.dim.dead : CFG.DEAD_ZONE; }

  /**
   * Spawn the dial centred at viewport (cx, cy).
   * @param {object} [opts]  { scale, bandAlpha, color, theme, design, timezone }
   */
  spawn(cx, cy, wedges, opts = {}) {
    this._hardRemove();
    this._wedges = wedges;
    this._active = -1;
    this._design = DESIGN_IDS.includes(opts.design) ? opts.design : 'radial';

    if (this._design === 'radial') {
      // Design I: fully user-customisable colour + theme.
      this._color = opts.color || DIAL_COLORS[DEFAULT_COLOR];
      this._theme = DIAL_THEME_LIST.includes(opts.theme) ? opts.theme : DEFAULT_THEME;
    } else {
      // Designs II-IX: fixed built-in identity — NOT tied to the user's colour pick.
      this._color = DESIGN_MAP[this._design].palette;
      this._theme = DEFAULT_THEME; // unused outside 'radial'
    }
    this._timezone = opts.timezone || DEFAULT_TIMEZONE;
    this._numerals = opts.numerals === 'english' ? 'english' : 'roman';

    const s = clamp(opts.scale ?? 1, 0.5, 1.6);
    this._bandAlpha = clamp(opts.bandAlpha ?? CFG.DEFAULT_OPACITY, 0, 1);
    const D = Math.round(CFG.D * s);
    this.dim = {
      s, D, c: D / 2,
      RO:   CFG.RING_OUT * s,
      RI:   CFG.RING_IN  * s,
      ICON: CFG.ICON_R   * s,
      dead: CFG.DEAD_ZONE * s,
    };

    const host = document.createElement('div');
    host.id = CFG.HOST_ID;
    Object.assign(host.style, {
      position: 'fixed', zIndex: '2147483647', pointerEvents: 'none',
      width: `${D}px`, height: `${D}px`,
      left: `${cx - D / 2}px`, top: `${cy - D / 2}px`,
      opacity: '0', transform: 'scale(0.7)',
      transition: `opacity ${CFG.APPEAR_MS}ms cubic-bezier(0.22,1,0.36,1), transform ${CFG.APPEAR_MS}ms cubic-bezier(0.22,1,0.36,1)`,
      willChange: 'opacity, transform',
    });

    const shadow = host.attachShadow({ mode: 'closed' });
    this._shadow = shadow;

    if (this._design === 'radial') {
      shadow.appendChild(this._style());
      shadow.appendChild(this._buildSVG());
    } else {
      shadow.appendChild(this._skinStyle());
      shadow.appendChild(this._buildSkinSVG(this._design));
    }
    this._buildIcons(shadow);

    if (DESIGN_MAP[this._design]?.clock) this._startClock(this._design, this._timezone);

    document.documentElement.appendChild(host);
    this._host = host;

    requestAnimationFrame(() => requestAnimationFrame(() => {
      host.style.opacity = '1';
      host.style.transform = 'scale(1)';
    }));
  }

  /** Update selection from cursor displacement relative to spawn centre. */
  track(dx, dy) {
    if (!this._host) return false;   // returns true if selection CHANGED
    const dist = Math.hypot(dx, dy);

    // radius tether always follows the cursor
    this._setTether(dx, dy, dist);

    let idx = -1;
    if (dist >= this.dim.dead) {
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;   // -180..180, 0 = right
      idx = (Math.round((ang + 90) / 45) % 8 + 8) % 8;  // 0 = North, clockwise
    }
    if (idx === this._active) return false;

    this._active = idx;
    this._wedgeEls.forEach((el, i) => el.classList.toggle('active', i === idx));
    this._setLabel(idx >= 0 ? this._wedges[idx].label : '');
    return true;
  }

  /** Draw the radius line from centre toward the cursor (capped to the ring). */
  _setTether(dx, dy, dist) {
    if (!this._tetherEl) return;
    const { c, RO } = this.dim;
    if (dist < 5) { this._tetherEl.style.opacity = '0'; this._tetherDot.style.opacity = '0'; return; }
    const max = RO * 1.12;
    const k = dist > max ? max / dist : 1;
    const x = c + dx * k, y = c + dy * k;
    this._tetherEl.setAttribute('x2', x); this._tetherEl.setAttribute('y2', y);
    this._tetherDot.setAttribute('cx', x); this._tetherDot.setAttribute('cy', y);
    this._tetherEl.style.opacity = '1';
    this._tetherDot.style.opacity = '1';
  }

  /** @returns {object|null} the wedge under the cursor at release, or null. */
  selected() {
    return this._active >= 0 ? this._wedges[this._active] : null;
  }

  dismiss() {
    if (!this._host) return;
    const host = this._host;
    // Stop any live clock ticking immediately — no reason to keep updating
    // hand rotations / digital text on an element that's about to be removed,
    // and leaving it running would leak an interval until the next spawn().
    if (this._clockInterval) { clearInterval(this._clockInterval); this._clockInterval = null; }
    host.style.transition = `opacity ${CFG.DISMISS_MS}ms ease, transform ${CFG.DISMISS_MS}ms ease`;
    host.style.opacity = '0';
    host.style.transform = 'scale(1.12)';
    this._host = null;
    this._dismissTimer = setTimeout(() => host.remove(), CFG.DISMISS_MS + 40);
  }

  /** Remove the dial immediately, no fade — used before a screenshot capture. */
  instantHide() { this._hardRemove(); }

  // ── internals ──────────────────────────────────────────────────────────────

  _hardRemove() {
    if (this._dismissTimer) clearTimeout(this._dismissTimer);
    if (this._clockInterval) { clearInterval(this._clockInterval); this._clockInterval = null; }
    document.getElementById(CFG.HOST_ID)?.remove();
    const stray = this._host; if (stray && stray.parentNode) stray.remove();
    this._host = this._shadow = this._labelEl = null;
    this._tetherEl = this._tetherDot = null;
    this._clockHands = this._clockDigital = null;
    this._wedgeEls = [];
    this._active = -1;
  }

  _style() {
    const { accent, bright } = this._color;
    const th = this._theme;
    const rgba = (hex, a) => hexRgba(hex, a);

    const ringMainW    = th === 'core' ? 4 : (th === 'glass' ? 1 : 2);
    const showRingIn   = th !== 'core';
    const dividerW     = th === 'core' ? 2 : (th === 'hex' ? 1.4 : (th === 'glass' ? 0.6 : 1));
    const dividerA     = th === 'core' ? 0.45 : (th === 'hex' ? 0.35 : (th === 'glass' ? 0.12 : 0.20));
    const wedgeStrokeA = th === 'glass' ? 0.10 : 0.20;

    const s = document.createElement('style');
    s.textContent = `
      svg { position:absolute; inset:0; overflow:visible; }
      .wedge { fill: url(#mwFill); stroke: ${rgba(accent, wedgeStrokeA)}; stroke-width:1; transition: fill .12s ease; }
      .wedge.active { fill: url(#mwActive); stroke: ${bright}; stroke-width:1; filter: url(#mwGlowStrong); }
      .ring-main  { fill:none; stroke: ${rgba(bright, 0.95)}; stroke-width:${ringMainW}; filter: url(#mwGlow); }
      .ring-inner { fill:none; stroke: ${rgba(accent, 0.55)}; stroke-width:1.4; filter: url(#mwGlow); display:${showRingIn ? '' : 'none'}; }
      .ring-dash  { fill:none; stroke: ${rgba(accent, 0.30)}; stroke-width:1; stroke-dasharray:2 7; display:${th === 'classic' ? '' : 'none'}; }
      .tick    { stroke: ${rgba(accent, 0.4)}; fill: ${rgba(accent, 0.4)}; stroke-width:1; stroke-linecap:round; }
      .divider { stroke: ${rgba(accent, dividerA)}; stroke-width:${dividerW}; }
      .reticle      { stroke: ${rgba(bright, 0.85)}; stroke-width:1.2; stroke-linecap:round; }
      .reticle-ring { fill:none; stroke: ${rgba(accent, 0.30)}; stroke-width:1; }
      .reticle-dot  { fill:${bright}; filter:url(#mwGlow); }
      .tether       { stroke: ${rgba(bright, 0.9)}; stroke-width:2; stroke-linecap:round; filter:url(#mwGlow); opacity:0; transition:opacity .08s ease; }
      .tether-dot   { fill:#f4ecff; filter:url(#mwGlow); opacity:0; transition:opacity .08s ease; }
      .centre-label { fill:#f4ecff; stroke:rgba(6,4,12,0.92); stroke-width:3.5; paint-order:stroke;
                      font:700 15px 'Segoe UI',system-ui,sans-serif; text-anchor:middle; letter-spacing:.4px; }
      .nav-glyph { fill:none; stroke:${bright}; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; filter:url(#mwGlow); }
      /* Box sized to clear the ring band at EVERY wedge angle. Worst case is a
         diagonal wedge (NE/SE/SW/NW), where an axis-aligned square box's corner
         reaches ICON_R + 0.7071*L from centre (L = box side) — not L/2 — so L
         must stay comfortably under (bandHalfWidth / 0.7071) with margin. */
      .ico { position:absolute; width:18px; height:18px; transform:translate(-50%,-50%); display:grid; place-items:center; pointer-events:none; }
      .ico img { width:14px; height:14px; border-radius:4px; display:block; box-shadow:0 0 6px ${rgba(accent,0.45)}; background:rgba(10,8,16,0.6); }
      .ico .ph { font:600 7px 'Segoe UI',sans-serif; color:${bright}; text-align:center; line-height:1.05; letter-spacing:.2px; text-shadow:0 0 6px ${rgba(accent,0.6)}; }
      .ico .letter { width:14px; height:14px; border-radius:4px; background:${rgba(accent,0.20)}; border:1px solid ${rgba(bright,0.6)}; color:#f0e6ff; font:700 9px 'Segoe UI',sans-serif; display:grid; place-items:center; box-shadow:0 0 6px ${rgba(accent,0.4)}; }
      .ico .glyph-box { width:14px; height:14px; border-radius:4px; background:${rgba(accent,0.18)}; border:1px solid ${rgba(bright,0.6)}; display:grid; place-items:center; box-shadow:0 0 6px ${rgba(accent,0.4)}; }
      .ico .glyph-box svg { width:8px; height:8px; }
      .ico .lock { position:absolute; right:-1px; bottom:-1px; width:7px; height:7px; filter:drop-shadow(0 0 2px rgba(0,0,0,0.7)); }
    `;
    return s;
  }

  _buildSVG() {
    const { D, c, RO, RI, ICON, s } = this.dim;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${D} ${D}`);
    svg.setAttribute('width', D); svg.setAttribute('height', D);

    const el = (tag, attrs, cls) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (cls) n.setAttribute('class', cls);
      return n;
    };
    const rad = (a) => a * Math.PI / 180;
    const bandAlpha = this._bandAlpha;
    const th = this._theme;
    const { accent, bright } = this._color;

    // ── defs: glow filters + theme-shaped wedge gradients ─────────────────
    const defs = el('defs', {});
    let fill0, fill1;
    if (th === 'glass') {
      fill0 = `rgba(255,255,255,${Math.min(0.16, bandAlpha * 0.5)})`;
      fill1 = hexRgba(accent, bandAlpha * 0.30);
    } else if (th === 'hex') {
      fill0 = hexRgba(accent, bandAlpha * 0.78);
      fill1 = hexRgba(accent, bandAlpha * 0.50);
    } else if (th === 'core') {
      fill0 = hexRgba(accent, Math.min(1, bandAlpha + 0.18));
      fill1 = hexRgba(bright, Math.min(1, bandAlpha + 0.05));
    } else if (th === 'occult' || th === 'aura') {
      // Handled by extra overlay layers below; base band stays like classic.
      fill0 = hexRgba(accent, bandAlpha * 0.55);
      fill1 = `rgba(11,7,20,${bandAlpha})`;
    } else { // classic
      fill0 = hexRgba(accent, bandAlpha * 0.55);
      fill1 = `rgba(11,7,20,${bandAlpha})`;
    }
    defs.innerHTML = `
      <filter id="mwGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="mwGlowStrong" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="mwFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${fill0}"/><stop offset="100%" stop-color="${fill1}"/>
      </linearGradient>
      <linearGradient id="mwActive" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${hexRgba(accent, Math.max(0.5, bandAlpha))}"/><stop offset="100%" stop-color="${hexRgba(bright, Math.max(0.55, bandAlpha))}"/>
      </linearGradient>`;
    svg.appendChild(defs);

    // ── outer decoration + tick marks (theme-dependent) ────────────────────
    if (th === 'classic') {
      svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 8 * s }, 'ring-dash'));
      for (let i = 0; i < 24; i++) {
        const ang = rad(i * 15);
        const r0 = RO + 2 * s, r1 = RO + (i % 2 ? 5 : 8) * s;
        svg.appendChild(el('line', {
          x1: c + r0 * Math.cos(ang), y1: c + r0 * Math.sin(ang),
          x2: c + r1 * Math.cos(ang), y2: c + r1 * Math.sin(ang),
        }, 'tick'));
      }
    } else if (th === 'hex') {
      // circuit-trace ticks at each wedge boundary
      for (let i = 0; i < 8; i++) {
        const ang = rad(-67.5 + i * 45);
        const r0 = RO + 2 * s, r1 = RO + 9 * s;
        const x0 = c + r0 * Math.cos(ang), y0 = c + r0 * Math.sin(ang);
        const x1 = c + r1 * Math.cos(ang), y1 = c + r1 * Math.sin(ang);
        svg.appendChild(el('line', { x1: x0, y1: y0, x2: x1, y2: y1 }, 'tick'));
        svg.appendChild(el('circle', { cx: x1, cy: y1, r: 1.4 * s }, 'tick'));
      }
    } else if (th === 'core') {
      // blocky tick marks at the 8 wedge centres
      for (let i = 0; i < 8; i++) {
        const ang = rad(-90 + i * 45);
        const r0 = RO + 3 * s;
        const x = c + r0 * Math.cos(ang), y = c + r0 * Math.sin(ang);
        const box = 3.4 * s;
        svg.appendChild(el('rect', {
          x: x - box / 2, y: y - box / 2, width: box, height: box,
          transform: `rotate(${45 + i * 45} ${x} ${y})`,
        }, 'tick'));
      }
    } else if (th === 'occult') {
      // Black magic-circle overlay — deliberately dark/monochrome, NOT tied to accent colour.
      svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 7 * s, fill: 'none', stroke: 'rgba(10,8,16,0.85)', 'stroke-width': 3 * s }));
      svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 7 * s, fill: 'none', stroke: hexRgba(accent, 0.5), 'stroke-width': 0.8 * s, 'stroke-dasharray': '1 5' }));
      // hexagram inscribed just outside the wedge ring
      const R2 = RO + 15 * s;
      const pts1 = [0, 120, 240].map((o) => { const a = rad(-90 + o); return `${c + R2 * Math.cos(a)},${c + R2 * Math.sin(a)}`; }).join(' ');
      const pts2 = [60, 180, 300].map((o) => { const a = rad(-90 + o); return `${c + R2 * Math.cos(a)},${c + R2 * Math.sin(a)}`; }).join(' ');
      svg.appendChild(el('polygon', { points: pts1, fill: 'none', stroke: 'rgba(20,16,28,0.7)', 'stroke-width': 1 * s }));
      svg.appendChild(el('polygon', { points: pts2, fill: 'none', stroke: 'rgba(20,16,28,0.7)', 'stroke-width': 1 * s }));
    } else if (th === 'aura') {
      // Small thin enchantment ring drawn OUTSIDE the main ring, all around.
      const R3 = RO + 16 * s;
      svg.appendChild(el('circle', { cx: c, cy: c, r: R3, fill: 'none', stroke: hexRgba(accent, 0.35), 'stroke-width': 0.7 * s, 'stroke-dasharray': '3 4' }));
      for (let i = 0; i < 16; i++) {
        const ang = rad(i * 22.5);
        const x = c + R3 * Math.cos(ang), y = c + R3 * Math.sin(ang);
        svg.appendChild(el('circle', { cx: x, cy: y, r: 1.1 * s, fill: hexRgba(bright, 0.55) }));
      }
    }
    // 'glass' theme intentionally has no outer decoration/ticks (minimal look)

    // ── 8 wedges — 'hex' uses straight faceted edges, others use arcs ──────
    this._wedgeEls = [];
    const straight = th === 'hex';
    for (let i = 0; i < 8; i++) {
      const centre = -90 + i * 45;
      const path = el('path', { d: this._wedgePath(c, RO, RI, centre - 22.5, centre + 22.5, straight) }, 'wedge');
      svg.appendChild(path);
      this._wedgeEls.push(path);
    }

    // ── dividers between wedges ───────────────────────────────────────────
    for (let i = 0; i < 8; i++) {
      const ang = rad(-67.5 + i * 45);
      svg.appendChild(el('line', {
        x1: c + RI * Math.cos(ang), y1: c + RI * Math.sin(ang),
        x2: c + RO * Math.cos(ang), y2: c + RO * Math.sin(ang),
      }, 'divider'));
    }

    // ── rings (transparent centre hole) ───────────────────────────────────
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO }, 'ring-main'));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI }, 'ring-inner'));

    // ── cursor tether (radius line from centre → cursor) ──────────────────
    this._tetherEl  = el('line',   { x1: c, y1: c, x2: c, y2: c }, 'tether');
    this._tetherDot = el('circle', { cx: c, cy: c, r: 3.2 * s },   'tether-dot');
    svg.appendChild(this._tetherEl);
    svg.appendChild(this._tetherDot);

    // ── nav glyphs (E forward, S reload, W back) ──────────────────────────
    this._navGlyph(svg, el, c, ICON, s, 0,   'forward');
    this._navGlyph(svg, el, c, ICON, s, 90,  'reload');
    this._navGlyph(svg, el, c, ICON, s, 180, 'back');

    // ── centre reticle (scaled, keeps the hole see-through) ───────────────
    svg.appendChild(el('circle', { cx: c, cy: c, r: 11 * s }, 'reticle-ring'));
    for (const [x1, y1, x2, y2] of [[-9,0,-5,0],[5,0,9,0],[0,-9,0,-5],[0,5,0,9]]) {
      svg.appendChild(el('line', { x1: c+x1*s, y1: c+y1*s, x2: c+x2*s, y2: c+y2*s }, 'reticle'));
    }
    svg.appendChild(el('circle', { cx: c, cy: c, r: 2.4 * s }, 'reticle-dot'));

    // ── centre label (outlined text, readable over the page) ──────────────
    this._labelEl = el('text', { x: c, y: c - 26 * s }, 'centre-label');
    this._labelEl.textContent = '';
    svg.appendChild(this._labelEl);

    return svg;
  }

  /** Donut wedge path between two angles (degrees) at radii RO/RI. */
  _wedgePath(c, RO, RI, a0, a1, straight) {
    const rad = (a) => a * Math.PI / 180;
    const p = (r, a) => [c + r * Math.cos(rad(a)), c + r * Math.sin(rad(a))];
    const [ox0, oy0] = p(RO, a0), [ox1, oy1] = p(RO, a1);
    const [ix1, iy1] = p(RI, a1), [ix0, iy0] = p(RI, a0);
    const outerSeg = straight ? `L ${ox1} ${oy1}` : `A ${RO} ${RO} 0 0 1 ${ox1} ${oy1}`;
    const innerSeg = straight ? `L ${ix0} ${iy0}` : `A ${RI} ${RI} 0 0 0 ${ix0} ${iy0}`;
    return `M ${ox0} ${oy0} ${outerSeg} L ${ix1} ${iy1} ${innerSeg} Z`;
  }

  _navGlyph(svg, el, c, ICON, s, angDeg, kind) {
    const rad = angDeg * Math.PI / 180;
    const x = c + ICON * Math.cos(rad);
    const y = c + ICON * Math.sin(rad);
    const g = el('g', { transform: `translate(${x} ${y}) scale(${s})` });
    if (kind === 'forward') {
      g.appendChild(el('path', { d: 'M-8 0 H4 M4 -4.5 L8.5 0 L4 4.5' }, 'nav-glyph'));
    } else if (kind === 'back') {
      g.appendChild(el('path', { d: 'M8 0 H-4 M-4 -4.5 L-8.5 0 L-4 4.5' }, 'nav-glyph'));
    } else { // reload — circular arrow with a clean arrowhead
      g.appendChild(el('path', { d: 'M6.5 -2.5 A7 7 0 1 1 3 -6.3' }, 'nav-glyph'));
      g.appendChild(el('path', { d: 'M6.6 -6.6 L6.9 -1.6 L2 -3.4 Z', fill: this._color.bright, stroke: 'none' }));
    }
    svg.appendChild(g);
  }

  /** HTML icon overlays for URL/Screenshot/New-Tab wedges. */
  _buildIcons(shadow) {
    const { c, ICON, s } = this.dim;
    const bright = this._color.bright;
    this._wedges.forEach((w, i) => {
      if (w.kind !== 'url' && w.kind !== 'screenshot' && w.kind !== 'newtab') return;
      const centre = -90 + i * 45;
      const rad = centre * Math.PI / 180;
      const x = c + ICON * Math.cos(rad);
      const y = c + ICON * Math.sin(rad);

      const box = document.createElement('div');
      box.className = 'ico';
      box.style.left = `${x}px`;
      box.style.top  = `${y}px`;
      box.style.transform = `translate(-50%,-50%) scale(${s})`;   // scale icon with dial

      if (w.kind === 'screenshot') {
        const gb = document.createElement('div');
        gb.className = 'glyph-box';
        gb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="${bright}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
        box.appendChild(gb);
      } else if (w.kind === 'newtab') {
        const gb = document.createElement('div');
        gb.className = 'glyph-box';
        gb.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="${bright}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 10v6M9 13h6"/></svg>`;
        box.appendChild(gb);
      } else if (w.url && !w.locked) {
        // favicon with letter fallback
        const img = document.createElement('img');
        img.src = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(w.host)}`;
        img.alt = '';
        img.addEventListener('error', () => {
          const letter = document.createElement('div');
          letter.className = 'letter';
          letter.textContent = (w.host[0] || '?').toUpperCase();
          img.replaceWith(letter);
        });
        box.appendChild(img);
      } else {
        // placeholder "Slot N"
        const ph = document.createElement('div');
        ph.className = 'ph';
        ph.textContent = `Slot ${w.slotNo}`;
        box.appendChild(ph);
      }

      if (w.locked) {
        const lock = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        lock.setAttribute('class', 'lock');
        lock.setAttribute('viewBox', '0 0 24 24');
        lock.innerHTML = `<rect x="4" y="11" width="16" height="10" rx="2" fill="#1a1326" stroke="${bright}" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="${bright}" stroke-width="2"/>`;
        box.appendChild(lock);
      }

      shadow.appendChild(box);
    });
  }

  _setLabel(text) {
    if (this._labelEl) this._labelEl.textContent = text || '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── SKIN SYSTEM (designs II-IX) ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════
  // Every skin below produces exactly the same interactive surface as the
  // radial design — this._wedgeEls (8), this._tetherEl/._tetherDot,
  // this._labelEl — via the shared _common* helpers, so track()/dismiss()/
  // selected() work identically regardless of which skin is active. Only the
  // decorative layer differs per design.

  _skinStyle() {
    const { accent, bright } = this._color;
    const rgba = hexRgba;
    const s = document.createElement('style');
    s.textContent = `
      svg { position:absolute; inset:0; overflow:visible; }
      /* Band segments — semi-transparent, exactly like the default Radial Dial,
         so the 8 options read crystal clear on every design. */
      .wedge { fill: url(#skBand); stroke: ${rgba(accent, 0.22)}; stroke-width:1; transition: fill .12s ease; }
      .wedge.active { fill: url(#skActive); stroke: ${bright}; stroke-width:1; filter: url(#skinGlowStrong); }
      .divider { stroke: ${rgba(accent, 0.28)}; stroke-width: 1; }
      .nav-glyph { fill:none; stroke:${bright}; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; filter:url(#skinGlow); }
      .reticle      { stroke: ${rgba(bright, 0.85)}; stroke-width:1.2; stroke-linecap:round; }
      .reticle-ring { fill:none; stroke: ${rgba(accent, 0.35)}; stroke-width:1; }
      .reticle-dot  { fill:${bright}; filter:url(#skinGlow); }
      .tether       { stroke: ${rgba(bright, 0.9)}; stroke-width:2; stroke-linecap:round; filter:url(#skinGlow); opacity:0; transition:opacity .08s ease; }
      .tether-dot   { fill:#ffffff; filter:url(#skinGlow); opacity:0; transition:opacity .08s ease; }
      .centre-label { fill:#f8f8ff; stroke:rgba(4,4,8,0.92); stroke-width:3.5; paint-order:stroke;
                      font:700 14px 'Segoe UI',system-ui,sans-serif; text-anchor:middle; letter-spacing:.4px; }
      .ico { position:absolute; width:18px; height:18px; transform:translate(-50%,-50%); display:grid; place-items:center; pointer-events:none; }
      .ico img { width:14px; height:14px; border-radius:4px; display:block; box-shadow:0 0 6px ${rgba(accent,0.5)}; background:rgba(6,6,10,0.7); }
      .ico .ph { font:600 7px 'Segoe UI',sans-serif; color:${bright}; text-align:center; line-height:1.05; letter-spacing:.2px; text-shadow:0 0 6px ${rgba(accent,0.6)}; }
      .ico .letter { width:14px; height:14px; border-radius:4px; background:${rgba(accent,0.22)}; border:1px solid ${rgba(bright,0.65)}; color:#fff; font:700 9px 'Segoe UI',sans-serif; display:grid; place-items:center; box-shadow:0 0 6px ${rgba(accent,0.45)}; }
      .ico .glyph-box { width:14px; height:14px; border-radius:4px; background:${rgba(accent,0.2)}; border:1px solid ${rgba(bright,0.65)}; display:grid; place-items:center; box-shadow:0 0 6px ${rgba(accent,0.45)}; }
      .ico .glyph-box svg { width:8px; height:8px; }
      .ico .lock { position:absolute; right:-1px; bottom:-1px; width:7px; height:7px; filter:drop-shadow(0 0 2px rgba(0,0,0,0.7)); }
      .clock-digital { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); text-align:center; pointer-events:none; }
      .clock-digital .cd-time { font:700 15px 'Share Tech Mono','Segoe UI',monospace; color:${bright}; text-shadow:0 0 8px ${rgba(accent,0.8)}; letter-spacing:1px; }
      .clock-digital .cd-ampm { font:600 7px 'Segoe UI',sans-serif; color:${rgba(bright,0.8)}; letter-spacing:1px; }
      .clock-digital .cd-date { font:600 6.5px 'Segoe UI',sans-serif; color:${rgba(bright,0.7)}; letter-spacing:0.5px; margin-top:1px; }
    `;
    return s;
  }

  _buildSkinSVG(designId) {
    const { D, c, RO, RI, s } = this.dim;
    const a = this._bandAlpha;
    const { accent, bright } = this._color;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${D} ${D}`);
    svg.setAttribute('width', D); svg.setAttribute('height', D);
    const el = (tag, attrs, cls) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (cls) n.setAttribute('class', cls);
      return n;
    };

    const defs = el('defs', {});
    // Band gradient (accent → dark) at the user's transparency, kept light enough
    // that the design's decoration still shows through behind the segments.
    defs.innerHTML = `
      <filter id="skinGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="skinGlowStrong" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <filter id="skinGlowXL" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="7" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <linearGradient id="skBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${hexRgba(accent, a * 0.45)}"/><stop offset="100%" stop-color="rgba(8,6,14,${a * 0.75})"/></linearGradient>
      <linearGradient id="skActive" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${hexRgba(accent, Math.max(0.55, a))}"/><stop offset="100%" stop-color="${hexRgba(bright, Math.max(0.6, a))}"/></linearGradient>
      <radialGradient id="skAura" cx="50%" cy="50%" r="50%"><stop offset="55%" stop-color="${hexRgba(accent, 0)}"/><stop offset="82%" stop-color="${hexRgba(accent, 0.30)}"/><stop offset="100%" stop-color="${hexRgba(accent, 0)}"/></radialGradient>
      <radialGradient id="skCore" cx="50%" cy="50%" r="50%"><stop offset="0%" stop-color="${hexRgba(bright, 0.95)}"/><stop offset="60%" stop-color="${hexRgba(accent, 0.65)}"/><stop offset="100%" stop-color="${hexRgba(accent, 0)}"/></radialGradient>
      <radialGradient id="skRingGrad" cx="50%" cy="50%" r="50%"><stop offset="86%" stop-color="${hexRgba(bright, 0)}"/><stop offset="93%" stop-color="${hexRgba(bright, 0.9)}"/><stop offset="100%" stop-color="${hexRgba(accent, 0)}"/></radialGradient>
    `;
    svg.appendChild(defs);

    const isClock = !!DESIGN_MAP[designId]?.clock;

    // per-design decoration, drawn first (sits visually behind the interactive layer)
    const fn = this[`_skin_${designId}`];
    if (typeof fn === 'function') fn.call(this, svg, el);

    // shared interactive layer — identical geometry/behaviour on every design,
    // and identical CLARITY to the default Radial Dial (segments + nav glyphs).
    this._commonWedges(svg, el, false);
    this._commonDividers(svg, el);
    this._skinNav(svg, el);                      // ← forward / reload / back (the options)
    this._commonTether(svg, el);
    if (!isClock) this._commonReticle(svg, el);  // clock designs use the centre for the clock
    this._commonLabel(svg, el);

    return svg;
  }

  /** Draw the three fixed-action glyphs (forward E, reload S, back W) for a skin. */
  _skinNav(svg, el) {
    const { c, ICON, s } = this.dim;
    this._navGlyph(svg, el, c, ICON, s, 0,   'forward');
    this._navGlyph(svg, el, c, ICON, s, 90,  'reload');
    this._navGlyph(svg, el, c, ICON, s, 180, 'back');
  }

  // ── shared interactive-layer builders (used by every skin) ────────────────
  _commonWedges(svg, el, straight) {
    const { c, RO, RI } = this.dim;
    this._wedgeEls = [];
    for (let i = 0; i < 8; i++) {
      const centre = -90 + i * 45;
      const path = el('path', { d: this._wedgePath(c, RO, RI, centre - 22.5, centre + 22.5, !!straight) }, 'wedge');
      svg.appendChild(path);
      this._wedgeEls.push(path);
    }
  }
  _commonDividers(svg, el) {
    const { c, RO, RI } = this.dim;
    const rad = (a) => a * Math.PI / 180;
    for (let i = 0; i < 8; i++) {
      const ang = rad(-67.5 + i * 45);
      svg.appendChild(el('line', { x1: c + RI * Math.cos(ang), y1: c + RI * Math.sin(ang), x2: c + RO * Math.cos(ang), y2: c + RO * Math.sin(ang) }, 'divider'));
    }
  }
  _commonTether(svg, el) {
    const { c, s } = this.dim;
    this._tetherEl  = el('line',   { x1: c, y1: c, x2: c, y2: c }, 'tether');
    this._tetherDot = el('circle', { cx: c, cy: c, r: 3.2 * s },   'tether-dot');
    svg.appendChild(this._tetherEl);
    svg.appendChild(this._tetherDot);
  }
  _commonReticle(svg, el) {
    const { c, s } = this.dim;
    svg.appendChild(el('circle', { cx: c, cy: c, r: 11 * s }, 'reticle-ring'));
    for (const [x1, y1, x2, y2] of [[-9,0,-5,0],[5,0,9,0],[0,-9,0,-5],[0,5,0,9]]) {
      svg.appendChild(el('line', { x1: c+x1*s, y1: c+y1*s, x2: c+x2*s, y2: c+y2*s }, 'reticle'));
    }
    svg.appendChild(el('circle', { cx: c, cy: c, r: 2.4 * s }, 'reticle-dot'));
  }
  _commonLabel(svg, el) {
    const { c, s } = this.dim;
    this._labelEl = el('text', { x: c, y: c - 26 * s }, 'centre-label');
    this._labelEl.textContent = '';
    svg.appendChild(this._labelEl);
  }

  // ── II. Ghostly Phantom — layered wispy glow ring, ghosts, drifting mist ──
  _skin_ghost(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    // soft ethereal halo behind everything
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 16 * s, fill: 'url(#skAura)' }));
    // layered plasma ring: broad soft glow → bright core → turbulent wisps
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO, fill: 'none', stroke: hexRgba(bright, 0.16), 'stroke-width': 12 * s, filter: 'url(#skinGlowXL)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 1 * s, fill: 'none', stroke: hexRgba(accent, 0.5), 'stroke-width': 5 * s, filter: 'url(#skinGlowStrong)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO, fill: 'none', stroke: hexRgba(bright, 0.85), 'stroke-width': 1.8 * s, filter: 'url(#skinGlow)' }));
    // long smoky wisps curling off the ring (ethereal mist, not clean flames)
    for (let i = 0; i < 14; i++) {
      const a = (i * (360 / 14) + prand(i) * 22) * Math.PI / 180;
      const rr = RO + (prand(i + 5) - 0.4) * 5 * s;
      const x0 = c + rr * Math.cos(a), y0 = c + rr * Math.sin(a);
      const swirl = (prand(i + 7) - 0.5) * 1.2;         // tangential curl
      const flr = RO + (6 + prand(i + 9) * 14) * s;
      const mx = c + flr * Math.cos(a + swirl * 0.4), my = c + flr * Math.sin(a + swirl * 0.4);
      const flr2 = RO + (10 + prand(i + 11) * 16) * s;
      const ex = c + flr2 * Math.cos(a + swirl), ey = c + flr2 * Math.sin(a + swirl);
      svg.appendChild(el('path', { d: `M${x0} ${y0} Q ${mx} ${my} ${ex} ${ey}`, fill: 'none', stroke: hexRgba(bright, 0.22 + prand(i) * 0.18), 'stroke-width': (0.8 + prand(i + 3) * 1.4) * s, 'stroke-linecap': 'round', filter: 'url(#skinGlowStrong)' }));
    }
    // extra turbulent smoke rings hugging the band (broken dashes read as fog)
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO - 6 * s, fill: 'none', stroke: hexRgba(bright, 0.18), 'stroke-width': 3 * s, 'stroke-dasharray': `${9 * s} ${14 * s}`, filter: 'url(#skinGlowStrong)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 5 * s, fill: 'none', stroke: hexRgba(accent, 0.25), 'stroke-width': 2.2 * s, 'stroke-dasharray': `${5 * s} ${11 * s}`, filter: 'url(#skinGlowStrong)' }));
    // spectral phantoms: elongated, translucent, with tattered dissolving tails
    const ghost = (x, y, sc, op, rot) => {
      const g = el('g', { transform: `translate(${x} ${y}) rotate(${rot}) scale(${sc})`, opacity: op });
      // motion-trail wisp streaming off behind the spectre
      g.appendChild(el('path', { d: 'M-7 8 Q -14 12 -20 10 Q -14 14 -6 12', fill: hexRgba(bright, 0.18), filter: 'url(#skinGlowStrong)' }));
      // faint smoke halo behind the body
      g.appendChild(el('ellipse', { cx: 0, cy: -1, rx: 10, ry: 13, fill: hexRgba(bright, 0.12), filter: 'url(#skinGlowStrong)' }));
      // hooded spectre body with ragged, uneven trailing tails
      g.appendChild(el('path', { d: 'M-8 4 C-9 -13 9 -13 8 4 L8 10 L5.5 5 L3 13 L0.5 6 L-2 14 L-4.5 6 L-7 11 Z', fill: hexRgba(bright, 0.42), stroke: hexRgba(bright, 0.7), 'stroke-width': 0.5, filter: 'url(#skinGlow)' }));
      // hollow sunken eyes + a wailing mouth
      g.appendChild(el('ellipse', { cx: -3, cy: -3, rx: 1.6, ry: 2.4, fill: '#0a0616' }));
      g.appendChild(el('ellipse', { cx: 3, cy: -3, rx: 1.6, ry: 2.4, fill: '#0a0616' }));
      g.appendChild(el('ellipse', { cx: 0, cy: 2, rx: 1.4, ry: 2.2, fill: '#0a0616' }));
      svg.appendChild(g);
    };
    // six spirits at varied depth, size and drift-tilt (feels like circling prey)
    [[26, RO + 10, 0.72, 0.92, 14], [88, RO + 6, 0.44, 0.6, -10], [150, RO + 11, 0.82, 0.95, 8],
     [205, RO + 4, 0.5, 0.55, -16], [258, RO - 1, 0.62, 0.8, 12], [318, RO + 9, 0.7, 0.88, -8]].forEach(([deg, gr, sc, op, rot]) => {
      const a = deg * Math.PI / 180;
      ghost(c + gr * Math.cos(a), c + gr * Math.sin(a), s * sc, String(op), rot);
    });
    // drifting soul-motes
    for (let i = 0; i < 16; i++) {
      const a = prand(i) * Math.PI * 2, r = RO + (2 + prand(i + 40) * 18) * s;
      svg.appendChild(el('circle', { cx: c + r * Math.cos(a), cy: c + r * Math.sin(a), r: (0.4 + prand(i + 80) * 1.2) * s, fill: hexRgba(bright, 0.4), filter: 'url(#skinGlow)' }));
    }
  }

  // ── III. Enchanted Magic — concentric rune rings + heptagram core ─────────
  _skin_magic(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    // mystical aura
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 18 * s, fill: 'url(#skAura)' }));
    // outer concentric magic-circle rings
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 12 * s, fill: 'none', stroke: hexRgba(accent, 0.35), 'stroke-width': 0.8 * s }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 7 * s, fill: 'none', stroke: hexRgba(bright, 0.5), 'stroke-width': 1 * s, filter: 'url(#skinGlow)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 9.5 * s, fill: 'none', stroke: hexRgba(accent, 0.4), 'stroke-width': 0.6 * s, 'stroke-dasharray': '2 4' }));
    // geometric rune marks between the outer rings (no font dependency)
    const runes = ['M-2 -3 L0 -3 L0 3 M0 -1 L2 1', 'M0 -3 L0 3 M-2 -1 L2 -1', 'M-2 -3 L2 3 M2 -3 L-2 3', 'M-2 -3 L2 -3 L-2 3 L2 3', 'M0 -3 L0 3 M-2 -3 L2 -3'];
    const Rr = RO + 9.5 * s;
    for (let i = 0; i < 12; i++) {
      const a = (i * 30 - 90) * Math.PI / 180;
      const x = c + Rr * Math.cos(a), y = c + Rr * Math.sin(a);
      svg.appendChild(el('path', { d: runes[i % runes.length], transform: `translate(${x} ${y}) rotate(${i * 30 + 90}) scale(${s * 0.9})`, fill: 'none', stroke: hexRgba(bright, 0.7), 'stroke-width': 0.8, 'stroke-linecap': 'round' }));
    }
    // faint radiant light rays streaming inward toward the star
    for (let i = 0; i < 24; i++) {
      const a = (i * 15) * Math.PI / 180, r0 = RI * 0.78, r1 = RI * 0.95;
      svg.appendChild(el('line', { x1: c + r0 * Math.cos(a), y1: c + r0 * Math.sin(a), x2: c + r1 * Math.cos(a), y2: c + r1 * Math.sin(a), stroke: hexRgba(bright, i % 2 ? 0.28 : 0.14), 'stroke-width': 0.6 * s }));
    }
    // inner heptagram (7-point star) in the centre hole — the enchanted sigil
    const Rh = RI * 0.72;
    const hp = []; for (let i = 0; i < 7; i++) { const a = (-90 + i * (360 * 3 / 7)) * Math.PI / 180; hp.push(`${c + Rh * Math.cos(a)},${c + Rh * Math.sin(a)}`); }
    svg.appendChild(el('polygon', { points: hp.join(' '), fill: hexRgba(accent, 0.12), stroke: hexRgba(bright, 0.75), 'stroke-width': 1 * s, filter: 'url(#skinGlow)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: Rh, fill: 'none', stroke: hexRgba(accent, 0.4), 'stroke-width': 0.6 * s }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: Rh * 0.52, fill: 'none', stroke: hexRgba(bright, 0.4), 'stroke-width': 0.6 * s, 'stroke-dasharray': '2 2' }));
    // glowing arcane core
    svg.appendChild(el('circle', { cx: c, cy: c, r: 5 * s, fill: 'url(#skCore)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: 1.8 * s, fill: bright, filter: 'url(#skinGlowStrong)' }));
    // twinkling spell-sparkles (4-point stars) drifting around the circle
    const twinkle = (x, y, r, op) => {
      svg.appendChild(el('path', { d: `M${x} ${y-r} Q ${x+r*0.16} ${y-r*0.16} ${x+r} ${y} Q ${x+r*0.16} ${y+r*0.16} ${x} ${y+r} Q ${x-r*0.16} ${y+r*0.16} ${x-r} ${y} Q ${x-r*0.16} ${y-r*0.16} ${x} ${y-r} Z`, fill: hexRgba(bright, op), filter: 'url(#skinGlow)' }));
    };
    for (let i = 0; i < 16; i++) {
      const a = prand(i) * Math.PI * 2, r = RO + (2 + prand(i + 30) * 14) * s;
      twinkle(c + r * Math.cos(a), c + r * Math.sin(a), (1.2 + prand(i + 60) * 2.4) * s, 0.45 + prand(i) * 0.4);
    }
  }

  // ── IV. Ninja Shadow — dark stone-plate ring, red cracks, shuriken, kanji ─
  _skin_ninja(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    const p = (r, a) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
    // faint red aura bleeding from the ring
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 14 * s, fill: 'url(#skAura)' }));
    // 8 dark rocky stone plates with gaps and jagged outer edges
    for (let i = 0; i < 8; i++) {
      const a0 = (-90 + i * 45 - 19) * Math.PI / 180, am = (-90 + i * 45) * Math.PI / 180, a1 = (-90 + i * 45 + 19) * Math.PI / 180;
      const ro = RO + (2 + prand(i) * 4) * s, rm = RO + (5 + prand(i + 3) * 4) * s, ri = RO - 4 * s;
      // outer edge chipped: a0 → mid bump → a1, then back along inner arc
      const d = `M ${p(ro, a0)} L ${p(rm, am)} L ${p(ro, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 0 0 ${p(ri, a0)} Z`;
      svg.appendChild(el('path', { d, fill: 'rgba(12,9,11,0.95)', stroke: hexRgba(accent, 0.55), 'stroke-width': 0.9 * s, filter: 'url(#skinGlow)' }));
      // inner plate highlight
      svg.appendChild(el('path', { d: `M ${p(RO - 4 * s, a0)} A ${RO - 4 * s} ${RO - 4 * s} 0 0 1 ${p(RO - 4 * s, a1)}`, fill: 'none', stroke: hexRgba(accent, 0.3), 'stroke-width': 0.6 * s }));
    }
    // glowing red cracks radiating between plates
    for (let i = 0; i < 8; i++) {
      const a = (-67.5 + i * 45) * Math.PI / 180;
      svg.appendChild(el('line', { x1: c + (RO - 6 * s) * Math.cos(a), y1: c + (RO - 6 * s) * Math.sin(a), x2: c + (RO + 8 * s) * Math.cos(a), y2: c + (RO + 8 * s) * Math.sin(a), stroke: hexRgba(accent, 0.8), 'stroke-width': 0.9 * s, filter: 'url(#skinGlowStrong)' }));
    }
    // proper 4-point throwing star (shuriken) with a bladed silhouette + hole
    const shR = RI * 0.62, shr = shR * 0.34;   // outer point / inner notch radii
    const g = el('g', { transform: `translate(${c} ${c})` });
    const star = [];
    for (let i = 0; i < 8; i++) {
      const rr = i % 2 === 0 ? shR : shr;
      const a = (-90 + i * 45) * Math.PI / 180;
      star.push(`${rr * Math.cos(a)},${rr * Math.sin(a)}`);
    }
    g.appendChild(el('polygon', { points: star.join(' '), fill: hexRgba(accent, 0.85), stroke: bright, 'stroke-width': 0.8 * s, 'stroke-linejoin': 'miter', filter: 'url(#skinGlowStrong)' }));
    // bevel highlight down each blade
    for (let i = 0; i < 4; i++) {
      const a = (-90 + i * 90) * Math.PI / 180;
      g.appendChild(el('line', { x1: 0, y1: 0, x2: shR * Math.cos(a), y2: shR * Math.sin(a), stroke: hexRgba(bright, 0.5), 'stroke-width': 0.6 * s }));
    }
    g.appendChild(el('circle', { cx: 0, cy: 0, r: shr * 0.7, fill: 'rgba(10,7,9,0.95)', stroke: hexRgba(bright, 0.8), 'stroke-width': 1 * s }));
    svg.appendChild(g);
    // kanji top/bottom (CJK — widely supported)
    const kanji = (ch, dy) => { const t = el('text', { x: c, y: c + dy, fill: hexRgba(accent, 0.9), 'font-size': 13 * s, 'font-family': "'Segoe UI',sans-serif", 'font-weight': '700', 'text-anchor': 'middle', filter: 'url(#skinGlow)' }); t.textContent = ch; svg.appendChild(t); };
    kanji('忍', -RO - 10 * s);
    kanji('影', RO + 18 * s);
  }

  // ── V. Analog Clock — roman-numeral face + live hands, INSIDE the hole ─────
  //     (numerals/hands live in the centre hole so the slot band around them
  //      stays crystal clear — the 5 slots + 3 nav arrows read exactly as the
  //      default dial, with the working clock nested in the middle.)
  _skin_aclock(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    // solid metallic bezel: glow + outer ring + brushed inner bezel + opaque face
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 1 * s, fill: 'none', stroke: hexRgba(accent, 0.5), 'stroke-width': 4.5 * s, filter: 'url(#skinGlowStrong)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO, fill: 'none', stroke: hexRgba(bright, 0.95), 'stroke-width': 2.4 * s, filter: 'url(#skinGlow)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI + 4 * s, fill: 'none', stroke: hexRgba(accent, 0.7), 'stroke-width': 2.6 * s }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI + 1.5 * s, fill: 'rgba(9,8,17,0.9)', stroke: hexRgba(bright, 0.4), 'stroke-width': 0.8 * s }));
    // minute + hour ticks (hour ticks longer & brighter)
    for (let i = 0; i < 60; i++) {
      const a = (i * 6) * Math.PI / 180;
      const hour = i % 5 === 0;
      const r0 = RI * (hour ? 0.84 : 0.92), r1 = RI * 0.99;
      svg.appendChild(el('line', { x1: c + r0 * Math.cos(a), y1: c + r0 * Math.sin(a), x2: c + r1 * Math.cos(a), y2: c + r1 * Math.sin(a), stroke: hexRgba(hour ? bright : accent, hour ? 0.9 : 0.45), 'stroke-width': (hour ? 1.5 : 0.6) * s }));
    }
    // numerals — roman (default) or english 12-hour, per design setting
    const roman   = ['XII','I','II','III','IIII','V','VI','VII','VIII','IX','X','XI'];
    const english = ['12','1','2','3','4','5','6','7','8','9','10','11'];
    const numerals = this._numerals === 'english' ? english : roman;
    const Rn = RI * 0.72;
    numerals.forEach((num, i) => {
      const a = (i * 30 - 90) * Math.PI / 180;
      const x = c + Rn * Math.cos(a), y = c + Rn * Math.sin(a);
      const t = el('text', { x, y: y + 2.7 * s, fill: bright, 'font-size': 8 * s, 'font-family': "'Georgia','Times New Roman',serif", 'font-weight': '700', 'text-anchor': 'middle' });
      t.textContent = num;
      svg.appendChild(t);
    });
    // ── hands: built pointing up (12 o'clock); rotated live in _startClock ──
    // ornate tapered leaf hands so hour & minute read clearly and distinctly.
    const Lh = RI * 0.5, Lm = RI * 0.74, Ls = RI * 0.8;
    const leaf = (L, w, tail) =>
      `M ${c} ${c - L} Q ${c + w} ${c - L * 0.42} ${c + w * 0.55} ${c - L * 0.12} ` +
      `L ${c + w * 0.45} ${c + tail} L ${c - w * 0.45} ${c + tail} L ${c - w * 0.55} ${c - L * 0.12} ` +
      `Q ${c - w} ${c - L * 0.42} ${c} ${c - L} Z`;
    const hourEl = el('path', { d: leaf(Lh, 4.4 * s, 11 * s), fill: bright, stroke: hexRgba(accent, 0.8), 'stroke-width': 0.7 * s, filter: 'url(#skinGlow)' });
    const minEl  = el('path', { d: leaf(Lm, 3.2 * s, 13 * s), fill: bright, stroke: hexRgba(accent, 0.8), 'stroke-width': 0.7 * s, filter: 'url(#skinGlow)' });
    // second hand: tapered red needle + counterweight tail.
    // NOTE: drawn as a polygon, NOT a <line> — a perfectly vertical line has a
    // zero-width bounding box, which collapses percentage-based glow filters in
    // Chrome and makes the arm invisible (only the dot survived).
    const secEl = el('g', {});
    secEl.appendChild(el('polygon', { points: `${c - 0.7 * s},${c + 13 * s} ${c - 1.2 * s},${c} ${c},${c - Ls} ${c + 1.2 * s},${c} ${c + 0.7 * s},${c + 13 * s}`, fill: '#ff5a4d', filter: 'url(#skinGlow)' }));
    secEl.appendChild(el('circle', { cx: c, cy: c + 13 * s, r: 2 * s, fill: '#ff5a4d' }));
    svg.appendChild(hourEl); svg.appendChild(minEl); svg.appendChild(secEl);
    // hub
    svg.appendChild(el('circle', { cx: c, cy: c, r: 3.6 * s, fill: bright, stroke: hexRgba(accent, 0.8), 'stroke-width': 0.8 * s, filter: 'url(#skinGlow)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: 1.5 * s, fill: '#ff5a4d' }));
    this._clockHands = { hourEl, minEl, secEl };
  }

  // ── VI. Digital Clock — mechanical ring + live LCD readout in the hole ────
  _skin_dclock(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    // cyan tech aura + solid double bezel
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 12 * s, fill: 'url(#skAura)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 1 * s, fill: 'none', stroke: hexRgba(accent, 0.45), 'stroke-width': 4 * s, filter: 'url(#skinGlowStrong)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO, fill: 'none', stroke: hexRgba(bright, 0.9), 'stroke-width': 2 * s, filter: 'url(#skinGlow)' }));
    // segmented outer tick ring (mechanical) — long/short alternating
    for (let i = 0; i < 48; i++) {
      const a = (i * 7.5) * Math.PI / 180, big = i % 4 === 0;
      const r0 = RO + 2 * s, r1 = RO + (big ? 7 : 4) * s;
      svg.appendChild(el('line', { x1: c + r0 * Math.cos(a), y1: c + r0 * Math.sin(a), x2: c + r1 * Math.cos(a), y2: c + r1 * Math.sin(a), stroke: hexRgba(big ? bright : accent, big ? 0.7 : 0.35), 'stroke-width': (big ? 1 : 0.6) * s }));
    }
    // circuit-trace arcs inside the band (adds the "tech" detail)
    const arc = (rr, a0, a1) => { const p = (a) => `${c + rr * Math.cos(a * Math.PI / 180)} ${c + rr * Math.sin(a * Math.PI / 180)}`; return `M ${p(a0)} A ${rr} ${rr} 0 0 1 ${p(a1)}`; };
    svg.appendChild(el('path', { d: arc(RO - 6 * s, -140, -40), fill: 'none', stroke: hexRgba(accent, 0.5), 'stroke-width': 0.8 * s, 'stroke-dasharray': '1 3' }));
    svg.appendChild(el('path', { d: arc(RO - 6 * s, 40, 140), fill: 'none', stroke: hexRgba(accent, 0.5), 'stroke-width': 0.8 * s, 'stroke-dasharray': '1 3' }));
    // solid glassy LCD face
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI + 2 * s, fill: 'rgba(4,12,20,0.9)', stroke: hexRgba(accent, 0.7), 'stroke-width': 1.4 * s }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI - 1 * s, fill: 'none', stroke: hexRgba(bright, 0.3), 'stroke-width': 0.6 * s }));
    // corner brackets around the readout
    [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([sx, sy]) => {
      const bx = c + sx * RI * 0.62, by = c + sy * RI * 0.42, L = 4 * s;
      svg.appendChild(el('path', { d: `M ${bx + sx*L} ${by} L ${bx} ${by} L ${bx} ${by + sy*L}`, fill: 'none', stroke: hexRgba(accent, 0.7), 'stroke-width': 0.9 * s, 'stroke-linecap': 'round' }));
    });
    // digital readout is appended as an HTML overlay in spawn() via _buildClockOverlay()
    this._needsDigitalOverlay = true;
  }

  /** HTML digital-clock readout, appended after the SVG (dclock only). */
  _buildClockOverlay(shadow) {
    const panel = document.createElement('div');
    panel.className = 'clock-digital';
    panel.style.transform = `translate(-50%,-50%) scale(${this.dim.s})`;
    panel.innerHTML = `<div class="cd-time" id="__mw_cd_time">--:--</div><div class="cd-ampm" id="__mw_cd_ampm">--</div><div class="cd-date" id="__mw_cd_date">---- -- ---</div>`;
    shadow.appendChild(panel);
    this._clockDigital = {
      time: panel.querySelector('#__mw_cd_time'),
      ampm: panel.querySelector('#__mw_cd_ampm'),
      date: panel.querySelector('#__mw_cd_date'),
    };
  }

  // ── VII. Chrono Core — plated energy dial with a green hourglass core ──────
  //     (generic geometric emblem + green tech ring; not branded in the UI.)
  _skin_chrono(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    const p = (r, a) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
    // Omnitrix palette — solid, saturated greens + metal + black
    const gLite = '#3ee06a', gMid = '#1f9c44', gDark = '#0b3d1e', metal = '#c6d2da', black = '#05120b';
    // green energy aura
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 14 * s, fill: 'url(#skAura)' }));
    // ── outer casing: chunky bright-green plates (the device shell) ───────────
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 2 * s, fill: 'none', stroke: gDark, 'stroke-width': 8 * s }));
    for (let i = 0; i < 8; i++) {
      const a0 = (-90 + i * 45 - 21) * Math.PI / 180, a1 = (-90 + i * 45 + 21) * Math.PI / 180;
      const ro = RO + 6 * s, ri = RO - 3 * s;
      svg.appendChild(el('path', { d: `M ${p(ro, a0)} A ${ro} ${ro} 0 0 1 ${p(ro, a1)} L ${p(ri, a1)} A ${ri} ${ri} 0 0 0 ${p(ri, a0)} Z`, fill: gMid, stroke: black, 'stroke-width': 1.4 * s, filter: 'url(#skinGlow)' }));
      // bright green highlight sliver on each plate
      const b0 = (-90 + i * 45 - 21) * Math.PI / 180, b1 = (-90 + i * 45 + 21) * Math.PI / 180, rb = RO + 4 * s;
      svg.appendChild(el('path', { d: `M ${p(rb, b0)} A ${rb} ${rb} 0 0 1 ${p(rb, b1)}`, fill: 'none', stroke: gLite, 'stroke-width': 1.4 * s, 'stroke-linecap': 'round' }));
    }
    // four metallic "release button" pins on the diagonals
    for (let i = 0; i < 4; i++) {
      const a = (-45 + i * 90) * Math.PI / 180, nx = c + RO * Math.cos(a), ny = c + RO * Math.sin(a);
      svg.appendChild(el('circle', { cx: nx, cy: ny, r: 4 * s, fill: metal, stroke: black, 'stroke-width': 1.2 * s }));
      svg.appendChild(el('circle', { cx: nx, cy: ny, r: 1.6 * s, fill: gLite, filter: 'url(#skinGlow)' }));
    }
    // ── faceplate that FILLS the inner circle: metal bezel → black lens ───────
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI, fill: metal, stroke: black, 'stroke-width': 1.4 * s }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI - 3 * s, fill: metal, stroke: '#8b98a2', 'stroke-width': 0.8 * s }));
    const faceR = RI - 5 * s;
    svg.appendChild(el('circle', { cx: c, cy: c, r: faceR, fill: black }));
    // green energy glow filling the lens
    svg.appendChild(el('circle', { cx: c, cy: c, r: faceR, fill: 'url(#skCore)' }));
    // ── the Omnitrix hourglass: green fills the full top & bottom of the lens ─
    // Each half's base is an ARC of the lens circle (not a flat chord), so the
    // green reaches the rim with zero gap and never crosses into the slot band;
    // the black lens shows only as the two curved side pockets.
    const th = 52 * Math.PI / 180;                       // half-spread of each cone
    const hx = faceR * Math.sin(th), hy = faceR * Math.cos(th);
    const hgTop = `M ${c - hx} ${c - hy} A ${faceR} ${faceR} 0 0 1 ${c + hx} ${c - hy} L ${c} ${c} Z`;
    const hgBot = `M ${c + hx} ${c + hy} A ${faceR} ${faceR} 0 0 1 ${c - hx} ${c + hy} L ${c} ${c} Z`;
    svg.appendChild(el('path', { d: hgTop, fill: gLite, filter: 'url(#skinGlow)' }));
    svg.appendChild(el('path', { d: hgBot, fill: gLite, filter: 'url(#skinGlow)' }));
    // crisp black X-edge separating green from the black side pockets
    svg.appendChild(el('path', { d: hgTop, fill: 'none', stroke: black, 'stroke-width': 1.4 * s, 'stroke-linejoin': 'round' }));
    svg.appendChild(el('path', { d: hgBot, fill: 'none', stroke: black, 'stroke-width': 1.4 * s, 'stroke-linejoin': 'round' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: 2.2 * s, fill: bright, filter: 'url(#skinGlow)' }));
  }

  // ── VIII. Ice Wraith — jagged crystal-shard ring, 6-arm snowflake core ────
  _skin_ice(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    // frosty aura
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 16 * s, fill: 'url(#skAura)' }));
    // frosted double rim of the ring band itself
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO, fill: 'none', stroke: hexRgba(bright, 0.7), 'stroke-width': 1.6 * s, filter: 'url(#skinGlowStrong)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI, fill: 'none', stroke: hexRgba(bright, 0.5), 'stroke-width': 1.2 * s, filter: 'url(#skinGlow)' }));
    // ── frozen-glass faceting across the ring band (makes the DIAL look icy) ──
    for (let i = 0; i < 16; i++) {
      const a0 = (i * 22.5) * Math.PI / 180, a1 = (i * 22.5 + 11) * Math.PI / 180;
      // a thin ice facet: from inner edge at a0 up to outer edge at a1
      svg.appendChild(el('polygon', {
        points: `${c + RI * Math.cos(a0)},${c + RI * Math.sin(a0)} ${c + RO * Math.cos(a1)},${c + RO * Math.sin(a1)} ${c + RO * Math.cos(a0)},${c + RO * Math.sin(a0)}`,
        fill: hexRgba(bright, 0.10 + (i % 2) * 0.06), stroke: hexRgba(bright, 0.22), 'stroke-width': 0.4 * s }));
    }
    // hoar-frost feather crystals growing inward from the outer rim
    for (let i = 0; i < 24; i++) {
      const a = (i * 15) * Math.PI / 180, r0 = RO - 1 * s, r1 = RO - (5 + (i % 3) * 4) * s;
      svg.appendChild(el('line', { x1: c + r0 * Math.cos(a), y1: c + r0 * Math.sin(a), x2: c + r1 * Math.cos(a), y2: c + r1 * Math.sin(a), stroke: hexRgba(bright, 0.35), 'stroke-width': 0.5 * s, 'stroke-linecap': 'round' }));
    }
    const shard = (a, base, len, w, fill, stroke) => {
      const bx = c + base * Math.cos(a), by = c + base * Math.sin(a);
      const tx = c + (base + len) * Math.cos(a), ty = c + (base + len) * Math.sin(a);
      const perp = a + Math.PI / 2;
      svg.appendChild(el('polygon', { points: `${bx + w * Math.cos(perp)},${by + w * Math.sin(perp)} ${tx},${ty} ${bx - w * Math.cos(perp)},${by - w * Math.sin(perp)}`, fill, stroke, 'stroke-width': 0.4 * s }));
    };
    // outward crystal shards (alternating long/short) — spiky ice crown
    for (let i = 0; i < 20; i++) {
      const a = (i * 18) * Math.PI / 180;
      shard(a, RO, (i % 2 === 0 ? 13 : 7) * s, (i % 2 === 0 ? 3 : 2) * s, hexRgba(bright, 0.6), hexRgba(accent, 0.75));
    }
    // inward shards making the ring's inner edge jagged/crystalline
    for (let i = 0; i < 16; i++) {
      const a = (i * 22.5 + 6) * Math.PI / 180;
      shard(a, RI, (5 + (i % 2) * 4) * s, 2 * s, hexRgba(bright, 0.45), hexRgba(accent, 0.5));
    }
    // detailed snowflake in the centre hole
    const Rf = RI * 0.7;
    const g = el('g', { transform: `translate(${c} ${c})` });
    for (let i = 0; i < 6; i++) {
      const rot = i * 60;
      g.appendChild(el('line', { x1: 0, y1: 0, x2: 0, y2: -Rf, stroke: bright, 'stroke-width': 1 * s, 'stroke-linecap': 'round', transform: `rotate(${rot})`, filter: 'url(#skinGlow)' }));
      g.appendChild(el('line', { x1: 0, y1: -Rf * 0.5, x2: 4.5 * s, y2: -Rf * 0.66, stroke: bright, 'stroke-width': 0.8 * s, 'stroke-linecap': 'round', transform: `rotate(${rot})` }));
      g.appendChild(el('line', { x1: 0, y1: -Rf * 0.5, x2: -4.5 * s, y2: -Rf * 0.66, stroke: bright, 'stroke-width': 0.8 * s, 'stroke-linecap': 'round', transform: `rotate(${rot})` }));
      g.appendChild(el('line', { x1: 0, y1: -Rf * 0.76, x2: 3.4 * s, y2: -Rf * 0.88, stroke: bright, 'stroke-width': 0.7 * s, 'stroke-linecap': 'round', transform: `rotate(${rot})` }));
      g.appendChild(el('line', { x1: 0, y1: -Rf * 0.76, x2: -3.4 * s, y2: -Rf * 0.88, stroke: bright, 'stroke-width': 0.7 * s, 'stroke-linecap': 'round', transform: `rotate(${rot})` }));
    }
    svg.appendChild(g);
    for (let i = 0; i < 8; i++) {
      const a = prand(i) * Math.PI * 2, r = RO + (2 + prand(i + 25) * 12) * s;
      svg.appendChild(el('circle', { cx: c + r * Math.cos(a), cy: c + r * Math.sin(a), r: 0.8 * s, fill: hexRgba(bright, 0.6) }));
    }
  }

  // ── IX. Dragon Inferno — wavy flame licks, scale ring, dragon-head sigil ──
  _skin_dragon(svg, el) {
    const { c, RO, RI, s } = this.dim;
    const { accent, bright } = this._color;
    // fiery aura
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 20 * s, fill: 'url(#skAura)' }));
    // dragon fire-breath: dense layered flame tongues (orange body + yellow core)
    const flame = (a, len, w, fill, op) => {
      const bx = c + RO * Math.cos(a), by = c + RO * Math.sin(a);
      const bend = a + (prand(Math.round(a * 30) + 10) - 0.5) * 0.7;
      const mx = c + (RO + len * 0.55) * Math.cos(bend), my = c + (RO + len * 0.55) * Math.sin(bend);
      const ta = a + (prand(Math.round(a * 30) + 20) - 0.5) * 0.3;
      const tx = c + (RO + len) * Math.cos(ta), ty = c + (RO + len) * Math.sin(ta);
      const perp = a + Math.PI / 2;
      const b1x = bx + w * Math.cos(perp), b1y = by + w * Math.sin(perp);
      const b2x = bx - w * Math.cos(perp), b2y = by - w * Math.sin(perp);
      svg.appendChild(el('path', { d: `M${b1x} ${b1y} Q ${mx} ${my} ${tx} ${ty} Q ${mx} ${my} ${b2x} ${b2y} Z`, fill: hexRgba(fill, op), filter: 'url(#skinGlow)' }));
    };
    for (let i = 0; i < 30; i++) {                 // outer orange flame body (full coverage)
      const a = (i * 12) * Math.PI / 180;
      flame(a, (10 + prand(i) * 12) * s, 2.6 * s, accent, 0.55);
    }
    for (let i = 0; i < 30; i++) {                 // inner bright-yellow flame cores
      const a = (i * 12 + 6) * Math.PI / 180;
      flame(a, (6 + prand(i + 50) * 8) * s, 1.5 * s, bright, 0.7);
    }
    // dragon-hide ring: dark band backing + overlapping scales across the WHOLE band
    svg.appendChild(el('circle', { cx: c, cy: c, r: (RO + RI) / 2, fill: 'none', stroke: 'rgba(16,6,3,0.88)', 'stroke-width': RO - RI + 2 * s }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO, fill: 'none', stroke: hexRgba(accent, 0.75), 'stroke-width': 1.6 * s, filter: 'url(#skinGlow)' }));
    svg.appendChild(el('circle', { cx: c, cy: c, r: RI, fill: 'none', stroke: hexRgba(accent, 0.5), 'stroke-width': 1 * s }));
    for (let row = 0; row < 7; row++) {
      const rr = RI + (4 + row * 4.6) * s;
      if (rr > RO - 1 * s) break;
      const n = 34, off = (row % 2) * Math.PI / n;   // alternate rows interlock
      for (let i = 0; i < n; i++) {
        const a = i * (2 * Math.PI / n) + off;
        const bx = c + (rr + 2.2 * s) * Math.cos(a), by = c + (rr + 2.2 * s) * Math.sin(a);
        const sw = (Math.PI / n) * 0.92;
        const x0 = c + rr * Math.cos(a - sw), y0 = c + rr * Math.sin(a - sw);
        const x1 = c + rr * Math.cos(a + sw), y1 = c + rr * Math.sin(a + sw);
        svg.appendChild(el('path', { d: `M${x0} ${y0} Q ${bx} ${by} ${x1} ${y1}`, fill: 'none', stroke: hexRgba(accent, row % 2 ? 0.45 : 0.6), 'stroke-width': 0.8 * s }));
      }
    }
    // ── dragon artwork filling the centre hole (bundled PNG, clipped round) ───
    const hole = RI - 2 * s;
    const clip = el('clipPath', { id: 'mw-dragon-clip' });
    clip.appendChild(el('circle', { cx: c, cy: c, r: hole }));
    svg.appendChild(clip);
    // dark backing so a transparent-cut PNG reads on any page background
    svg.appendChild(el('circle', { cx: c, cy: c, r: hole, fill: '#160600' }));
    const img = el('image', {
      x: c - hole, y: c - hole, width: hole * 2, height: hole * 2,
      preserveAspectRatio: 'xMidYMid slice', 'clip-path': 'url(#mw-dragon-clip)',
    });
    const dragonUrl = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL)
      ? chrome.runtime.getURL('assets/art/dragon-center.png')
      : '../assets/art/dragon-center.png';
    img.setAttribute('href', dragonUrl);                                   // SVG2
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dragonUrl); // legacy
    svg.appendChild(img);
    // subtle inner rim so the artwork sits inside a lens
    svg.appendChild(el('circle', { cx: c, cy: c, r: hole, fill: 'none', stroke: hexRgba(bright, 0.35), 'stroke-width': 1 * s }));
  }

  // ── Live clock tick (analog hands / digital text), timezone-aware ─────────
  _startClock(designId, timezone) {
    if (this._clockInterval) { clearInterval(this._clockInterval); this._clockInterval = null; }
    const { c } = this.dim;
    const update = () => {
      const t = getTZTime(timezone);
      if (designId === 'aclock' && this._clockHands) {
        const hourAngle = ((t.h % 12) + t.m / 60) * 30;
        const minAngle  = (t.m + t.s / 60) * 6;
        const secAngle  = t.s * 6;
        this._clockHands.hourEl.setAttribute('transform', `rotate(${hourAngle} ${c} ${c})`);
        this._clockHands.minEl.setAttribute('transform',  `rotate(${minAngle} ${c} ${c})`);
        this._clockHands.secEl.setAttribute('transform',  `rotate(${secAngle} ${c} ${c})`);
      } else if (designId === 'dclock' && this._clockDigital) {
        const hh12 = (t.h % 12) || 12;
        this._clockDigital.time.textContent = `${String(hh12).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
        this._clockDigital.ampm.textContent = t.h >= 12 ? 'PM' : 'AM';
        this._clockDigital.date.textContent = `${(t.weekday || '').toUpperCase()} ${t.day} ${(t.month || '').toUpperCase()}`;
      }
    };
    if (designId === 'dclock' && this._needsDigitalOverlay && this._shadow) {
      this._buildClockOverlay(this._shadow);
      this._needsDigitalOverlay = false;
    }
    update();
    this._clockInterval = setInterval(update, 1000);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ContextGuard — suppress the native context menu after a real dial gesture
// ═══════════════════════════════════════════════════════════════════════════════
class ContextGuard {
  constructor() { this._suppress = false; }
  arm()  { this._suppress = true; }
  consume() { if (this._suppress) { this._suppress = false; return true; } return false; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MouseController — entry point
// ═══════════════════════════════════════════════════════════════════════════════
class MouseController {
  constructor() {
    this._hud     = new RadialDialHUD();
    this._ticker  = new Ticker();
    this._guard   = new ContextGuard();

    this._open     = false;   // dial is currently shown
    this._engaged  = false;   // cursor left the dead-zone at least once
    this._pending  = null;    // hold-to-open timer id
    this._safety   = null;    // last-resort auto-dismiss timer
    this._downX    = 0;       // right-button-down origin (dial centre)
    this._downY    = 0;
    this._curX     = 0;       // latest cursor position
    this._curY     = 0;
    this._movePending = false;
    this._activeDesignId = 'radial';
    this._activeDesignSettings = null;

    this._bind();
    console.log('[MOUSSY] Radial dial engine ready — build: v8-designs —', location.hostname);
  }

  _bind() {
    document.addEventListener('mousedown',   this._onDown.bind(this),  { capture: true });
    document.addEventListener('mousemove',   this._onMove.bind(this),  { passive: true });
    document.addEventListener('mouseup',     this._onUp.bind(this),    { capture: true });
    document.addEventListener('contextmenu', this._onCtx.bind(this),   { capture: true });
    // Also listen on window so a release just outside the document still lands.
    window.addEventListener('mouseup',       this._onUp.bind(this),    { capture: true });
    // Safety nets so the dial can never get stuck open if the mouseup is lost
    // (cursor over an iframe/embed, alt-tab, tab switch, focus loss).
    window.addEventListener('blur',          () => this._forceClose());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this._forceClose(); });
  }

  _cancelPending() {
    if (this._pending) { clearTimeout(this._pending); this._pending = null; }
  }

  _clearSafety() { if (this._safety) { clearTimeout(this._safety); this._safety = null; } }

  /** Dismiss the dial without firing (cancel path for lost-release / focus loss). */
  _forceClose() {
    this._cancelPending();
    this._clearSafety();
    if (!this._open) return;
    this._open = false;
    this._hud.dismiss();
  }

  _onDown(e) {
    if (e.button !== 2) return;
    if (Store.isPaused()) return;          // gestures off for this page

    this._cancelPending();
    this._downX = this._curX = e.clientX;
    this._downY = this._curY = e.clientY;
    this._open = false;
    this._engaged = false;

    // Resolve which design + its settings ONCE per press, so a storage change
    // mid-hold can't yank the delay/size out from under an in-progress gesture.
    this._activeDesignId = Store.activeDesign();
    this._activeDesignSettings = Store.designSettingsFor(this._activeDesignId);

    // Hold-to-activate: the dial only appears after the configured delay, so a
    // normal quick right-click still opens the browser's context menu.
    const delay = clamp(this._activeDesignSettings.delay, 0, 3000);
    if (delay <= 0) this._openDial();
    else this._pending = setTimeout(() => this._openDial(), delay);
  }

  _openDial() {
    this._pending = null;
    if (this._open) return;
    this._open = true;
    const ds = this._activeDesignSettings || Store.designSettingsFor('radial');
    this._hud.spawn(this._downX, this._downY, buildWedges(), {
      scale:     clamp(ds.size, 0.5, 1.6),
      bandAlpha: clamp(ds.opacity, 0, 1),
      color:     Store.dialColor(),      // only meaningful for the 'radial' skin
      theme:     Store.dialTheme(),      // only meaningful for the 'radial' skin
      design:    this._activeDesignId,
      timezone:  ds.timezone,
      numerals:  ds.numerals,
    });
    this._ticker.tick(900, 0.10, 0.05);    // soft "open" blip
    this._ticker.loadCustom(Store.soundCustomUrl());   // pre-decode, fire-and-forget
    this._track();                          // reflect any movement during the hold
    // Last-resort auto-dismiss if a release is never seen.
    this._clearSafety();
    this._safety = setTimeout(() => this._forceClose(), 8000);
  }

  _onMove(e) {
    this._curX = e.clientX;
    this._curY = e.clientY;
    if (!this._open) return;
    if (!this._movePending) {
      this._movePending = true;
      requestAnimationFrame(() => this._processMove());
    }
  }

  _processMove() {
    this._movePending = false;
    if (this._open) this._track();
  }

  _track() {
    const dx = this._curX - this._downX;
    const dy = this._curY - this._downY;
    if (Math.hypot(dx, dy) >= this._hud.deadZone()) this._engaged = true;
    const changed = this._hud.track(dx, dy);
    if (changed && this._hud.selected()) {
      this._ticker.playSelected(Store.soundId(), Store.soundCustomUrl(), Store.isPremium());
    }
  }

  _onUp(e) {
    if (e.button !== 2) return;
    this._cancelPending();
    this._clearSafety();
    if (!this._open) return;   // released before the dial opened → native menu

    this._open = false;
    const wedge = this._hud.selected();

    if (wedge && wedge.kind === 'screenshot') {
      // Hide the dial with NO fade before capturing so it never appears in
      // the screenshot, then wait a couple of frames for the browser to
      // actually paint the removal before asking background to capture.
      this._hud.instantHide();
      this._guard.arm();
      requestAnimationFrame(() => requestAnimationFrame(() => this._fire(wedge)));
      return;
    }

    this._hud.dismiss();
    this._guard.arm();         // dial was shown → swallow the context menu
    if (wedge) this._fire(wedge);
  }

  _onCtx(e) {
    if (this._guard.consume()) { e.preventDefault(); e.stopPropagation(); return; }
    // If the menu fires while the dial is still open, the release was lost —
    // cancel the dial and swallow this menu so nothing gets stuck.
    if (this._open) { e.preventDefault(); e.stopPropagation(); this._forceClose(); }
  }

  // ── Action dispatch ──────────────────────────────────────────────────────────
  _fire(wedge) {
    if (wedge.kind === 'nav') {
      this._ticker.tick(2000, 0.18, 0.05);
      if (wedge.action === 'forward')      history.forward();
      else if (wedge.action === 'back')    history.back();
      else if (wedge.action === 'reload')  location.reload();
      return;
    }

    if (wedge.kind === 'screenshot') {
      this._ticker.tick(2200, 0.18, 0.05);
      try { chrome.runtime.sendMessage({ type: 'CAPTURE_SCREENSHOT' }); } catch (_) {}
      return;
    }

    if (wedge.kind === 'newtab') {
      this._ticker.tick(2000, 0.18, 0.05);
      try { chrome.runtime.sendMessage({ type: 'OPEN_NEW_TAB' }); } catch (_) {}
      return;
    }

    // url wedge
    if (wedge.locked) {
      // Premium slot on free tier → ask the background to show the upgrade toast.
      try { chrome.runtime.sendMessage({ type: 'SHOW_UPGRADE' }); } catch (_) {}
      return;
    }
    if (!wedge.url) return;                 // empty slot → cancel
    this._ticker.tick(2000, 0.18, 0.05);
    try { location.assign(wedge.url); } catch (_) { location.href = wedge.url; }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Boot (single-injection guard)
// ═══════════════════════════════════════════════════════════════════════════════
if (!window.__MOUSSY_ENGINE__) {
  window.__MOUSSY_ENGINE__ = new MouseController();
}
