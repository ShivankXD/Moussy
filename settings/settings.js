/**
 * MOUSSY — Settings Controller  (settings.js)
 * =============================================
 * All settings-page logic lives here (extension-page CSP forbids inline JS).
 *
 *   • Live preview dial — mirrors size, transparency, colour, theme, slot
 *     favicons/modes exactly as the in-page dial renders them.
 *   • Appearance tray  — 8 colours (free, any plan) + 4 structural themes
 *     (premium only).
 *   • Sound catalog    — several synthesised tick sounds (some premium) plus
 *     a premium "record & trim your own ≤2s clip" custom sound.
 *   • Slot 1 & 2       — dropdown: Open Link / Screenshot / New Tab.
 *   • Import / Export  — premium-only JSON round-trip of all settings.
 *
 * Everything persists to chrome.storage.local (shared with content.js), with a
 * localStorage fallback for standalone preview.
 */

'use strict';

const KEYS = {
  slots:        'moussy_gesture_slots',
  plan:         'moussy_plan',
  size:         'moussy_dial_size',
  opacity:      'moussy_dial_opacity',
  delay:        'moussy_dial_delay',
  color:        'moussy_dial_color',
  theme:        'moussy_dial_theme',
  soundId:      'moussy_sound_id',
  soundCustom:  'moussy_sound_custom',
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
  classic: { name: 'Classic Neon',  desc: 'Double ring, 24 tick marks, dashed rune ring.', premium: false },
  glass:   { name: 'Glass Minimal', desc: 'Single thin ring, frosted band, no ticks.',      premium: true },
  hex:     { name: 'Hex Tech',      desc: 'Faceted octagon wedges, circuit-trace ticks.',   premium: true },
  core:    { name: 'Solid Core',    desc: 'Bold thick ring, blocky cardinal ticks.',        premium: true },
};
const SOUND_CATALOG = {
  classic: { name: 'Classic Tick',      premium: false, synth: { type: 'square',   freq: 1550, dur: 0.045, gain: 0.16 } },
  crystal: { name: 'Crystal Chime',     premium: false, synth: { type: 'triangle', freq: 2200, freq2: 3100, dur: 0.09,  gain: 0.14 } },
  pulse:   { name: 'Deep Pulse',        premium: false, synth: { type: 'sine',     freq: 220,  dur: 0.07,  gain: 0.24 } },
  laser:   { name: 'Laser Zap',         premium: false, synth: { type: 'sawtooth', freq: 2400, freqEnd: 600, dur: 0.06, gain: 0.13 } },
  arcade:  { name: 'Retro Arcade Blip', premium: true,  synth: { type: 'square',   freq: 900,  freq2: 1500, dur: 0.055, gain: 0.18 } },
  cyber:   { name: 'Cyber Alert',       premium: true,  synth: { type: 'sawtooth', freq: 1800, freq2: 2700, dur: 0.05, gain: 0.15 } },
  custom:  { name: 'Custom Sound',      premium: true,  custom: true },
};

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
  size: DEF.size, opacity: DEF.opacity, delay: DEF.delay, color: DEF.color, theme: DEF.theme,
  soundId: DEF.soundId, soundCustom: null,
  slots: ['', '', '', '', ''], slotModes: ['url', 'url', 'url', 'url', 'url'],
  plan: 'free',
};
const $ = (id) => document.getElementById(id);
const isPremium = () => state.plan === 'monthly' || state.plan === 'legend';

function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }

// ── wedge model (clockwise from North) ─────────────────────────────────────────
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

