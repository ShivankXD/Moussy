/**
 * MOUSSY — Settings Controller  (settings.js)
 * =============================================
 * All settings-page logic lives here (extension-page CSP forbids inline JS).
 *
 *   • Designs gallery — 9 dial designs (I "Radial Dial" free/default + II-IX
 *     premium reskins). Each has its own size/opacity/hold-delay profile (and
 *     a timezone for the two clock designs); Colours & Themes only apply to I.
 *   • Live preview   — mirrors size, transparency, colour/theme (design I) or
 *     the fixed skin palette (II-IX), and slot favicons/modes, exactly as the
 *     in-page dial renders them. Clock designs tick live in the preview too.
 *   • Sound catalog  — several synthesised tick sounds (mostly premium) plus
 *     a premium "record & trim your own ≤2s clip" custom sound.
 *   • Slot 1 & 2      — dropdown: Open Link / Screenshot / New Tab. Slots are
 *     SHARED across all designs (Cards 2-4 are common, not per-design).
 *   • Import / Export — premium-only JSON round-trip of all settings.
 *
 * Everything persists to chrome.storage.local (shared with content.js), with a
 * localStorage fallback for standalone preview.
 */

'use strict';

const KEYS = {
  slots:          'moussy_gesture_slots',
  plan:           'moussy_plan',
  size:           'moussy_dial_size',
  opacity:        'moussy_dial_opacity',
  delay:          'moussy_dial_delay',
  color:          'moussy_dial_color',
  theme:          'moussy_dial_theme',
  soundId:        'moussy_sound_id',
  soundCustom:    'moussy_sound_custom',
  activeDesign:   'moussy_active_design',
  designSettings: 'moussy_design_settings',
};
const DEF = { size: 0.82, opacity: 0.55, delay: 500, color: 'violet', theme: 'classic', soundId: 'classic' };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const MAX_CUSTOM_SOUND_SEC = 2;

// ── Dial colours + themes + sound catalog — must mirror content.js exactly ────
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
const DIAL_THEMES = {
  classic: { name: 'Classic Neon',  desc: 'Double ring, 24 tick marks, dashed rune ring.',              premium: false },
  glass:   { name: 'Glass Minimal', desc: 'Single thin ring, frosted band, no ticks.',                   premium: true },
  hex:     { name: 'Hex Tech',      desc: 'Faceted octagon wedges, circuit-trace ticks.',                premium: true },
  core:    { name: 'Solid Core',    desc: 'Bold thick ring, blocky cardinal ticks.',                     premium: true },
  occult:  { name: 'Occult Sigil',  desc: 'Dark hexagram overlay — always black, any dial colour.',      premium: true },
  aura:    { name: 'Outer Aura',    desc: 'Thin enchanted ring drawn all around, outside the main ring.', premium: true },
};
const SOUND_CATALOG = {
  classic: { name: 'Classic Tick',      premium: false, synth: { type: 'square',   freq: 1550, dur: 0.045, gain: 0.16 } },
  crystal: { name: 'Crystal Chime',     premium: true,  synth: { type: 'triangle', freq: 2200, freq2: 3100, dur: 0.09,  gain: 0.14 } },
  pulse:   { name: 'Deep Pulse',        premium: true,  synth: { type: 'sine',     freq: 220,  dur: 0.07,  gain: 0.24 } },
  laser:   { name: 'Laser Zap',         premium: true,  synth: { type: 'sawtooth', freq: 2400, freqEnd: 600, dur: 0.06, gain: 0.13 } },
  arcade:  { name: 'Retro Arcade Blip', premium: true,  synth: { type: 'square',   freq: 900,  freq2: 1500, dur: 0.055, gain: 0.18 } },
  cyber:   { name: 'Cyber Alert',       premium: true,  synth: { type: 'sawtooth', freq: 1800, freq2: 2700, dur: 0.05, gain: 0.15 } },
  custom:  { name: 'Custom Sound',      premium: true,  custom: true },
};

/** Mirrors content.js's DESIGN_REGISTRY exactly (ids, roman numerals, fixed palettes). */
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
const DEFAULT_TIMEZONE = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) { return 'UTC'; } })();
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

function getTZTime(tz) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || 'UTC', hour12: false,
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      weekday: 'short', day: '2-digit', month: 'short',
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    return {
      h: parseInt(get('hour'), 10) % 24 || 0, m: parseInt(get('minute'), 10) || 0, s: parseInt(get('second'), 10) || 0,
      weekday: get('weekday') || '', day: get('day') || '', month: get('month') || '',
    };
  } catch (_) {
    const d = new Date();
    return { h: d.getHours(), m: d.getMinutes(), s: d.getSeconds(), weekday: '', day: String(d.getDate()).padStart(2, '0'), month: d.toLocaleString('en-US', { month: 'short' }) };
  }
}

// ── storage adapter ───────────────────────────────────────────────────────────
const hasChrome = typeof chrome !== 'undefined' && chrome?.storage?.local;
const store = {
  get(keys) {
    if (hasChrome) return new Promise((r) => chrome.storage.local.get(keys, r));
    const o = {};
    for (const k of keys) { try { o[k] = JSON.parse(localStorage.getItem(k)); } catch { o[k] = null; } }
    return Promise.resolve(o);
  },
  set(obj) {
    if (hasChrome) return new Promise((r) => chrome.storage.local.set(obj, r));
    for (const [k, v] of Object.entries(obj)) localStorage.setItem(k, JSON.stringify(v));
    return Promise.resolve();
  },
};

// ── state ─────────────────────────────────────────────────────────────────────
const state = {
  size: DEF.size, opacity: DEF.opacity, delay: DEF.delay, color: DEF.color, theme: DEF.theme,   // design I ("radial") — legacy flat keys
  soundId: DEF.soundId, soundCustom: null,
  slots: ['', '', '', '', ''], slotModes: ['url', 'url', 'url', 'url', 'url'],                  // shared across ALL designs
  plan: 'free',
  activeDesign: 'radial',   // which design content.js actually renders
  selectedTab: 'radial',    // which design's profile panel is open in THIS UI (not persisted)
  otherDesigns: {},         // { [designId]: {size,opacity,delay,timezone} } — excludes 'radial'
};
const $ = (id) => document.getElementById(id);
const isPremium = () => state.plan === 'monthly' || state.plan === 'legend';

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

/** Per-design size/opacity/delay/timezone — 'radial' uses the legacy flat state fields. */
function getTabSettings(id) {
  if (id === 'radial') return { size: state.size, opacity: state.opacity, delay: state.delay, timezone: '' };
  if (!state.otherDesigns[id]) state.otherDesigns[id] = { size: DEF.size, opacity: DEF.opacity, delay: DEF.delay, timezone: DEFAULT_TIMEZONE };
  return state.otherDesigns[id];
}
function setTabSize(id, v)    { if (id === 'radial') state.size = v;    else getTabSettings(id).size = v; }
function setTabOpacity(id, v) { if (id === 'radial') state.opacity = v; else getTabSettings(id).opacity = v; }
function setTabDelay(id, v)   { if (id === 'radial') state.delay = v;   else getTabSettings(id).delay = v; }
function setTabTimezone(id, v){ if (id !== 'radial') getTabSettings(id).timezone = v; }

