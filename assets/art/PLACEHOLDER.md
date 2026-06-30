# MOUSSY — Hero Art

Drop a **transparent PNG** named `hero.png` in this folder to show it in the
centre of the gesture wheel in the popup (the armoured-warrior + mouse key-art).

- Filename: `hero.png` (exact)
- Recommended size: ~300×360px, transparent background
- If no `hero.png` is present, the popup falls back to a built-in vector
  mouse/emblem so the panel still looks complete.

The popup loads it via `popup/popup.html` → `<img id="hero-img" src="../assets/art/hero.png">`
and reveals it only once it loads successfully (`popup.js` → `initHero()`).
