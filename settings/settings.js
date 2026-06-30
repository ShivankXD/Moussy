/**
 * MOUSSY — Settings Controller  (settings.js)
 * =============================================
 * Manages the full configuration dashboard (settings.html).
 *
 * Responsibilities
 * ─────────────────
 *  • StorageAdapter     — chrome.storage.local wrapper with localStorage fallback
 *  • PlanManager        — loads current plan and gates locked elements accordingly
 *  • SlotManager        — loads/saves gesture slot data (gesture type + URL)
 *  • ToggleManager      — loads/saves premium feature toggle states
 *  • PrimeTooltip       — singleton floating tooltip for locked elements
 *  • SlotCountUpdater   — keeps the pip bar and counter in sync
 *  • SaveManager        — debounced save with visual confirmation
 *  • NavHighlighter     — highlights active sidebar link on scroll
 *  • ToastManager       — non-blocking notification system
 *
 * Storage schema  (chrome.storage.local)
 * ──────────────────────────────────────
 *  moussy_plan              : 'free' | 'monthly' | 'legend'
 *  moussy_gesture_slots     : Array<{ gesture: string, url: string }>  (length 6)
 *  moussy_hud_clock         : boolean
 *  moussy_sound_pack        : boolean
 */

'use strict';

// ─── Storage Adapter ──────────────────────────────────────────────────────────
const Storage = {
  async get(keys) {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      return new Promise((res) => chrome.storage.local.get(keys, res));
    }
    const result = {};
    for (const k of (Array.isArray(keys) ? keys : [keys])) {
      try { result[k] = JSON.parse(localStorage.getItem(k)); }
      catch { result[k] = null; }
    }
    return result;
  },

  async set(items) {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      return new Promise((res) => chrome.storage.local.set(items, res));
    }
    for (const [k, v] of Object.entries(items)) {
      localStorage.setItem(k, JSON.stringify(v));
    }
  },
};

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_PLAN        = 'moussy_plan';
const STORAGE_SLOTS       = 'moussy_gesture_slots';
const STORAGE_HUD         = 'moussy_hud_clock';
const STORAGE_SOUND       = 'moussy_sound_enabled';   // must match background.js key

const TOTAL_SLOTS         = 5;   // radial URL slots (Slot 1..5 → N, NE, SE, SW, NW)
const FREE_SLOT_LIMIT     = 1;   // only Slot 1 (North) is free

/** How many slots a given plan can use */
const PLAN_SLOT_LIMITS = {
  free:    1,
  monthly: 5,
  legend:  5,
};

// ─── State ────────────────────────────────────────────────────────────────────
let currentPlan   = 'free';
let slotData      = Array.from({ length: TOTAL_SLOTS }, () => ({ gesture: '', url: '' }));
let hudEnabled    = false;
let soundEnabled  = false;

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
/**
 * @param {string} msg
 * @param {'ok'|'success'|'error'} type
 * @param {number} [ms=3000]
 */
function toast(msg, type = 'ok', ms = 3000) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(_toastTimer);
  el.textContent = msg;
  el.className   = `visible ${type}`;
  _toastTimer    = setTimeout(() => el.className = '', ms);
}

// ─── Plan Manager ─────────────────────────────────────────────────────────────
/**
 * Reads persisted plan, unlocks elements accordingly, updates the header chip.
 */
async function loadPlan() {
  const data = await Storage.get([STORAGE_PLAN]);
  currentPlan = data[STORAGE_PLAN] ?? 'free';
  applyPlanGating(currentPlan);
  updatePlanChip(currentPlan);
}

/**
 * Unlocks slots / toggles based on plan.
 * @param {'free'|'monthly'|'legend'} plan
 */