// ── wedge model (clockwise from North) — SHARED slot bindings, used by every design ──
function wedgeModel() {
  const premium = isPremium();
  const slot = (slotNo, i) => {
    const url = (state.slots[i] || '').trim(), mode = state.slotModes[i] || 'url';
    const locked = slotNo >= 2 && !premium;
    if (!locked && mode === 'screenshot') return { kind: 'screenshot', slotNo, locked: false };
    if (!locked && mode === 'newtab')     return { kind: 'newtab',     slotNo, locked: false };
    return { kind: 'url', slotNo, url, host: hostOf(url), locked };
  };
  return [
    slot(1, 0), slot(2, 1),
    { kind: 'nav', action: 'forward' },
    slot(3, 2),
    { kind: 'nav', action: 'reload' },
    slot(4, 3),
    { kind: 'nav', action: 'back' },
    slot(5, 4),
  ];
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Live preview dial renderer (mirrors content.js RadialDialHUD)
// ═══════════════════════════════════════════════════════════════════════════════
function wedgePath(c, RO, RI, a0, a1, straight) {
  const r = (a) => a * Math.PI / 180;
  const p = (rr, a) => [c + rr * Math.cos(r(a)), c + rr * Math.sin(r(a))];
  const [ox0, oy0] = p(RO, a0), [ox1, oy1] = p(RO, a1), [ix1, iy1] = p(RI, a1), [ix0, iy0] = p(RI, a0);
  const outerSeg = straight ? `L ${ox1} ${oy1}` : `A ${RO} ${RO} 0 0 1 ${ox1} ${oy1}`;
  const innerSeg = straight ? `L ${ix0} ${iy0}` : `A ${RI} ${RI} 0 0 0 ${ix0} ${iy0}`;
  return `M ${ox0} ${oy0} ${outerSeg} L ${ix1} ${iy1} ${innerSeg} Z`;
}
function hexRgba(hex, a) {
  const h = (hex || '#a855f7').replace('#', '');
  const r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
  return `rgba(${r},${g},${b},${a})`;
}

// deterministic pseudo-noise so preview decoration matches content.js exactly
function prand(i) { const x = Math.sin(i * 127.1 + 3.7) * 43758.5453; return x - Math.floor(x); }

let _previewClockInterval = null;
function clearPreviewClock() { if (_previewClockInterval) { clearInterval(_previewClockInterval); _previewClockInterval = null; } }

/** Dispatcher — routes to the design-I renderer or a skin-preview renderer. */
function renderPreview() {
  clearPreviewClock();
  const stage = $('preview-stage');
  if (!stage) return;
  stage.querySelector('.pv-dial')?.remove();
  if (state.selectedTab === 'radial') renderRadialPreview(stage);
  else renderSkinPreview(stage, state.selectedTab);
}

/** HTML icon overlays shared by both the radial preview and every skin preview. */
function buildPreviewIcons(wrap, model, c, ICON, iconScale, bright) {
  const rad = (d) => d * Math.PI / 180;
  model.forEach((w, i) => {
    if (w.kind !== 'url' && w.kind !== 'screenshot' && w.kind !== 'newtab') return;
    const ang = rad(-90 + i * 45);
    const x = c + ICON * Math.cos(ang), y = c + ICON * Math.sin(ang);
    const box = document.createElement('div');
    box.className = 'pv-ico';
    box.style.left = `${x}px`; box.style.top = `${y}px`;
    box.style.transform = `translate(-50%,-50%) scale(${iconScale})`;

    if (w.kind === 'screenshot') {
      box.innerHTML = `<div class="pv-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="${bright}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg></div>`;
    } else if (w.kind === 'newtab') {
      box.innerHTML = `<div class="pv-glyph"><svg viewBox="0 0 24 24" fill="none" stroke="${bright}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 10v6M9 13h6"/></svg></div>`;
    } else if (w.url && !w.locked) {
      const img = document.createElement('img');
      img.src = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(w.host)}`;
      img.addEventListener('error', () => {
        const l = document.createElement('div'); l.className = 'pv-letter';
        l.textContent = (w.host[0] || '?').toUpperCase(); img.replaceWith(l);
      });
      box.appendChild(img);
    } else {
      const ph = document.createElement('div'); ph.className = 'pv-ph'; ph.textContent = `Slot ${w.slotNo}`;
      box.appendChild(ph);
    }
    if (w.locked) {
      const lk = document.createElement('div'); lk.className = 'pv-lock';
      lk.innerHTML = `<svg viewBox="0 0 24 24" width="8" height="8"><rect x="4" y="11" width="16" height="10" rx="2" fill="#1a1326" stroke="${bright}" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="${bright}" stroke-width="2"/></svg>`;
      box.appendChild(lk);
    }
    wrap.appendChild(box);
  });
}

/** Design I preview — fully user-customisable colour + theme. */
function renderRadialPreview(stage) {
  const ts = getTabSettings('radial');
  const size = ts.size, a = ts.opacity;
  const theme = isPremium() ? state.theme : 'classic';
  const col = DIAL_COLORS[state.color] || DIAL_COLORS.violet;
  const { accent, bright } = col;
  const Dp = Math.round(210 * size);
  const c = Dp / 2, s = Dp / 210;
  const RO = Dp * 0.43, RI = Dp * 0.31, ICON = Dp * (103 / 280);
  const iconScale = Dp / 280;
  const model = wedgeModel();
  const rad = (d) => d * Math.PI / 180;

  const ringMainW  = theme === 'core' ? 4 : (theme === 'glass' ? 1 : 2);
  const showRingIn = theme !== 'core';
  const dividerW   = theme === 'core' ? 2 : (theme === 'hex' ? 1.4 : (theme === 'glass' ? 0.6 : 1));
  const dividerA   = theme === 'core' ? 0.45 : (theme === 'hex' ? 0.35 : (theme === 'glass' ? 0.12 : 0.20));
  const wedgeStrokeA = theme === 'glass' ? 0.10 : 0.20;
  const straight = theme === 'hex';

  let fill0, fill1;
  if (theme === 'glass') { fill0 = `rgba(255,255,255,${Math.min(0.16, a * 0.5)})`; fill1 = hexRgba(accent, a * 0.30); }
  else if (theme === 'hex') { fill0 = hexRgba(accent, a * 0.78); fill1 = hexRgba(accent, a * 0.50); }
  else if (theme === 'core') { fill0 = hexRgba(accent, Math.min(1, a + 0.18)); fill1 = hexRgba(bright, Math.min(1, a + 0.05)); }
  else { fill0 = hexRgba(accent, a * 0.55); fill1 = `rgba(11,7,20,${a})`; }

  let parts = '';
  parts += `<defs>
    <filter id="pvGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${1.6*s}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="pvBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${fill0}"/><stop offset="100%" stop-color="${fill1}"/></linearGradient>
  </defs>`;

  if (theme === 'classic') {
    parts += `<circle cx="${c}" cy="${c}" r="${RO + 8*s}" fill="none" stroke="${hexRgba(accent,0.3)}" stroke-width="1" stroke-dasharray="2 7"/>`;
    for (let i = 0; i < 24; i++) {
      const ang = rad(i * 15), r0 = RO + 2*s, r1 = RO + (i % 2 ? 5 : 8)*s;
      parts += `<line x1="${c+r0*Math.cos(ang)}" y1="${c+r0*Math.sin(ang)}" x2="${c+r1*Math.cos(ang)}" y2="${c+r1*Math.sin(ang)}" stroke="${hexRgba(accent,0.4)}" stroke-width="1"/>`;
    }
  } else if (theme === 'hex') {
    for (let i = 0; i < 8; i++) {
      const ang = rad(-67.5 + i * 45), r0 = RO + 2*s, r1 = RO + 9*s;
      const x0 = c+r0*Math.cos(ang), y0 = c+r0*Math.sin(ang), x1 = c+r1*Math.cos(ang), y1 = c+r1*Math.sin(ang);
      parts += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${hexRgba(accent,0.4)}" stroke-width="1"/><circle cx="${x1}" cy="${y1}" r="${1.4*s}" fill="${hexRgba(accent,0.4)}"/>`;
    }
  } else if (theme === 'core') {
    for (let i = 0; i < 8; i++) {
      const ang = rad(-90 + i * 45), r0 = RO + 3*s, x = c+r0*Math.cos(ang), y = c+r0*Math.sin(ang), box = 3.4*s;
      parts += `<rect x="${x-box/2}" y="${y-box/2}" width="${box}" height="${box}" fill="${hexRgba(accent,0.4)}" transform="rotate(${45+i*45} ${x} ${y})"/>`;
    }
  } else if (theme === 'occult') {
    parts += `<circle cx="${c}" cy="${c}" r="${RO + 7*s}" fill="none" stroke="rgba(10,8,16,0.85)" stroke-width="${3*s}"/>`;
    parts += `<circle cx="${c}" cy="${c}" r="${RO + 7*s}" fill="none" stroke="${hexRgba(accent,0.5)}" stroke-width="${0.8*s}" stroke-dasharray="1 5"/>`;
    const R2 = RO + 15*s;
    const hexPts = (offset) => [0,120,240].map((o) => { const ang2 = rad(-90+offset+o); return `${c+R2*Math.cos(ang2)},${c+R2*Math.sin(ang2)}`; }).join(' ');
    parts += `<polygon points="${hexPts(0)}" fill="none" stroke="rgba(20,16,28,0.7)" stroke-width="${1*s}"/>`;
    parts += `<polygon points="${hexPts(60)}" fill="none" stroke="rgba(20,16,28,0.7)" stroke-width="${1*s}"/>`;
  } else if (theme === 'aura') {
    const R3 = RO + 16*s;
    parts += `<circle cx="${c}" cy="${c}" r="${R3}" fill="none" stroke="${hexRgba(accent,0.35)}" stroke-width="${0.7*s}" stroke-dasharray="3 4"/>`;
    for (let i = 0; i < 16; i++) {
      const ang = rad(i * 22.5), x = c+R3*Math.cos(ang), y = c+R3*Math.sin(ang);
      parts += `<circle cx="${x}" cy="${y}" r="${1.1*s}" fill="${hexRgba(bright,0.55)}"/>`;
    }
  }

  for (let i = 0; i < 8; i++) {
    const centre = -90 + i * 45;
    parts += `<path d="${wedgePath(c, RO, RI, centre - 22.5, centre + 22.5, straight)}" fill="url(#pvBand)" stroke="${hexRgba(accent,wedgeStrokeA)}" stroke-width="1"/>`;
  }
  for (let i = 0; i < 8; i++) {
    const ang = rad(-67.5 + i * 45);
    parts += `<line x1="${c+RI*Math.cos(ang)}" y1="${c+RI*Math.sin(ang)}" x2="${c+RO*Math.cos(ang)}" y2="${c+RO*Math.sin(ang)}" stroke="${hexRgba(accent,dividerA)}" stroke-width="${dividerW}"/>`;
  }
  parts += `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(bright,0.95)}" stroke-width="${ringMainW}" filter="url(#pvGlow)"/>`;
  if (showRingIn) parts += `<circle cx="${c}" cy="${c}" r="${RI}" fill="none" stroke="${hexRgba(accent,0.55)}" stroke-width="1.4" filter="url(#pvGlow)"/>`;

  const glyph = (ang, kind) => {
    const x = c + ICON * Math.cos(rad(ang)), y = c + ICON * Math.sin(rad(ang));
    const t = `translate(${x} ${y}) scale(${s})`;
    const st = `fill="none" stroke="${bright}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"`;
    if (kind === 'forward') return `<path transform="${t}" d="M-8 0 H4 M4 -4.5 L8.5 0 L4 4.5" ${st}/>`;
    if (kind === 'back')    return `<path transform="${t}" d="M8 0 H-4 M-4 -4.5 L-8.5 0 L-4 4.5" ${st}/>`;
    return `<g transform="${t}"><path d="M6.5 -2.5 A7 7 0 1 1 3 -6.3" ${st}/><path d="M6.6 -6.6 L6.9 -1.6 L2 -3.4 Z" fill="${bright}"/></g>`;
  };
  parts += glyph(0, 'forward') + glyph(90, 'reload') + glyph(180, 'back');
  parts += `<circle cx="${c}" cy="${c}" r="${11*s}" fill="none" stroke="${hexRgba(accent,0.30)}" stroke-width="1"/>`;
  for (const [x1,y1,x2,y2] of [[-9,0,-5,0],[5,0,9,0],[0,-9,0,-5],[0,5,0,9]])
    parts += `<line x1="${c+x1*s}" y1="${c+y1*s}" x2="${c+x2*s}" y2="${c+y2*s}" stroke="${hexRgba(bright,0.85)}" stroke-width="1.2" stroke-linecap="round"/>`;
  parts += `<circle cx="${c}" cy="${c}" r="${2.4*s}" fill="${bright}" filter="url(#pvGlow)"/>`;

  const wrap = document.createElement('div');
  wrap.className = 'pv-dial';
  wrap.style.width = wrap.style.height = `${Dp}px`;
  wrap.innerHTML = `<svg width="${Dp}" height="${Dp}" viewBox="0 0 ${Dp} ${Dp}" style="overflow:visible">${parts}</svg>`;

  buildPreviewIcons(wrap, model, c, ICON, iconScale, bright);
  stage.appendChild(wrap);
}

// ── Skin previews (designs II-IX) — mirror content.js's _skin_* builders ───────
const SKIN_PREVIEW_BUILDERS = {
  ghost(c, RO, RI, s, rad, accent, bright) {
    // multi-layer glowing wispy ring
    let p = `<circle cx="${c}" cy="${c}" r="${RO+2*s}" fill="none" stroke="${hexRgba(bright,0.28)}" stroke-width="${7*s}" filter="url(#skGlowStrong)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(bright,0.6)}" stroke-width="${2*s}" filter="url(#skGlow)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RO-3*s}" fill="none" stroke="${hexRgba(accent,0.35)}" stroke-width="${1*s}" stroke-dasharray="1 6"/>`;
    // ghost silhouettes straddling the ring edge
    [22, 96, 168, 262, 322].forEach((deg, i) => {
      const a = rad(deg), gr = RO + (i % 2 ? 4 : 9) * s, x = c + gr * Math.cos(a), y = c + gr * Math.sin(a);
      p += `<g transform="translate(${x} ${y}) scale(${s*(0.5+(i%2)*0.14)})" opacity="0.92">
        <path d="M-9 5 C-9 -9 9 -9 9 5 L9 11 L5 7 L1 11 L-3 7 L-7 11 Z" fill="${hexRgba(bright,0.6)}" filter="url(#skGlow)"/>
        <circle cx="-3" cy="-1" r="1.2" fill="#1a0f2e"/><circle cx="3" cy="-1" r="1.2" fill="#1a0f2e"/>
      </g>`;
    });
    // drifting mist wisps outside the ring
    for (let i = 0; i < 12; i++) { const a = prand(i)*Math.PI*2, r = RO + (2+prand(i+40)*14)*s; p += `<circle cx="${c+r*Math.cos(a)}" cy="${c+r*Math.sin(a)}" r="${(0.6+prand(i+80))*s}" fill="${hexRgba(bright,0.4)}"/>`; }
    return p;
  },
  magic(c, RO, RI, s, rad, accent, bright) {
    // outer concentric magic-circle rings
    let p = `<circle cx="${c}" cy="${c}" r="${RO+12*s}" fill="none" stroke="${hexRgba(accent,0.35)}" stroke-width="${0.8*s}"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RO+7*s}" fill="none" stroke="${hexRgba(bright,0.5)}" stroke-width="${1*s}" filter="url(#skGlow)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RO+9.5*s}" fill="none" stroke="${hexRgba(accent,0.4)}" stroke-width="${0.6*s}" stroke-dasharray="2 4"/>`;
    // geometric rune marks between the outer rings
    const runes = ['M-2 -3 L0 -3 L0 3 M0 -1 L2 1', 'M0 -3 L0 3 M-2 -1 L2 -1', 'M-2 -3 L2 3 M2 -3 L-2 3', 'M-2 -3 L2 -3 L-2 3 L2 3', 'M0 -3 L0 3 M-2 -3 L2 -3'];
    const Rr = RO + 9.5 * s;
    for (let i = 0; i < 12; i++) { const a = rad(i*30-90), x = c+Rr*Math.cos(a), y = c+Rr*Math.sin(a); p += `<path d="${runes[i%runes.length]}" transform="translate(${x} ${y}) rotate(${i*30+90}) scale(${s*0.9})" fill="none" stroke="${hexRgba(bright,0.7)}" stroke-width="0.8" stroke-linecap="round"/>`; }
    // inner heptagram (7-point star) in the centre hole
    const Rh = RI * 0.72; const hp = [];
    for (let i = 0; i < 7; i++) { const a = rad(-90 + i*(360*3/7)); hp.push(`${c+Rh*Math.cos(a)},${c+Rh*Math.sin(a)}`); }
    p += `<polygon points="${hp.join(' ')}" fill="none" stroke="${hexRgba(bright,0.7)}" stroke-width="${1*s}" filter="url(#skGlow)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${Rh}" fill="none" stroke="${hexRgba(accent,0.4)}" stroke-width="${0.6*s}"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${Rh*0.52}" fill="none" stroke="${hexRgba(bright,0.4)}" stroke-width="${0.6*s}" stroke-dasharray="2 2"/>`;
    // sparkle dust outside
    for (let i = 0; i < 10; i++) { const a = prand(i)*Math.PI*2, r = RO + (2+prand(i+30)*12)*s, x = c+r*Math.cos(a), y = c+r*Math.sin(a); p += `<path d="M${x-1.5} ${y} L${x} ${y-1.5} L${x+1.5} ${y} L${x} ${y+1.5} Z" fill="${hexRgba(bright,0.6)}"/>`; }
    return p;
  },
  ninja(c, RO, RI, s, rad, accent, bright) {
    const pt = (r, a) => `${c + r * Math.cos(a)} ${c + r * Math.sin(a)}`;
    // 8 dark stone plates with gaps
    let p = '';
    for (let i = 0; i < 8; i++) {
      const a0 = rad(-90 + i*45 - 19), a1 = rad(-90 + i*45 + 19), ro = RO+3*s, ri = RO-3*s;
      p += `<path d="M ${pt(ro,a0)} A ${ro} ${ro} 0 0 1 ${pt(ro,a1)} L ${pt(ri,a1)} A ${ri} ${ri} 0 0 0 ${pt(ri,a0)} Z" fill="rgba(14,10,12,0.92)" stroke="${hexRgba(accent,0.5)}" stroke-width="${0.8*s}"/>`;
    }
    // glowing red cracks radiating between plates
    for (let i = 0; i < 8; i++) { const a = rad(-67.5 + i*45); p += `<line x1="${c+(RO-3*s)*Math.cos(a)}" y1="${c+(RO-3*s)*Math.sin(a)}" x2="${c+(RO+7*s)*Math.cos(a)}" y2="${c+(RO+7*s)*Math.sin(a)}" stroke="${hexRgba(accent,0.75)}" stroke-width="${0.8*s}" filter="url(#skGlow)"/>`; }
    // red shuriken in the centre hole
    let g = `<g transform="translate(${c} ${c}) scale(${s*0.9})">`;
    for (let i = 0; i < 4; i++) g += `<path d="M0 0 L4 -16 L9 -5 Z" fill="${hexRgba(accent,0.6)}" transform="rotate(${i*90})" filter="url(#skGlow)"/>`;
    g += `<circle cx="0" cy="0" r="3" fill="none" stroke="${hexRgba(bright,0.7)}" stroke-width="1"/></g>`; p += g;
    p += `<text x="${c}" y="${c-RO-10*s}" fill="${hexRgba(accent,0.9)}" font-size="${13*s}" font-family="'Segoe UI',sans-serif" font-weight="700" text-anchor="middle" filter="url(#skGlow)">忍</text>`;
    p += `<text x="${c}" y="${c+RO+18*s}" fill="${hexRgba(accent,0.9)}" font-size="${13*s}" font-family="'Segoe UI',sans-serif" font-weight="700" text-anchor="middle" filter="url(#skGlow)">影</text>`;
    return p;
  },
  chrono(c, RO, RI, s, rad, accent, bright) {
    let p = `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(bright,0.6)}" stroke-width="${1.4*s}" filter="url(#skGlow)"/>`;
    for (let i = 0; i < 8; i++) {
      const a = rad(-67.5 + i*45), r0 = RO+2*s, r1 = RO+8*s;
      const x0 = c+r0*Math.cos(a), y0 = c+r0*Math.sin(a), x1 = c+r1*Math.cos(a), y1 = c+r1*Math.sin(a);
      p += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y1}" stroke="${hexRgba(accent,0.5)}" stroke-width="${1*s}"/><circle cx="${x1}" cy="${y1}" r="${1.3*s}" fill="${hexRgba(accent,0.7)}"/>`;
    }
    p += `<circle cx="${c}" cy="${c}" r="${RI}" fill="none" stroke="${hexRgba(accent,0.35)}" stroke-width="${0.8*s}" stroke-dasharray="3 3"/>`;
    const Re = RI * 0.62;
    p += `<path d="M ${c} ${c-Re} C ${c+Re*0.85} ${c-Re*0.3}, ${c+Re*0.85} ${c+Re*0.3}, ${c} ${c+Re} C ${c-Re*0.85} ${c+Re*0.3}, ${c-Re*0.85} ${c-Re*0.3}, ${c} ${c-Re} Z" fill="${hexRgba(accent,0.55)}" stroke="${bright}" stroke-width="${1*s}" filter="url(#skGlowStrong)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${2.6*s}" fill="${bright}" filter="url(#skGlow)"/>`;
    return p;
  },
  ice(c, RO, RI, s, rad, accent, bright) {
    let p = `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(bright,0.5)}" stroke-width="${1.2*s}" filter="url(#skGlow)"/>`;
    // outward crystal shards (alternating long/short)
    for (let i = 0; i < 20; i++) {
      const a = rad(i*18), bx = c+RO*Math.cos(a), by = c+RO*Math.sin(a);
      const len = (i%2===0?12:7)*s, tx = c+(RO+len)*Math.cos(a), ty = c+(RO+len)*Math.sin(a);
      const perp = a+Math.PI/2, w = (i%2===0?3:2)*s;
      p += `<polygon points="${bx+w*Math.cos(perp)},${by+w*Math.sin(perp)} ${tx},${ty} ${bx-w*Math.cos(perp)},${by-w*Math.sin(perp)}" fill="${hexRgba(bright,0.5)}" stroke="${hexRgba(accent,0.6)}" stroke-width="${0.4*s}"/>`;
    }
    // detailed snowflake in the centre hole
    const Rf = RI * 0.7;
    let g = `<g transform="translate(${c} ${c})">`;
    for (let i = 0; i < 6; i++) {
      const rot = i * 60;
      g += `<line x1="0" y1="0" x2="0" y2="${-Rf}" stroke="${bright}" stroke-width="${1*s}" stroke-linecap="round" transform="rotate(${rot})" filter="url(#skGlow)"/>`;
      g += `<line x1="0" y1="${-Rf*0.5}" x2="${4.5*s}" y2="${-Rf*0.66}" stroke="${bright}" stroke-width="${0.8*s}" stroke-linecap="round" transform="rotate(${rot})"/>`;
      g += `<line x1="0" y1="${-Rf*0.5}" x2="${-4.5*s}" y2="${-Rf*0.66}" stroke="${bright}" stroke-width="${0.8*s}" stroke-linecap="round" transform="rotate(${rot})"/>`;
      g += `<line x1="0" y1="${-Rf*0.76}" x2="${3.4*s}" y2="${-Rf*0.88}" stroke="${bright}" stroke-width="${0.7*s}" stroke-linecap="round" transform="rotate(${rot})"/>`;
      g += `<line x1="0" y1="${-Rf*0.76}" x2="${-3.4*s}" y2="${-Rf*0.88}" stroke="${bright}" stroke-width="${0.7*s}" stroke-linecap="round" transform="rotate(${rot})"/>`;
    }
    g += '</g>'; p += g;
    for (let i = 0; i < 8; i++) { const a = prand(i)*Math.PI*2, r = RO + (2+prand(i+25)*12)*s; p += `<circle cx="${c+r*Math.cos(a)}" cy="${c+r*Math.sin(a)}" r="${0.8*s}" fill="${hexRgba(bright,0.6)}"/>`; }
    return p;
  },
  dragon(c, RO, RI, s, rad, accent, bright) {
    // wavy flame tongues licking outward
    let p = '';
    for (let i = 0; i < 18; i++) {
      const a = rad(i*20), bx = c+RO*Math.cos(a), by = c+RO*Math.sin(a);
      const len = (9+prand(i)*8)*s, bend = a+(prand(i+10)-0.5)*0.7;
      const mx = c+(RO+len*0.55)*Math.cos(bend), my = c+(RO+len*0.55)*Math.sin(bend);
      const ta = a+(prand(i+20)-0.5)*0.3, tx = c+(RO+len)*Math.cos(ta), ty = c+(RO+len)*Math.sin(ta);
      const perp = a+Math.PI/2, w = 2*s;
      const b1x = bx+w*Math.cos(perp), b1y = by+w*Math.sin(perp), b2x = bx-w*Math.cos(perp), b2y = by-w*Math.sin(perp);
      p += `<path d="M${b1x} ${b1y} Q ${mx} ${my} ${tx} ${ty} Q ${mx} ${my} ${b2x} ${b2y} Z" fill="${hexRgba(i%2?accent:bright,0.6)}" filter="url(#skGlow)"/>`;
    }
    // scale ring
    p += `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(accent,0.6)}" stroke-width="${2*s}" filter="url(#skGlow)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RO-3*s}" fill="none" stroke="${hexRgba(accent,0.3)}" stroke-width="${1*s}" stroke-dasharray="3 3"/>`;
    // geometric dragon-head sigil in the centre hole
    p += `<g transform="translate(${c} ${c}) scale(${s*1.15})">
      <path d="M-11 5 L-5 -9 L-1 -3 L0 -9 L1 -3 L5 -9 L11 5 L4 3 L0 8 L-4 3 Z" fill="${hexRgba(accent,0.7)}" stroke="${bright}" stroke-width="0.7" filter="url(#skGlowStrong)"/>
      <circle cx="-4" cy="-1" r="1.1" fill="#fff2d0"/><circle cx="4" cy="-1" r="1.1" fill="#fff2d0"/>
    </g>`;
    return p;
  },
  aclock(c, RO, RI, s, rad, accent, bright) {
    let p = `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(bright,0.7)}" stroke-width="${1.6*s}" filter="url(#skGlow)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RI}" fill="rgba(8,7,14,0.4)" stroke="${hexRgba(accent,0.5)}" stroke-width="${1*s}"/>`;
    const numerals = ['XII','I','II','III','IIII','V','VI','VII','VIII','IX','X','XI'];
    const Rn = RI * 0.78;
    numerals.forEach((num, i) => { const a = rad(i*30-90), x = c+Rn*Math.cos(a), y = c+Rn*Math.sin(a); p += `<text x="${x}" y="${y+2.4*s}" fill="${hexRgba(bright,0.9)}" font-size="${7*s}" font-family="Georgia,serif" text-anchor="middle">${num}</text>`; });
    for (let i = 0; i < 60; i++) { if (i % 5 === 0) continue; const a = rad(i*6), r0 = RI*0.9, r1 = RI*0.96; p += `<line x1="${c+r0*Math.cos(a)}" y1="${c+r0*Math.sin(a)}" x2="${c+r1*Math.cos(a)}" y2="${c+r1*Math.sin(a)}" stroke="${hexRgba(accent,0.4)}" stroke-width="${0.5*s}"/>`; }
    p += `<line class="pv-hour" x1="${c}" y1="${c}" x2="${c}" y2="${c-RI*0.42}" stroke="${bright}" stroke-width="${2.2*s}" stroke-linecap="round" filter="url(#skGlow)"/>`;
    p += `<line class="pv-min" x1="${c}" y1="${c}" x2="${c}" y2="${c-RI*0.6}" stroke="${bright}" stroke-width="${1.5*s}" stroke-linecap="round" filter="url(#skGlow)"/>`;
    p += `<line class="pv-sec" x1="${c}" y1="${c}" x2="${c}" y2="${c-RI*0.68}" stroke="${hexRgba(accent,0.9)}" stroke-width="${0.8*s}" stroke-linecap="round"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${2.2*s}" fill="${bright}" filter="url(#skGlow)"/>`;
    return p;
  },
  dclock(c, RO, RI, s, rad, accent, bright) {
    let p = `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="${hexRgba(bright,0.6)}" stroke-width="${1.4*s}" filter="url(#skGlow)"/>`;
    p += `<circle cx="${c}" cy="${c}" r="${RI}" fill="rgba(8,7,14,0.4)" stroke="${hexRgba(accent,0.5)}" stroke-width="${1*s}"/>`;
    for (let i = 0; i < 40; i++) { const a = rad(i*9), r0 = RO+2*s, r1 = RO+5*s; p += `<line x1="${c+r0*Math.cos(a)}" y1="${c+r0*Math.sin(a)}" x2="${c+r1*Math.cos(a)}" y2="${c+r1*Math.sin(a)}" stroke="${hexRgba(accent,0.35)}" stroke-width="${0.6*s}"/>`; }
    return p;
  },
};

