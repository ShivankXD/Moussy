/**
 * MOUSSY — Settings Controller  (settings.js)
 * =============================================
 * All settings-page logic lives here (extension-page CSP forbids inline JS).
 *
 *   • Live preview dial — a self-contained SVG mirror of the in-page dial that
 *     reflects size, band transparency, and slot favicons in real time.
 *   • Size slider     → moussy_dial_size    (scale 0.5..1.6)
 *   • Transparency    → moussy_dial_opacity  (band alpha 0..1)
 *   • 5 URL slots      → moussy_gesture_slots (Slot 1 free, 2-5 premium)
 *   • Premium gate     → moussy_plan
 *
 * Everything persists to chrome.storage.local (shared with content.js), with a
 * localStorage fallback for standalone preview.
 */

'use strict';

const KEYS = {
  slots:   'moussy_gesture_slots',
  plan:    'moussy_plan',
  size:    'moussy_dial_size',
  opacity: 'moussy_dial_opacity',
  delay:   'moussy_dial_delay',
};
const DEF = { size: 0.82, opacity: 0.55, delay: 500 };   // delay in ms
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

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
const state = { size: DEF.size, opacity: DEF.opacity, delay: DEF.delay, slots: ['', '', '', '', ''], plan: 'free' };
const $ = (id) => document.getElementById(id);

// ── wedge model (clockwise from North) ─────────────────────────────────────────
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } }
function wedgeModel() {
  const premium = state.plan === 'monthly' || state.plan === 'legend';
  const u = (slotNo, i) => {
    const url = (state.slots[i] || '').trim(), host = hostOf(url);
    const locked = slotNo >= 2 && !premium;
    return { kind: 'url', slotNo, url, host, locked };
  };
  return [
    u(1, 0),                                   // N
    u(2, 1),                                   // NE
    { kind: 'nav', action: 'forward' },        // E
    u(3, 2),                                   // SE
    { kind: 'nav', action: 'reload' },         // S
    u(4, 3),                                   // SW
    { kind: 'nav', action: 'back' },           // W
    u(5, 4),                                   // NW
  ];
}

// ── preview dial renderer ───────────────────────────────────────────────────────
function wedgePath(c, RO, RI, a0, a1) {
  const r = (a) => a * Math.PI / 180;
  const p = (rr, a) => [c + rr * Math.cos(r(a)), c + rr * Math.sin(r(a))];
  const [ox0, oy0] = p(RO, a0), [ox1, oy1] = p(RO, a1), [ix1, iy1] = p(RI, a1), [ix0, iy0] = p(RI, a0);
  return `M ${ox0} ${oy0} A ${RO} ${RO} 0 0 1 ${ox1} ${oy1} L ${ix1} ${iy1} A ${RI} ${RI} 0 0 0 ${ix0} ${iy0} Z`;
}

