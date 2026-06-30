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
  ICON_R:     103,   // radius at which wedge icons sit (inside the thin band)
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
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── Caches (slots + premium + pause), primed from storage, live-updated
// ═══════════════════════════════════════════════════════════════════════════════

const Store = (() => {
  let _slots = [];        // array of url strings, index 0..4
  let _plan  = 'free';
  let _pauseGlobal = false;
  let _pauseHosts  = [];
  const _host = (() => { try { return location.hostname; } catch { return ''; } })();

  (async () => {
    try {
      const d = await chrome.storage.local.get([
        CFG.STORAGE_SLOTS, CFG.STORAGE_PLAN, CFG.STORAGE_PAUSE_GLOBAL, CFG.STORAGE_PAUSE_HOSTS,
      ]);
      setSlots(d[CFG.STORAGE_SLOTS]);
      _plan        = d[CFG.STORAGE_PLAN] ?? 'free';
      _pauseGlobal = d[CFG.STORAGE_PAUSE_GLOBAL] === true;
      _pauseHosts  = Array.isArray(d[CFG.STORAGE_PAUSE_HOSTS]) ? d[CFG.STORAGE_PAUSE_HOSTS] : [];
    } catch (_) { /* chrome:// or invalidated context */ }
  })();

  function setSlots(raw) {
    if (!Array.isArray(raw)) { _slots = []; return; }
    _slots = raw.map((s) => (typeof s === 'string' ? s : (s && s.url) || '').trim());
  }

  return {
    slotUrl(i)   { return _slots[i] || ''; },
    isPremium()  { return _plan === 'monthly' || _plan === 'legend'; },
    isPaused()   { return _pauseGlobal || _pauseHosts.includes(_host); },
    _onChange(changes) {
      if (CFG.STORAGE_SLOTS in changes)        setSlots(changes[CFG.STORAGE_SLOTS].newValue);
      if (CFG.STORAGE_PLAN in changes)         _plan = changes[CFG.STORAGE_PLAN].newValue ?? 'free';
      if (CFG.STORAGE_PAUSE_GLOBAL in changes) _pauseGlobal = changes[CFG.STORAGE_PAUSE_GLOBAL].newValue === true;
      if (CFG.STORAGE_PAUSE_HOSTS in changes)  _pauseHosts = Array.isArray(changes[CFG.STORAGE_PAUSE_HOSTS].newValue) ? changes[CFG.STORAGE_PAUSE_HOSTS].newValue : [];
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

  /** Spawn the dial centred at viewport (cx, cy). */
  spawn(cx, cy, wedges) {
    this._hardRemove();
    this._wedges = wedges;
    this._active = -1;

    const D = CFG.D;
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
    shadow.appendChild(this._buildSVG(D));
    this._buildIcons(shadow, D);

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
    let idx = -1;
    if (dist >= CFG.DEAD_ZONE) {
      const ang = Math.atan2(dy, dx) * 180 / Math.PI;   // -180..180, 0 = right
      idx = (Math.round((ang + 90) / 45) % 8 + 8) % 8;  // 0 = North, clockwise
    }
    if (idx === this._active) return false;

    this._active = idx;
    this._wedgeEls.forEach((el, i) => el.classList.toggle('active', i === idx));
    this._setLabel(idx >= 0 ? this._wedges[idx].label : '');
    return true;
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
    this._wedgeEls = [];
    this._active = -1;
  }

  _style(D) {
    const s = document.createElement('style');
    s.textContent = `
      svg { position:absolute; inset:0; overflow:visible; }
      .wedge { fill: rgba(20,16,32,0.82); stroke: rgba(168,85,247,0.35); stroke-width:1; transition: fill .1s ease; }
      .wedge.active { fill: rgba(168,85,247,0.55); stroke: ${CFG.ACCENT_BRIGHT}; }
      .ring { fill:none; stroke: rgba(168,85,247,0.9); stroke-width:2; }
      .ring-dash { fill:none; stroke: rgba(168,85,247,0.25); stroke-width:1; stroke-dasharray:2 7; }
      .divider { stroke: rgba(168,85,247,0.25); stroke-width:1; }
      .centre-bg { fill: rgba(8,6,14,0.92); stroke: rgba(168,85,247,0.5); stroke-width:1.4; }
      .centre-label { fill:#e9d8ff; font:600 13px 'Segoe UI',sans-serif; text-anchor:middle; }
      .nav-glyph { fill:none; stroke:${CFG.ACCENT_BRIGHT}; stroke-width:2.4; stroke-linecap:round; stroke-linejoin:round; }
      .ico { position:absolute; width:34px; height:34px; transform:translate(-50%,-50%); display:grid; place-items:center; pointer-events:none; }
      .ico img { width:26px; height:26px; border-radius:5px; display:block; }
      .ico .ph { font:600 11px 'Segoe UI',sans-serif; color:#b89cf0; text-align:center; line-height:1.05; letter-spacing:.3px; }
      .ico .letter { width:26px; height:26px; border-radius:5px; background:rgba(168,85,247,0.18); border:1px solid rgba(168,85,247,0.5); color:#e9d8ff; font:700 14px 'Segoe UI',sans-serif; display:grid; place-items:center; }
      .ico .lock { position:absolute; right:-2px; bottom:-2px; width:13px; height:13px; }
    `;
    return s;
  }

  _buildSVG(D) {
    const c = D / 2, NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${D} ${D}`);
    svg.setAttribute('width', D); svg.setAttribute('height', D);

    const el = (tag, attrs, cls) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (cls) n.setAttribute('class', cls);
      return n;
    };

    // outer dashed decoration
    svg.appendChild(el('circle', { cx: c, cy: c, r: CFG.RING_OUT + 8 }, 'ring-dash'));

    // 8 wedges
    this._wedgeEls = [];
    for (let i = 0; i < 8; i++) {
      const centre = -90 + i * 45;                // degrees, 0 = right
      const path = el('path', { d: this._wedgePath(c, centre - 22.5, centre + 22.5) }, 'wedge');
      svg.appendChild(path);
      this._wedgeEls.push(path);
    }

    // rings
    svg.appendChild(el('circle', { cx: c, cy: c, r: CFG.RING_OUT }, 'ring'));
    svg.appendChild(el('circle', { cx: c, cy: c, r: CFG.RING_IN }, 'centre-bg'));

    // nav glyphs (E forward, S reload, W back) drawn in SVG
    this._navGlyph(svg, el, c, 0,   'forward');
    this._navGlyph(svg, el, c, 90,  'reload');
    this._navGlyph(svg, el, c, 180, 'back');

    // centre label
    this._labelEl = el('text', { x: c, y: c + 4 }, 'centre-label');
    this._labelEl.textContent = '';
    svg.appendChild(this._labelEl);

    return svg;
  }

  /** Donut wedge path between two angles (degrees). */
  _wedgePath(c, a0, a1) {
    const rad = (a) => a * Math.PI / 180;
    const RO = CFG.RING_OUT, RI = CFG.RING_IN;
    const p = (r, a) => [c + r * Math.cos(rad(a)), c + r * Math.sin(rad(a))];
    const [ox0, oy0] = p(RO, a0), [ox1, oy1] = p(RO, a1);
    const [ix1, iy1] = p(RI, a1), [ix0, iy0] = p(RI, a0);
    return `M ${ox0} ${oy0} A ${RO} ${RO} 0 0 1 ${ox1} ${oy1} L ${ix1} ${iy1} A ${RI} ${RI} 0 0 0 ${ix0} ${iy0} Z`;
  }

  _navGlyph(svg, el, c, angDeg, kind) {
    const rad = angDeg * Math.PI / 180;
    const x = c + CFG.ICON_R * Math.cos(rad);
    const y = c + CFG.ICON_R * Math.sin(rad);
    const g = el('g', { transform: `translate(${x} ${y})` });
    if (kind === 'forward') {
      g.appendChild(el('path', { d: 'M-4 -7 L4 0 L-4 7' }, 'nav-glyph'));
    } else if (kind === 'back') {
      g.appendChild(el('path', { d: 'M4 -7 L-4 0 L4 7' }, 'nav-glyph'));
    } else { // reload
      g.appendChild(el('path', { d: 'M7 0 A7 7 0 1 1 4 -6' }, 'nav-glyph'));
      g.appendChild(el('path', { d: 'M4 -9 L5 -5 L1 -5 Z', fill: CFG.ACCENT_BRIGHT, stroke: 'none' }));
    }
    svg.appendChild(g);
  }

  /** HTML icon overlays for URL wedges (favicons / placeholders / lock). */
  _buildIcons(shadow, D) {
    const c = D / 2;
    this._wedges.forEach((w, i) => {
      if (w.kind !== 'url') return;
      const centre = -90 + i * 45;
      const rad = centre * Math.PI / 180;
      const x = c + CFG.ICON_R * Math.cos(rad);
      const y = c + CFG.ICON_R * Math.sin(rad);

      const box = document.createElement('div');
      box.className = 'ico';
      box.style.left = `${x}px`;
      box.style.top  = `${y}px`;

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

    this._active   = false;   // right button held with dial open
    this._engaged  = false;   // cursor left the dead-zone at least once
    this._originX  = 0;
    this._originY  = 0;
    this._moveX    = 0;
    this._moveY    = 0;
    this._movePending = false;

    this._bind();
    console.log('[MOUSSY] Radial dial engine ready on', location.hostname);
  }

  _bind() {
    document.addEventListener('mousedown',   this._onDown.bind(this),  { capture: true });
    document.addEventListener('mousemove',   this._onMove.bind(this),  { passive: true });
    document.addEventListener('mouseup',     this._onUp.bind(this),    { capture: true });
    document.addEventListener('contextmenu', this._onCtx.bind(this),   { capture: true });
  }

  _onDown(e) {
    if (e.button !== 2) return;
    if (Store.isPaused()) return;          // gestures off for this page

    this._active  = true;
    this._engaged = false;
    this._originX = e.clientX;
    this._originY = e.clientY;
    this._hud.spawn(e.clientX, e.clientY, buildWedges());
    this._ticker.tick(900, 0.10, 0.05);    // soft "open" blip
  }

  _onMove(e) {
    if (!this._active) return;
    this._moveX = e.clientX;
    this._moveY = e.clientY;
    if (!this._movePending) {
      this._movePending = true;
      requestAnimationFrame(() => this._processMove());
    }
  }

  _processMove() {
    this._movePending = false;
    if (!this._active) return;
    const dx = this._moveX - this._originX;
    const dy = this._moveY - this._originY;
    if (Math.hypot(dx, dy) >= CFG.DEAD_ZONE) this._engaged = true;
    const changed = this._hud.track(dx, dy);
    if (changed && this._hud.selected()) this._ticker.tick(1550, 0.16, 0.04);  // per-slot tick
  }

  _onUp(e) {
    if (e.button !== 2 || !this._active) return;
    this._active = false;

    const wedge = this._hud.selected();
    this._hud.dismiss();

    if (this._engaged) this._guard.arm();   // a real gesture happened → swallow the menu
    if (wedge) this._fire(wedge);
  }

  _onCtx(e) {
    if (this._guard.consume()) { e.preventDefault(); e.stopPropagation(); }
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
