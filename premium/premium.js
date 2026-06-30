/**
 * MOUSSY — Premium Page Controller  (premium.js)
 * ================================================
 * Handles all interactivity on premium.html:
 *  – Plan state management (read / write via chrome.storage)
 *  – CTA button click handling & loading animation
 *  – Toast notification system
 *  – Particle burst effect on upgrade confirmation
 *  – Keyboard accessibility (Enter / Space on cards)
 *  – Graceful fallback when running outside extension context
 *
 * Payment integration
 * ────────────────────
 * Replace the `PAYMENT_URLS` map with real Stripe / payment-processor
 * checkout links. The `handlePurchase()` function is the single hook point.
 *
 * Storage schema (chrome.storage.local)
 * ──────────────────────────────────────
 *  {
 *    moussy_plan:          'free' | 'monthly' | 'legend',
 *    moussy_plan_expires:  null | ISO-8601 string   (monthly only),
 *    moussy_license_key:   null | string            (legend only)
 *  }
 */

'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────

/**
 * Replace these with real Stripe Checkout / payment URLs when ready.
 * Each key maps to the plan identifier used throughout this file.
 * @type {Record<string, string>}
 */
const PAYMENT_URLS = {
  monthly: 'https://buy.stripe.com/PLACEHOLDER_MONTHLY',
  legend:  'https://buy.stripe.com/PLACEHOLDER_LEGEND',
};

/** Storage keys */
const STORAGE_KEYS = {
  plan:       'moussy_plan',
  expires:    'moussy_plan_expires',
  licenseKey: 'moussy_license_key',
};