function renderPreview() {
  const stage = $('preview-stage');
  if (!stage) return;
  stage.querySelector('.pv-dial')?.remove();

  const size = state.size, a = state.opacity;
  const Dp = Math.round(210 * size);
  const c = Dp / 2, s = Dp / 210;
  const RO = Dp * 0.43, RI = Dp * 0.31, ICON = Dp * 0.329;   // icons tucked inside band
  const iconScale = Dp / 280;                                // match the real dial's icon:dial ratio
  const model = wedgeModel();
  const rad = (d) => d * Math.PI / 180;

  let parts = '';
  // defs
  parts += `<defs>
    <filter id="pvGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="${1.6*s}" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    <linearGradient id="pvBand" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="rgba(56,30,96,${a})"/><stop offset="100%" stop-color="rgba(11,7,20,${a})"/></linearGradient>
  </defs>`;
  // outer dash ring
  parts += `<circle cx="${c}" cy="${c}" r="${RO + 8*s}" fill="none" stroke="rgba(168,85,247,0.3)" stroke-width="1" stroke-dasharray="2 7"/>`;
  // ticks
  for (let i = 0; i < 24; i++) {
    const ang = rad(i * 15), r0 = RO + 2*s, r1 = RO + (i % 2 ? 5 : 8)*s;
    parts += `<line x1="${c+r0*Math.cos(ang)}" y1="${c+r0*Math.sin(ang)}" x2="${c+r1*Math.cos(ang)}" y2="${c+r1*Math.sin(ang)}" stroke="rgba(168,85,247,0.35)" stroke-width="1"/>`;
  }
  // wedges
  for (let i = 0; i < 8; i++) {
    const centre = -90 + i * 45;
    parts += `<path d="${wedgePath(c, RO, RI, centre - 22.5, centre + 22.5)}" fill="url(#pvBand)" stroke="rgba(168,85,247,0.20)" stroke-width="1"/>`;
  }
  // dividers
  for (let i = 0; i < 8; i++) {
    const ang = rad(-67.5 + i * 45);
    parts += `<line x1="${c+RI*Math.cos(ang)}" y1="${c+RI*Math.sin(ang)}" x2="${c+RO*Math.cos(ang)}" y2="${c+RO*Math.sin(ang)}" stroke="rgba(168,85,247,0.20)" stroke-width="1"/>`;
  }
  // rings
  parts += `<circle cx="${c}" cy="${c}" r="${RO}" fill="none" stroke="rgba(192,132,252,0.95)" stroke-width="2" filter="url(#pvGlow)"/>`;
  parts += `<circle cx="${c}" cy="${c}" r="${RI}" fill="none" stroke="rgba(168,85,247,0.55)" stroke-width="1.4" filter="url(#pvGlow)"/>`;
  // nav glyphs
  const glyph = (ang, kind) => {
    const x = c + ICON * Math.cos(rad(ang)), y = c + ICON * Math.sin(rad(ang));
    const t = `translate(${x} ${y}) scale(${s})`;
    const st = 'fill="none" stroke="#c084fc" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"';
    if (kind === 'forward') return `<path transform="${t}" d="M-8 0 H4 M4 -4.5 L8.5 0 L4 4.5" ${st}/>`;
    if (kind === 'back')    return `<path transform="${t}" d="M8 0 H-4 M-4 -4.5 L-8.5 0 L-4 4.5" ${st}/>`;
    return `<g transform="${t}"><path d="M6.5 -2.5 A7 7 0 1 1 3 -6.3" ${st}/><path d="M6.6 -6.6 L6.9 -1.6 L2 -3.4 Z" fill="#c084fc"/></g>`;
  };
  parts += glyph(0, 'forward') + glyph(90, 'reload') + glyph(180, 'back');
  // reticle
  parts += `<circle cx="${c}" cy="${c}" r="${11*s}" fill="none" stroke="rgba(168,85,247,0.30)" stroke-width="1"/>`;
  for (const [x1,y1,x2,y2] of [[-9,0,-5,0],[5,0,9,0],[0,-9,0,-5],[0,5,0,9]])
    parts += `<line x1="${c+x1*s}" y1="${c+y1*s}" x2="${c+x2*s}" y2="${c+y2*s}" stroke="rgba(192,132,252,0.85)" stroke-width="1.2" stroke-linecap="round"/>`;
  parts += `<circle cx="${c}" cy="${c}" r="${2.4*s}" fill="#c084fc" filter="url(#pvGlow)"/>`;

  const wrap = document.createElement('div');
  wrap.className = 'pv-dial';
  wrap.style.width = wrap.style.height = `${Dp}px`;
  wrap.innerHTML = `<svg width="${Dp}" height="${Dp}" viewBox="0 0 ${Dp} ${Dp}" style="overflow:visible">${parts}</svg>`;

  // URL slot icon overlays (favicon / placeholder / lock)
  model.forEach((w, i) => {
    if (w.kind !== 'url') return;
    const ang = rad(-90 + i * 45);
    const x = c + ICON * Math.cos(ang), y = c + ICON * Math.sin(ang);
    const box = document.createElement('div');
    box.className = 'pv-ico';
    box.style.left = `${x}px`; box.style.top = `${y}px`;
    box.style.transform = `translate(-50%,-50%) scale(${iconScale})`;
    if (w.url && !w.locked) {
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
      lk.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13"><rect x="4" y="11" width="16" height="10" rx="2" fill="#1a1326" stroke="#c084fc" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="#c084fc" stroke-width="2"/></svg>`;
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

function applyPremiumGate() {
  const premium = state.plan === 'monthly' || state.plan === 'legend';
  for (let i = 2; i <= 5; i++) {
    const row = $(`slot-${i}-row`), input = $(`slot-${i}-url`), badge = document.querySelector(`[data-lockbadge="${i}"]`);
    if (!row || !input) continue;
    row.classList.toggle('locked', !premium);
    input.disabled = !premium;
    if (badge) badge.style.display = premium ? 'none' : '';
  }
  const chip = $('plan-chip');
  if (chip) {
    chip.textContent = premium ? (state.plan === 'legend' ? 'LEGEND' : 'MONTHLY') : 'FREE';
    chip.className = 'plan-chip ' + (premium ? 'is-premium' : 'is-free');
  }
  const banner = $('upgrade-banner');
  if (banner) banner.style.display = premium ? 'none' : '';
}

// ── persistence ─────────────────────────────────────────────────────────────────
let _saveT = null;
function saveSoon() { clearTimeout(_saveT); _saveT = setTimeout(saveNow, 400); }
async function saveNow(showToast) {
  await store.set({
    [KEYS.size]:    state.size,
    [KEYS.opacity]: state.opacity,
    [KEYS.delay]:   state.delay,
    [KEYS.slots]:   state.slots.map((url) => ({ url: (url || '').trim() })),
  });
  if (showToast) toast('// CONFIG SAVED');
}

let _toastT = null;
function toast(msg) {
  const t = $('toast'); if (!t) return;
  t.textContent = msg; t.className = 'visible';
  clearTimeout(_toastT); _toastT = setTimeout(() => (t.className = ''), 2200);
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
}

// ── init ────────────────────────────────────────────────────────────────────────
async function init() {
  const d = await store.get([KEYS.slots, KEYS.plan, KEYS.size, KEYS.opacity, KEYS.delay]);
  if (typeof d[KEYS.size] === 'number') state.size = clamp(d[KEYS.size], 0.5, 1.6);
  if (typeof d[KEYS.opacity] === 'number') state.opacity = clamp(d[KEYS.opacity], 0, 1);
  if (typeof d[KEYS.delay] === 'number') state.delay = clamp(d[KEYS.delay], 0, 5000);
  state.plan = d[KEYS.plan] || 'free';
  const saved = d[KEYS.slots];
  if (Array.isArray(saved)) saved.forEach((sObj, i) => { if (i < 5) state.slots[i] = (typeof sObj === 'string' ? sObj : (sObj && sObj.url) || ''); });

  wire();
  applyPremiumGate();
  syncLabels();
  for (let i = 0; i < 5; i++) refreshSlotFavicon(i);
  renderPreview();

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
