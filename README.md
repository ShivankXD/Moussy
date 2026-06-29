# MOUSSY 🖱️⚡

> High-performance, dark-themed, cyberpunk-style **mouse gesture extension** for Chrome.  
> Built with **Manifest V3** — zero dependencies, maximum performance.

---

## Project Structure

```
moussy/
├── manifest.json                  ← MV3 manifest (entry point)
│
├── background/
│   └── background.js              ← Service worker: gesture routing, offscreen mgmt, storage
│
├── content/
│   └── content.js                 ← Injected script: mouse capture, trail rendering, gesture recognition
│
├── popup/
│   ├── popup.html                 ← Action toolbar popup
│   ├── popup.js                   ← Popup logic
│   └── popup.css                  ← Popup styles (cyberpunk dark theme)
│
├── options/
│   ├── options.html               ← Full config page (opens in tab)
│   ├── options.js                 ← Options logic
│   └── options.css                ← Options styles
│
├── offscreen/
│   ├── offscreen.html             ← Offscreen document host (MV3 audio workaround)
│   └── offscreen.js               ← Web Audio API manager — plays sound clips off-thread
│
└── assets/
    ├── icons/
    │   ├── icon16.png             ← 16×16  extension icon
    │   ├── icon32.png             ← 32×32
    │   ├── icon48.png             ← 48×48
    │   └── icon128.png            ← 128×128
    └── sounds/
        ├── gesture_match.ogg      ← Sound on successful gesture
        ├── gesture_trail.ogg      ← Ambient tick during draw (optional)
        ├── gesture_fail.ogg       ← Unrecognised gesture tone
        └── gesture_action.ogg     ← Action executed confirmation
```

---

## Permissions

| Permission     | Purpose                                                    |
|----------------|------------------------------------------------------------|
| `storage`      | Persist gesture maps, settings, and user profiles          |
| `activeTab`    | Access the current tab for scripting and screenshots       |
| `scripting`    | Inject utility scripts (screenshot capture, DOM actions)   |
| `offscreen`    | Run Web Audio API in an offscreen doc — no lag on the page |
| `contextMenus` | Register gesture shortcuts in the right-click menu         |
| `tabs`         | Tab navigation gesture actions                             |

---

## Getting Started (Load Unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** → select this folder
4. The MOUSSY icon will appear in your toolbar

---

## Roadmap

- [ ] Gesture recognition engine (direction-vector based)
- [ ] On-page gesture trail renderer (canvas overlay)
- [ ] Gesture → action mapping (configurable)
- [ ] Web Audio API sound pack system (offscreen)
- [ ] Screenshot utility (activeTab + scripting)
- [ ] Full cyberpunk options UI
- [ ] Import / Export gesture profiles
- [ ] Per-domain allow/block list