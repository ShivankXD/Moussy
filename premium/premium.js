/**
 * MOUSSY — Premium Page Controller  (premium.js)
 * ================================================
 * Payments are handled by Fungies.io (Merchant of Record — it takes the money
 * and handles tax). This page:
 *   – reads the current plan from the background service worker (the single
 *     source of truth is chrome.storage.local `moussy_plan`)
 *   – opens the Fungies hosted checkout for a chosen plan
 *   – LEGEND: lets the buyer paste the one-time key emailed by Fungies; the
 *     background worker redeems it against our Cloudflare Worker (POST /redeem)
 *   – MONTHLY: lets the buyer confirm the email they checked out with; the
 *     background worker verifies the subscription (GET /subscription-status)
 *   – reflects the current plan with NO downgrade paths
 *
 * No secrets and no key list live here — only the public Fungies checkout URLs.
 * All validation happens in the background worker + Cloudflare Worker.
 */

'use strict';

/**
 * Fungies hosted-checkout links for each paid product (from your Fungies
 * dashboard → product → "Share / Checkout link"). These are public URLs.
 */
const FUNGIES_CHECKOUT = {
  monthly: 'https://shivankxd.app.fungies.io/subscribe/b225a780-23fa-425c-bf0b-7953d6f4d638', // Monthly Pass
  legend:  'https://shivankxd.app.fungies.io/checkout/1a4463cb-16f7-4cf8-bf24-c6b171cd2670',  // Legend Plan
};

/** Plan metadata (display only). Order matters: index = tier rank. */
const PLANS = {
  free:    { id: 'free',    label: 'Free Engine',  rank: 0 },
  monthly: { id: 'monthly', label: 'Monthly Pass', rank: 1 },
  legend:  { id: 'legend',  label: 'Legend Plan',  rank: 2 },
};

/** @type {'free'|'monthly'|'legend'} */
let currentPlan = 'free';

/** Thin promise wrapper around chrome.runtime.sendMessage. */
function bg(type, payload) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type, payload }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false });
      });
    } catch (e) {
      resolve({ ok: false, error: e?.message });
    }
  });
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let _toastTimer = null;
function showToast(message, duration = 3200, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(_toastTimer);
  el.textContent = message;
  el.style.borderColor = type === 'error' ? '#f87171' : 'var(--border-bright)';
  el.classList.add('visible');
  _toastTimer = setTimeout(() => el.classList.remove('visible'), duration);
}

// ─── Particle burst (flair on checkout launch) ─────────────────────────────────
function spawnParticles(anchorEl, theme = 'purple') {
  if (!anchorEl) return;
  const rect = anchorEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const color = theme === 'gold' ? '#f5c542' : '#a855f7';
  const COUNT = 18;
  for (let i = 0; i < COUNT; i++) {
    const p = document.createElement('div');
    const angle = (i / COUNT) * 360, dist = 60 + Math.random() * 80;
    const size = 3 + Math.random() * 4, dur = 500 + Math.random() * 400;
    Object.assign(p.style, {
      position: 'fixed', left: `${cx}px`, top: `${cy}px`,
      width: `${size}px`, height: `${size}px`, borderRadius: '50%',
      background: color, boxShadow: `0 0 ${size * 2}px ${color}`,
      pointerEvents: 'none', zIndex: '999999', transform: 'translate(-50%, -50%)',
      transition: `transform ${dur}ms cubic-bezier(0,0,0.2,1), opacity ${dur}ms ease`, opacity: '1',
    });
    document.body.appendChild(p);
    requestAnimationFrame(() => {
      const rad = (angle * Math.PI) / 180;
      p.style.transform = `translate(calc(-50% + ${Math.cos(rad) * dist}px), calc(-50% + ${Math.sin(rad) * dist}px))`;
      p.style.opacity = '0';
    });
    setTimeout(() => p.remove(), dur + 50);
  }
}

// ─── UI: reflect current plan (NO downgrade paths) ─────────────────────────────
function setBtn(btn, text, enabled) {
  if (!btn) return;
  btn.querySelector('.btn-text').textContent = text;
  btn.disabled = !enabled;
  btn.classList.toggle('is-owned', !enabled);
}