/** Plan metadata (drives UI state) */
const PLANS = {
  free: {
    id:    'free',
    label: 'Free Engine',
    price: '$0.00',
  },
  monthly: {
    id:    'monthly',
    label: 'Monthly Pass',
    price: '$3.99/mo',
  },
  legend: {
    id:    'legend',
    label: 'Legend Plan',
    price: '$29.99',
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

/** @type {'free'|'monthly'|'legend'} */
let currentPlan = 'free';

// ─── Storage Adapter ──────────────────────────────────────────────────────────
/**
 * Wraps chrome.storage.local with a Promise API.
 * Falls back to localStorage when running outside an extension context
 * (e.g., during standalone development / design review).
 */
const Storage = {
  async get(keys) {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
    }
    // Fallback: localStorage
    const result = {};
    for (const key of (Array.isArray(keys) ? keys : [keys])) {
      try { result[key] = JSON.parse(localStorage.getItem(key)); } catch { result[key] = null; }
    }
    return result;
  },

  async set(items) {
    if (typeof chrome !== 'undefined' && chrome?.storage?.local) {
      return new Promise((resolve) => chrome.storage.local.set(items, resolve));
    }
    for (const [k, v] of Object.entries(items)) {
      localStorage.setItem(k, JSON.stringify(v));
    }
  },
};

// ─── Toast ────────────────────────────────────────────────────────────────────

let _toastTimer = null;

/**
 * Show a transient notification at the bottom of the screen.
 * @param {string}  message
 * @param {number}  [duration=3200]  ms to display
 * @param {'ok'|'error'}  [type='ok']
 */
function showToast(message, duration = 3200, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;

  clearTimeout(_toastTimer);
  el.textContent = message;
  el.style.borderColor = type === 'error' ? '#f87171' : 'var(--border-bright)';
  el.classList.add('visible');

  _toastTimer = setTimeout(() => el.classList.remove('visible'), duration);
}

// ─── Particle Burst ───────────────────────────────────────────────────────────
/**
 * Spawns a brief CSS particle explosion at the given button element.
 * Particles are small divs animated with random trajectories via CSS variables.
 * All particles self-remove after animation ends.
 *
 * @param {HTMLElement} anchorEl    Element to launch particles from
 * @param {'purple'|'gold'}  theme
 */
function spawnParticles(anchorEl, theme = 'purple') {
  const rect  = anchorEl.getBoundingClientRect();
  const cx    = rect.left + rect.width  / 2;
  const cy    = rect.top  + rect.height / 2;
  const color = theme === 'gold' ? '#f5c542' : '#a855f7';
  const COUNT = 18;

  for (let i = 0; i < COUNT; i++) {
    const p  = document.createElement('div');
    const angle  = (i / COUNT) * 360;
    const dist   = 60 + Math.random() * 80;
    const size   = 3 + Math.random() * 4;
    const dur    = 500 + Math.random() * 400;

    Object.assign(p.style, {
      position:        'fixed',
      left:            `${cx}px`,
      top:             `${cy}px`,
      width:           `${size}px`,
      height:          `${size}px`,
      borderRadius:    '50%',
      background:      color,
      boxShadow:       `0 0 ${size * 2}px ${color}`,
      pointerEvents:   'none',
      zIndex:          '999999',
      transform:       'translate(-50%, -50%)',
      transition:      `transform ${dur}ms cubic-bezier(0,0,0.2,1), opacity ${dur}ms ease`,
      opacity:         '1',
    });

    document.body.appendChild(p);

    // Trigger after paint
    requestAnimationFrame(() => {
      const rad = (angle * Math.PI) / 180;
      const tx  = Math.cos(rad) * dist;
      const ty  = Math.sin(rad) * dist;
      p.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px))`;
      p.style.opacity   = '0';
    });

    setTimeout(() => p.remove(), dur + 50);
  }
}

// ─── UI Updater ───────────────────────────────────────────────────────────────
/**
 * Reflects the current plan in the DOM.
 * – Marks the active plan card with an aria-selected attribute
 * – Updates the Free button text if user has upgraded
 * @param {'free'|'monthly'|'legend'} plan
 */
function reflectPlanInUI(plan) {
  const btnFree    = document.getElementById('btn-free');
  const cardFree   = document.getElementById('plan-free');
  const cardMonth  = document.getElementById('plan-monthly');
  const cardLegend = document.getElementById('plan-legend');

  [cardFree, cardMonth, cardLegend].forEach((c) => c?.removeAttribute('aria-selected'));

  const activeCard = document.getElementById(`plan-${plan}`);
  activeCard?.setAttribute('aria-selected', 'true');

  if (btnFree) {
    btnFree.querySelector('.btn-text').textContent =
      plan === 'free' ? 'CURRENT PLAN' : 'DOWNGRADE';
    btnFree.disabled = plan === 'free';
  }

  const btnMonthly = document.getElementById('btn-monthly');
  if (btnMonthly) {
    btnMonthly.querySelector('.btn-text').textContent =
      plan === 'monthly' ? 'CURRENT PLAN' :
      plan === 'legend'  ? 'DOWNGRADE'    : 'ACTIVATE MONTHLY';
    btnMonthly.disabled = plan === 'monthly';
  }

  const btnLegend = document.getElementById('btn-legend');
  if (btnLegend) {
    btnLegend.querySelector('.btn-text').textContent =
      plan === 'legend' ? 'CURRENT PLAN' : 'UNLOCK LEGEND STATUS';
    btnLegend.disabled = plan === 'legend';
  }
}

// ─── Purchase Handler ─────────────────────────────────────────────────────────
/**
 * Central hook for initiating a purchase.
 * Currently redirects to the Stripe checkout URL.
 * Replace / extend this function to integrate your payment processor.
 *
 * @param {'monthly'|'legend'} plan
 * @param {HTMLButtonElement}  btnEl
 */
async function handlePurchase(plan, btnEl) {
  if (plan === currentPlan) return;

  // Animate the button into loading state
  btnEl.classList.add('loading');

  try {
    // ── Simulate async check (e.g., validate user session) ────────────
    await new Promise((r) => setTimeout(r, 800));

    const url = PAYMENT_URLS[plan];

    if (!url || url.includes('PLACEHOLDER')) {
      // Payment URLs not yet configured — show developer notice
      showToast(`[ DEV ] Payment gateway not yet wired for "${PLANS[plan].label}". Hook PAYMENT_URLS in premium.js.`, 5000, 'error');
      btnEl.classList.remove('loading');
      return;
    }

    // Open Stripe checkout in a new tab
    window.open(url, '_blank', 'noopener,noreferrer');
    showToast(`Redirecting to checkout for ${PLANS[plan].label}…`);

  } catch (err) {
    console.error('[MOUSSY:premium] Purchase error:', err);
    showToast('Something went wrong. Please try again.', 4000, 'error');
  } finally {
    btnEl.classList.remove('loading');
  }
}

/**
 * Simulate a successful plan activation (used for testing UI flow).
 * In production this would be called via a post-payment webhook callback
 * or a query-string token verification on page load.
 *
 * @param {'free'|'monthly'|'legend'} plan
 */
async function activatePlan(plan) {
  const data = {
    [STORAGE_KEYS.plan]: plan,
    [STORAGE_KEYS.expires]:    plan === 'monthly' ? getMonthFromNow() : null,
    [STORAGE_KEYS.licenseKey]: plan === 'legend'  ? generateMockKey() : null,
  };

  await Storage.set(data);
  currentPlan = plan;
  reflectPlanInUI(plan);
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function getMonthFromNow() {
  const d = new Date();
  d.setMonth(d.getMonth() + 1);
  return d.toISOString();
}

function generateMockKey() {
  // Generates a readable mock license key for UI demonstration
  const seg = () => Math.random().toString(36).substring(2, 7).toUpperCase();
  return `MSY-${seg()}-${seg()}-${seg()}`;
}

// ─── Event Wiring ─────────────────────────────────────────────────────────────

function bindButtons() {
  const btns = document.querySelectorAll('.cta-btn[data-plan]');

  btns.forEach((btn) => {
    btn.addEventListener('click', async () => {
      const plan = btn.dataset.plan;

      if (plan === 'free') {
        if (currentPlan === 'free') {
          showToast('// FREE ENGINE is already your active config.');
        } else {
          await activatePlan('free');
          showToast('// Reverted to FREE ENGINE.');
        }
        return;
      }

      if (plan === currentPlan) {
        showToast(`// ${PLANS[plan].label} is already active.`);
        return;
      }

      // Activate the plan directly (mock — wire PAYMENT_URLS for real checkout).
      const theme = plan === 'legend' ? 'gold' : 'purple';
      spawnParticles(btn, theme);
      btn.classList.add('loading');
      await new Promise((r) => setTimeout(r, 700));
      await activatePlan(plan);
      btn.classList.remove('loading');
      showToast(`✓ ${PLANS[plan].label} activated — premium slots unlocked.`, 4000);
    });
  });
}

