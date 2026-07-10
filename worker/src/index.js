/**
 * MOUSSY — License Worker  (Cloudflare Workers + D1)
 * ════════════════════════════════════════════════════════════════════════════
 * Runtime validation layer for MOUSSY's paid tiers. Fungies.io is the Merchant
 * of Record (it takes the money + handles tax) but does NOT verify keys at
 * runtime — it only decrements key inventory on sale. So this Worker owns the
 * "is this key/subscription actually valid?" decision.
 *
 * Two paid tiers:
 *   • Legend Plan  ($19.99 one-time)  → Fungies "Software Keys" → POST /redeem
 *   • Monthly Pass ($2.99/mo)         → Fungies "Subscriptions" → GET /subscription-status
 *
 * Endpoints
 *   POST /redeem              { key, device_id }        → { valid, reason? }
 *   GET  /subscription-status ?userId=… | ?email=…      → { active, reason? }
 *   GET  /health                                        → { ok:true }
 *
 * Secrets (wrangler secret put …) — NEVER shipped in the extension:
 *   FUNGIES_API_KEY   read API key (x-api-key) for the Fungies REST API
 *
 * Bindings (wrangler.toml):
 *   DB               D1 database holding the legend_keys inventory
 *   REDEEM_LIMITER   (optional) native Rate Limiting binding for /redeem
 *
 * Vars (wrangler.toml [vars]):
 *   FUNGIES_API_BASE   default https://api.fungies.io
 *   ALLOWED_ORIGIN     "*" or a specific chrome-extension://<id> origin
 * ──────────────────────────────────────────────────────────────────────────── */

const KEY_RE = /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/;

export default {
  /**
   * @param {Request} request
   * @param {Env} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(env, request);

    // Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === '/health' && request.method === 'GET') {
        return json({ ok: true }, 200, cors);
      }

      if (url.pathname === '/redeem' && request.method === 'POST') {
        return await handleRedeem(request, env, cors);
      }

      if (url.pathname === '/subscription-status' && request.method === 'GET') {
        return await handleSubscriptionStatus(url, env, cors);
      }

      return json({ error: 'not_found' }, 404, cors);
    } catch (err) {
      // Never leak internals (or secrets) to the client.
      console.error('[moussy-license] unhandled', err && err.stack ? err.stack : err);
      return json({ error: 'server_error' }, 500, cors);
    }
  },
};

// ════════════════════════════════════════════════════════════════════════════
// POST /redeem  — Legend one-time key activation
// ════════════════════════════════════════════════════════════════════════════
/**
 * Body: { key: string, device_id: string }
 * Returns:
 *   { valid:true }                              first redeem, or same device re-check
 *   { valid:false, reason:"already_used" }      redeemed by a DIFFERENT device
 *   { valid:false, reason:"invalid_key" }       not in inventory
 *   { valid:false, reason:"bad_request" }       malformed body / key format
 *   { valid:false, reason:"rate_limited" }      too many attempts from this IP
 */
async function handleRedeem(request, env, cors) {
  // ── Rate limit (brute-force protection). Keyspace is ~36^15 so guessing a
  //    live key is already infeasible; this is defense-in-depth. The native
  //    binding is optional — if it isn't configured we simply skip it. ──
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (env.REDEEM_LIMITER) {
    const { success } = await env.REDEEM_LIMITER.limit({ key: `redeem:${ip}` });
    if (!success) return json({ valid: false, reason: 'rate_limited' }, 429, cors);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ valid: false, reason: 'bad_request' }, 400, cors);
  }

  const key = normalizeKey(body && body.key);
  const deviceId = typeof (body && body.device_id) === 'string' ? body.device_id.trim() : '';

  if (!key || !KEY_RE.test(key) || !deviceId) {
    return json({ valid: false, reason: 'bad_request' }, 400, cors);
  }

  // Look up the key.
  const row = await env.DB
    .prepare('SELECT key, redeemed, device_id FROM legend_keys WHERE key = ?')
    .bind(key)
    .first();

  if (!row) {
    return json({ valid: false, reason: 'invalid_key' }, 200, cors);
  }

  // Already redeemed?
  if (row.redeemed) {
    if (row.device_id && row.device_id === deviceId) {
      // Idempotent: same install re-checking (e.g. after a reinstall that kept
      // the same device_id via chrome.storage.sync). Treat as still valid.
      return json({ valid: true }, 200, cors);
    }
    return json({ valid: false, reason: 'already_used' }, 200, cors);
  }

  // Unredeemed → claim it atomically. The `AND redeemed = 0` guard makes this
  // safe against two concurrent redeems racing for the same key.
  const now = new Date().toISOString();
  const upd = await env.DB
    .prepare(
      'UPDATE legend_keys SET redeemed = 1, redeemed_at = ?, device_id = ? ' +
      'WHERE key = ? AND redeemed = 0'
    )
    .bind(now, deviceId, key)
    .run();

  if (upd.meta && upd.meta.changes === 1) {
    return json({ valid: true }, 200, cors);
  }

  // We lost the race — someone redeemed between our SELECT and UPDATE. Re-read
  // and decide based on who owns it now.
  const after = await env.DB
    .prepare('SELECT device_id FROM legend_keys WHERE key = ?')
    .bind(key)
    .first();

  if (after && after.device_id === deviceId) {
    return json({ valid: true }, 200, cors);
  }
  return json({ valid: false, reason: 'already_used' }, 200, cors);
}