function renderSkinPreview(stage, designId) {
  const d = DESIGN_MAP[designId];
  if (!d || !d.palette) return;
  const { accent, bright } = d.palette;
  const ts = getTabSettings(designId);
  const Dp = Math.round(210 * ts.size);
  const c = Dp / 2, s = Dp / 210;
  const RO = Dp * 0.43, RI = Dp * 0.31, ICON = Dp * (103 / 280);
  const iconScale = Dp / 280;
  const model = wedgeModel();
  const rad = (deg) => deg * Math.PI / 180;

  const a = ts.opacity;
  const isClock = !!d.clock;
  let parts = `<defs>
    <filter id="skGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${1.6*s}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <filter id="skGlowStrong" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="${3*s}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="skBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${hexRgba(accent, a*0.45)}"/><stop offset="100%" stop-color="rgba(8,6,14,${a*0.75})"/></linearGradient>
  </defs>`;

  const builder = SKIN_PREVIEW_BUILDERS[designId];
  if (builder) parts += builder(c, RO, RI, s, rad, accent, bright);

  // Clear band segments (mirror content.js — "options crystal clear")
  for (let i = 0; i < 8; i++) {
    const centre = -90 + i * 45;
    parts += `<path d="${wedgePath(c, RO, RI, centre - 22.5, centre + 22.5, false)}" fill="url(#skBand)" stroke="${hexRgba(accent,0.22)}" stroke-width="1"/>`;
  }
  for (let i = 0; i < 8; i++) {
    const ang = rad(-67.5 + i * 45);
    parts += `<line x1="${c+RI*Math.cos(ang)}" y1="${c+RI*Math.sin(ang)}" x2="${c+RO*Math.cos(ang)}" y2="${c+RO*Math.sin(ang)}" stroke="${hexRgba(accent,0.28)}" stroke-width="1"/>`;
  }
  // nav glyphs (forward E / reload S / back W) — the fixed-action options
  const navGlyph = (ang, kind) => {
    const x = c + ICON * Math.cos(rad(ang)), y = c + ICON * Math.sin(rad(ang));
    const t = `translate(${x} ${y}) scale(${s})`;
    const st = `fill="none" stroke="${bright}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" filter="url(#skGlow)"`;
    if (kind === 'forward') return `<path transform="${t}" d="M-8 0 H4 M4 -4.5 L8.5 0 L4 4.5" ${st}/>`;
    if (kind === 'back')    return `<path transform="${t}" d="M8 0 H-4 M-4 -4.5 L-8.5 0 L-4 4.5" ${st}/>`;
    return `<g transform="${t}"><path d="M6.5 -2.5 A7 7 0 1 1 3 -6.3" ${st}/><path d="M6.6 -6.6 L6.9 -1.6 L2 -3.4 Z" fill="${bright}"/></g>`;
  };
  parts += navGlyph(0, 'forward') + navGlyph(90, 'reload') + navGlyph(180, 'back');
  // reticle — non-clock designs only (clocks use the centre for the clock)
  if (!isClock) {
    parts += `<circle cx="${c}" cy="${c}" r="${11*s}" fill="none" stroke="${hexRgba(accent,0.30)}" stroke-width="1"/>`;
    for (const [x1,y1,x2,y2] of [[-9,0,-5,0],[5,0,9,0],[0,-9,0,-5],[0,5,0,9]])
      parts += `<line x1="${c+x1*s}" y1="${c+y1*s}" x2="${c+x2*s}" y2="${c+y2*s}" stroke="${hexRgba(bright,0.85)}" stroke-width="1.2" stroke-linecap="round"/>`;
    parts += `<circle cx="${c}" cy="${c}" r="${2.4*s}" fill="${bright}" filter="url(#skGlow)"/>`;
  }

  const wrap = document.createElement('div');
  wrap.className = 'pv-dial';
  wrap.style.width = wrap.style.height = `${Dp}px`;
  wrap.innerHTML = `<svg width="${Dp}" height="${Dp}" viewBox="0 0 ${Dp} ${Dp}" style="overflow:visible">${parts}</svg>`;

  if (d.clock) {
    const panel = document.createElement('div');
    panel.className = 'pv-clock-digital';
    panel.style.cssText = `position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) scale(${s});text-align:center;pointer-events:none;`;
    panel.innerHTML = `<div class="pv-cd-time" style="font:700 15px 'Share Tech Mono',monospace;color:${bright};text-shadow:0 0 8px ${hexRgba(accent,0.8)};letter-spacing:1px">--:--</div><div class="pv-cd-ampm" style="font:600 7px sans-serif;color:${hexRgba(bright,0.8)};letter-spacing:1px">--</div><div class="pv-cd-date" style="font:600 6.5px sans-serif;color:${hexRgba(bright,0.7)};letter-spacing:.5px;margin-top:1px">---- -- ---</div>`;
    panel.style.display = designId === 'dclock' ? '' : 'none';
    wrap.appendChild(panel);
  }

  buildPreviewIcons(wrap, model, c, ICON, iconScale, bright);
  stage.appendChild(wrap);

  if (designId === 'aclock' || designId === 'dclock') startPreviewClock(designId, wrap, c, ts.timezone);
}

