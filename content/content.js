/**
 * MOUSSY — Gesture Engine  (content.js)
 * =======================================
 * Injected at document_idle into every page.
 *
 * Architecture overview
 * ─────────────────────
 *  CanvasManager   – creates / owns the fullscreen overlay canvas
 *  TrailRenderer   – draws the neon glow trail with requestAnimationFrame
 *  GestureRecorder – records raw coords → builds point list → classifies gesture
 *  ContextGuard    – suppresses contextmenu only when a real swipe happened
 *  MouseController – wires all DOM events together; entry point
 *
 * Performance strategy
 * ─────────────────────
 *  • Canvas is created once and reused (no DOM thrash per gesture)
 *  • Mouse-move handler is throttled via requestAnimationFrame flag
 *    (no setTimeout / setInterval overhead)
 *  • Trail is drawn incrementally (only the new segment each frame)
 *  • All path data lives in a pre-allocated typed Float32Array that is
 *    reset on each gesture start — zero GC pressure during recording
 *  • canvas.style.pointerEvents = "none" so no hit-testing overhead
 *  • Fade-out uses a single rAF loop, not CSS transitions (more reliable)
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const CFG = Object.freeze({
  /** Minimum pixel distance before we consider it a real gesture stroke */
  MIN_STROKE_PX: 20,

  /** Maximum points stored per gesture (pre-allocated buffer) */
  MAX_POINTS: 4096,

  /** Trail neon colour */
  TRAIL_COLOR: '#a855f7',

  /** Glow layers: each entry is [shadowBlur, alpha] */
  GLOW_LAYERS: [
    [48, 0.25],
    [24, 0.45],
    [10, 0.85],
    [3,  1.00],
  ],

  /** Base trail line width (px) */
  LINE_WIDTH: 3,

  /** Fade-out duration in milliseconds */
  FADE_MS: 280,

  /** Canvas element id */
  CANVAS_ID: 'moussy-canvas',
});

// Recognised primary swipe directions
const Direction = Object.freeze({
  UP:    'UP',
  DOWN:  'DOWN',
  LEFT:  'LEFT',
  RIGHT: 'RIGHT',
});

// ─── CanvasManager ────────────────────────────────────────────────────────────
/**
 * Owns the singleton fullscreen overlay canvas.
 * The canvas is appended once to <body> and never removed,
 * keeping DOM mutations to an absolute minimum.
 */
class CanvasManager {
  constructor() {
    this._canvas = null;
    this._ctx    = null;
  }

  /** Lazily creates and returns the canvas element. */
  get canvas() {
    if (!this._canvas) this._init();
    return this._canvas;
  }

  /** Returns the 2D rendering context. */
  get ctx() {
    if (!this._ctx) this._init();
    return this._ctx;
  }

  _init() {
    const c = document.createElement('canvas');
    c.id = CFG.CANVAS_ID;

    // Position the canvas so it covers the entire viewport
    const s = c.style;
    s.position        = 'fixed';
    s.top             = '0';
    s.left            = '0';
    s.width           = '100vw';
    s.height          = '100vh';
    s.zIndex          = '2147483647';   // maximum possible z-index
    s.pointerEvents   = 'none';         // completely transparent to mouse events
    s.imageRendering  = 'pixelated';
    s.display         = 'block';
    s.opacity         = '1';
    s.willChange      = 'opacity';      // hint compositor for fade transitions

    this._fitToViewport(c);
    document.documentElement.appendChild(c);  // append to <html>, not <body>, so it
                                               // survives body replacements (SPAs)
    this._ctx    = c.getContext('2d', { alpha: true, desynchronized: true });
    this._canvas = c;

    // Re-fit the canvas whenever the viewport is resized
    window.addEventListener('resize', () => this._fitToViewport(this._canvas), { passive: true });
  }

  _fitToViewport(canvas) {
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
  }

  /** Immediately clear every pixel. */
  clear() {
    const { width, height } = this._canvas;
    this._ctx.clearRect(0, 0, width, height);
  }
}