function reflectPlanInUI(plan) {
  const rank = PLANS[plan].rank;

  ['plan-free', 'plan-monthly', 'plan-legend'].forEach((id) =>
    document.getElementById(id)?.removeAttribute('aria-selected'));
  document.getElementById(`plan-${plan}`)?.setAttribute('aria-selected', 'true');

  setBtn(document.getElementById('btn-free'),
    plan === 'free' ? 'CURRENT PLAN' : 'INCLUDED IN YOUR PLAN', false);

  const btnMonthly = document.getElementById('btn-monthly');
  if (rank === 0)              setBtn(btnMonthly, 'ACTIVATE MONTHLY', true);
  else if (plan === 'monthly') setBtn(btnMonthly, '✓ YOUR PLAN', false);
  else                         setBtn(btnMonthly, 'LEGEND COVERS THIS', false);

  const btnLegend = document.getElementById('btn-legend');
  if (plan === 'legend')  setBtn(btnLegend, '✓ YOUR PLAN', false);
  else if (rank === 1)    setBtn(btnLegend, 'UPGRADE TO LEGEND', true);
  else                    setBtn(btnLegend, 'UNLOCK LEGEND STATUS', true);

  // Activation rows start hidden and are revealed on demand (plan button or
  // hint click). Once a tier is owned there is nothing left to redeem for it,
  // so hide that tier's row + hint entirely.
  if (plan === 'legend') {
    // Legend covers everything — no activation needed anywhere.
    ['legend-activate', 'legend-hint', 'monthly-activate', 'monthly-hint'].forEach(hide);
  } else if (plan === 'monthly') {
    hide('monthly-activate'); hide('monthly-hint');   // Monthly owned
    show('legend-hint');                              // can still upgrade to Legend
  } else {
    show('monthly-hint'); show('legend-hint');        // free: both restore hints visible
  }
}

function hide(id) { const el = document.getElementById(id); if (el) el.hidden = true; }
function show(id) { const el = document.getElementById(id); if (el) el.hidden = false; }

// ─── Checkout launch ────────────────────────────────────────────────────────
function openCheckout(plan) {
  const url = FUNGIES_CHECKOUT[plan];
  if (!url || url.includes('YOUR-STORE')) {
    showToast('Checkout link not configured yet.', 3500, 'error');
    return false;
  }
  window.open(url, '_blank', 'noopener');
  return true;
}

// ─── Legend key activation ───────────────────────────────────────────────────
/** Live-format a Legend key into XXXXX-XXXXX-XXXXX as the user types. */
function formatKey(raw) {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 15);
  return clean.replace(/(.{5})(.{1,5})?(.{1,5})?/, (_, a, b, c) =>
    [a, b, c].filter(Boolean).join('-'));
}

async function activateLegendKey() {
  const input = document.getElementById('legend-key');
  const btn = document.getElementById('btn-legend-activate');
  const key = (input?.value || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/.test(key)) {
    showToast('Enter a full key: XXXXX-XXXXX-XXXXX', 3500, 'error');
    input?.focus();
    return;
  }
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'CHECKING…';
  const resp = await bg('REDEEM_LEGEND', { key });
  btn.disabled = false;
  btn.textContent = prev;

  if (resp.ok) {
    currentPlan = resp.plan || 'legend';
    reflectPlanInUI(currentPlan);
    spawnParticles(document.getElementById('btn-legend'), 'gold');
    showToast('✓ Legend activated — lifetime access unlocked!', 4500);
    return;
  }
  showToast(legendError(resp.reason), 4500, 'error');
}

function legendError(reason) {
  switch (reason) {
    case 'already_used': return 'That key is already activated on another device.';
    case 'invalid_key':  return 'Key not recognized. Check for typos.';
    case 'bad_format':   return 'Key must look like XXXXX-XXXXX-XXXXX.';
    case 'network':      return 'Network issue — check your connection and retry.';
    default:             return 'Could not activate that key. Please try again.';
  }
}

