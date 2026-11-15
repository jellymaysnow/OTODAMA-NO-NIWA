/* Shared constants and mutable app state. Classic scripts share the AV namespace. */
window.AV = window.AV || {};

// Single-pigment tonal scales on wet white paper
AV.PALETTES = {
  indigo: { name: '群青・藍', hex: '#1D6FA3', wash: [0.64, 0.85, 0.93], mid: [0.14, 0.45, 0.69], deep: [0.05, 0.13, 0.31] }
};

// Build a tonal scale (diluted wash -> body -> deep core) from any hex colour
AV.makePalette = (hex, name) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  const v = parseInt(m ? m[1] : '1D6FA3', 16);
  const mid = [(v >> 16 & 255) / 255, (v >> 8 & 255) / 255, (v & 255) / 255];
  const wash = mid.map(c => c + (1 - c) * 0.6);
  const deep = mid.map(c => c * 0.33);
  return { name, hex: '#' + (m ? m[1] : '1D6FA3'), wash, mid, deep };
};
AV.PALETTES.custom = AV.makePalette('#7A4FA3', '自由選択');

// Built-in sound: path to your audio file (relative to index.html). Set to null to use the generated tones.
//  stems (optional): instrument tracks separated beforehand with tools/separate.py. They are analysed
//  silently in sync with the main file, and every instrument drops its own ink. If they fail to load
//  (not generated yet), the mixed-signal detection is used instead.
AV.BUILTIN_AUDIO = {
  src: 'Project.wav',
  name: 'Project'
  // stems: { dir: 'stems/project/', ext: 'mp3', names: ['drums', 'bass', 'vocals', 'guitar', 'piano', 'other'] }
};

// Local separation server (tools/server.py). Separation mode uploads the chosen audio here to split it
// into instruments; nothing leaves this PC. Serve the page from the same server for the simplest setup.
AV.SEPARATOR_API = 'http://127.0.0.1:8765';

// Per-instrument ink behaviour for separated stems (same meaning as BAND_CFG, plus:)
//  fallbackFloor 9 = off: a separated instrument has reliable attacks, so no extra drops during held notes
//  floor     : stem energy below this counts as silence
//  gap       : minimum seconds between two drops of this instrument
//  pitch     : true = horizontal position follows the note's pitch
//  yRange    : [low, high] uv height this instrument may drop in (0 = bottom, 1 = top)
// fluxMin is relative to the stem alone, so it can be lower than the band values above.
AV.STEM_CFG = {
  drums:  { fluxMin: 0.10, floor: 0.04, gap: 0.04, fallbackFloor: 9, fallbackEvery: 9, r0: 0.030, p0: 0.40, wet: 0.45, feed: 0.004, pitch: false, yRange: null },
  bass:   { fluxMin: 0.05, floor: 0.04, gap: 0.05, fallbackFloor: 9, fallbackEvery: 1.2, r0: 0.062, p0: 0.40, wet: 0.80, feed: 0.016, pitch: true,  yRange: [0.05, 0.45] },
  vocals: { fluxMin: 0.05, floor: 0.04, gap: 0.08, fallbackFloor: 9, fallbackEvery: 1.0, r0: 0.045, p0: 0.30, wet: 0.80, feed: 0.014, pitch: true,  yRange: [0.45, 1.0] },
  guitar: { fluxMin: 0.04, floor: 0.04, gap: 0.03, fallbackFloor: 9, fallbackEvery: 1.0, r0: 0.032, p0: 0.30, wet: 0.70, feed: 0.010, pitch: true,  yRange: null },
  piano:  { fluxMin: 0.04, floor: 0.04, gap: 0.03, fallbackFloor: 9, fallbackEvery: 1.0, r0: 0.030, p0: 0.30, wet: 0.70, feed: 0.010, pitch: true,  yRange: null },
  other:  { fluxMin: 0.05, floor: 0.04, gap: 0.05, fallbackFloor: 9, fallbackEvery: 1.0, r0: 0.035, p0: 0.26, wet: 0.70, feed: 0.010, pitch: true,  yRange: null }
};

// Master ink strength for every drop (1 = the per-band / per-instrument p0 as written, lower = paler)
AV.INK_DENSITY = 0.75;

// Video recording: true = film the whole tab as shown (buttons and panels included; the browser asks to
// share this tab first), false = film only the painting and its seal (no prompt)
AV.RECORD_WITH_UI = true;

// Where this much ink (rough estimate, per 1/24 x 1/14 of the paper) has piled up, water is dropped
// there to open it out. Lower = water comes sooner.
AV.DENSE_LIMIT = 3.0;

// 光 (light): high, clear notes leave mica / gold-leaf flecks that twinkle on the paper
//  LIGHT_MIDI  : notes at or above this pitch carry light (76 = E5)
//  LIGHT_COLOR : fleck colour (pale gold). Pearl mica: [0.94, 0.96, 1.0]
AV.LIGHT_MIDI = 76;
AV.LIGHT_COLOR = [1.0, 0.86, 0.55];

// Where notes land: 'enso' = on a circle (pitch class on the circle of fifths, octave = distance from centre)
//                   'free' = horizontal by pitch, random height
AV.COMPOSITION = 'enso';

AV.ATTACK_GAP = 0.03; // seconds; one drop per note attack across all bands
AV.MAX_DROPS = 16; // must match u_drops[] size in the sim shader

// Per-band ink behaviour
//  fluxMin           : minimum spectral flux (sudden spectral growth) that counts as a note attack
//  fallbackFloor/Every : drop anyway when the band is loud for a while but has no clear attacks
//  r0 / p0 / wet    : first drop radius, pigment, wetness (low wet = a short note barely spreads)
//  feed             : pigment added per frame while the note is held (long note = long spread)
AV.BAND_CFG = {
  bass: { fluxMin: 0.100, fallbackFloor: 0.38, fallbackEvery: 0.9, r0: 0.060, p0: 0.36 * 2, wet: 0.78, feed: 0.016 },
  mid: { fluxMin: 0.060, fallbackFloor: 0.30, fallbackEvery: 0.8, r0: 0.038, p0: 0.26 * 2, wet: 0.66, feed: 0.012 },
  high: { fluxMin: 0.040, fallbackFloor: 0.24, fallbackEvery: 0.7, r0: 0.022, p0: 0.18 * 2, wet: 0.55, feed: 0.008 }
};

AV.state = {
  time: 0,
  paletteKey: 'indigo',
  palette: AV.PALETTES.indigo,
  sensitivity: 1.3,
  separation: { state: 'idle', pct: 0, msg: '' },   // in-browser separation progress (model | init | run | done | error)
  preparing: false,     // separation mode: waiting for the instruments to be separated before playback starts
  analysis: 'normal',   // 'normal' = mixed-signal bands | 'stem' = per-instrument (built-in sound with stems only)
  mode: 'synth',        // 'synth' | 'mic' | 'file'
  isPlaying: false,
  hasFile: false,
  fileName: '',
  energy: { bass: 0, mid: 0, high: 0, total: 0 },
  flux: { bass: 0, mid: 0, high: 0 }   // spectral flux per band (attack detector)
};

AV.lerp = (a, b, t) => a + (b - a) * t;
