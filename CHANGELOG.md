# Changelog

## 1.0.0 — 2026-10-10

First public release.

- Lossless trimming with FFmpeg stream copy: no re-encoding, no quality loss.
- Keyframe-aware In/Out markers: keyframes on the timeline, start snaps to the nearest keyframe, <kbd>Alt</kbd> for free placement with a ⚠ hint.
- Any number of fragments with list editing, preview and undo/redo.
- Batch export to separate files or merged into one file; file-name templates.
- Audio tracks: enable/disable, reorder, language/title, add or replace with external audio, millisecond offset and drag-to-sync.
- FFmpeg dry-run compatibility check before export with one-click switch to MKV.
- Waveforms, audio-file trimming, `.nee` projects, light/dark theme, English/Russian UI.
- Accurate cuts across MP4/MOV, MKV/WebM, FLV, AVI and MPEG-TS sources (seek heuristics compensated, TS keyframe selection by timestamp, AVI timestamp regeneration).
- Installer and portable builds with FFmpeg 9.0 bundled.
