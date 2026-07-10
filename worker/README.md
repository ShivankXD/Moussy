# MOUSSY — License Worker

Runtime validation layer for MOUSSY's paid tiers, deployed on **Cloudflare
Workers + D1** (same pattern as NativeOffice, but a separate Worker + database).

Fungies.io is the Merchant of Record (payments + tax). It sells the Legend keys
and runs the Monthly subscription, but it does **not** verify keys at runtime —
so this Worker does.

```
worker/
├── src/index.js                         # the Worker (routes below)
├── wrangler.toml                        # bindings + vars (no secrets)
├── data/moussy_legend_keys.csv          # the 500 keys — single source of truth
├── scripts/generate-seed.mjs            # CSV -> 0002 seed migration
└── migrations/
    ├── 0001_create_legend_keys.sql      # schema
    └── 0002_seed_legend_keys.sql        # GENERATED — 500 INSERTs
```

## Endpoints

| Method | Path                    | Body / Query                     | Response |
|--------|-------------------------|----------------------------------|----------|
| POST   | `/redeem`               | `{ key, device_id }`             | `{ valid, reason? }` |
| GET    | `/subscription-status`  | `?userId=…` or `?email=…`        | `{ active, reason? }` |
| GET    | `/health`               | —                                | `{ ok:true }` |

`/redeem` reasons: `already_used`, `invalid_key`, `bad_request`, `rate_limited`.

## One-time setup

```bash
cd worker
npm install                       # installs wrangler (devDependency)

# 1. Create the D1 database, paste the printed database_id into wrangler.toml
npx wrangler d1 create moussy-license

# 2. Regenerate the seed from the CSV (safe to re-run)
node scripts/generate-seed.mjs

# 3. Apply migrations (schema + 500 keys)
npx wrangler d1 migrations apply moussy-license            # remote
# npx wrangler d1 migrations apply moussy-license --local  # local dev

# 4. Store the Fungies READ api key as an encrypted secret (never in code)
npx wrangler secret put FUNGIES_API_KEY

# 5. Deploy
npx wrangler deploy
```

After deploy, copy the Worker URL (e.g.
`https://moussy-license.<subdomain>.workers.dev`) into the extension at
`background/background.js` → `LICENSE_WORKER_BASE`.

## Local development

```bash
npx wrangler d1 migrations apply moussy-license --local
npx wrangler dev
```

Smoke tests:

```bash
# redeem (use a real key from the CSV)
curl -s -XPOST localhost:8787/redeem \
  -H 'content-type: application/json' \
  -d '{"key":"0CGUL-E78OW-WBRTC","device_id":"dev-1"}'
# -> {"valid":true}   (again with same device_id -> still {"valid":true})
# -> different device_id -> {"valid":false,"reason":"already_used"}

curl -s 'localhost:8787/subscription-status?email=buyer@example.com'
```

## Security notes

- **Secrets** (`FUNGIES_API_KEY`) live only as Worker secrets, never in the
  extension bundle. The key list lives only in D1 (seeded from the CSV).
- **Device binding**: a Legend key is bound to the first `device_id` that
  redeems it. Re-redeeming from the same `device_id` is idempotent (so a
  reinstall that preserved its id via `chrome.storage.sync` restores cleanly);
  a different id is rejected as `already_used`.
- **Rate limiting** on `/redeem` is defense-in-depth; the ~36¹⁵ keyspace
  already makes guessing a live key infeasible.