function applyPlanGating(plan) {
  const limit = PLAN_SLOT_LIMITS[plan] ?? FREE_SLOT_LIMIT;

  // ── Slots ────────────────────────────────────────────────────────────────
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const slotEl = document.querySelector(`[data-slot="${i}"]`);
    if (!slotEl) continue;

    if (i <= limit) {
      // UNLOCK
      slotEl.classList.remove('locked');
      slotEl.removeAttribute('data-locked');
      slotEl.querySelector('.lock-overlay')?.remove();
      const select = slotEl.querySelector('.slot-gesture-select');
      const urlIn  = slotEl.querySelector('.slot-url-input');
      if (select) { select.disabled = false; select.removeAttribute('aria-hidden'); select.removeAttribute('tabindex'); }
      if (urlIn)  { urlIn.disabled  = false; urlIn.removeAttribute('aria-hidden');  urlIn.removeAttribute('tabindex'); }
    } else {
      // Ensure locked state is present (idempotent)
      slotEl.classList.add('locked');
      slotEl.setAttribute('data-locked', 'true');
    }
  }

  // ── Pip bar ──────────────────────────────────────────────────────────────
  const pips       = document.querySelectorAll('.slot-pip');
  const totalSpan  = document.getElementById('slot-total-count');
  if (totalSpan) totalSpan.textContent = limit;

  pips.forEach((pip, idx) => {
    pip.classList.remove('active', 'locked-pip');
    if (idx >= limit) pip.classList.add('locked-pip');
    // active state is set in updateSlotPips() after data loads
  });

  // ── Badge on slots module ────────────────────────────────────────────────
  const badge = document.querySelector('#slots-module .module-badge');
  if (badge) {
    badge.textContent = plan === 'free' ? 'FREE: 2 SLOTS' : `${plan.toUpperCase()}: ${limit} SLOTS`;
    badge.className   = `module-badge ${plan === 'free' ? 'badge-free' : 'badge-prime'}`;
  }

  // ── Premium toggles ──────────────────────────────────────────────────────
  const isPrime = plan === 'monthly' || plan === 'legend';
  unlockToggleRow('toggle-hud',   'toggle-hud-input',   isPrime);
  unlockToggleRow('toggle-sound', 'toggle-sound-input', isPrime);

  // ── Hide upgrade banner if already on a paid plan ────────────────────────
  const banner = document.getElementById('upgrade-banner');
  if (banner) banner.style.display = isPrime ? 'none' : '';
}

function unlockToggleRow(rowId, inputId, unlock) {
  const row   = document.getElementById(rowId);
  const input = document.getElementById(inputId);
  if (!row || !input) return;

  if (unlock) {
    row.classList.remove('locked');
    row.removeAttribute('data-locked');
    input.disabled = false;
    input.removeAttribute('aria-disabled');
  } else {
    row.classList.add('locked');
    row.setAttribute('data-locked', 'true');
    input.disabled = true;
    input.setAttribute('aria-disabled', 'true');
  }
}

function updatePlanChip(plan) {
  const chip  = document.getElementById('plan-chip');
  const label = document.getElementById('plan-chip-label');
  if (!chip || !label) return;
  chip.className = `plan-chip ${plan}`;
  label.textContent = {
    free:    'FREE ENGINE',
    monthly: 'MONTHLY PASS',
    legend:  'LEGEND STATUS',
  }[plan] ?? 'FREE ENGINE';
}

// ─── Slot Manager ─────────────────────────────────────────────────────────────

async function loadSlots() {
  const data = await Storage.get([STORAGE_SLOTS]);
  const saved = data[STORAGE_SLOTS];

  if (Array.isArray(saved)) {
    // Merge saved data into our state array (preserve length 6)
    saved.forEach((entry, i) => {
      if (i < TOTAL_SLOTS && entry) slotData[i] = entry;
    });
  }

  renderSlots();
}

function renderSlots() {
  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const n = i + 1;
    const gestureEl = document.getElementById(`slot-${n}-gesture`);
    const urlEl     = document.getElementById(`slot-${n}-url`);
    if (!gestureEl || !urlEl) continue;

    gestureEl.value = slotData[i].gesture ?? '';
    urlEl.value     = slotData[i].url     ?? '';
  }
  updateSlotPips();
}

function updateSlotPips() {
  const limit = PLAN_SLOT_LIMITS[currentPlan] ?? FREE_SLOT_LIMIT;
  let usedCount = 0;
  const pips = document.querySelectorAll('.slot-pip');

  for (let i = 0; i < TOTAL_SLOTS; i++) {
    const n       = i + 1;
    const hasVal  = !!(slotData[i]?.gesture || slotData[i]?.url);
    const unlocked = n <= limit;
    const pip     = pips[i];

    if (hasVal) usedCount++;

    // Update the slot status dot
    const slotEl = document.querySelector(`[data-slot="${n}"]`);
    if (slotEl) {
      const dot = slotEl.querySelector('.slot-status-dot');
      if (dot) {
        dot.classList.toggle('', false);
        slotEl.classList.toggle('has-value', hasVal && unlocked);
      }
    }

    // Update pip
    if (!pip) continue;
    pip.classList.remove('active', 'locked-pip');
    if (!unlocked) {
      pip.classList.add('locked-pip');
    } else if (hasVal) {
      pip.classList.add('active');
    }
  }

  const countEl = document.getElementById('slot-used-count');
  if (countEl) countEl.textContent = String(usedCount);
}

