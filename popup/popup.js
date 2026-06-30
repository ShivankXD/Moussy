/**
 * MOUSSY — Control Panel  (popup.js)
 * ════════════════════════════════════
 * Drives the toolbar popup (popup.html). Responsibilities:
 *   • Reflect + persist the two pause states (per-site and global)
 *   • Launch the SETTINGS page and the BUY PREMIUM page in new tabs
 *   • Reflect the current plan on the premium banner
 *
 * Persistence
 * ───────────
 * Everything is stored in chrome.storage.local — the single source of truth
 * shared with background.js and content.js:
 *   moussy_paused_global : boolean              (gestures off everywhere)
 *   moussy_paused_hosts  : string[]             (hostnames with gestures off)
 *   moussy_plan          : 'free'|'monthly'|'legend'
 *
 * content.js watches storage.onChanged for these keys, so toggling here takes
 * effect on open tabs immediately — no reload required.
 */

'use strict';

const KEY_GLOBAL = 'moussy_paused_global';
const KEY_HOSTS  = 'moussy_paused_hosts';
const KEY_PLAN   = 'moussy_plan';

const runtimeURL = (path) =>
  (typeof chrome !== 'undefined' && chrome?.runtime?.getURL)
    ? chrome.runtime.getURL(path)
    : path;
const SETTINGS_URL = runtimeURL('settings/settings.html');
const PREMIUM_URL  = runtimeURL('premium/premium.html');

// ── DOM refs ──────────────────────────────────────────────────────────────────
const els = {
  toggleSite:    document.getElementById('toggle-site'),
  toggleAll:     document.getElementById('toggle-all'),
  rowSite:       document.getElementById('row-site'),
  siteHost:      document.getElementById('site-host'),
  btnSettings:   document.getElementById('btn-settings'),
  btnPremium:    document.getElementById('btn-premium'),
  premiumKicker: document.getElementById('premium-kicker'),
  premiumTitle:  document.getElementById('premium-title'),
  btnMin:        document.getElementById('btn-min'),
  btnClose:      document.getElementById('btn-close'),
  heroImg:       document.getElementById('hero-img'),
  heroFallback:  document.getElementById('hero-fallback'),
};

// ── Storage helpers ───────────────────────────────────────────────────────────
// Fall back to a no-op store when running outside the extension (standalone
// preview / design review) so the panel still renders without throwing.
const hasStorage = typeof chrome !== 'undefined' && chrome?.storage?.local;
const get = (keys) => hasStorage
  ? new Promise((res) => chrome.storage.local.get(keys, res))
  : Promise.resolve({});
const set = (items) => hasStorage
  ? new Promise((res) => chrome.storage.local.set(items, res))
  : Promise.resolve();

/** Resolve the active tab and its hostname (null if not an http(s) page). */
async function getActiveHost() {
  try {
    if (typeof chrome === 'undefined' || !chrome?.tabs?.query) return null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return null;
    const u = new URL(tab.url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname;
  } catch {
    return null;
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
let host = null;   // current tab hostname, or null if gestures can't run here

// ── Render ────────────────────────────────────────────────────────────────────
/** Show the optional hero PNG once it loads; otherwise keep the vector fallback. */
function initHero() {
  if (!els.heroImg) return;
  els.heroImg.addEventListener('load', () => {
    if (els.heroImg.naturalWidth === 0) return;   // broken/empty image
    els.heroImg.classList.add('loaded');
    els.heroFallback?.classList.add('hidden');
  });
  els.heroImg.addEventListener('error', () => {
    // No hero.png supplied — the vector fallback stays visible.
    els.heroImg.remove();
  });
}

function renderPremium(plan) {
  const paid = plan === 'monthly' || plan === 'legend';
  els.btnPremium.classList.toggle('is-active', paid);
  if (paid) {
    els.premiumKicker.textContent = 'Active subscription';
    els.premiumTitle.textContent = plan === 'legend' ? 'LEGEND STATUS' : 'MONTHLY PASS';
  } else {
    els.premiumKicker.textContent = 'Need more functionalities?';
    els.premiumTitle.textContent = 'BUY PREMIUM';
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  host = await getActiveHost();

  const data = await get([KEY_GLOBAL, KEY_HOSTS, KEY_PLAN]);
  const global = data[KEY_GLOBAL] === true;
  const hosts  = Array.isArray(data[KEY_HOSTS]) ? data[KEY_HOSTS] : [];
  const plan   = data[KEY_PLAN] ?? 'free';

  // Per-site toggle
  if (host) {
    els.siteHost.textContent = host;
    els.toggleSite.checked = hosts.includes(host);
  } else {
    els.siteHost.textContent = 'Not available on this page';
    els.toggleSite.checked = false;
    els.rowSite.classList.add('is-disabled');
    els.toggleSite.disabled = true;
  }

  // Global toggle
  els.toggleAll.checked = global;

  initHero();
  renderPremium(plan);
  bindEvents();
}

// ── Events ────────────────────────────────────────────────────────────────────
function bindEvents() {
  els.toggleSite.addEventListener('change', async () => {
    if (!host) return;
    const data = await get(KEY_HOSTS);
    const hosts = new Set(Array.isArray(data[KEY_HOSTS]) ? data[KEY_HOSTS] : []);
    if (els.toggleSite.checked) hosts.add(host);
    else hosts.delete(host);
    await set({ [KEY_HOSTS]: [...hosts] });
  });

  els.toggleAll.addEventListener('change', async () => {
    await set({ [KEY_GLOBAL]: els.toggleAll.checked });
  });

  els.btnSettings.addEventListener('click', () => openTab(SETTINGS_URL));
  els.btnPremium.addEventListener('click', () => openTab(PREMIUM_URL));
  els.btnClose?.addEventListener('click', () => window.close());
  els.btnMin?.addEventListener('click', () => window.close());
}

/** Open an extension page in a new foreground tab, then close the popup. */
function openTab(url) {
  if (chrome?.tabs?.create) {
    chrome.tabs.create({ url, active: true }, () => window.close());
  } else {
    window.open(url, '_blank');
  }
}

document.addEventListener('DOMContentLoaded', init);