function bindFooterLinks() {
  const noopLinks = ['link-terms', 'link-privacy', 'link-refund', 'link-contact'];
  noopLinks.forEach((id) => {
    document.getElementById(id)?.addEventListener('click', (e) => {
      e.preventDefault();
      showToast(`[ DEV ] "${id.replace('link-', '')}" page not yet linked.`, 3000);
    });
  });
}

/**
 * Keyboard accessibility: allow Enter / Space on plan cards to focus the CTA.
 */
function bindCardKeyboard() {
  document.querySelectorAll('.plan-card').forEach((card) => {
    card.setAttribute('tabindex', '0');
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        card.querySelector('.cta-btn')?.click();
      }
    });
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  // Load persisted plan from storage
  const stored = await Storage.get([STORAGE_KEYS.plan, STORAGE_KEYS.expires]);
  const savedPlan = stored[STORAGE_KEYS.plan];

  // Check if monthly subscription has expired
  if (savedPlan === 'monthly') {
    const expires = stored[STORAGE_KEYS.expires];
    if (expires && new Date(expires) < new Date()) {
      console.warn('[MOUSSY:premium] Monthly subscription expired — reverting to free.');
      await activatePlan('free');
    } else {
      currentPlan = 'monthly';
    }
  } else if (savedPlan === 'legend') {
    currentPlan = 'legend';
  } else {
    currentPlan = 'free';
  }

  reflectPlanInUI(currentPlan);
  bindButtons();
  bindFooterLinks();
  bindCardKeyboard();

  // Expose activatePlan to the global scope for post-payment webhook callbacks
  // e.g. called by a payment success redirect:  window.moussyActivate('legend')
  window.moussyActivate = activatePlan;

  console.log(`[MOUSSY:premium] UI ready. Current plan: ${currentPlan}`);
}

document.addEventListener('DOMContentLoaded', init);
