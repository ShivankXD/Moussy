# MOUSSY — Wireframe Reference Images

This folder contains the UI reference screenshots used to design the MOUSSY extension interface.

## Files

| File | Description |
|------|-------------|
| `popup_preview.png` | Extension popup preview — the main popup.html UI showing the gesture HUD, toggles, SETTINGS button, and BUY PREMIUM banner |
| `pricing_page.png` | Premium / pricing page — three-tier plan cards: FREE ENGINE ($0), MONTHLY PASS ($3.99/mo), LEGEND PLAN ($29.99 one-time) |
| `settings_dashboard.png` | Settings dashboard — the main settings.html reference showing sidebar nav, gesture mode selector, allocation matrix, and locked premium section |

## Design Tokens Extracted

- **Primary accent:** `#a855f7` (neon purple)
- **Background:** `#050508` (deep carbon)
- **Surface:** `#0d0d12` / `#111118`
- **Border:** `#1a1a26`
- **Font:** Orbitron (headings), Share Tech Mono (data), Inter (body)
- **Gold accent:** `#f5c542` (Legend tier)

## Key Design Patterns

1. **Corner bracket decorations** on cards — thin L-shaped borders at corners
2. **Tech grid background** — faint purple dot/line grid overlay
3. **Glow effects** — purple drop-shadows on active/selected elements
4. **Lock state** — `opacity: 0.4`, `pointer-events: none`, lock icon glyph
5. **Tooltip** — JS-positioned dark panel appearing on hover over locked elements