function startPreviewClock(designId, wrap, c, timezone) {
  const update = () => {
    const t = getTZTime(timezone);
    if (designId === 'aclock') {
      const hourEl = wrap.querySelector('.pv-hour'), minEl = wrap.querySelector('.pv-min'), secEl = wrap.querySelector('.pv-sec');
      if (!hourEl) return;
      const hourAngle = ((t.h % 12) + t.m / 60) * 30, minAngle = (t.m + t.s / 60) * 6, secAngle = t.s * 6;
      hourEl.setAttribute('transform', `rotate(${hourAngle} ${c} ${c})`);
      minEl.setAttribute('transform', `rotate(${minAngle} ${c} ${c})`);
      secEl.setAttribute('transform', `rotate(${secAngle} ${c} ${c})`);
    } else if (designId === 'dclock') {
      const timeEl = wrap.querySelector('.pv-cd-time'), ampmEl = wrap.querySelector('.pv-cd-ampm'), dateEl = wrap.querySelector('.pv-cd-date');
      if (!timeEl) return;
      const hh12 = (t.h % 12) || 12;
      timeEl.textContent = `${String(hh12).padStart(2, '0')}:${String(t.m).padStart(2, '0')}`;
      ampmEl.textContent = t.h >= 12 ? 'PM' : 'AM';
      dateEl.textContent = `${(t.weekday || '').toUpperCase()} ${t.day} ${(t.month || '').toUpperCase()}`;
    }
  };
  update();
  _previewClockInterval = setInterval(update, 1000);
}