// ─── TrailRenderer ────────────────────────────────────────────────────────────
/**
 * Draws the neon glow trail incrementally.
 * Each call to `segment(x0, y0, x1, y1)` queues one line segment.
 * A single rAF loop drains the queue, keeping paint off the event-handler path.
 *
 * Glow effect is achieved by painting the same segment several times with
 * increasing shadowBlur and decreasing opacity — giving a multi-layered bloom.
 */
class TrailRenderer {
  /**
   * @param {CanvasManager} canvasManager
   */
  constructor(canvasManager) {
    this._cm        = canvasManager;
    this._queue     = [];   // pending segments  [{x0,y0,x1,y1}]
    this._rafId     = null;
    this._fading    = false;
    this._fadeStart = 0;
    this._fadeRafId = null;
  }

  /**
   * Queue a new segment to be painted on the next animation frame.
   * @param {number} x0
   * @param {number} y0
   * @param {number} x1
   * @param {number} y1
   */
  segment(x0, y0, x1, y1) {
    this._queue.push({ x0, y0, x1, y1 });
    if (!this._rafId) {
      this._rafId = requestAnimationFrame(() => this._flush());
    }
  }

  /** Drain the pending segment queue and paint to canvas. */
  _flush() {
    this._rafId = null;
    if (!this._queue.length) return;

    const ctx = this._cm.ctx;
    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    for (const seg of this._queue) {
      this._paintGlowSegment(ctx, seg);
    }
    this._queue.length = 0;   // reset without reallocating

    ctx.restore();
  }

  /**
   * Paints one segment with layered glow passes.
   * @param {CanvasRenderingContext2D} ctx
   * @param {{ x0:number, y0:number, x1:number, y1:number }} seg
   */
  _paintGlowSegment(ctx, seg) {
    const { x0, y0, x1, y1 } = seg;

    for (const [blur, alpha] of CFG.GLOW_LAYERS) {
      ctx.beginPath();
      ctx.globalAlpha  = alpha;
      ctx.shadowColor  = CFG.TRAIL_COLOR;
      ctx.shadowBlur   = blur;
      ctx.strokeStyle  = CFG.TRAIL_COLOR;
      ctx.lineWidth    = blur > 20 ? CFG.LINE_WIDTH + 1 : CFG.LINE_WIDTH;
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }

    // Bright white-purple core for the sharpest inner line
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

  /**
   * Fade out the canvas, then clear it entirely.
   * Uses a rAF loop rather than CSS transitions for predictable timing.
   */
  fadeAndClear() {
    // Cancel any queued paint before we start wiping
    if (this._rafId) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
      this._queue.length = 0;
    }
    if (this._fadeRafId) {
      cancelAnimationFrame(this._fadeRafId);
    }

    this._fading    = true;
    this._fadeStart = performance.now();
    const canvas    = this._cm.canvas;
    const startOpacity = parseFloat(canvas.style.opacity ?? '1');

    const tick = (now) => {
      const elapsed  = now - this._fadeStart;
      const progress = Math.min(elapsed / CFG.FADE_MS, 1);
      canvas.style.opacity = String(startOpacity * (1 - progress));

      if (progress < 1) {
        this._fadeRafId = requestAnimationFrame(tick);
      } else {
        this._fading            = false;
        this._fadeRafId         = null;
        canvas.style.opacity    = '1';
        this._cm.clear();
      }
    };

    this._fadeRafId = requestAnimationFrame(tick);
  }

  /** Instant clear with no fade (used on gesture start to reset state). */
  hardClear() {
    if (this._rafId)    { cancelAnimationFrame(this._rafId);    this._rafId    = null; }
    if (this._fadeRafId){ cancelAnimationFrame(this._fadeRafId); this._fadeRafId = null; }
    this._queue.length          = 0;
    this._fading                = false;
    this._cm.canvas.style.opacity = '1';
    this._cm.clear();
  }
}

