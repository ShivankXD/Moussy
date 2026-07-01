/**
 * MOUSSY — Radial Dial Engine  (content.js)
 * ===========================================
 * Injected at document_idle into every tab.
 *
 * Interaction model (radial pie / "dial")
 * ───────────────────────────────────────
 *   1. Press + HOLD the right mouse button  → a 8-wedge dial appears centred
 *      on the cursor.
 *   2. Move the mouse outward toward a wedge → that wedge highlights, a "tick"
 *      sound fires on each slot change, and the centre shows the wedge's label.
 *   3. RELEASE the button                    → the highlighted wedge's action
 *      fires. Releasing inside the centre dead-zone cancels (no action).
 *
 * Wedge layout (clockwise from top)
 * ──────────────────────────────────
 *   N  (top)    Slot 1   — user URL (FREE)         favicon / "Slot 1"
 *   NE          Slot 2   — user URL (PREMIUM)      favicon / "Slot 2" + lock
 *   E  (right)  Forward  — page history forward    ►
 *   SE          Slot 3   — user URL (PREMIUM)      favicon / "Slot 3" + lock
 *   S  (bottom) Reload   — reload page             ↻
 *   SW          Slot 4   — user URL (PREMIUM)      favicon / "Slot 4" + lock
 *   W  (left)   Back     — page history back       ◄
 *   NW          Slot 5   — user URL (PREMIUM)      favicon / "Slot 5" + lock
 *
 * Storage (chrome.storage.local)
 * ───────────────────────────────
 *   moussy_gesture_slots : Array<{url}>  — index 0..4 → Slot 1..5
 *   moussy_plan          : 'free'|'monthly'|'legend'  — premium gate
 *   moussy_paused_global : boolean
 *   moussy_paused_hosts  : string[]
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ── Constants
// ═══════════════════════════════════════════════════════════════════════════════

const CFG = Object.freeze({
  D:          280,   // SVG box size (px)
  RING_OUT:   120,   // outer ring radius
  RING_IN:    86,    // inner / dead-zone radius — large hole = thin ring band
  ICON_R:     92,    // radius at which wedge icons sit (tucked inside the band)
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

  DEFAULT_SIZE:         0.82,   // a touch smaller than base
  DEFAULT_OPACITY:      0.55,   // violet/black band mix
  DEFAULT_DELAY:        500,    // ms of right-hold before the dial opens
});

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// ═══════════════════════════════════════════════════════════════════════════════
// ── Caches (slots + premium + pause), primed from storage, live-updated
// ═══════════════════════════════════════════════════════════════════════════════

const Store = (() => {
  let _slots = [];        // array of url strings, index 0..4
  let _plan  = 'free';
  let _pauseGlobal = false;
  let _pauseHosts  = [];
  let _size    = CFG.DEFAULT_SIZE;
  let _opacity = CFG.DEFAULT_OPACITY;
  let _delay   = CFG.DEFAULT_DELAY;
  const _host = (() => { try { return location.hostname; } catch { return ''; } })();

  (async () => {
    try {
      const d = await chrome.storage.local.get([
        CFG.STORAGE_SLOTS, CFG.STORAGE_PLAN, CFG.STORAGE_PAUSE_GLOBAL, CFG.STORAGE_PAUSE_HOSTS,
        CFG.STORAGE_SIZE, CFG.STORAGE_OPACITY, CFG.STORAGE_DELAY,
      ]);
      setSlots(d[CFG.STORAGE_SLOTS]);
      _plan        = d[CFG.STORAGE_PLAN] ?? 'free';
      _pauseGlobal = d[CFG.STORAGE_PAUSE_GLOBAL] === true;
      _pauseHosts  = Array.isArray(d[CFG.STORAGE_PAUSE_HOSTS]) ? d[CFG.STORAGE_PAUSE_HOSTS] : [];
      if (typeof d[CFG.STORAGE_SIZE]    === 'number') _size    = d[CFG.STORAGE_SIZE];
      if (typeof d[CFG.STORAGE_OPACITY] === 'number') _opacity = d[CFG.STORAGE_OPACITY];
      if (typeof d[CFG.STORAGE_DELAY]   === 'number') _delay   = d[CFG.STORAGE_DELAY];
    } catch (_) { /* chrome:// or invalidated context */ }
  })();

  function setSlots(raw) {
    if (!Array.isArray(raw)) { _slots = []; return; }
    _slots = raw.map((s) => (typeof s === 'string' ? s : (s && s.url) || '').trim());
  }

  return {
    slotUrl(i)     { return _slots[i] || ''; },
    isPremium()    { return _plan === 'monthly' || _plan === 'legend'; },
    isPaused()     { return _pauseGlobal || _pauseHosts.includes(_host); },
    dialSize()     { return clamp(_size, 0.5, 1.6); },
    dialOpacity()  { return clamp(_opacity, 0, 1); },
    dialDelay()    { return clamp(_delay, 0, 3000); },
    _onChange(changes) {
      if (CFG.STORAGE_SLOTS in changes)        setSlots(changes[CFG.STORAGE_SLOTS].newValue);
      if (CFG.STORAGE_PLAN in changes)         _plan = changes[CFG.STORAGE_PLAN].newValue ?? 'free';
      if (CFG.STORAGE_PAUSE_GLOBAL in changes) _pauseGlobal = changes[CFG.STORAGE_PAUSE_GLOBAL].newValue === true;
      if (CFG.STORAGE_PAUSE_HOSTS in changes)  _pauseHosts = Array.isArray(changes[CFG.STORAGE_PAUSE_HOSTS].newValue) ? changes[CFG.STORAGE_PAUSE_HOSTS].newValue : [];
      if (CFG.STORAGE_SIZE in changes    && typeof changes[CFG.STORAGE_SIZE].newValue === 'number')    _size = changes[CFG.STORAGE_SIZE].newValue;
      if (CFG.STORAGE_OPACITY in changes && typeof changes[CFG.STORAGE_OPACITY].newValue === 'number') _opacity = changes[CFG.STORAGE_OPACITY].newValue;
      if (CFG.STORAGE_DELAY in changes   && typeof changes[CFG.STORAGE_DELAY].newValue === 'number')   _delay = changes[CFG.STORAGE_DELAY].newValue;
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
 * @returns {Array<object>}
 */
function buildWedges() {
  const premium = Store.isPremium();

  const urlWedge = (slotNo, sIdx) => {
    const url    = Store.slotUrl(sIdx);
    const host   = hostOf(url);
    const locked = slotNo >= 2 && !premium;   // Slots 2..5 require premium
    return {
      kind:  'url',
      slotNo,
      url,
      host,
      locked,
      label: locked ? `Slot ${slotNo} 🔒` : (host || `Slot ${slotNo}`),
    };
  };

  // clockwise from North
  return [
    urlWedge(1, 0),                                     // N
    urlWedge(2, 1),                                     // NE
    { kind: 'nav', action: 'forward', label: 'Forward' }, // E
    urlWedge(3, 2),                                     // SE
    { kind: 'nav', action: 'reload',  label: 'Reload'  }, // S
    urlWedge(4, 3),                                     // SW
    { kind: 'nav', action: 'back',    label: 'Back'    }, // W
    urlWedge(5, 4),                                     // NW
  ];
}

function hostOf(url) {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Ticker — short Web Audio "tick" on slot change (no asset required)
// ═══════════════════════════════════════════════════════════════════════════════
class Ticker {
  constructor() { this._ctx = null; }

  _ensure() {
    if (!this._ctx) {
      try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch { this._ctx = null; }
    }
    if (this._ctx && this._ctx.state === 'suspended') this._ctx.resume().catch(() => {});
  }

  /** @param {number} freq  pitch (Hz) — vary it for select vs fire */
  tick(freq = 1500, gain = 0.16, dur = 0.045) {
    this._ensure();
    if (!this._ctx) return;
    const ctx = this._ctx;
    const t   = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g   = ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + dur + 0.01);
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
  }

  get isOpen() { return !!this._host; }

  /** Effective dead-zone radius in screen px (scales with dial size). */
  deadZone() { return this.dim ? this.dim.dead : CFG.DEAD_ZONE; }

  /**
   * Spawn the dial centred at viewport (cx, cy).
   * @param {object} [opts]  { scale, bandAlpha }
   */
  spawn(cx, cy, wedges, opts = {}) {
    this._hardRemove();
    this._wedges = wedges;
    this._active = -1;

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
    shadow.appendChild(this._style(D));
    shadow.appendChild(this._buildSVG());
    this._buildIcons(shadow);

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
    host.style.transition = `opacity ${CFG.DISMISS_MS}ms ease, transform ${CFG.DISMISS_MS}ms ease`;
    host.style.opacity = '0';
    host.style.transform = 'scale(1.12)';
    this._host = null;
    this._dismissTimer = setTimeout(() => host.remove(), CFG.DISMISS_MS + 40);
  }

  // ── internals ──────────────────────────────────────────────────────────────

  _hardRemove() {
    if (this._dismissTimer) clearTimeout(this._dismissTimer);
    document.getElementById(CFG.HOST_ID)?.remove();
    const stray = this._host; if (stray && stray.parentNode) stray.remove();
    this._host = this._shadow = this._labelEl = null;
    this._tetherEl = this._tetherDot = null;
    this._wedgeEls = [];
    this._active = -1;
  }

  _style(D) {
    const s = document.createElement('style');
    s.textContent = `
      svg { position:absolute; inset:0; overflow:visible; }
      /* Band fill = violet/black mix; its alpha is the user's transparency
         setting (0 = fully see-through). Selected wedge glows brighter. */
      .wedge { fill: url(#mwFill); stroke: rgba(168,85,247,0.20); stroke-width:1; transition: fill .12s ease; }
      .wedge.active { fill: url(#mwActive); stroke: ${CFG.ACCENT_BRIGHT}; stroke-width:1; filter: url(#mwGlowStrong); }
      .ring-main  { fill:none; stroke: rgba(192,132,252,0.95); stroke-width:2;   filter: url(#mwGlow); }
      .ring-inner { fill:none; stroke: rgba(168,85,247,0.55); stroke-width:1.4; filter: url(#mwGlow); }
      .ring-dash  { fill:none; stroke: rgba(168,85,247,0.30); stroke-width:1; stroke-dasharray:2 7; }
      .tick    { stroke: rgba(168,85,247,0.35); stroke-width:1; stroke-linecap:round; }
      .divider { stroke: rgba(168,85,247,0.20); stroke-width:1; }
      .reticle      { stroke: rgba(192,132,252,0.85); stroke-width:1.2; stroke-linecap:round; }
      .reticle-ring { fill:none; stroke: rgba(168,85,247,0.30); stroke-width:1; }
      .reticle-dot  { fill:${CFG.ACCENT_BRIGHT}; filter:url(#mwGlow); }
      .tether       { stroke: rgba(192,132,252,0.9); stroke-width:2; stroke-linecap:round; filter:url(#mwGlow); opacity:0; transition:opacity .08s ease; }
      .tether-dot   { fill:#f4ecff; filter:url(#mwGlow); opacity:0; transition:opacity .08s ease; }
      .centre-label { fill:#f4ecff; stroke:rgba(6,4,12,0.92); stroke-width:3.5; paint-order:stroke;
                      font:700 15px 'Segoe UI',system-ui,sans-serif; text-anchor:middle; letter-spacing:.4px; }
      .nav-glyph { fill:none; stroke:${CFG.ACCENT_BRIGHT}; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; filter:url(#mwGlow); }
      .ico { position:absolute; width:34px; height:34px; transform:translate(-50%,-50%); display:grid; place-items:center; pointer-events:none; }
      .ico img { width:26px; height:26px; border-radius:6px; display:block; box-shadow:0 0 10px rgba(168,85,247,0.45); background:rgba(10,8,16,0.6); }
      .ico .ph { font:600 11px 'Segoe UI',sans-serif; color:#c9b4ff; text-align:center; line-height:1.05; letter-spacing:.4px; text-shadow:0 0 8px rgba(168,85,247,0.6); }
      .ico .letter { width:26px; height:26px; border-radius:6px; background:rgba(168,85,247,0.20); border:1px solid rgba(192,132,252,0.6); color:#f0e6ff; font:700 14px 'Segoe UI',sans-serif; display:grid; place-items:center; box-shadow:0 0 10px rgba(168,85,247,0.4); }
      .ico .lock { position:absolute; right:-3px; bottom:-3px; width:14px; height:14px; filter:drop-shadow(0 0 3px rgba(0,0,0,0.7)); }
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
    const a = this._bandAlpha;

    // ── defs: glow filters + wedge gradients (band alpha = user setting) ──
    const defs = el('defs', {});
    defs.innerHTML = `
      <filter id="mwGlow" x="-40%" y="-40%" width="180%" height="180%">
        <feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <filter id="mwGlowStrong" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="mwFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(56,30,96,${a})"/><stop offset="100%" stop-color="rgba(11,7,20,${a})"/>
      </linearGradient>
      <linearGradient id="mwActive" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="rgba(168,85,247,${Math.max(0.5, a)})"/><stop offset="100%" stop-color="rgba(109,40,217,${Math.max(0.55, a)})"/>
      </linearGradient>`;
    svg.appendChild(defs);

    // ── outer dashed rune ring + tick marks ───────────────────────────────
    svg.appendChild(el('circle', { cx: c, cy: c, r: RO + 8 * s }, 'ring-dash'));
    for (let i = 0; i < 24; i++) {
      const ang = rad(i * 15);
      const r0 = RO + 2 * s, r1 = RO + (i % 2 ? 5 : 8) * s;
      svg.appendChild(el('line', {
        x1: c + r0 * Math.cos(ang), y1: c + r0 * Math.sin(ang),
        x2: c + r1 * Math.cos(ang), y2: c + r1 * Math.sin(ang),
      }, 'tick'));
    }

    // ── 8 wedges ──────────────────────────────────────────────────────────
    this._wedgeEls = [];
    for (let i = 0; i < 8; i++) {
      const centre = -90 + i * 45;
      const path = el('path', { d: this._wedgePath(c, RO, RI, centre - 22.5, centre + 22.5) }, 'wedge');
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
  _wedgePath(c, RO, RI, a0, a1) {
    const rad = (a) => a * Math.PI / 180;
    const p = (r, a) => [c + r * Math.cos(rad(a)), c + r * Math.sin(rad(a))];
    const [ox0, oy0] = p(RO, a0), [ox1, oy1] = p(RO, a1);
    const [ix1, iy1] = p(RI, a1), [ix0, iy0] = p(RI, a0);
    return `M ${ox0} ${oy0} A ${RO} ${RO} 0 0 1 ${ox1} ${oy1} L ${ix1} ${iy1} A ${RI} ${RI} 0 0 0 ${ix0} ${iy0} Z`;
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
      g.appendChild(el('path', { d: 'M6.6 -6.6 L6.9 -1.6 L2 -3.4 Z', fill: CFG.ACCENT_BRIGHT, stroke: 'none' }));
    }
    svg.appendChild(g);
  }

  /** HTML icon overlays for URL wedges (favicons / placeholders / lock). */
  _buildIcons(shadow) {
    const { c, ICON, s } = this.dim;
    this._wedges.forEach((w, i) => {
      if (w.kind !== 'url') return;
      const centre = -90 + i * 45;
      const rad = centre * Math.PI / 180;
      const x = c + ICON * Math.cos(rad);
      const y = c + ICON * Math.sin(rad);

      const box = document.createElement('div');
      box.className = 'ico';
      box.style.left = `${x}px`;
      box.style.top  = `${y}px`;
      box.style.transform = `translate(-50%,-50%) scale(${s})`;   // scale icon with dial

      if (w.url && !w.locked) {
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
        lock.innerHTML = '<rect x="4" y="11" width="16" height="10" rx="2" fill="#1a1326" stroke="#c084fc" stroke-width="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="#c084fc" stroke-width="2"/>';
        box.appendChild(lock);
      }

      shadow.appendChild(box);
    });
  }

  _setLabel(text) {
    if (this._labelEl) this._labelEl.textContent = text || '';
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

    this._bind();
    console.log('[MOUSSY] Radial dial engine ready — build: v6-polish —', location.hostname);
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

    // Hold-to-activate: the dial only appears after the configured delay, so a
    // normal quick right-click still opens the browser's context menu.
    const delay = Store.dialDelay();
    if (delay <= 0) this._openDial();
    else this._pending = setTimeout(() => this._openDial(), delay);
  }

  _openDial() {
    this._pending = null;
    if (this._open) return;
    this._open = true;
    this._hud.spawn(this._downX, this._downY, buildWedges(), {
      scale:     Store.dialSize(),
      bandAlpha: Store.dialOpacity(),
    });
    this._ticker.tick(900, 0.10, 0.05);    // soft "open" blip
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
    if (changed && this._hud.selected()) this._ticker.tick(1550, 0.16, 0.04);  // per-slot tick
  }

  _onUp(e) {
    if (e.button !== 2) return;
    this._cancelPending();
    this._clearSafety();
    if (!this._open) return;   // released before the dial opened → native menu

    this._open = false;
    const wedge = this._hud.selected();
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
