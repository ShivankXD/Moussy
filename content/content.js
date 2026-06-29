/**
 * MOUSSY — Gesture Engine  (content.js)
 * =======================================
 * Injected at document_idle into every tab via manifest content_scripts.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Architecture                                                           │
 * │                                                                         │
 * │  GestureMode   – reads moussy_gesture_mode from storage (cached)       │
 * │                                                                         │
 * │  CanvasManager   – singleton fullscreen canvas for FREE-HAND trail      │
 * │  TrailRenderer   – neon glow trail with layered rAF paint              │
 * │                                                                         │
 * │  OmniClockHUD    – Ben 10 Watch-style SVG HUD injected as a DOM node   │
 * │    ├─ spawn(x, y)     inject + animate in                               │
 * │    ├─ track(dx, dy)   highlight the active direction arm               │
 * │    └─ dismiss()       fade-out + DOM removal                            │
 * │                                                                         │
 * │  GestureRecorder – pre-allocated Float32Array path accumulator          │
 * │  ContextGuard    – single-shot contextmenu suppression                  │
 * │  MouseController – event wiring + mode dispatch (entry point)          │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * Performance notes
 * ──────────────────
 *  • Canvas is created once and reused across gestures (no DOM thrash)
 *  • mousemove throttled via rAF flag — one paint call per display frame
 *  • Float32Array recording buffer: reset on each gesture start (zero GC)
 *  • HUD element uses CSS transform/opacity — compositor-only animation
 *  • canvas pointerEvents = "none", HUD pointerEvents = "none"
 *    → neither intercepts any page events
 *  • Gesture mode cached in memory after first storage read
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// ── Constants
// ═══════════════════════════════════════════════════════════════════════════════

const CFG = Object.freeze({
  /** Minimum pixel displacement to register as an intentional stroke */
  MIN_STROKE_PX: 20,

  /** Radius (px) of the dead-zone circle around the HUD centre.
   *  The cursor must travel beyond this before a direction is committed. */
  HUD_DEAD_ZONE: 38,

  /** Maximum points stored per gesture stroke (pre-allocated) */
  MAX_POINTS: 4096,

  /** Neon purple — the primary accent colour */
  TRAIL_COLOR: '#a855f7',

  /** Glow passes: [shadowBlur, globalAlpha] per layer */
  GLOW_LAYERS: [
    [48, 0.20],
    [24, 0.40],
    [10, 0.80],
    [3,  1.00],
  ],

  /** Base trail stroke width */
  LINE_WIDTH: 3,

  /** Trail canvas fade-out duration (ms) */
  FADE_MS: 280,

  /** HUD appear / disappear animation duration (ms) */
  HUD_APPEAR_MS: 200,
  HUD_DISMISS_MS: 220,

  /** HUD radius (px) — diameter of the circular wheel on screen */
  HUD_RADIUS: 72,

  CANVAS_ID:  'moussy-canvas',
  HUD_ID:     'moussy-omni-hud',

  /** Storage key for gesture mode (set by settings.js) */
  STORAGE_MODE_KEY: 'moussy_gesture_mode',
});

/** Cardinal directions — mirrors background.js Dir enum */
const Direction = Object.freeze({
  UP:    'UP',
  DOWN:  'DOWN',
  LEFT:  'LEFT',
  RIGHT: 'RIGHT',
});

/** Gesture render modes */
const GestureMode = Object.freeze({
  OMNI:      'omni',      // Ben 10 Watch HUD
  FREEHAND:  'freehand',  // neon trail canvas (original)
});

// ═══════════════════════════════════════════════════════════════════════════════
// ── GestureModeCache
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Reads the configured gesture mode from chrome.storage once per page load
 * and caches it in memory. Falls back to FREEHAND if storage is unavailable.
 */
const GestureModeCache = (() => {
  let _mode = GestureMode.FREEHAND;  // safe default
  let _resolved = false;

  // Kick off async read immediately on script load
  const _readPromise = (async () => {
    try {
      const data = await chrome.storage.local.get(CFG.STORAGE_MODE_KEY);
      const stored = data[CFG.STORAGE_MODE_KEY];
      if (stored === GestureMode.OMNI || stored === GestureMode.FREEHAND) {
        _mode = stored;
      }
    } catch (_) {
      // Extension context not available (e.g., chrome:// page) — keep default
    }
    _resolved = true;
  })();

  return {
    /** @returns {Promise<string>} resolves to 'omni' | 'freehand' */
    async get() {
      if (!_resolved) await _readPromise;
      return _mode;
    },

    /** Override the cached value (for runtime settings changes) */
    set(mode) { _mode = mode; },
  };
})();