// ─── GestureRecorder ──────────────────────────────────────────────────────────
/**
 * Accumulates raw cursor positions into a pre-allocated Float32Array.
 * On `stop()` it analyses the displacement vector and returns a Direction.
 *
 * Memory layout of _buf: [x0, y0, x1, y1, …]
 * Using Float32Array means zero GC pressure during recording.
 */
class GestureRecorder {
  constructor() {
    // Pre-allocate buffer: MAX_POINTS × 2 floats (x, y per point)
    this._buf    = new Float32Array(CFG.MAX_POINTS * 2);
    this._len    = 0;   // number of points stored
    this._active = false;
  }

  /** Begin a new recording from the given origin. */
  start(x, y) {
    this._len    = 0;
    this._active = true;
    this._push(x, y);
  }

  /** Append the latest cursor position. */
  push(x, y) {
    if (!this._active) return;
    // Throttle: only store a point if it differs from the last one
    if (this._len > 0) {
      const li = (this._len - 1) * 2;
      if (Math.abs(this._buf[li] - x) < 1 && Math.abs(this._buf[li + 1] - y) < 1) return;
    }
    this._push(x, y);
  }

  _push(x, y) {
    if (this._len >= CFG.MAX_POINTS) return; // silently cap — avoids bounds errors
    const i = this._len * 2;
    this._buf[i]     = x;
    this._buf[i + 1] = y;
    this._len++;
  }

  /**
   * Stop recording and classify the gesture.
   * @returns {{ direction: string|null, dx: number, dy: number, distance: number, pointCount: number }}
   */
  stop() {
    this._active = false;
    if (this._len < 2) {
      return { direction: null, dx: 0, dy: 0, distance: 0, pointCount: this._len };
    }

    const x0 = this._buf[0];
    const y0 = this._buf[1];
    const x1 = this._buf[(this._len - 1) * 2];
    const y1 = this._buf[(this._len - 1) * 2 + 1];

    const dx       = x1 - x0;
    const dy       = y1 - y0;
    const distance = Math.hypot(dx, dy);

    let direction = null;
    if (distance >= CFG.MIN_STROKE_PX) {
      direction = this._classify(dx, dy);
    }

    return { direction, dx, dy, distance, pointCount: this._len };
  }

  /**
   * Map a displacement vector to a cardinal direction.
   * We compare |dx| vs |dy| to pick the dominant axis,
   * then use the sign to choose the direction.
   *
   * @param {number} dx
   * @param {number} dy
   * @returns {string}  one of Direction.*
   */
  _classify(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx > 0 ? Direction.RIGHT : Direction.LEFT;
    } else {
      return dy > 0 ? Direction.DOWN : Direction.UP;
    }
  }

  get isActive() { return this._active; }

  /**
   * Retrieve the last two points stored (for incremental segment drawing).
   * @returns {{ prevX: number, prevY: number, currX: number, currY: number } | null}
   */
  lastSegment() {
    if (this._len < 2) return null;
    const pi = (this._len - 2) * 2;
    const ci = (this._len - 1) * 2;
    return {
      prevX: this._buf[pi],
      prevY: this._buf[pi + 1],
      currX: this._buf[ci],
      currY: this._buf[ci + 1],
    };
  }
}

// ─── ContextGuard ─────────────────────────────────────────────────────────────
/**
 * Decides whether to suppress the browser's native contextmenu event.
 *
 * Rule:
 *  • If the user performed a real gesture stroke (distance ≥ MIN_STROKE_PX)
 *    → suppress the next contextmenu event exactly once.
 *  • If the user just right-clicked without moving (normal right-click)
 *    → let the contextmenu through unmodified.
 *
 * We use a single-use flag so suppression is per-gesture, not global.
 */
class ContextGuard {
  constructor() {
    this._suppress = false;
  }

  /** Call this when a gesture with a real stroke has been completed. */
  armSuppression() {
    this._suppress = true;
  }

  /**
   * Call this from the `contextmenu` event handler.
   * Returns true if the event should be blocked.
   * @param {MouseEvent} e
   * @returns {boolean}
   */
  shouldSuppress(e) {
    if (this._suppress) {
      this._suppress = false;  // consume the flag — one-shot
      return true;
    }
    return false;
  }
}