function renderPreview() {
  const stage = $('preview-stage');
  if (!stage) return;
  stage.querySelector('.pv-dial')?.remove();

  const size = state.size, a = state.opacity;
  const theme = isPremium() ? state.theme : 'classic';
  const col = DIAL_COLORS[state.color] || DIAL_COLORS.violet;
  const { accent, bright } = col;
  const Dp = Math.round(210 * size);
  const c = Dp / 2, s = Dp / 210;
  const RO = Dp * 0.43, RI = Dp * 0.31, ICON = Dp * 0.329;
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
      lk.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="4" y="11" width="16" height="10" rx="2" fill="#1a1326" stroke="${bright}" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="${bright}" stroke-width="2"/></svg>`;
      box.appendChild(lk);
    }
    wrap.appendChild(box);
  });

  stage.appendChild(wrap);
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
  applySlotModeUI(1); // Slot 2 also gated by premium (mode dropdown itself stays enabled to preview, but firing is gated in content.js regardless)

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
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Appearance tray (colours + themes)
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

  // custom sound panel gate
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
      exportedAt: new Date().toISOString(), version: 1,
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
  const sizeEl = $('size-slider'), opEl = $('opacity-slider'), delayEl = $('delay-input');
  if (sizeEl) sizeEl.value = String(state.size);
  if (opEl) opEl.value = String(state.opacity);
  if (delayEl) delayEl.value = (state.delay / 1000).toFixed(1);
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
  const sv = $('size-val'), ov = $('opacity-val');
  if (sv) sv.textContent = `${Math.round(state.size * 100)}%`;
  if (ov) ov.textContent = `${Math.round(state.opacity * 100)}%`;
  updateDelayWarn(state.delay / 1000);
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
    sizeEl.value = String(state.size);
    sizeEl.addEventListener('input', () => {
      state.size = clamp(parseFloat(sizeEl.value), 0.5, 1.6);
      syncLabels(); renderPreview(); saveSoon();
    });
  }
  if (opEl) {
    opEl.value = String(state.opacity);
    opEl.addEventListener('input', () => {
      state.opacity = clamp(parseFloat(opEl.value), 0, 1);
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
    delayEl.value = (state.delay / 1000).toFixed(1);
    const commitDelay = () => {
      let sec = parseFloat(delayEl.value);
      if (!isFinite(sec)) sec = DEF.delay / 1000;
      sec = clamp(sec, 0, 5);
      delayEl.value = sec.toFixed(1);
      state.delay = Math.round(sec * 1000);
      updateDelayWarn(sec);
      saveSoon();
    };
    delayEl.addEventListener('change', commitDelay);
    delayEl.addEventListener('input', () => updateDelayWarn(parseFloat(delayEl.value)));
  }

  $('save-btn')?.addEventListener('click', () => saveNow(true));
  $('reset-dial')?.addEventListener('click', () => {
    state.size = DEF.size; state.opacity = DEF.opacity; state.delay = DEF.delay;
    if (sizeEl) sizeEl.value = String(DEF.size);
    if (opEl) opEl.value = String(DEF.opacity);
    if (delayEl) delayEl.value = (DEF.delay / 1000).toFixed(1);
    syncLabels(); renderPreview(); saveNow(true);
  });

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
  const d = await store.get([KEYS.slots, KEYS.plan, KEYS.size, KEYS.opacity, KEYS.delay, KEYS.color, KEYS.theme, KEYS.soundId, KEYS.soundCustom]);
  if (typeof d[KEYS.size] === 'number') state.size = clamp(d[KEYS.size], 0.5, 1.6);
  if (typeof d[KEYS.opacity] === 'number') state.opacity = clamp(d[KEYS.opacity], 0, 1);
  if (typeof d[KEYS.delay] === 'number') state.delay = clamp(d[KEYS.delay], 0, 5000);
  if (typeof d[KEYS.color] === 'string' && DIAL_COLORS[d[KEYS.color]]) state.color = d[KEYS.color];
  if (typeof d[KEYS.theme] === 'string' && DIAL_THEMES[d[KEYS.theme]]) state.theme = d[KEYS.theme];
  if (typeof d[KEYS.soundId] === 'string' && SOUND_CATALOG[d[KEYS.soundId]]) state.soundId = d[KEYS.soundId];
  if (d[KEYS.soundCustom] && typeof d[KEYS.soundCustom] === 'object') state.soundCustom = d[KEYS.soundCustom];
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

  wire();
  applyPremiumGate();
  syncLabels();
  for (let i = 0; i < 5; i++) { refreshSlotFavicon(i); applySlotModeUI(i); }
  renderColorSwatches();
  renderPreview();
  updateCustomSoundRowUI();

  // live-update if plan changes elsewhere (e.g., activated on Pricing page)
  try {
    chrome.storage.onChanged.addListener((c, area) => {
      if (area !== 'local') return;
      if (c[KEYS.plan]) { state.plan = c[KEYS.plan].newValue || 'free'; applyPremiumGate(); renderPreview(); }
    });
  } catch (_) {}

  console.log('[MOUSSY:settings] ready');
}

document.addEventListener('DOMContentLoaded', init);