function bindSlotInputs() {
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const gestureEl = document.getElementById(`slot-${i}-gesture`);
    const urlEl     = document.getElementById(`slot-${i}-url`);

    gestureEl?.addEventListener('change', () => {
      slotData[i - 1].gesture = gestureEl.value;
      updateSlotPips();
      debouncedAutoSave();
    });

    urlEl?.addEventListener('input', () => {
      slotData[i - 1].url = urlEl.value.trim();
      updateSlotPips();
      debouncedAutoSave();
    });
  }
}

// ─── Toggle Manager ───────────────────────────────────────────────────────────

async function loadToggles() {
  const data = await Storage.get([STORAGE_HUD, STORAGE_SOUND]);
  hudEnabled   = data[STORAGE_HUD]   ?? false;
  soundEnabled = data[STORAGE_SOUND] ?? false;

  const hudInput   = document.getElementById('toggle-hud-input');
  const soundInput = document.getElementById('toggle-sound-input');

  if (hudInput)   hudInput.checked   = hudEnabled;
  if (soundInput) soundInput.checked = soundEnabled;
}

function bindToggles() {
  document.getElementById('toggle-hud-input')?.addEventListener('change', (e) => {
    hudEnabled = e.target.checked;
    debouncedAutoSave();
    toast(`HUD Clock: ${hudEnabled ? 'ENABLED' : 'DISABLED'}`, 'success');
  });

  document.getElementById('toggle-sound-input')?.addEventListener('change', (e) => {
    soundEnabled = e.target.checked;
    debouncedAutoSave();
    toast(`Sound Pack: ${soundEnabled ? 'ENABLED' : 'DISABLED'}`, 'success');
  });
}

// ─── Save Manager ─────────────────────────────────────────────────────────────

let _saveDebounce = null;

/** Auto-save with 800ms debounce (triggered by input changes) */
function debouncedAutoSave() {
  clearTimeout(_saveDebounce);
  _saveDebounce = setTimeout(() => saveAll(true), 800);
}

/**
 * Persist all settings to storage.
 * @param {boolean} [silent=false]  if true, show a softer toast
 */
async function saveAll(silent = false) {
  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) {
    saveBtn.classList.add('saved');
    saveBtn.querySelector ? null : null;
    saveBtn.textContent = 'SAVED ✓';
  }

  await Storage.set({
    [STORAGE_SLOTS]: slotData.map((s) => ({ gesture: s.gesture || '', url: s.url || '' })),
    [STORAGE_HUD]:   hudEnabled,
    [STORAGE_SOUND]: soundEnabled,
  });

  if (!silent) toast('// CONFIG SAVED SUCCESSFULLY', 'success');

  // Reset button label
  setTimeout(() => {
    if (saveBtn) {
      saveBtn.classList.remove('saved');
      saveBtn.textContent = 'SAVE CONFIG';
    }
  }, 2000);
}

// ─── Prime Protocol Tooltip ───────────────────────────────────────────────────
/**
 * Singleton floating tooltip that appears when a locked element is hovered.
 *
 * Strategy:
 *  1. Identify all locked elements (data-locked="true" or children of them)
 *  2. On mouseenter → position tooltip above the hovered element and show it
 *  3. On mouseleave → start a short grace period; hide if not re-entered
 *  4. The tooltip itself is hoverable (so the upgrade link is clickable)
 */