// Listen for runtime storage changes so mode switches take effect immediately
// without requiring a page reload.
try {
  chrome.storage.onChanged.addListener((changes) => {
    if (CFG.STORAGE_MODE_KEY in changes) {
      const newMode = changes[CFG.STORAGE_MODE_KEY].newValue;
      if (newMode === GestureMode.OMNI || newMode === GestureMode.FREEHAND) {
        GestureModeCache.set(newMode);
        console.log(`[MOUSSY] Gesture mode updated → ${newMode}`);
      }
    }
  });
} catch (_) { /* chrome:// pages */ }

// ═══════════════════════════════════════════════════════════════════════════════
// ── CanvasManager  (FREE-HAND mode)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Owns the singleton fullscreen overlay canvas used by TrailRenderer.
 * Appended to <html> (not <body>) to survive SPA body replacements.
 */
class CanvasManager {
  constructor() {
    this._canvas = null;
    this._ctx    = null;
  }

  get canvas() { if (!this._canvas) this._init(); return this._canvas; }
  get ctx()    { if (!this._ctx)    this._init(); return this._ctx;    }

  _init() {
    const c = document.createElement('canvas');
    c.id = CFG.CANVAS_ID;

    const s = c.style;
    s.position        = 'fixed';
    s.top             = '0';
    s.left            = '0';
    s.width           = '100vw';
    s.height          = '100vh';
    s.zIndex          = '2147483647';
    s.pointerEvents   = 'none';
    s.imageRendering  = 'pixelated';
    s.display         = 'block';
    s.opacity         = '1';
    s.willChange      = 'opacity';

    this._fitToViewport(c);
    document.documentElement.appendChild(c);
    this._ctx    = c.getContext('2d', { alpha: true, desynchronized: true });
    this._canvas = c;

    window.addEventListener('resize', () => this._fitToViewport(this._canvas), { passive: true });
  }

