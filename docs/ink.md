# ink.js

[日本語](ink.ja.md)

The module (`AV.ink`) that turns sound energy into "ink-drop instructions".
It does not draw anything itself. Every frame it builds a queue describing where to drop ink and with what size, pigment and wetness, and hands it to `renderer.js`.

## Two input paths

| Path | Used when | Unit of detection |
|---|---|---|
| Bands (`update`) | Microphone, loaded files, built-in audio without stems | Three bands of the mixed signal: low / mid / high |
| Stems (`updateStems`) | Built-in audio with prepared stems | Per instrument (drums / bass / vocals / guitar / piano / other) |

### Where stems come from in separation mode
- **Automatic separation on a local server** (`js/separator.js` + `tools/server.py`): in separation mode, a loaded file (picked or dropped) is sent to a server on your own PC and split by Demucs (`htdemucs_6s`, six sources). Audio never leaves your machine. Playback is not delayed: it starts with band detection and switches to per-instrument analysis once separation finishes. Results are cached per content in `.stems-cache/`, so the same song is instant the second time.
  - Start: double-click `start.bat` (runs `tools/server.py` with the Python in `.venv` and opens `http://127.0.0.1:8765/`; the same server also serves the app).
  - Environment: Python 3.13, torch 2.6.0 (CUDA 12.4) and demucs 4.1.0 in `.venv`. To rebuild: `python -m venv .venv` → `.venv\Scripts\python -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124` → `.venv\Scripts\python -m pip install demucs numpy`.
  - If the server is not running, separation mode shows "cannot connect to the local server" and continues in normal mode.
  - The endpoint is `AV.SEPARATOR_API` in `config.js`. To use it from a page hosted elsewhere, start the server with `--origin https://your-public-url`.
- **Pre-separated stems**: if stems prepared by the author exist for the built-in audio (see below), they are used. If not found, separation falls back to the in-browser path.

### Pre-separated stems (for built-in audio)
Separate a song into instruments beforehand and ship the files with the site. Playback uses the original audio (`src`); the stems play in sync as **silent, analysis-only** tracks. Each instrument detects attacks on its own stem, so e.g. piano strums are not buried under other instruments.

1. Separate (once per song), after `pip install demucs`:
   `python tools/separate.py "song.mp3" --id mysong`
   → six mp3 files are written to `stems/mysong/` (Demucs `htdemucs_6s`, 128 kbps).
2. Set `dir` of `AV.BUILTIN_AUDIO.stems` in `js/config.js` to `stems/mysong/`.
3. Deploy the `stems/` folder with the site. (If you put it in a public repository, mind the rights to the audio, and adjust `stems/` and `*.mp3` in `.gitignore`.)

Switch the analysis mode with "通常 / 分離" (Normal / Separate) at the bottom of the screen, even during playback.
- Normal: always band detection.
- Separate: stem detection for built-in audio. For the microphone and loaded files it stays on band detection.
If stems are missing or fail to load, it falls back to band detection even in separation mode.
Tune each instrument's ink character (size, density, pitch range, pitch-to-position mapping) with `AV.STEM_CFG` in `config.js`.

## Input (band detection)
Reads the following from `AV.state` (updated by `audio.js`).

| Item | Meaning |
|---|---|
| `energy.bass / mid / high` | Loudness per band (0+) |
| `flux.bass / mid / high` | Spectral flux per band (strength of onsets) |
| `time` | Elapsed seconds |

Per-band behaviour is tuned with `AV.BAND_CFG` in `config.js`.

## Processing flow (`update()` is called every frame)

1. **Attack detection `detectAttack`**
   Compares each band's flux with 1.3× its own moving average and detects bands that rise suddenly. The moving average barely rises during an attack, so continuous sounds like strums are caught too. Only the strongest band fires, so a single piano note does not drop a drop for both its fundamental and its overtones. Nothing fires within `AV.ATTACK_GAP` (0.03 s) of the previous one.
2. **Drop `spawn`**
   One drop per attack. Radius and pigment amount scale with strength. Short sounds make small, quick-drying drops that barely spread.
3. **Sustained feed `updateFeeder`**
   While a note is held (energy at or above about 78% of its onset peak), a weak drop is added at the same position every frame (up to 9 s).
   - The radius grows up to about 6.5× with hold time.
   - What is fed is "coloured water": pigment decays exponentially with hold time while only water (wetness) keeps being supplied.
   - The shader also stops feeding pigment once the local pigment reaches about 0.2 (a cap).
   → Long notes become a **wide, pale bloom** rather than a dense core.
4. **Fallback `fallback`**
   Even without a clear attack, a drop is placed at regular intervals while the sound stays loud.
5. **Position choice `pickPosition`**
   Eight random candidates are generated and the one farthest from drops of the last 8 seconds is chosen. Drops do not cluster, and they avoid the edges and the area around the goniometer.
   On an attack, pitch (`AV.state.pitchX`: the frequency bin that rose most since the previous frame, mapped to 0–1 on a log axis from about 80 Hz to 5 kHz) sets the horizontal position and only the vertical position is random. Low notes land on the left, high notes on the right, so a strum becomes a bloom that flows sideways.

## Public API

| Function | Purpose |
|---|---|
| `update(canvasAspect)` | Call every frame during playback |
| `idle()` | Call every frame while stopped (releases the hold state) |
| `dropRandom(radius, pigment, wetness)` | One drop at a random position (e.g. when playback starts) |
| `take()` | Take the accumulated drops and empty the queue |
| `reset()` | Discard the queue and hold state (when clearing the canvas) |

## Drop data
`{ x, y, radius, pigment, wetness, seed, kind }`
- `kind`: 0 = single drop / 1 = sustained feed
- `seed`: per-drop shape random number (no two shapes are the same)
- The queue limit is `AV.MAX_DROPS` (6). It must match `u_drops[6]` in the shader. On overflow, sustained feeds take priority; otherwise the oldest is dropped.

## Tuning tips
- Wider / paler long notes: `grow` (coefficient 1.1, capped at 5 s) and `thin` (lower bound 0.07) in `updateFeeder`
- Sharper response: each band's `fluxMin` in `config.js` (smaller is more sensitive)
- Drop size / density: each band's `r0` / `p0`