// ════════════════════════════════════════════════════════════════════════════
// GET /subscription-status  — Monthly Pass liveness check (via Fungies API)
// ════════════════════════════════════════════════════════════════════════════
/**
 * Query: ?userId=<fungiesUserId>  OR  ?email=<purchaserEmail>
 * Calls the Fungies REST API with the server-side x-api-key secret and reports
 * whether the caller currently has an ACTIVE subscription.
 *
 * Returns: { active:boolean, reason?:string }
 */
async function handleSubscriptionStatus(url, env, cors) {
  const userId = (url.searchParams.get('userId') || '').trim();
  const email = (url.searchParams.get('email') || '').trim().toLowerCase();

  if (!userId && !email) {
    return json({ active: false, reason: 'missing_identifier' }, 400, cors);
  }
  if (!env.FUNGIES_API_KEY) {
    return json({ active: false, reason: 'server_not_configured' }, 500, cors);
  }

  const base = (env.FUNGIES_API_BASE || 'https://api.fungies.io').replace(/\/+$/, '');
  const headers = { 'x-api-key': env.FUNGIES_API_KEY, 'Content-Type': 'application/json' };

  try {
    // Preferred path (as set up in the Fungies dashboard): a user's inventory
    // filtered to subscription products.
    if (userId) {
      const res = await fetch(
        `${base}/users/${encodeURIComponent(userId)}/inventory?productType=Subscription`,
        { headers }
      );
      if (!res.ok) return json({ active: false, reason: `fungies_${res.status}` }, 200, cors);
      const data = await res.json();
      return json({ active: inventoryLooksActive(data) }, 200, cors);
    }

    // Fallback when we only captured an email at checkout: scan active
    // subscriptions and match the customer email. Heavier, so userId is
    // preferred whenever the extension has it.
    const res = await fetch(`${base}/subscriptions/list?status=active`, { headers });
    if (!res.ok) return json({ active: false, reason: `fungies_${res.status}` }, 200, cors);
    const data = await res.json();
    return json({ active: subscriptionsMatchEmail(data, email) }, 200, cors);
  } catch (err) {
    console.error('[moussy-license] fungies fetch failed', err && err.message);
    // Signal a transient failure so the extension can apply its grace period
    // instead of downgrading the user on a blip.
    return json({ active: false, reason: 'upstream_unavailable' }, 502, cors);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════
function normalizeKey(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

/**
 * Defensive parse of a Fungies inventory response. Shapes vary, so we accept
 * several: a bare array, { items:[…] }, { data:[…] }, or a single object.
 * An entry counts as active if it isn't expired/cancelled and either says so
 * explicitly or has a currentPeriodEnd in the future.
 */
function inventoryLooksActive(data) {
  const items = extractList(data);
  const now = Date.now();
  return items.some((it) => entryActive(it, now));
}

function subscriptionsMatchEmail(data, email) {
  if (!email) return false;
  const items = extractList(data);
  const now = Date.now();
  return items.some((it) => {
    const em = String(
      (it && (it.email || it.customerEmail || (it.customer && it.customer.email))) || ''
    ).toLowerCase();
    return em === email && entryActive(it, now);
  });
}

function entryActive(it, now) {
  if (!it || typeof it !== 'object') return false;
  const status = String(it.status || it.state || '').toLowerCase();
  if (status && ['cancelled', 'canceled', 'expired', 'inactive', 'past_due', 'unpaid'].includes(status)) {
    return false;
  }
  if (status === 'active' || status === 'trialing' || it.active === true) return true;
  const end = it.currentPeriodEnd || it.current_period_end || it.expiresAt || it.expires_at;
  if (end) {
    const t = typeof end === 'number' ? end * (end < 1e12 ? 1000 : 1) : Date.parse(end);
    if (!Number.isNaN(t)) return t > now;
  }
  // If we got an entry back at all with no negative signal, treat presence as active.
  return status === '' && it.active === undefined && end === undefined && Object.keys(it).length > 0;
}

function extractList(data) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && Array.isArray(data.subscriptions)) return data.subscriptions;
  if (data && typeof data === 'object') return [data];
  return [];
}

function corsHeaders(env, request) {
  const allow = env.ALLOWED_ORIGIN || '*';
  const origin = request.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allow === '*' ? '*' : (origin === allow ? allow : allow),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}