  _fitToViewport(canvas) {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  clear() {
    const { width, height } = this._canvas;
    this._ctx.clearRect(0, 0, width, height);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── TrailRenderer  (FREE-HAND mode)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Paints the neon glow trail incrementally onto the CanvasManager surface.
 * Each new mouse segment is queued and flushed in a single rAF call,
 * keeping paint work entirely off the event-handler thread.
 */
class TrailRenderer {
  /** @param {CanvasManager} canvasManager */
  constructor(canvasManager) {
    this._cm        = canvasManager;
    this._queue     = [];
    this._rafId     = null;
    this._fadeRafId = null;
  }

  /** Queue a segment to be painted on the next display frame. */
  segment(x0, y0, x1, y1) {
    this._queue.push({ x0, y0, x1, y1 });
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => this._flush());
    }
  }

  _flush() {
    this._rafId = null;
    if (!this._queue.length) return;

    const ctx = this._cm.ctx;
    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    for (const seg of this._queue) this._paintGlowSegment(ctx, seg);
    this._queue.length = 0;

    ctx.restore();
  }

  _paintGlowSegment(ctx, { x0, y0, x1, y1 }) {
    // Multi-pass bloom layers
    for (const [blur, alpha] of CFG.GLOW_LAYERS) {
      ctx.beginPath();
      ctx.globalAlpha = alpha;
      ctx.shadowColor = CFG.TRAIL_COLOR;
      ctx.shadowBlur  = blur;
      ctx.strokeStyle = CFG.TRAIL_COLOR;
      ctx.lineWidth   = blur > 20 ? CFG.LINE_WIDTH + 1 : CFG.LINE_WIDTH;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    // Bright white-purple core
    ctx.beginPath();
    ctx.globalAlpha = 0.6;
    ctx.shadowBlur  = 2;
    ctx.shadowColor = '#e8b4f8';
    ctx.strokeStyle = '#f0d6ff';
    ctx.lineWidth   = 1.2;
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
  }

  fadeAndClear() {
    if (this._rafId)    { cancelAnimationFrame(this._rafId);    this._rafId = null; }
    if (this._fadeRafId){ cancelAnimationFrame(this._fadeRafId); }
    this._queue.length  = 0;

    const canvas     = this._cm.canvas;
    const startAlpha = parseFloat(canvas.style.opacity ?? '1');
    const startTime  = performance.now();

    const tick = (now) => {
      const t = Math.min((now - startTime) / CFG.FADE_MS, 1);
      canvas.style.opacity = String(startAlpha * (1 - t));
      if (t < 1) {
        this._fadeRafId = requestAnimationFrame(tick);
      } else {
        this._fadeRafId      = null;
        canvas.style.opacity = '1';
        this._cm.clear();
      }
    };
    this._fadeRafId = requestAnimationFrame(tick);
  }

  hardClear() {
    if (this._rafId)    { cancelAnimationFrame(this._rafId);    this._rafId    = null; }
    if (this._fadeRafId){ cancelAnimationFrame(this._fadeRafId); this._fadeRafId = null; }
    this._queue.length           = 0;
    this._cm.canvas.style.opacity = '1';
    this._cm.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── OmniClockHUD  (OMNI-CLOCK mode)
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Renders the Ben 10 Watch-style circular gesture HUD directly in the DOM.
 *
 * Design spec
 * ──────────────────────────────────────────────────────────────────────────────
 *  • A fixed container div centred on the right-click origin
 *  • Inner SVG: two concentric rings, four directional arrow arms (Up, Down,
 *    Left, Right) positioned on the ring boundary, a pulsing centre reticle,
 *    and a sparse tech-dash decoration layer
 *  • Appears via scale(0.6→1) + opacity(0→1) CSS transition (GPU compositor)
 *  • Active direction arm lights up in full purple as the cursor moves
 *  • Dismissal: scale(1→1.1) + opacity(1→0) → DOM removal
 *
 * Isolation guarantees
 * ──────────────────────────────────────────────────────────────────────────────
 *  • All styles are inline — zero CSS class conflicts with the host page
 *  • pointerEvents = "none" — the HUD never swallows page mouse events
 *  • ID-guarded mount — only one HUD exists at any time
 *  • Uses Shadow DOM to fully encapsulate styles from the page
 */
class OmniClockHUD {
  constructor() {
    this._host      = null;   // the injected container element
    this._shadow    = null;   // Shadow DOM root
    this._svgEl     = null;   // the SVG inside shadow
    this._armEls    = {};     // { UP, DOWN, LEFT, RIGHT } → <g> elements
    this._reticleEl = null;   // centre pulsing dot group
    this._centreX   = 0;
    this._centreY   = 0;
    this._dismissRaf = null;
    this._activeDir  = null;
    this._animating  = false; // true while appear/dismiss animation runs
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Inject and animate the HUD centred on (cx, cy).
   * @param {number} cx  clientX of the right-click origin
   * @param {number} cy  clientY of the right-click origin
   */
  spawn(cx, cy) {
    this._hardRemove();     // safety: clear any leftover from a previous gesture

    this._centreX   = cx;
    this._centreY   = cy;
    this._activeDir = null;
    this._animating = true;

    // ── Container ──────────────────────────────────────────────────────────
    const host = document.createElement('div');
    host.id = CFG.HUD_ID;

    const D = CFG.HUD_RADIUS * 2 + 40;   // total pixel box (ring + label clearance)

    Object.assign(host.style, {
      position:       'fixed',
      zIndex:         '2147483647',
      pointerEvents:  'none',
      width:          `${D}px`,
      height:         `${D}px`,
      left:           `${cx - D / 2}px`,
      top:            `${cy - D / 2}px`,
      willChange:     'opacity, transform',
      // Appear animation start state
      opacity:        '0',
      transform:      'scale(0.62)',
      transition:     `opacity ${CFG.HUD_APPEAR_MS}ms cubic-bezier(0.22,1,0.36,1),
                       transform ${CFG.HUD_APPEAR_MS}ms cubic-bezier(0.22,1,0.36,1)`,
    });

    // ── Shadow DOM for full style isolation ────────────────────────────────
    const shadow = host.attachShadow({ mode: 'closed' });
    this._shadow = shadow;

    // Scoped keyframe animations live inside the shadow
    const style = document.createElement('style');
    style.textContent = `
      @keyframes moussy-pulse {
        0%,100% { opacity:0.55; transform:scale(0.88); }
        50%      { opacity:1;    transform:scale(1.08); }
      }
      @keyframes moussy-ring-spin {
        from { transform:rotate(0deg) translateX(-50%) translateY(-50%); }
        to   { transform:rotate(360deg) translateX(-50%) translateY(-50%); }
      }
      @keyframes moussy-ring-spin-rev {
        from { transform: rotate(0deg); }
        to   { transform: rotate(-360deg); }
      }
      .pulse-ring {
        animation: moussy-pulse 1.8s ease-in-out infinite;
        transform-origin: center center;
      }
      .spin-dash {
        transform-origin: ${D/2}px ${D/2}px;
        animation: moussy-ring-spin-rev 14s linear infinite;
      }
      .arm-group {
        transition: opacity 0.12s ease;
        opacity: 0.42;
      }
      .arm-group.active {
        opacity: 1.0;
      }
    `;
    shadow.appendChild(style);

    // ── SVG ────────────────────────────────────────────────────────────────
    const svg = this._buildSVG(D);
    shadow.appendChild(svg);
    this._svgEl = svg;

    // Mount into document
    document.documentElement.appendChild(host);
    this._host = host;

    // Trigger compositor animation into view on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        host.style.opacity   = '1';
        host.style.transform = 'scale(1)';
        setTimeout(() => { this._animating = false; }, CFG.HUD_APPEAR_MS);
      });
    });
  }

  /**
   * Update the highlighted direction arm as the cursor moves.
   * @param {number} dx  current X displacement from spawn origin
   * @param {number} dy  current Y displacement from spawn origin
   */
  track(dx, dy) {
    if (!this._host) return;

    const dist = Math.hypot(dx, dy);
    if (dist < CFG.HUD_DEAD_ZONE) {
      // Inside dead-zone: dim all arms
      this._setActiveArm(null);
      return;
    }

    // Classify dominant axis
    let dir;
    if (Math.abs(dx) >= Math.abs(dy)) {
      dir = dx > 0 ? Direction.RIGHT : Direction.LEFT;
    } else {
      dir = dy > 0 ? Direction.DOWN : Direction.UP;
    }

    this._setActiveArm(dir);
  }

  /**
   * Animate the HUD out and remove it from the DOM.
   * @param {string|null} firedDirection  the recognised direction, or null
   */
  dismiss(firedDirection) {
    if (!this._host) return;
    if (this._dismissRaf) cancelAnimationFrame(this._dismissRaf);

    const host = this._host;

    // Brief directional burst flash before dismissal
    if (firedDirection) this._flashArm(firedDirection);

    // Dismiss animation: scale up + fade out
    host.style.transition = `opacity ${CFG.HUD_DISMISS_MS}ms ease,
                              transform ${CFG.HUD_DISMISS_MS}ms cubic-bezier(0.4,0,1,1)`;
    host.style.opacity   = '0';
    host.style.transform = 'scale(1.14)';

    const pid = setTimeout(() => {
      if (host.parentNode) host.parentNode.removeChild(host);
      if (this._host === host) {
        this._host = null;
        this._svgEl = null;
        this._armEls = {};
        this._reticleEl = null;
      }
    }, CFG.HUD_DISMISS_MS + 40);

    // Safety cancel on repeat calls
    this._dismissPid = pid;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  _hardRemove() {
    if (this._dismissPid) clearTimeout(this._dismissPid);
    const existing = document.getElementById(CFG.HUD_ID);
    if (existing) existing.remove();
    this._host = null;
    this._svgEl = null;
    this._armEls = {};
    this._reticleEl = null;
    this._activeDir = null;
  }

  _setActiveArm(dir) {
    if (dir === this._activeDir) return;
    this._activeDir = dir;

    for (const [d, el] of Object.entries(this._armEls)) {
      if (el) {
        el.classList.toggle('active', d === dir);
      }
    }
  }

  /** Brief bright flash on the fired direction before dismissal. */
  _flashArm(dir) {
    const el = this._armEls[dir];
    if (!el) return;
    el.classList.add('active');
    // The element is about to be removed anyway — no cleanup needed
  }

  // ── SVG Construction ───────────────────────────────────────────────────────

  /**
   * Builds the complete OMNI-CLOCK SVG.
   * All measurements are in the local coordinate space [0, D] × [0, D].
   *
   * @param {number} D   total SVG box size in pixels
   * @returns {SVGSVGElement}
   */
  _buildSVG(D) {
    const cx = D / 2;   // centre X in SVG coords
    const cy = D / 2;   // centre Y in SVG coords
    const R  = CFG.HUD_RADIUS; // radius of the main ring

    const svg = this._svgNS('svg');
    svg.setAttribute('viewBox', `0 0 ${D} ${D}`);
    svg.setAttribute('width',   `${D}`);
    svg.setAttribute('height',  `${D}`);
    svg.setAttribute('xmlns',   'http://www.w3.org/2000/svg');
    Object.assign(svg.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'visible',
    });

    // ── Defs ────────────────────────────────────────────────────────────────
    const defs = this._svgNS('defs');

    // Radial gradient for HUD background fill
    const rg = this._svgNS('radialGradient');
    rg.id = 'moussy-hud-bg';
    rg.setAttribute('cx', '50%'); rg.setAttribute('cy', '50%');
    rg.setAttribute('r', '50%');
    rg.appendChild(this._stop('0%',   'rgba(168,85,247,0.14)'));
    rg.appendChild(this._stop('70%',  'rgba(168,85,247,0.04)'));
    rg.appendChild(this._stop('100%', 'rgba(0,0,0,0)'));
    defs.appendChild(rg);

    // Glow filter for rings and arrows
    const glowF = this._svgNS('filter');
    glowF.id = 'moussy-glow';
    glowF.setAttribute('x', '-30%'); glowF.setAttribute('y', '-30%');
    glowF.setAttribute('width', '160%'); glowF.setAttribute('height', '160%');
    const feBlur = this._svgNS('feGaussianBlur');
    feBlur.setAttribute('stdDeviation', '2.5');
    feBlur.setAttribute('result', 'blur');
    const feMerge = this._svgNS('feMerge');
    const n1 = this._svgNS('feMergeNode'); n1.setAttribute('in', 'blur');
    const n2 = this._svgNS('feMergeNode'); n2.setAttribute('in', 'SourceGraphic');
    feMerge.appendChild(n1); feMerge.appendChild(n2);
    glowF.appendChild(feBlur); glowF.appendChild(feMerge);
    defs.appendChild(glowF);

    // Stronger glow for active arm arrows
    const strongGlowF = this._svgNS('filter');
    strongGlowF.id = 'moussy-strong-glow';
    strongGlowF.setAttribute('x', '-50%'); strongGlowF.setAttribute('y', '-50%');
    strongGlowF.setAttribute('width', '200%'); strongGlowF.setAttribute('height', '200%');
    const feBlur2 = this._svgNS('feGaussianBlur');
    feBlur2.setAttribute('stdDeviation', '4');
    feBlur2.setAttribute('result', 'blur');
    const feMerge2 = this._svgNS('feMerge');
    const m1 = this._svgNS('feMergeNode'); m1.setAttribute('in', 'blur');
    const m2 = this._svgNS('feMergeNode'); m2.setAttribute('in', 'SourceGraphic');
    feMerge2.appendChild(m1); feMerge2.appendChild(m2);
    strongGlowF.appendChild(feBlur2); strongGlowF.appendChild(feMerge2);
    defs.appendChild(strongGlowF);

    svg.appendChild(defs);

    // ── Background radial fill ───────────────────────────────────────────
    svg.appendChild(this._circle(cx, cy, R, {
      fill: 'url(#moussy-hud-bg)',
    }));

    // ── Tech dash ring (slow counter-rotation) ───────────────────────────
    const dashRing = this._circle(cx, cy, R + 12, {
      fill:              'none',
      stroke:            'rgba(168,85,247,0.2)',
      'stroke-width':    '1',
      'stroke-dasharray':'4 10',
    });
    dashRing.classList.add('spin-dash');
    svg.appendChild(dashRing);

    // ── Outer ring — main glowing border ────────────────────────────────
    svg.appendChild(this._circle(cx, cy, R, {
      fill:           'none',
      stroke:         'rgba(168,85,247,0.9)',
      'stroke-width': '1.5',
      filter:         'url(#moussy-glow)',
    }));

    // ── Inner ring — subtle decoration ──────────────────────────────────
    svg.appendChild(this._circle(cx, cy, R * 0.72, {
      fill:              'none',
      stroke:            'rgba(168,85,247,0.2)',
      'stroke-width':    '0.7',
      'stroke-dasharray':'2 5',
    }));

    // ── Sector dividers (faint lines through the ring) ───────────────────
    const dividerDirs = [
      [cx, cy - R * 0.72, cx, cy - R],
      [cx, cy + R * 0.72, cx, cy + R],
      [cx - R * 0.72, cy, cx - R, cy],
      [cx + R * 0.72, cy, cx + R, cy],
    ];
    for (const [x1, y1, x2, y2] of dividerDirs) {
      const line = this._svgNS('line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('stroke', 'rgba(168,85,247,0.18)');
      line.setAttribute('stroke-width', '0.6');
      line.setAttribute('stroke-dasharray', '2 3');
      svg.appendChild(line);
    }

    // ── Direction arm arrows ────────────────────────────────────────────
    // Each arm is a <g> with .arm-group CSS class for opacity transitions.
    this._armEls[Direction.UP]    = this._buildArm(svg, cx, cy, R, Direction.UP);
    this._armEls[Direction.DOWN]  = this._buildArm(svg, cx, cy, R, Direction.DOWN);
    this._armEls[Direction.LEFT]  = this._buildArm(svg, cx, cy, R, Direction.LEFT);
    this._armEls[Direction.RIGHT] = this._buildArm(svg, cx, cy, R, Direction.RIGHT);

    // ── Centre reticle ──────────────────────────────────────────────────
    svg.appendChild(this._buildReticle(cx, cy));

    return svg;
  }

  /**
   * Builds a directional arm <g> with double-chevron arrow + label.
   *
   * Arrow geometry: two small filled triangles (Ben 10 chevron style),
   * stacked pointing in the direction, placed just outside the inner ring
   * boundary on the ring's edge.
   *
   * @param {SVGSVGElement} parent
   * @param {number} cx       SVG centre X
   * @param {number} cy       SVG centre Y
   * @param {number} R        ring radius
   * @param {string} dir      Direction.*
   * @returns {SVGGElement}
   */
  _buildArm(parent, cx, cy, R, dir) {
    const g = this._svgNS('g');
    g.classList.add('arm-group');
    g.setAttribute('filter', 'url(#moussy-strong-glow)');

    // Chevron dimensions
    const W = 9;   // half-width of arrowhead base
    const H = 7;   // height of one arrowhead triangle
    const GAP = 4; // space between the two stacked chevrons

    // Arm centre position on the ring surface (slightly inside for clean look)
    const armR = R * 0.88;

    // Build chevrons based on direction
    // Two stacked filled triangles pointing in `dir`
    let triangles = [];

    if (dir === Direction.UP) {
      const ax = cx, ay = cy - armR;
      // Near chevron (closer to centre)
      triangles.push(`${ax},${ay + H + GAP} ${ax - W},${ay + H * 2 + GAP} ${ax + W},${ay + H * 2 + GAP}`);
      // Far chevron (pointing tip)
      triangles.push(`${ax},${ay} ${ax - W},${ay + H} ${ax + W},${ay + H}`);
    } else if (dir === Direction.DOWN) {
      const ax = cx, ay = cy + armR;
      triangles.push(`${ax},${ay - H - GAP} ${ax - W},${ay - H * 2 - GAP} ${ax + W},${ay - H * 2 - GAP}`);
      triangles.push(`${ax},${ay} ${ax - W},${ay - H} ${ax + W},${ay - H}`);
    } else if (dir === Direction.LEFT) {
      const ax = cx - armR, ay = cy;
      triangles.push(`${ax + H + GAP},${ay} ${ax + H * 2 + GAP},${ay - W} ${ax + H * 2 + GAP},${ay + W}`);
      triangles.push(`${ax},${ay} ${ax + H},${ay - W} ${ax + H},${ay + W}`);
    } else { // RIGHT
      const ax = cx + armR, ay = cy;
      triangles.push(`${ax - H - GAP},${ay} ${ax - H * 2 - GAP},${ay - W} ${ax - H * 2 - GAP},${ay + W}`);
      triangles.push(`${ax},${ay} ${ax - H},${ay - W} ${ax - H},${ay + W}`);
    }

    for (let i = 0; i < triangles.length; i++) {
      const poly = this._svgNS('polygon');
      poly.setAttribute('points', triangles[i]);
      poly.setAttribute('fill', '#a855f7');
      poly.setAttribute('opacity', i === 0 ? '0.55' : '0.95');
      g.appendChild(poly);
    }

    // Direction label text below / above / beside the arrow
    const label = this._svgNS('text');
    label.setAttribute('font-family', "'Share Tech Mono', monospace");
    label.setAttribute('font-size', '8');
    label.setAttribute('fill', 'rgba(168,85,247,0.85)');
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('letter-spacing', '1');
    label.textContent = dir === Direction.UP    ? 'UP'
                      : dir === Direction.DOWN  ? 'DOWN'
                      : dir === Direction.LEFT  ? 'BACK'
                      :                           'FORWARD';

    const labelOffset = 14;
    if (dir === Direction.UP) {
      label.setAttribute('x', cx);
      label.setAttribute('y', cy - R - labelOffset + 6);
    } else if (dir === Direction.DOWN) {
      label.setAttribute('x', cx);
      label.setAttribute('y', cy + R + labelOffset);
    } else if (dir === Direction.LEFT) {
      label.setAttribute('x', cx - R - labelOffset - 2);
      label.setAttribute('y', cy + 3);
      label.setAttribute('text-anchor', 'end');
    } else {
      label.setAttribute('x', cx + R + labelOffset + 2);
      label.setAttribute('y', cy + 3);
      label.setAttribute('text-anchor', 'start');
    }
    g.appendChild(label);

    parent.appendChild(g);
    return g;
  }

  /**
   * Builds the pulsing centre reticle:
   *   outer soft halo → inner dark disc → crosshair lines → centre dot
   */
  _buildReticle(cx, cy) {
    const g = this._svgNS('g');

    // Outer halo glow ring
    const halo = this._circle(cx, cy, 18, {
      fill:   'rgba(168,85,247,0.08)',
      stroke: 'rgba(168,85,247,0.35)',
      'stroke-width': '1',
    });
    halo.classList.add('pulse-ring');
    g.appendChild(halo);

    // Dark inner disc
    g.appendChild(this._circle(cx, cy, 13, {
      fill:   'rgba(5,5,10,0.88)',
      stroke: 'rgba(168,85,247,0.55)',
      'stroke-width': '1.2',
    }));

    // Crosshair lines
    for (const [x1, y1, x2, y2] of [
      [cx - 8, cy, cx - 4, cy],
      [cx + 4, cy, cx + 8, cy],
      [cx, cy - 8, cx, cy - 4],
      [cx, cy + 4, cx, cy + 8],
    ]) {
      const line = this._svgNS('line');
      line.setAttribute('x1', x1); line.setAttribute('y1', y1);
      line.setAttribute('x2', x2); line.setAttribute('y2', y2);
      line.setAttribute('stroke', 'rgba(168,85,247,0.8)');
      line.setAttribute('stroke-width', '0.8');
      line.setAttribute('stroke-linecap', 'round');
      g.appendChild(line);
    }

    // Bright centre dot
    g.appendChild(this._circle(cx, cy, 2.5, {
      fill: '#c084fc',
      filter: 'url(#moussy-glow)',
    }));

    this._reticleEl = g;
    return g;
  }

  // ── SVG utility methods ────────────────────────────────────────────────────

  _svgNS(tag) {
    return document.createElementNS('http://www.w3.org/2000/svg', tag);
  }

  _circle(cx, cy, r, attrs = {}) {
    const el = this._svgNS('circle');
    el.setAttribute('cx', cx);
    el.setAttribute('cy', cy);
    el.setAttribute('r',  r);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  _stop(offset, color) {
    const el = this._svgNS('stop');
    el.setAttribute('offset', offset);
    el.setAttribute('stop-color', color);
    return el;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── GestureRecorder
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Records raw cursor coordinates into a pre-allocated Float32Array.
 * Layout: [x0, y0, x1, y1, …] — two floats per sample point.
 * `stop()` classifies the completed stroke as a cardinal Direction.
 */
class GestureRecorder {
  constructor() {
    this._buf    = new Float32Array(CFG.MAX_POINTS * 2);
    this._len    = 0;
    this._active = false;

    // Origin of the current gesture (for HUD arm tracking)
    this.originX = 0;
    this.originY = 0;
  }

  start(x, y) {
    this._len    = 0;
    this._active = true;
    this.originX = x;
    this.originY = y;
    this._push(x, y);
  }

  push(x, y) {
    if (!this._active) return;
    // Micro-throttle: skip identical coordinates
    if (this._len > 0) {
      const li = (this._len - 1) * 2;
      if (Math.abs(this._buf[li] - x) < 1 && Math.abs(this._buf[li + 1] - y) < 1) return;
    }
    this._push(x, y);
  }

  _push(x, y) {
    if (this._len >= CFG.MAX_POINTS) return;
    const i = this._len * 2;
    this._buf[i]     = x;
    this._buf[i + 1] = y;
    this._len++;
  }

  stop() {
    this._active = false;
    if (this._len < 2) {
      return { direction: null, dx: 0, dy: 0, distance: 0, pointCount: this._len };
    }

    const x0 = this._buf[0],       y0 = this._buf[1];
    const x1 = this._buf[(this._len - 1) * 2];
    const y1 = this._buf[(this._len - 1) * 2 + 1];
    const dx = x1 - x0, dy = y1 - y0;
    const distance = Math.hypot(dx, dy);

    const direction = distance >= CFG.MIN_STROKE_PX ? this._classify(dx, dy) : null;
    return { direction, dx, dy, distance, pointCount: this._len };
  }

  _classify(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx > 0 ? Direction.RIGHT : Direction.LEFT;
    }
    return dy > 0 ? Direction.DOWN : Direction.UP;
  }

  get isActive() { return this._active; }

  lastSegment() {
    if (this._len < 2) return null;
    const pi = (this._len - 2) * 2, ci = (this._len - 1) * 2;
    return {
      prevX: this._buf[pi],     prevY: this._buf[pi + 1],
      currX: this._buf[ci],     currY: this._buf[ci + 1],
    };
  }

  /** Current displacement from the gesture origin */
  currentDisplacement() {
    if (this._len < 1) return { dx: 0, dy: 0 };
    const li = (this._len - 1) * 2;
    return {
      dx: this._buf[li]     - this.originX,
      dy: this._buf[li + 1] - this.originY,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── ContextGuard
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * One-shot contextmenu suppression.
 * Armed only when a real gesture stroke was completed; fires once, then resets.
 */
class ContextGuard {
  constructor() { this._suppress = false; }
  armSuppression()  { this._suppress = true; }
  shouldSuppress()  {
    if (this._suppress) { this._suppress = false; return true; }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── MouseController
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Wires all DOM events → gesture subsystems.
 *
 * Dispatch flow
 * ──────────────
 *   mousedown (btn 2)  → read mode → spawn HUD  OR  hardClear trail
 *   mousemove          → record coords → HUD.track() OR trail.segment()
 *   mouseup   (btn 2)  → stop recording → HUD.dismiss() OR trail.fadeAndClear()
 *                         → dispatch result to background service worker
 *   contextmenu        → ContextGuard: suppress if real stroke was made
 *
 * rAF throttle: a single pending-flag prevents queueing more than one
 * animation frame per display refresh cycle for mousemove processing.
 */
class MouseController {
  constructor() {
    this._canvas   = new CanvasManager();
    this._trail    = new TrailRenderer(this._canvas);
    this._hud      = new OmniClockHUD();
    this._recorder = new GestureRecorder();
    this._guard    = new ContextGuard();

    this._movePending = false;
    this._moveX = 0;
    this._moveY = 0;
    this._currentMode = GestureMode.FREEHAND;  // updated on each mousedown

    this._bindEvents();
    console.log('[MOUSSY] Gesture engine v2 (OMNI+FREEHAND) on:', window.location.hostname);
  }

  _bindEvents() {
    document.addEventListener('mousedown',   this._onMouseDown.bind(this),   { capture: true, passive: true });
    document.addEventListener('mousemove',   this._onMouseMove.bind(this),   { capture: false, passive: true });
    document.addEventListener('mouseup',     this._onMouseUp.bind(this),     { capture: true, passive: true });
    document.addEventListener('contextmenu', this._onContextMenu.bind(this), { capture: true });
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  _onMouseDown(e) {
    if (e.button !== 2) return;

    // Read the cached mode synchronously; then spawn the appropriate visualiser.
    // Because GestureModeCache resolves instantly after the first async read,
    // the `.then()` callback fires in a microtask — before the next paint frame.
    GestureModeCache.get().then((mode) => {
      this._currentMode = mode;

      if (mode === GestureMode.OMNI) {
        this._trail.hardClear();               // ensure canvas is blank
        this._hud.spawn(e.clientX, e.clientY); // inject HUD at click origin
      } else {
        this._trail.hardClear();               // reset any leftover trail
      }

      this._recorder.start(e.clientX, e.clientY);
    });
  }

  _onMouseMove(e) {
    if (!this._recorder.isActive) return;

    this._moveX = e.clientX;
    this._moveY = e.clientY;

    if (!this._movePending) {
      this._movePending = true;
      requestAnimationFrame(() => this._processMove());
    }
  }

  _processMove() {
    this._movePending = false;
    if (!this._recorder.isActive) return;

    this._recorder.push(this._moveX, this._moveY);

    if (this._currentMode === GestureMode.OMNI) {
      // Track displacement and update the HUD arm highlight
      const { dx, dy } = this._recorder.currentDisplacement();
      this._hud.track(dx, dy);
    } else {
      // Paint the neon trail segment
      const seg = this._recorder.lastSegment();
      if (seg) {
        this._trail.segment(seg.prevX, seg.prevY, seg.currX, seg.currY);
      }
    }
  }

  _onMouseUp(e) {
    if (e.button !== 2) return;
    if (!this._recorder.isActive) return;

    // Flush any pending rAF move before stopping
    if (this._movePending) {
      this._movePending = false;
      this._recorder.push(this._moveX, this._moveY);
      const seg = this._recorder.lastSegment();
      if (this._currentMode !== GestureMode.OMNI && seg) {
        this._trail.segment(seg.prevX, seg.prevY, seg.currX, seg.currY);
      }
    }

    const result = this._recorder.stop();

    if (this._currentMode === GestureMode.OMNI) {
      this._hud.dismiss(result.direction);   // animate HUD out
    } else {
      this._trail.fadeAndClear();            // fade trail canvas
    }

    if (result.direction) {
      this._guard.armSuppression();
      this._dispatch(result);
    }
    // No stroke → guard stays disarmed → native context menu shows normally
  }

  _onContextMenu(e) {
    if (this._guard.shouldSuppress()) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ── Background Dispatch ────────────────────────────────────────────────────

  /**
   * Send the classified gesture payload to the background service worker.
   * The background will handle navigation, slot bindings, and audio.
   *
   * @param {{ direction:string, dx:number, dy:number, distance:number, pointCount:number }} result
   */
  _dispatch(result) {
    console.log(
      `[MOUSSY] ${this._currentMode === GestureMode.OMNI ? '⚙ OMNI' : '✏ FREEHAND'}`,
      `→ ${result.direction}`,
      `(Δ${Math.round(result.dx)}, Δ${Math.round(result.dy)})`,
      `${Math.round(result.distance)}px / ${result.pointCount} pts`,
    );

    chrome.runtime.sendMessage({
      type:    'GESTURE',
      payload: {
        direction:   result.direction,
        dx:          result.dx,
        dy:          result.dy,
        distance:    result.distance,
        pointCount:  result.pointCount,
        renderMode:  this._currentMode,
        timestamp:   Date.now(),
        url:         window.location.href,
      },
    }).catch(() => {
      // Silently ignore: extension context invalidated on page unload
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ── Boot
// ═══════════════════════════════════════════════════════════════════════════════
// Double-injection guard: Chrome can call content scripts more than once in
// some SPA routing scenarios. The flag on `window` prevents duplicate engines.
if (!window.__MOUSSY_ENGINE__) {
  window.__MOUSSY_ENGINE__ = new MouseController();
}