// ─── Monthly purchase confirmation ───────────────────────────────────────────
async function confirmMonthly() {
  const input = document.getElementById('monthly-email');
  const btn = document.getElementById('btn-monthly-confirm');
  const email = (input?.value || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Enter the email you used at checkout.', 3500, 'error');
    input?.focus();
    return;
  }
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'CHECKING…';
  const resp = await bg('SET_MONTHLY_IDENTITY', { email });
  btn.disabled = false;
  btn.textContent = prev;

  currentPlan = resp.plan || currentPlan;
  reflectPlanInUI(currentPlan);
  if (currentPlan === 'monthly') {
    spawnParticles(document.getElementById('btn-monthly'), 'purple');
    showToast('✓ Monthly Pass active — premium unlocked!', 4500);
  } else {
    showToast('No active subscription found for that email yet. If you just paid, give it a moment and retry.', 5000, 'error');
  }
}

// ─── Event wiring ──────────────────────────────────────────────────────────────
function bindButtons() {
  document.getElementById('btn-monthly')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) { showToast(`// You already have ${PLANS[currentPlan].label}.`); return; }
    spawnParticles(btn, 'purple');
    if (openCheckout('monthly')) {
      show('monthly-activate');
      showToast('Opening secure checkout… confirm your email here once you\'ve paid.', 4000);
      document.getElementById('monthly-email')?.focus();
    }
  });

  document.getElementById('btn-legend')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    if (btn.disabled) { showToast('// You already have Legend access.'); return; }
    spawnParticles(btn, 'gold');
    if (openCheckout('legend')) {
      show('legend-activate');
      showToast('Opening secure checkout… paste your key here once you receive it.', 4000);
      document.getElementById('legend-key')?.focus();
    }
  });

  // Hints reveal the activation rows (for buyers restoring on a new install).
  document.getElementById('legend-hint')?.addEventListener('click', () => {
    show('legend-activate'); document.getElementById('legend-key')?.focus();
  });
  document.getElementById('monthly-hint')?.addEventListener('click', () => {
    show('monthly-activate'); document.getElementById('monthly-email')?.focus();
  });

  // Activation actions.
  document.getElementById('btn-legend-activate')?.addEventListener('click', activateLegendKey);
  document.getElementById('btn-monthly-confirm')?.addEventListener('click', confirmMonthly);

  const keyInput = document.getElementById('legend-key');
  keyInput?.addEventListener('input', (e) => { e.target.value = formatKey(e.target.value); });
  keyInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') activateLegendKey(); });
  document.getElementById('monthly-email')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmMonthly();
  });
}

function bindFooterLinks() {
  const contact = document.getElementById('link-contact');
  contact?.addEventListener('click', (e) => {
    e.preventDefault();
    try { window.open(chrome.runtime.getURL('contact/contact.html'), '_blank', 'noopener'); }
    catch { showToast('Contact page unavailable.', 3000); }
  });
  ['link-terms', 'link-privacy', 'link-refund'].forEach((id) => {
    document.getElementById(id)?.addEventListener('click', (e) => {
      e.preventDefault();
      showToast(`[ DEV ] "${id.replace('link-', '')}" page not yet linked.`, 3000);
    });
  });
}

function bindCardKeyboard() {
  document.querySelectorAll('.plan-card').forEach((card) => {
    card.setAttribute('tabindex', '0');
    card.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target === card) {
        e.preventDefault();
        card.querySelector('.cta-btn')?.click();
      }
    });
  });
}

// ─── Init ──────────────────────────────────────────────────────────────────────
async function refreshPlan() {
  const resp = await bg('GET_LICENSE_STATE');
  currentPlan = resp.ok && resp.plan ? resp.plan : 'free';
  reflectPlanInUI(currentPlan);
}

async function init() {
  reflectPlanInUI('free');   // optimistic paint before the async check
  await refreshPlan();
  bindButtons();
  bindFooterLinks();
  bindCardKeyboard();

  // If the plan changes underneath us (e.g. the 24h re-check downgrades an
  // expired Monthly, or a redeem completes), keep the UI honest.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.moussy_plan) {
      currentPlan = changes.moussy_plan.newValue || 'free';
      reflectPlanInUI(currentPlan);
    }
  });

  console.log(`[MOUSSY:premium] UI ready. Current plan: ${currentPlan}`);
}

document.addEventListener('DOMContentLoaded', init);