// ─── MouseController ──────────────────────────────────────────────────────────
/**
 * Wires mouse events to the gesture engine.
 * All event listeners are registered once; internal state is minimal.
 *
 * Flow:
 *   mousedown (btn 2)  → GestureRecorder.start()  +  TrailRenderer.hardClear()
 *   mousemove          → GestureRecorder.push()    +  TrailRenderer.segment()
 *   mouseup   (btn 2)  → GestureRecorder.stop()   +  TrailRenderer.fadeAndClear()
 *                         → classify direction, dispatch to background
 *   contextmenu        → ContextGuard.shouldSuppress()
 */
class MouseController {
  constructor() {
    this._canvas   = new CanvasManager();
    this._trail    = new TrailRenderer(this._canvas);
    this._recorder = new GestureRecorder();
    this._guard    = new ContextGuard();

    // rAF throttle flag — true means we already have a pending frame
    this._movePending = false;
    // Snapshot of latest mouse coords for the throttled move handler
    this._moveX = 0;
    this._moveY = 0;

    this._bindEvents();
    console.log('[MOUSSY] Gesture engine initialised on:', window.location.hostname);
  }

  _bindEvents() {
    // Use capture phase for mousedown / mouseup so we fire before page handlers.
    // mousemove on window so we track even when cursor leaves a slow element.
    document.addEventListener('mousedown',   this._onMouseDown.bind(this),   { capture: true, passive: true });
    document.addEventListener('mousemove',   this._onMouseMove.bind(this),   { capture: false, passive: true });
    document.addEventListener('mouseup',     this._onMouseUp.bind(this),     { capture: true, passive: true });
    document.addEventListener('contextmenu', this._onContextMenu.bind(this), { capture: true });
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  _onMouseDown(e) {
    if (e.button !== 2) return;   // only right button

    this._trail.hardClear();
    this._recorder.start(e.clientX, e.clientY);
  }

  _onMouseMove(e) {
    if (!this._recorder.isActive) return;

    // Throttle: store latest coords; only one rAF paint per frame
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

    const seg = this._recorder.lastSegment();
    if (seg) {
      this._trail.segment(seg.prevX, seg.prevY, seg.currX, seg.currY);
    }
  }

  _onMouseUp(e) {
    if (e.button !== 2) return;
    if (!this._recorder.isActive) return;

    // Flush any pending move before stopping
    if (this._movePending) {
      this._movePending = false;
      this._recorder.push(this._moveX, this._moveY);
      const seg = this._recorder.lastSegment();
      if (seg) this._trail.segment(seg.prevX, seg.prevY, seg.currX, seg.currY);
    }

    const result = this._recorder.stop();
    this._trail.fadeAndClear();

    if (result.direction) {
      this._guard.armSuppression();
      this._dispatch(result);
    }
    // If no real stroke → guard stays disarmed → native context menu will show
  }

  _onContextMenu(e) {
    if (this._guard.shouldSuppress(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  /**
   * Send the classified gesture to the background service worker.
   * @param {{ direction: string, dx: number, dy: number, distance: number, pointCount: number }} result
   */
  _dispatch(result) {
    console.log(`[MOUSSY] Gesture recognised → ${result.direction}`,
      `(Δ${Math.round(result.dx)}, Δ${Math.round(result.dy)})`,
      `${Math.round(result.distance)}px over ${result.pointCount} pts`);

    chrome.runtime.sendMessage({
      type:    'GESTURE',
      payload: {
        direction:  result.direction,
        dx:         result.dx,
        dy:         result.dy,
        distance:   result.distance,
        pointCount: result.pointCount,
        timestamp:  Date.now(),
        url:        window.location.href,
      },
    }).catch(() => {
      // Extension context may be invalidated on page unload — silently ignore
    });
  }
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
// Guard against double-injection (e.g. in iframes or hot-reload scenarios)
if (!window.__MOUSSY_ENGINE__) {
  window.__MOUSSY_ENGINE__ = new MouseController();
}