// ── slot UI (favicon chips + premium gate) ──────────────────────────────────────
function refreshSlotFavicon(i) {
  const box = $(`favicon-${i + 1}`);
  if (!box) return;
  const mode = state.slotModes[i] || 'url';
  if (mode === 'screenshot') { box.innerHTML = modeGlyphSVG('screenshot'); return; }
  if (mode === 'newtab')     { box.innerHTML = modeGlyphSVG('newtab'); return; }
  const url = (state.slots[i] || '').trim(), host = hostOf(url);
  if (!host) { box.innerHTML = globeSVG(); return; }
  const img = new Image();
  img.onload = () => { box.innerHTML = `<img src="${img.src}" width="22" height="22" alt="" style="border-radius:4px"/>`; };
  img.onerror = () => { box.innerHTML = `<span class="fav-letter">${(host[0] || '?').toUpperCase()}</span>`; };
  img.src = `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(host)}`;
}
function globeSVG() {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#8a7bb8" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15 15 0 010 20M12 2a15 15 0 000 20"/></svg>`;
}
function modeGlyphSVG(kind) {
  if (kind === 'screenshot') return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>`;
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#c084fc" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 10v6M9 13h6"/></svg>`;
}

/** Slot 1/2 mode dropdown → toggles whether the URL input is usable. */
function applySlotModeUI(i) {
  const input = $(`slot-${i + 1}-url`);
  const sel = $(`slot-${i + 1}-mode`);
  const mode = state.slotModes[i] || 'url';
  if (sel) sel.value = mode;
  if (input) {
    const slotLocked = (i >= 1) && !isPremium();
    input.disabled = mode !== 'url' || slotLocked;
    input.style.opacity = mode !== 'url' ? '0.45' : '';
    input.placeholder = mode === 'url' ? (i === 0 ? 'https://your-link.com' : 'Premium — https://your-link.com') : `${mode === 'screenshot' ? 'Screenshot' : 'New Tab'} — no link needed`;
  }
}