const PrimeTooltip = (() => {
  const TIP_GRACE_MS = 180;   // ms to wait before hiding on mouseleave

  let tooltip    = null;
  let hideTimer  = null;
  let isOverTip  = false;

  function getTooltip() {
    if (!tooltip) tooltip = document.getElementById('prime-tooltip');
    return tooltip;
  }

  /**
   * Position and show the tooltip above a given element.
   * @param {HTMLElement} anchor
   */
  function show(anchor) {
    clearTimeout(hideTimer);
    const tip  = getTooltip();
    if (!tip) return;

    const rect = anchor.getBoundingClientRect();
    const tipW = 320;   // matches CSS max-width

    // Horizontal: centre over anchor, clamp to viewport edges
    let left = rect.left + rect.width / 2 - tipW / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - tipW - 12));

    // Vertical: place above the anchor with a small gap
    const tipEstimatedH = 160;
    let top = rect.top - tipEstimatedH - 10;
    if (top < 12) top = rect.bottom + 10; // flip below if no room above

    tip.style.left    = `${left}px`;
    tip.style.top     = `${top}px`;
    tip.style.width   = `${tipW}px`;
    tip.classList.add('visible');
  }

  function scheduledHide() {
    hideTimer = setTimeout(() => {
      if (!isOverTip) {
        const tip = getTooltip();
        tip?.classList.remove('visible');
      }
    }, TIP_GRACE_MS);
  }

  /**
   * Wire hover listeners to all currently-locked elements.
   * Call again after plan gating changes.
   */
  function bindLockedElements() {
    const tip = getTooltip();
    if (!tip) return;

    // Collect all elements that are locked or live inside a locked container
    const lockedEls = document.querySelectorAll(
      '[data-locked="true"], [data-locked="true"] .lock-overlay'
    );

    lockedEls.forEach((el) => {
      // Avoid double-binding
      if (el.dataset.tipBound) return;
      el.dataset.tipBound = '1';

      el.addEventListener('mouseenter', () => show(el), { passive: true });
      el.addEventListener('mouseleave', scheduledHide, { passive: true });
    });

    // Keep tooltip alive while hovering it
    tip.addEventListener('mouseenter', () => {
      clearTimeout(hideTimer);
      isOverTip = true;
    }, { passive: true });

    tip.addEventListener('mouseleave', () => {
      isOverTip = false;
      scheduledHide();
    }, { passive: true });
  }

  return { bindLockedElements, show };
})();

// ─── Nav Highlighter ──────────────────────────────────────────────────────────
/**
 * Highlights the correct sidebar link based on which section is in view.
 * Uses IntersectionObserver for zero scroll-handler overhead.
 */
function initNavHighlighter() {
  const sections = document.querySelectorAll('section[id]');
  const navLinks = document.querySelectorAll('.nav-link[href^="#"]');

  if (!sections.length || !navLinks.length) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          navLinks.forEach((link) => {
            link.classList.toggle('active', link.getAttribute('href') === `#${id}`);
          });
        }
      });
    },
    { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
  );

  sections.forEach((s) => observer.observe(s));
}

// ─── Save Button ──────────────────────────────────────────────────────────────
function bindSaveButton() {
  document.getElementById('save-btn')?.addEventListener('click', () => saveAll(false));
}

// ─── Keyboard Shortcuts ───────────────────────────────────────────────────────
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+S / Cmd+S → save
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveAll(false);
    }
  });
}

// ─── Smooth section scroll for sidebar links ──────────────────────────────────
function bindSidebarScroll() {
  document.querySelectorAll('.nav-link[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const target = document.querySelector(link.getAttribute('href'));
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

// ─── Slot URL validation on blur ──────────────────────────────────────────────
function bindUrlValidation() {
  for (let i = 1; i <= TOTAL_SLOTS; i++) {
    const urlEl = document.getElementById(`slot-${i}-url`);
    if (!urlEl) continue;

    urlEl.addEventListener('blur', () => {
      const val = urlEl.value.trim();
      if (!val) return;

      // Auto-prepend https:// if user forgot it
      if (!/^https?:\/\//i.test(val)) {
        urlEl.value = `https://${val}`;
        slotData[i - 1].url = urlEl.value;
      }

      // Basic URL validation
      try {
        new URL(urlEl.value);
        urlEl.style.borderColor = '';   // reset to default
      } catch {
        urlEl.style.borderColor = 'rgba(248,113,113,0.6)';
        toast(`// Slot ${i}: invalid URL format`, 'error', 4000);
      }
    });
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function init() {
  try {
    // Load data in parallel
    await Promise.all([
      loadPlan(),
      loadSlots(),
      loadToggles(),
    ]);

    // Bind all interactivity
    bindSlotInputs();
    bindToggles();
    bindSaveButton();
    bindKeyboardShortcuts();
    bindSidebarScroll();
    bindUrlValidation();
    initNavHighlighter();

    // Wire Prime tooltip to all currently locked elements
    // (called after plan gating has been applied)
    PrimeTooltip.bindLockedElements();

    console.log(`[MOUSSY:settings] Controller ready. Plan: ${currentPlan}`);
  } catch (err) {
    console.error('[MOUSSY:settings] Init error:', err);
    toast('// Init error — check console', 'error', 6000);
  }
}

document.addEventListener('DOMContentLoaded', init);
