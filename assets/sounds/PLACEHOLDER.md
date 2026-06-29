# MOUSSY — Required Audio Assets
# ════════════════════════════════
# Place the following files in this directory before loading the extension.
#
# REQUIRED (referenced by default in background.js + offscreen.js):
#   metal_slash.mp3     ← triggered on every successful navigation gesture
#                          (50% volume / 0.5 gain)
#
# OPTIONAL (for future premium sound packs):
#   gesture_match.mp3   ← alternative gesture confirm sound
#   gesture_fail.mp3    ← unrecognised gesture tone
#   gesture_trail.mp3   ← ambient tick during draw
#   gesture_action.mp3  ← action executed confirmation
#
# FORMAT NOTES:
#   • MP3 is required for cross-browser AudioContext.decodeAudioData() support
#   • OGG is also accepted (smaller file size) — update clip filenames in background.js
#   • Recommended duration: 0.3s – 0.8s (shorter = snappier feel)
#   • Recommended sample rate: 44100 Hz
#   • Keep raw file sizes under 100KB for instant cache loading
#
# FREE SOURCES:
#   • https://freesound.org  (CC0 / CC-BY clips)
#   • https://mixkit.co/free-sound-effects/
#   • https://zapsplat.com