function applyPremiumGate() {
  const premium = isPremium();
  for (let i = 2; i <= 5; i++) {
    const row = $(`slot-${i}-row`), input = $(`slot-${i}-url`), badge = document.querySelector(`[data-lockbadge="${i}"]`);
    if (!row || !input) continue;
    row.classList.toggle('locked', !premium);
    if ((state.slotModes[i - 1] || 'url') === 'url') input.disabled = !premium;
    if (badge) badge.style.display = premium ? 'none' : '';
  }
  applySlotModeUI(1);

  const chip = $('plan-chip');
  if (chip) {
    chip.textContent = premium ? (state.plan === 'legend' ? 'LEGEND' : 'MONTHLY') : 'FREE';
    chip.className = 'plan-chip ' + (premium ? 'is-premium' : 'is-free');
  }
  const banner = $('upgrade-banner');
  if (banner) banner.style.display = premium ? 'none' : '';

  renderThemeTray();
  renderSoundList();
  applyExportImportGate();
  renderDesignTabs();
  applyTabVisibility();
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Designs gallery (roman numerals I-IX) + per-design profile panel
// ═══════════════════════════════════════════════════════════════════════════════
function renderDesignTabs() {
  const wrap = $('design-tabs');
  if (!wrap) return;
  const premium = isPremium();
  wrap.innerHTML = '';
  DESIGN_REGISTRY.forEach((d) => {
    const locked = !d.free && !premium;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'design-tab'
      + (state.selectedTab === d.id ? ' selected' : '')
      + (locked ? ' locked' : '')
      + (state.activeDesign === d.id ? ' is-active' : '');
    btn.innerHTML = `
      <span class="dt-roman">${d.roman}</span>
      <span class="dt-name">${d.name}${d.free ? '<b>DEFAULT</b>' : ''}</span>
      ${locked ? '<span class="dt-lock">🔒</span>' : ''}
      ${state.activeDesign === d.id ? '<span class="dt-dot" title="Currently in use"></span>' : ''}
    `;
    btn.addEventListener('click', () => selectTab(d.id));
    wrap.appendChild(btn);
  });
}

/** Show/hide the profile-panel controls that only apply to certain designs. */
function applyTabVisibility() {
  const id = state.selectedTab;
  const d = DESIGN_MAP[id];
  if (!d) return;
  const premium = isPremium();
  const locked = !d.free && !premium;

  const nameLabel = $('design-name-label');
  if (nameLabel) nameLabel.textContent = `${d.roman}. ${d.name.toUpperCase()}${d.free ? ' — DEFAULT' : ''}`;

  const trayBtn = $('tray-btn');
  if (trayBtn) trayBtn.style.display = id === 'radial' ? '' : 'none';

  const tzCtrl = $('timezone-ctrl');
  if (tzCtrl) tzCtrl.style.display = d.clock ? '' : 'none';
  if (d.clock) {
    const tzSel = $('timezone-select');
    if (tzSel) tzSel.value = getTabSettings(id).timezone || DEFAULT_TIMEZONE;
  }

  const useBtn = $('use-design-btn');
  const lockNote = $('design-lock-note');
  const controlsBody = $('design-controls-body');
  if (controlsBody) controlsBody.style.display = locked ? 'none' : '';
  if (lockNote) lockNote.style.display = locked ? '' : 'none';
  if (useBtn) {
    useBtn.style.display = locked ? 'none' : '';
    const isActive = state.activeDesign === id;
    useBtn.disabled = isActive;
    useBtn.textContent = isActive ? '✓ ACTIVE — IN USE' : 'USE THIS DESIGN';
    useBtn.classList.toggle('is-active', isActive);
  }
}

function selectTab(id) {
  if (!DESIGN_MAP[id]) return;
  state.selectedTab = id;
  // Close the appearance tray when leaving design I — it only applies there.
  if (id !== 'radial') { $('appearance-tray')?.classList.remove('open'); $('tray-backdrop')?.classList.remove('open'); }

  const ts = getTabSettings(id);
  const sizeEl = $('size-slider'), opEl = $('opacity-slider'), delayEl = $('delay-input');
  if (sizeEl) sizeEl.value = String(ts.size);
  if (opEl) opEl.value = String(ts.opacity);
  if (delayEl) delayEl.value = (ts.delay / 1000).toFixed(1);

  renderDesignTabs();
  applyTabVisibility();
  syncLabels();
  renderPreview();
}

function useSelectedDesign() {
  const id = state.selectedTab;
  const d = DESIGN_MAP[id];
  if (!d) return;
  if (!d.free && !isPremium()) { toast('// This design unlocks with Premium'); return; }
  state.activeDesign = id;
  renderDesignTabs();
  applyTabVisibility();
  saveNow(true);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Appearance tray (colours + themes) — design I only
// ═══════════════════════════════════════════════════════════════════════════════
function renderColorSwatches() {
  const wrap = $('color-swatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  for (const [key, c] of Object.entries(DIAL_COLORS)) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch' + (state.color === key ? ' selected' : '');
    btn.style.setProperty('--sw', c.accent);
    btn.title = c.name;
    btn.setAttribute('aria-label', c.name);
    btn.addEventListener('click', () => {
      state.color = key;
      renderColorSwatches(); renderPreview(); saveSoon();
    });
    wrap.appendChild(btn);
  }
}

function renderThemeTray() {
  const wrap = $('theme-cards');
  if (!wrap) return;
  const premium = isPremium();
  wrap.innerHTML = '';
  for (const [key, t] of Object.entries(DIAL_THEMES)) {
    const locked = t.premium && !premium;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'theme-card' + (state.theme === key && !locked ? ' selected' : '') + (locked ? ' locked' : '');
    card.innerHTML = `
      <div class="theme-name">${t.name}${locked ? ' 🔒' : ''}</div>
      <div class="theme-desc">${t.desc}</div>
      ${locked ? '<div class="theme-badge">PREMIUM</div>' : ''}
    `;
    card.addEventListener('click', () => {
      if (locked) { toast('// Themes unlock with Premium'); return; }
      state.theme = key;
      renderThemeTray(); renderPreview(); saveSoon();
    });
    wrap.appendChild(card);
  }
}

function wireTray() {
  const btn = $('tray-btn'), tray = $('appearance-tray'), closeBtn = $('tray-close'), backdrop = $('tray-backdrop');
  if (!btn || !tray) return;
  const open = () => { tray.classList.add('open'); backdrop?.classList.add('open'); };
  const close = () => { tray.classList.remove('open'); backdrop?.classList.remove('open'); };
  btn.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  backdrop?.addEventListener('click', close);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Sound catalog + custom upload/trim
// ═══════════════════════════════════════════════════════════════════════════════
let _previewCtx = null;
function previewPlay(recipe) {
  if (!_previewCtx) { try { _previewCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { return; } }
  if (_previewCtx.state === 'suspended') _previewCtx.resume().catch(() => {});
  const ctx = _previewCtx, t = ctx.currentTime, dur = recipe.dur ?? 0.05;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.type = recipe.type || 'square';
  osc.frequency.setValueAtTime(recipe.freq, t);
  if (recipe.freq2 != null) osc.frequency.linearRampToValueAtTime(recipe.freq2, t + dur * 0.6);
  if (recipe.freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(40, recipe.freqEnd), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(recipe.gain ?? 0.16, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t); osc.stop(t + dur + 0.01);
}

function renderSoundList() {
  const wrap = $('sound-list');
  if (!wrap) return;
  const premium = isPremium();
  wrap.innerHTML = '';
  for (const [key, snd] of Object.entries(SOUND_CATALOG)) {
    if (snd.custom) continue; // rendered separately below as its own panel
    const locked = snd.premium && !premium;
    const row = document.createElement('div');
    row.className = 'sound-row' + (state.soundId === key ? ' selected' : '') + (locked ? ' locked' : '');
    row.innerHTML = `
      <div class="sound-radio" aria-hidden="true"></div>
      <span class="sound-name">${snd.name}</span>
      ${locked ? '<span class="lock-badge"><svg viewBox="0 0 24 24"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>PREMIUM</span>' : '<button type="button" class="play-btn" title="Preview">▶</button>'}
    `;
    row.addEventListener('click', (e) => {
      if (e.target.closest('.play-btn')) { previewPlay(snd.synth); return; }
      if (locked) { toast('// This sound unlocks with Premium'); return; }
      state.soundId = key;
      renderSoundList(); saveSoon();
    });
    wrap.appendChild(row);
  }

  const customPanel = $('custom-sound-panel');
  const customLockBanner = $('custom-sound-lock');
  if (customPanel && customLockBanner) {
    customPanel.style.display = premium ? '' : 'none';
    customLockBanner.style.display = premium ? 'none' : '';
  }
  updateCustomSoundRowUI();
}

function updateCustomSoundRowUI() {
  const row = $('custom-sound-current');
  if (!row) return;
  if (state.soundId === 'custom' && state.soundCustom) {
    row.textContent = `Active: "${state.soundCustom.name || 'Custom clip'}" (${(state.soundCustom.dur || 0).toFixed(1)}s)`;
  } else {
    row.textContent = 'No custom sound saved yet.';
  }
}

// ── Custom sound: decode → trim → encode WAV → save as data URL ────────────────
let _customDecodeCtx = null;
let _decodedBuffer = null;
let _decodedName = '';

function getDecodeCtx() {
  if (!_customDecodeCtx) { try { _customDecodeCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) {} }
  return _customDecodeCtx;
}

async function handleCustomFile(file) {
  if (!file) return;
  const ctx = getDecodeCtx();
  if (!ctx) { toast('// Audio not supported in this browser'); return; }
  try {
    const buf = await file.arrayBuffer();
    _decodedBuffer = await ctx.decodeAudioData(buf.slice(0));
    _decodedName = file.name.replace(/\.[a-z0-9]+$/i, '');
    const dur = _decodedBuffer.duration;
    const endEl = $('trim-end'), startEl = $('trim-start');
    if (startEl) { startEl.max = String(Math.max(0, dur - 0.05).toFixed(2)); startEl.value = '0'; }
    if (endEl)   { endEl.max = String(dur.toFixed(2)); endEl.value = String(Math.min(dur, MAX_CUSTOM_SOUND_SEC).toFixed(2)); }
    $('trim-panel')?.classList.add('visible');
    $('trim-duration').textContent = `Source clip: ${dur.toFixed(1)}s — pick up to ${MAX_CUSTOM_SOUND_SEC}s to keep.`;
    clampTrimRange();
  } catch (err) {
    toast('// Could not read that audio file');
    console.error('[MOUSSY:settings] decode failed', err);
  }
}

function clampTrimRange() {
  const startEl = $('trim-start'), endEl = $('trim-end');
  if (!startEl || !endEl || !_decodedBuffer) return;
  let start = parseFloat(startEl.value) || 0;
  let end = parseFloat(endEl.value) || 0;
  if (end - start > MAX_CUSTOM_SOUND_SEC) end = start + MAX_CUSTOM_SOUND_SEC;
  if (end > _decodedBuffer.duration) end = _decodedBuffer.duration;
  if (start < 0) start = 0;
  if (start > end - 0.05) start = Math.max(0, end - 0.05);
  startEl.value = start.toFixed(2);
  endEl.value = end.toFixed(2);
  $('trim-range-label').textContent = `${start.toFixed(2)}s → ${end.toFixed(2)}s (${(end - start).toFixed(2)}s)`;
}

function previewTrim() {
  if (!_decodedBuffer || !_customDecodeCtx) return;
  const start = parseFloat($('trim-start').value) || 0;
  const end = parseFloat($('trim-end').value) || 0;
  const dur = Math.max(0.05, end - start);
  if (_customDecodeCtx.state === 'suspended') _customDecodeCtx.resume().catch(() => {});
  const src = _customDecodeCtx.createBufferSource();
  src.buffer = _decodedBuffer;
  src.connect(_customDecodeCtx.destination);
  src.start(0, start, dur);
}

/** Downmix + re-encode the trimmed segment as a compact 16-bit mono WAV. */
function encodeTrimmedWav(buffer, startSec, endSec) {
  const sr = buffer.sampleRate;
  const startSample = Math.max(0, Math.floor(startSec * sr));
  const endSample = Math.min(buffer.length, Math.floor(endSec * sr));
  const frameCount = Math.max(1, endSample - startSample);
  const ch0 = buffer.getChannelData(0);
  const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : null;

  const blockAlign = 2; // 1 channel * 2 bytes
  const dataSize = frameCount * blockAlign;
  const ab = new ArrayBuffer(44 + dataSize);
  const view = new DataView(ab);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };

  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sr, true);
  view.setUint32(28, sr * blockAlign, true); view.setUint16(32, blockAlign, true); view.setUint16(34, 16, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);

  let off = 44;
  for (let i = 0; i < frameCount; i++) {
    const idx = startSample + i;
    let sample = ch1 ? (ch0[idx] + ch1[idx]) / 2 : ch0[idx];
    sample = Math.max(-1, Math.min(1, sample));
    view.setInt16(off, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    off += 2;
  }
  return new Blob([ab], { type: 'audio/wav' });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

async function saveCustomSound() {
  if (!_decodedBuffer) { toast('// Upload a sound file first'); return; }
  const start = parseFloat($('trim-start').value) || 0;
  const end = parseFloat($('trim-end').value) || 0;
  if (end - start < 0.05) { toast('// Selection too short'); return; }
  try {
    const blob = encodeTrimmedWav(_decodedBuffer, start, end);
    const dataUrl = await blobToDataUrl(blob);
    state.soundCustom = { dataUrl, name: _decodedName || 'Custom clip', dur: end - start };
    state.soundId = 'custom';
    await store.set({ [KEYS.soundCustom]: state.soundCustom, [KEYS.soundId]: state.soundId });
    updateCustomSoundRowUI();
    renderSoundList();
    toast('// Custom sound saved');
  } catch (err) {
    toast('// Could not save custom sound');
    console.error('[MOUSSY:settings] wav encode failed', err);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Import / Export (premium only)
// ═══════════════════════════════════════════════════════════════════════════════
function applyExportImportGate() {
  const premium = isPremium();
  $('io-locked').style.display = premium ? 'none' : '';
  $('io-unlocked').style.display = premium ? '' : 'none';
}

function buildExportPayload() {
  return {
    _moussy: {
      app: 'MOUSSY', tagline: 'CONTROL. POWER. PRECISION.',
      exportedAt: new Date().toISOString(), version: 2,
    },
    FREE: {
      dial_size: state.size,
      dial_opacity: state.opacity,
      dial_delay: state.delay,
      dial_color: state.color,
      sound_id: state.soundId === 'custom' ? 'classic' : state.soundId, // custom moves to PREMIUM below
      slot1_mode: state.slotModes[0],
      slot1_url: state.slots[0],
    },
    PREMIUM: {
      dial_theme: state.theme,
      slot2_mode: state.slotModes[1],
      slot2_url: state.slots[1],
      slot3_url: state.slots[2],
      slot4_url: state.slots[3],
      slot5_url: state.slots[4],
      sound_id_if_premium: state.soundId,
      sound_custom: state.soundCustom,
      active_design: state.activeDesign,
      design_settings: state.otherDesigns,
    },
  };
}

function exportSettings() {
  const payload = buildExportPayload();
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const date = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url; a.download = `moussy-settings-${date}.json`;
  document.body.appendChild(a); a.click();
  requestAnimationFrame(() => { document.body.removeChild(a); URL.revokeObjectURL(url); });
  toast('// Settings exported');
}

async function importSettingsFile(file) {
  if (!file) return;
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    await applyImportedSettings(obj);
  } catch (err) {
    toast('// Invalid settings file');
    console.error('[MOUSSY:settings] import failed', err);
  }
}

async function applyImportedSettings(obj) {
  if (!obj || typeof obj !== 'object') { toast('// Invalid settings file'); return; }
  const free = obj.FREE || {};
  const premium = obj.PREMIUM || {};

  // 1. Read + apply FREE settings first
  if (typeof free.dial_size === 'number') state.size = clamp(free.dial_size, 0.5, 1.6);
  if (typeof free.dial_opacity === 'number') state.opacity = clamp(free.dial_opacity, 0, 1);
  if (typeof free.dial_delay === 'number') state.delay = clamp(free.dial_delay, 0, 5000);
  if (typeof free.dial_color === 'string' && DIAL_COLORS[free.dial_color]) state.color = free.dial_color;
  if (typeof free.sound_id === 'string' && SOUND_CATALOG[free.sound_id] && !SOUND_CATALOG[free.sound_id].premium) state.soundId = free.sound_id;
  if (typeof free.slot1_mode === 'string' && ['url','screenshot','newtab'].includes(free.slot1_mode)) state.slotModes[0] = free.slot1_mode;
  if (typeof free.slot1_url === 'string') state.slots[0] = free.slot1_url;

  // 2. Read + apply PREMIUM settings — only if this account is currently premium
  let skippedPremium = false;
  if (isPremium()) {
    if (typeof premium.dial_theme === 'string' && DIAL_THEMES[premium.dial_theme]) state.theme = premium.dial_theme;
    if (typeof premium.slot2_mode === 'string' && ['url','screenshot','newtab'].includes(premium.slot2_mode)) state.slotModes[1] = premium.slot2_mode;
    if (typeof premium.slot2_url === 'string') state.slots[1] = premium.slot2_url;
    if (typeof premium.slot3_url === 'string') state.slots[2] = premium.slot3_url;
    if (typeof premium.slot4_url === 'string') state.slots[3] = premium.slot4_url;
    if (typeof premium.slot5_url === 'string') state.slots[4] = premium.slot5_url;
    if (typeof premium.sound_id_if_premium === 'string' && SOUND_CATALOG[premium.sound_id_if_premium]) state.soundId = premium.sound_id_if_premium;
    if (premium.sound_custom && typeof premium.sound_custom.dataUrl === 'string') state.soundCustom = premium.sound_custom;
    if (typeof premium.active_design === 'string' && DESIGN_MAP[premium.active_design]) state.activeDesign = premium.active_design;
    if (premium.design_settings && typeof premium.design_settings === 'object') state.otherDesigns = premium.design_settings;
  } else if (Object.keys(premium).length) {
    skippedPremium = true;
  }

  // 3. Refresh every part of the UI + persist
  refreshAllInputs();
  applyPremiumGate();
  syncLabels();
  for (let i = 0; i < 5; i++) refreshSlotFavicon(i);
  renderColorSwatches();
  renderPreview();
  await saveNow(false);

  toast(skippedPremium
    ? '// Imported — premium settings skipped (not on a paid plan)'
    : '// Settings imported successfully');
}

function refreshAllInputs() {
  const ts = getTabSettings(state.selectedTab);
  const sizeEl = $('size-slider'), opEl = $('opacity-slider'), delayEl = $('delay-input');
  if (sizeEl) sizeEl.value = String(ts.size);
  if (opEl) opEl.value = String(ts.opacity);
  if (delayEl) delayEl.value = (ts.delay / 1000).toFixed(1);
  for (let i = 1; i <= 5; i++) {
    const input = $(`slot-${i}-url`);
    if (input) input.value = state.slots[i - 1] || '';
    applySlotModeUI(i - 1);
  }
}

// ── persistence ─────────────────────────────────────────────────────────────────
let _saveT = null;
function saveSoon() { clearTimeout(_saveT); _saveT = setTimeout(() => saveNow(false), 400); }
async function saveNow(showToast) {
  await store.set({
    [KEYS.size]:    state.size,
    [KEYS.opacity]: state.opacity,
    [KEYS.delay]:   state.delay,
    [KEYS.color]:   state.color,
    [KEYS.theme]:   state.theme,
    [KEYS.soundId]: state.soundId,
    [KEYS.slots]:   state.slots.map((url, i) => ({ url: (url || '').trim(), mode: state.slotModes[i] || 'url' })),
    [KEYS.activeDesign]:   state.activeDesign,
    [KEYS.designSettings]: state.otherDesigns,
  });
  if (showToast) toast('// CONFIG SAVED');
}

let _toastT = null;
function toast(msg) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.className = 'visible';
  clearTimeout(_toastT); _toastT = setTimeout(() => (t.className = ''), 2600);
}

// ── value labels ────────────────────────────────────────────────────────────────
function syncLabels() {
  const ts = getTabSettings(state.selectedTab);
  const sv = $('size-val'), ov = $('opacity-val');
  if (sv) sv.textContent = `${Math.round(ts.size * 100)}%`;
  if (ov) ov.textContent = `${Math.round(ts.opacity * 100)}%`;
  updateDelayWarn(ts.delay / 1000);
}

/** Warn when the hold delay strays from the comfortable ~0.5s zone. */
function updateDelayWarn(sec) {
  const w = $('delay-warn');
  if (!w) return;
  if (!isFinite(sec)) { w.textContent = ''; return; }
  if (sec < 0.2)      w.textContent = '⚠ Very short — the dial may fire on ordinary right-clicks. Default is 0.5s.';
  else if (sec > 1)   w.textContent = '⚠ Long holds get tiring fast. Default 0.5s is the sweet spot.';
  else                w.textContent = '✓ Comfortable range (default 0.5s).';
  w.className = 'delay-warn ' + (sec < 0.2 || sec > 1 ? 'bad' : 'ok');
}

// ── wiring ────────────────────────────────────────────────────────────────────
function wire() {
  const sizeEl = $('size-slider'), opEl = $('opacity-slider');
  if (sizeEl) {
    sizeEl.addEventListener('input', () => {
      const v = clamp(parseFloat(sizeEl.value), 0.5, 1.6);
      setTabSize(state.selectedTab, v);
      syncLabels(); renderPreview(); saveSoon();
    });
  }
  if (opEl) {
    opEl.addEventListener('input', () => {
      const v = clamp(parseFloat(opEl.value), 0, 1);
      setTabOpacity(state.selectedTab, v);
      syncLabels(); renderPreview(); saveSoon();
    });
  }

  for (let i = 1; i <= 5; i++) {
    const input = $(`slot-${i}-url`);
    if (!input) continue;
    input.value = state.slots[i - 1] || '';
    input.addEventListener('input', () => {
      state.slots[i - 1] = input.value.trim();
      refreshSlotFavicon(i - 1); renderPreview(); saveSoon();
    });
    input.addEventListener('blur', () => {
      let v = input.value.trim();
      if (v && !/^https?:\/\//i.test(v)) { v = 'https://' + v; input.value = v; state.slots[i - 1] = v; }
      refreshSlotFavicon(i - 1); renderPreview(); saveSoon();
    });
  }

  // Slot 1 & 2 mode dropdowns
  for (let i = 0; i < 2; i++) {
    const sel = $(`slot-${i + 1}-mode`);
    if (!sel) continue;
    sel.addEventListener('change', () => {
      state.slotModes[i] = sel.value;
      applySlotModeUI(i);
      refreshSlotFavicon(i); renderPreview(); saveSoon();
    });
  }

  const delayEl = $('delay-input');
  if (delayEl) {
    const commitDelay = () => {
      let sec = parseFloat(delayEl.value);
      if (!isFinite(sec)) sec = DEF.delay / 1000;
      sec = clamp(sec, 0, 5);
      delayEl.value = sec.toFixed(1);
      setTabDelay(state.selectedTab, Math.round(sec * 1000));
      updateDelayWarn(sec);
      saveSoon();
    };
    delayEl.addEventListener('change', commitDelay);
    delayEl.addEventListener('input', () => updateDelayWarn(parseFloat(delayEl.value)));
  }

  const tzSel = $('timezone-select');
  if (tzSel) {
    tzSel.innerHTML = TIMEZONES.map((tz) => `<option value="${tz.id}">${tz.label}</option>`).join('');
    tzSel.addEventListener('change', () => {
      setTabTimezone(state.selectedTab, tzSel.value);
      renderPreview(); saveSoon();
    });
  }

  $('save-btn')?.addEventListener('click', () => saveNow(true));
  $('reset-dial')?.addEventListener('click', () => {
    const tab = state.selectedTab;
    setTabSize(tab, DEF.size); setTabOpacity(tab, DEF.opacity); setTabDelay(tab, DEF.delay);
    const ts = getTabSettings(tab);
    if (sizeEl) sizeEl.value = String(ts.size);
    if (opEl) opEl.value = String(ts.opacity);
    if (delayEl) delayEl.value = (ts.delay / 1000).toFixed(1);
    syncLabels(); renderPreview(); saveNow(true);
  });

  $('use-design-btn')?.addEventListener('click', useSelectedDesign);

  wireTray();

  $('custom-sound-file')?.addEventListener('change', (e) => handleCustomFile(e.target.files?.[0]));
  $('trim-start')?.addEventListener('input', clampTrimRange);
  $('trim-end')?.addEventListener('input', clampTrimRange);
  $('trim-preview-btn')?.addEventListener('click', previewTrim);
  $('trim-save-btn')?.addEventListener('click', saveCustomSound);

  $('export-btn')?.addEventListener('click', exportSettings);
  $('import-file')?.addEventListener('change', (e) => importSettingsFile(e.target.files?.[0]));
}

// ── init ────────────────────────────────────────────────────────────────────────
async function init() {
  const d = await store.get([
    KEYS.slots, KEYS.plan, KEYS.size, KEYS.opacity, KEYS.delay, KEYS.color, KEYS.theme, KEYS.soundId, KEYS.soundCustom,
    KEYS.activeDesign, KEYS.designSettings,
  ]);
  if (typeof d[KEYS.size] === 'number') state.size = clamp(d[KEYS.size], 0.5, 1.6);
  if (typeof d[KEYS.opacity] === 'number') state.opacity = clamp(d[KEYS.opacity], 0, 1);
  if (typeof d[KEYS.delay] === 'number') state.delay = clamp(d[KEYS.delay], 0, 5000);
  if (typeof d[KEYS.color] === 'string' && DIAL_COLORS[d[KEYS.color]]) state.color = d[KEYS.color];
  if (typeof d[KEYS.theme] === 'string' && DIAL_THEMES[d[KEYS.theme]]) state.theme = d[KEYS.theme];
  if (typeof d[KEYS.soundId] === 'string' && SOUND_CATALOG[d[KEYS.soundId]]) state.soundId = d[KEYS.soundId];
  if (d[KEYS.soundCustom] && typeof d[KEYS.soundCustom] === 'object') state.soundCustom = d[KEYS.soundCustom];
  if (typeof d[KEYS.activeDesign] === 'string' && DESIGN_MAP[d[KEYS.activeDesign]]) state.activeDesign = d[KEYS.activeDesign];
  if (d[KEYS.designSettings] && typeof d[KEYS.designSettings] === 'object') state.otherDesigns = d[KEYS.designSettings];
  state.plan = d[KEYS.plan] || 'free';
  const saved = d[KEYS.slots];
  if (Array.isArray(saved)) {
    saved.forEach((sObj, i) => {
      if (i >= 5) return;
      if (typeof sObj === 'string') { state.slots[i] = sObj; return; }
      state.slots[i] = (sObj && sObj.url) || '';
      state.slotModes[i] = (sObj && (sObj.mode === 'screenshot' || sObj.mode === 'newtab')) ? sObj.mode : 'url';
    });
  }

  // If premium was revoked while a premium design was active, fall back visually too.
  if (!isPremium() && state.activeDesign !== 'radial') state.selectedTab = 'radial';
  else state.selectedTab = state.activeDesign;

  wire();
  applyPremiumGate();
  applyTabVisibility();
  syncLabels();
  for (let i = 0; i < 5; i++) { refreshSlotFavicon(i); applySlotModeUI(i); }
  renderColorSwatches();
  renderPreview();
  updateCustomSoundRowUI();

  // live-update if plan changes elsewhere (e.g., activated on Pricing page)
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local') return;
      if (c[KEYS.plan]) {
        state.plan = c[KEYS.plan].newValue || 'free';
        applyPremiumGate(); applyTabVisibility(); renderPreview();
      }
    });
  } catch (_) {}

  console.log('[MOUSSY:settings] ready');
}

document.addEventListener('DOMContentLoaded', init);
