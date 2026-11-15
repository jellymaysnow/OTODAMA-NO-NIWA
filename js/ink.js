/* Turns audio into ink drops: note onsets, sustained feeding, and where on the paper each note lands.
   Two input paths share the same drop logic:
   - bands: bass / mid / high of the mixed signal (microphone, files in normal mode)
   - stems: one voice per separated instrument (drums, bass, piano ...), each detected on its own
   Placement (AV.COMPOSITION):
   - 'enso': notes are placed on a circle - pitch class around it (circle of fifths, the song's key at the top),
             octave from the centre outwards. A finished song leaves its harmony as one ensō.
   - 'free': horizontal position follows the pitch, height is random (the earlier behaviour). */
window.AV = window.AV || {};

AV.ink = (() => {
  const newVoice = () => ({ fluxMean: 0, f1: 0, f2: 0, r1: 0, note1: null, last: 0, lastAttack: 0, feeder: null });
  const bands = { bass: newVoice(), mid: newVoice(), high: newVoice() };
  const stemVoices = {};
  const recentDrops = [];
  let queue = [];
  let aspect = 1;
  let lastAttack = 0;
  let notePrev = null;      // note seen on the previous frame (an onset fires one frame after its flux peak)

  function queueDrop(x, y, radius, pigment, wetness, seed, kind) {
    // A single NaN reaching the shader spreads through the whole sheet: never let one through
    if (![x, y, radius, pigment, wetness, seed].every(Number.isFinite)) return;
    if (queue.length >= AV.MAX_DROPS) {
      // Sacrifice a sustained feed first, then a tendril segment, otherwise the oldest drop
      let idx = queue.findIndex(d => d.kind === 1);
      if (idx < 0) idx = queue.findIndex(d => d.kind === 4);
      queue.splice(idx >= 0 ? idx : 0, 1);
    }
    queue.push({ x, y, radius, pigment, wetness, seed, kind });
    if (kind === 0 || kind === 2 || kind === 4) deposit(x, y, radius, pigment);
  }

  // ---- ink density map: a coarse estimate of how much ink each region of the paper holds ----
  // Used to notice where ink piles up too thickly, so water can be dropped there to open it out.
  const GW = 24, GH = 14;
  const density = new Float32Array(GW * GH);
  const densityCool = new Float32Array(GW * GH);
  const cellOf = (x, y) => Math.min(GH - 1, Math.max(0, Math.floor(y * GH))) * GW + Math.min(GW - 1, Math.max(0, Math.floor(x * GW)));
  function deposit(x, y, radius, pigment) {
    density[cellOf(x, y)] += pigment * Math.min(4, (radius / 0.03) ** 2);
  }

  // Goniometer area (plus a margin for the ink's own radius) in uv coordinates, or null if it isn't shown.
  // uv y runs bottom -> top, like the simulation texture.
  function scopeZone() {
    const box = document.getElementById('scopeBox');
    if (!box || getComputedStyle(box).display === 'none' || box.style.opacity === '0') return null;
    const r = box.getBoundingClientRect();
    const w = window.innerWidth, h = window.innerHeight, pad = 80;
    return {
      x0: (r.left - pad) / w, x1: (r.right + pad) / w,
      y0: 1 - (r.bottom + pad) / h, y1: 1 - (r.top - pad) / h
    };
  }

  // ---- placement --------------------------------------------------------------------------

  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Ensō: angle = pitch class on the circle of fifths (tonic at 12 o'clock, clockwise),
  // radius = octave (low notes near the centre, high notes on the rim). Uv y points up.
  function ensoCandidate(note) {
    let theta, m;
    if (note && Number.isFinite(note.midi)) {
      const rel = (((note.pc - AV.plan.tonic) % 12) + 12) % 12;
      const step = (rel * 7) % 12;                            // chromatic -> circle of fifths
      // Spread across almost the whole 1/12 sector, so a repeated note doesn't hit the same point
      theta = (step / 12) * TAU + (Math.random() - 0.5) * (TAU / 12) * 0.9;
      m = clamp((note.midi - 36) / 60, 0, 1);                 // C2 .. C7
    } else {
      theta = Math.random() * TAU;
      m = 0.5;
    }
    // The ring slowly widens over the song: the same note later in the piece lands on fresh paper,
    // and the finished ensō carries the passage of time as its thickness
    const p = songProgress();
    const r = 0.07 + m * 0.29 + (p - 0.5) * 0.08 + (Math.random() - 0.5) * 0.085;
    // On a wide screen the circle becomes an ellipse that uses the width, not just the height
    const stretch = Math.min(aspect, 1.5);
    return { x: 0.5 + (r * stretch * Math.sin(theta)) / aspect, y: 0.5 + r * Math.cos(theta) };
  }

  function songProgress() {
    const pl = AV.audio.player;
    return pl && pl.duration > 0 && Number.isFinite(pl.duration) ? clamp(pl.currentTime / pl.duration, 0, 1) : 0.5;
  }

  function freeCandidate(note, y0, y1, mx) {
    const px = note ? note.pitchX : null;
    const x = px == null
      ? mx + Math.random() * (1 - mx * 2)
      : mx + px * (1 - mx * 2) + (Math.random() - 0.5) * 0.05;
    return { x, y: y0 + Math.random() * (y1 - y0) };
  }

  // Best-candidate sampling: several candidates from the composition rule, the one farthest from
  // recent drops wins, so notes repeated in a row don't all pile onto one spot.
  function pickPosition(note, yRange) {
    const time = AV.state.time;
    const mx = 0.05, my = 0.06;
    const y0 = yRange ? Math.max(my, yRange[0]) : my;
    const y1 = yRange ? Math.min(1 - my, yRange[1]) : 1 - my;
    for (let i = recentDrops.length - 1; i >= 0; i--) {
      if (time - recentDrops[i].t > 8) recentDrops.splice(i, 1);
    }
    const enso = AV.COMPOSITION === 'enso';
    const blocked = scopeZone();
    let best = null;
    let bestScore = -1;
    for (let i = 0, tried = 0; i < 8 && tried < 40; tried++) {
      const c = enso ? ensoCandidate(note) : freeCandidate(note, y0, y1, mx);
      const x = clamp(c.x, mx, 1 - mx), y = clamp(c.y, my, 1 - my);
      // Keep ink off the goniometer so the meter stays readable
      if (blocked && x > blocked.x0 && x < blocked.x1 && y > blocked.y0 && y < blocked.y1) continue;
      i++;
      let minD = 1.5;
      for (const r of recentDrops) {
        const d = Math.hypot((x - r.x) * aspect, y - r.y);
        if (d < minD) minD = d;
      }
      const score = minD * (0.6 + Math.random() * 0.8);
      if (score > bestScore) { bestScore = score; best = { x, y }; }
    }
    if (!best) best = { x: 0.5, y: 0.5 };
    recentDrops.push({ x: best.x, y: best.y, t: time });
    return best;
  }

  // ---- whole-song plan -> how much ink -------------------------------------------------------

  // Climax = deepest ink, quiet passages = mostly water (they stay as open space on the paper)
  function planShape(wet) {
    if (!AV.plan.ready) return { depth: 1, wet };
    const e = AV.plan.energyAt(AV.audio.player.currentTime);
    if (e < 0.15) return { depth: 0.35, wet: Math.min(1, wet * 1.3) };
    return { depth: 0.55 + 0.8 * e, wet };
  }

  // ---- voice logic (shared by bands and stems) -------------------------------------------

  function spawn(v, cfg, e, strength, note, yRange) {
    const time = AV.state.time;
    v.last = time;
    // 重ね塗り: a phrase heard before is laid again over its earlier strokes
    const glazePos = note ? glazeTarget(note) : null;
    const pos = glazePos || pickPosition(note, yRange);
    if (note) logNote(note, pos);
    const seed = Math.random();
    const shape = planShape(cfg.wet);
    const radius = cfg.r0 * (0.75 + Math.random() * 0.5) * (0.85 + strength * 0.5);
    let pigment = cfg.p0 * (0.8 + Math.random() * 0.4) * (0.75 + strength * 0.5) * shape.depth;
    if (glazePos) { pigment *= 0.7; shape.wet *= 0.7; }      // a thin glaze over the first layer
    // 飛沫: a very strong attack, or a burst of quick notes, flicks a spray of fine droplets
    noteBurst(time);
    if (strength > 1.05 || burstCount(time) >= 3) splatter(pos, cfg, strength);
    // 光: a high, clear note is more light than ink - lighter pigment plus a scatter of mica / gold
    const bright = note && Number.isFinite(note.midi) && note.midi >= AV.LIGHT_MIDI;
    if (bright) {
      pigment *= 0.6;
      queueDrop(pos.x, pos.y, radius * 1.4, 0.45 + Math.min(strength, 1.2) * 0.35, 0, Math.random(), 5);
    }
    queueDrop(pos.x, pos.y, radius, Math.min(pigment * AV.INK_DENSITY, 0.85), shape.wet, seed, 0);
    v.feeder = { x: pos.x, y: pos.y, seed, peak: e, start: time, radius: cfg.r0 };
  }

  /** A bowed / sung note (cello, strings, voice): no attack to detect, so it is recognised when the
      sustained pitch moves to a new note. It enters softly - a feathered wash instead of a drop -
      and then behaves like any held note: it keeps feeding, sprouts tendrils, and leaves water when it ends. */
  function bowNote(v, cfg, e, note, yRange) {
    const time = AV.state.time;
    v.last = time;
    v.lastAttack = time;
    const glazePos = glazeTarget(note);
    const pos = glazePos || pickPosition(note, yRange);
    logNote(note, pos);
    const shape = planShape(1.0);
    const radius = cfg.r0 * (1.3 + Math.random() * 0.5);
    let pigment = cfg.p0 * 0.7 * (0.7 + Math.min(e, 1) * 0.5) * shape.depth;
    if (Number.isFinite(note.midi) && note.midi >= AV.LIGHT_MIDI) {
      pigment *= 0.6;
      queueDrop(pos.x, pos.y, radius * 1.3, 0.4, 0, Math.random(), 5);
    }
    queueDrop(pos.x, pos.y, radius, Math.min(pigment * AV.INK_DENSITY, 0.7), shape.wet, Math.random(), 2);
    v.feeder = { x: pos.x, y: pos.y, seed: Math.random(), peak: e, start: time, radius: cfg.r0 * 1.2 };
  }

  // ---- techniques ---------------------------------------------------------------------------
  // 芽生え  sprout : a held note grows tendrils outward, like roots / shoots creeping through wet paper
  // にじみ  bleed  : a soft, swelling entry (strings, pads) lays a wide feathered wash with no core
  // 水      water  : when a long note is released, clear water falls into the still-damp ink and
  //                  pushes it outward into a bloom with a darker frilled rim (back-run)

  const SPROUT_START = 0.5;      // s held before tendrils appear
  const SPROUT_SPEED = 0.045;    // uv per second at full level
  const SPROUT_MAX_LEN = 0.22;   // uv
  const SPROUT_MAX_TIPS = 5;
  const pendingWater = [];       // { t, x, y, r }

  function startTips(f) {
    // Grow away from the centre of the ensō, like shoots reaching outward
    const out = Math.atan2(f.y - 0.5, (f.x - 0.5) * aspect);
    const n = 2 + (Math.random() < 0.5 ? 1 : 0);
    f.tips = [];
    for (let i = 0; i < n; i++) {
      f.tips.push({ x: f.x, y: f.y, ang: out + (Math.random() - 0.5) * 1.8, len: 0, w: 1 });
    }
  }

  function growTips(f, cfg, level) {
    const step = SPROUT_SPEED * 0.016 * (0.4 + 0.6 * level);
    for (let i = f.tips.length - 1; i >= 0; i--) {
      const t = f.tips[i];
      t.ang += (Math.random() - 0.5) * 0.35;                 // wander
      t.x += (Math.cos(t.ang) * step) / aspect;
      t.y += Math.sin(t.ang) * step;
      t.len += step;
      const taper = 1 - t.len / SPROUT_MAX_LEN;
      if (taper <= 0 || t.x < 0.02 || t.x > 0.98 || t.y < 0.02 || t.y > 0.98) { f.tips.splice(i, 1); continue; }
      const radius = f.radius * 0.22 * t.w * (0.35 + 0.65 * taper);
      queueDrop(t.x, t.y, radius, cfg.feed * 0.9 * level * taper * AV.INK_DENSITY, 0.6, f.seed + i * 0.13, 4);
      // Occasionally fork: a thinner branch splits off
      if (f.tips.length < SPROUT_MAX_TIPS && Math.random() < 0.01) {
        f.tips.push({ x: t.x, y: t.y, ang: t.ang + (Math.random() < 0.5 ? -1 : 1) * (0.5 + Math.random() * 0.5), len: t.len, w: t.w * 0.7 });
      }
    }
  }

  function updateFeeder(v, cfg, e) {
    const time = AV.state.time;
    const f = v.feeder;
    if (!f) return;
    const held = time - f.start;
    if (held < 0.15) f.peak = Math.max(f.peak, e);
    if ((held > 0.3 && e < f.peak * 0.55) || held > 18) {   // a held note ends once it has really died down
      v.feeder = null;
      // A long note leaves a lingering tail: water falls into the damp ink -> bloom
      if (held > 0.8 && Math.random() < 0.6) {
        pendingWater.push({
          t: time + 0.25 + Math.random() * 0.5,
          x: f.x + ((Math.random() - 0.5) * f.radius) / aspect,
          y: f.y + (Math.random() - 0.5) * f.radius,
          r: f.radius * (1.3 + Math.random() * 0.6)
        });
      }
    } else if (held > 0.3) {
      // Held note: the wet area widens a little while the ink thins out (tinted water)...
      const level = Math.min(1, e / Math.max(f.peak, 0.05));
      const grow = 1 + Math.min(held - 0.3, 2) * 0.8;        // up to ~2.6x radius
      const tint = Math.exp(-(held - 0.3) * 0.5);
      queueDrop(f.x, f.y, f.radius * 0.55 * grow, cfg.feed * level * 0.35 * tint, 1.0, f.seed, 1);
      // ...and from SPROUT_START on it sprouts tendrils that keep growing as long as the note sounds
      if (held > SPROUT_START) {
        if (!f.tips) startTips(f);
        growTips(f, cfg, level);
      }
    }
  }

  /** Soft entry: energy swelling steadily without a sharp onset -> a wide, coreless wash */
  function swell(v, e) {
    v.eFast = AV.lerp(v.eFast || 0, e, 0.25);
    v.eSlow = AV.lerp(v.eSlow || 0, e, 0.03);
    return v.eFast - v.eSlow;
  }

  function bleed(v, cfg, e, note, yRange) {
    const time = AV.state.time;
    v.lastBleed = time;
    const pos = pickPosition(note, yRange);
    const shape = planShape(1.0);
    const pigment = cfg.p0 * 0.4 * (0.6 + Math.min(e, 1) * 0.6) * shape.depth * AV.INK_DENSITY;
    queueDrop(pos.x, pos.y, cfg.r0 * (2.6 + Math.random() * 1.2), Math.min(pigment, 0.5), 1.0, Math.random(), 2);
  }

  function maybeBleed(v, cfg, e, note, yRange) {
    const time = AV.state.time;
    const s = swell(v, e);
    if (s > 0.1 && e > 0.12 && time - v.lastAttack > 0.6 && time - (v.lastBleed || 0) > 1.6) {
      bleed(v, cfg, e, note, yRange);
    }
  }

  function flushWater() {
    const time = AV.state.time;
    for (let i = pendingWater.length - 1; i >= 0; i--) {
      const w = pendingWater[i];
      if (w.t > time) continue;
      pendingWater.splice(i, 1);
      queueDrop(w.x, w.y, w.r, 0, 1.0, Math.random(), 3);
    }
  }

  /** Onset = a local peak of the spectral flux that stands above the running average.
      Firing on the peak (one frame later, ~16 ms) gives exactly one drop per note, right on its attack,
      while the small wobble inside a held tone never forms such a peak. Returns the onset ratio or 0. */
  function onset(v, flux, cfg, audible) {
    const ratioNow = audible ? flux / (v.fluxMean * 1.3 + cfg.fluxMin) : 0;
    const peak = v.r1 > 1 && v.f1 >= flux && v.f1 > v.f2 ? v.r1 : 0;
    v.fluxMean = AV.lerp(v.fluxMean, flux, ratioNow > 1 ? 0.006 : 0.04);
    v.f2 = v.f1; v.f1 = flux; v.r1 = ratioNow;
    return peak;
  }

  // ---- stage 5 techniques -----------------------------------------------------------------
  // 飛沫 splatter : strong attacks / quick bursts flick a fan of fine, crisp droplets
  // 塩   salt     : a shimmering high texture (tremolo, sparkle) scatters salt on wet ink -> pale crystal stars
  // 重ね塗り glaze : a repeated phrase is painted again over its first strokes, deepening them
  // 拭き取り lift  : a fading passage lifts pigment with a damp brush, opening light areas
  // 水で広げる     : where ink has piled up too thickly, water is dropped to open it out

  const pendingSplat = [];       // droplets released over a few frames
  const burstTimes = [];
  let lastSplat = -9, lastSalt = -9, lastLift = -9, highHoldStart = -1;

  function noteBurst(time) {
    burstTimes.push(time);
    while (burstTimes.length && time - burstTimes[0] > 0.35) burstTimes.shift();
  }
  const burstCount = () => burstTimes.length;

  function splatter(pos, cfg, strength) {
    const time = AV.state.time;
    if (time - lastSplat < 1.2) return;
    lastSplat = time;
    const n = 8 + Math.floor(Math.random() * 7);
    const dir = Math.random() * TAU;                          // the flick goes one way: a fan, not a ring
    for (let i = 0; i < n; i++) {
      const ang = dir + (Math.random() - 0.5) * 1.6;
      const dist = 0.015 + Math.pow(Math.random(), 1.8) * 0.12 * (0.7 + strength * 0.4);
      pendingSplat.push({
        t: time + Math.random() * 0.05,
        x: pos.x + (Math.cos(ang) * dist) / aspect,
        y: pos.y + Math.sin(ang) * dist,
        r: cfg.r0 * (0.08 + Math.random() * 0.22),
        p: cfg.p0 * (0.6 + Math.random() * 0.5) * AV.INK_DENSITY
      });
    }
  }

  // Phrase memory for glazing: pitch classes in the order they were played, with where they landed
  const noteLog = [];
  function logNote(note, pos) {
    noteLog.push({ pc: note.pc, x: pos.x, y: pos.y });
    if (noteLog.length > 400) noteLog.shift();
  }
  function glazeTarget(note) {
    const n = noteLog.length;
    if (n < 10) return null;
    const a = noteLog[n - 2].pc, b = noteLog[n - 1].pc, c = note.pc;
    // Most recent earlier occurrence of the same three-note figure (not the one just played)
    for (let j = n - 6; j >= 2; j--) {
      if (noteLog[j].pc === c && noteLog[j - 1].pc === b && noteLog[j - 2].pc === a) {
        return {
          x: noteLog[j].x + ((Math.random() - 0.5) * 0.012) / aspect,
          y: noteLog[j].y + (Math.random() - 0.5) * 0.012
        };
      }
    }
    return null;
  }

  function recentWetSpot(maxAge) {
    const time = AV.state.time;
    for (let i = recentDrops.length - 1; i >= 0; i--) {
      if (time - recentDrops[i].t <= maxAge) return recentDrops[i];
    }
    return null;
  }

  function densestCell() {
    let best = -1, bestV = 0;
    for (let i = 0; i < density.length; i++) if (density[i] > bestV) { bestV = density[i]; best = i; }
    return best < 0 ? null : { i: best, v: bestV, x: (best % GW + 0.5) / GW, y: (Math.floor(best / GW) + 0.5) / GH };
  }

  /** Once per frame: release scheduled drops and run the texture-level techniques */
  function tick() {
    const time = AV.state.time;
    const { energy, flux } = AV.state;
    flushWater();

    // 飛沫: release the droplets (a few per frame, they read as one flick)
    for (let i = pendingSplat.length - 1, k = 0; i >= 0 && k < 6; i--) {
      if (pendingSplat[i].t > time) continue;
      const s = pendingSplat.splice(i, 1)[0];
      k++;
      queueDrop(s.x, s.y, s.r, s.p, 0.25, Math.random(), 0);
    }

    // 塩: high band shimmering for a while without clear attacks, over ink that is still wet
    if (energy.high > 0.3 && flux.high < 0.05) {
      if (highHoldStart < 0) highHoldStart = time;
    } else {
      highHoldStart = -1;
    }
    if (highHoldStart >= 0 && time - highHoldStart > 0.8 && time - lastSalt > 2.5) {
      const spot = recentWetSpot(1.5);
      if (spot) {
        lastSalt = time;
        queueDrop(spot.x, spot.y, 0.05 + Math.random() * 0.04, 1, 0, Math.random(), 6);
      }
    }

    // 拭き取り: a fading passage (decrescendo, or the song's final fade) lifts pigment
    const fading = swellVoice.eFast - swellVoice.eSlow < -0.06 && time - lastAttack > 1.0 && energy.total > 0.03;
    const pl = AV.audio.player;
    const finalFade = AV.plan.ready && pl.duration > 0 && pl.currentTime / pl.duration > 0.88 &&
      AV.plan.energyAt(pl.currentTime) < AV.plan.energyAt(Math.max(0, pl.currentTime - 3)) * 0.85;
    if ((fading || finalFade) && time - lastLift > 2.2) {
      const c = densestCell();
      const spot = c && c.v > 0.8 ? c : recentWetSpot(6);
      if (spot) {
        lastLift = time;
        queueDrop(spot.x + (Math.random() - 0.5) * 0.04, spot.y + (Math.random() - 0.5) * 0.04,
          0.05 + Math.random() * 0.03, 0.8, 0.5, Math.random(), 7);
        if (c && spot === c) density[c.i] *= 0.7;
      }
    }

    // 水で広げる: ink piled up too thickly in one place -> water opens it out (re-wets and spreads it)
    const c = densestCell();
    if (c && c.v > AV.DENSE_LIMIT && time > densityCool[c.i]) {
      densityCool[c.i] = time + 5;
      density[c.i] *= 0.5;
      for (let k = 0; k < 3; k++) {
        pendingWater.push({
          t: time + k * 0.18,
          x: c.x + ((Math.random() - 0.5) * 0.03) / aspect,
          y: c.y + (Math.random() - 0.5) * 0.03,
          r: 0.06 + Math.random() * 0.03
        });
      }
    }
  }

  // ---- mixed-signal path (bands) ---------------------------------------------------------

  /** Call once per frame while the mixed signal is analysed */
  function update(canvasAspect) {
    aspect = canvasAspect;
    const { time, flux, energy } = AV.state;
    // Only the band with the strongest onset fires, so one piano note = one drop
    // (its fundamental and harmonics don't each spawn their own)
    let best = null, bestRatio = 0;
    for (const name of Object.keys(bands)) {
      const r = onset(bands[name], flux[name], AV.BAND_CFG[name], true);
      if (r > bestRatio) { best = name; bestRatio = r; }
    }
    if (best && time - lastAttack > AV.ATTACK_GAP) {
      lastAttack = time;
      const strength = Math.min(1.2, energy[best] * 0.7 + Math.min(bestRatio, 3.5) * 0.15);
      spawn(bands[best], AV.BAND_CFG[best], energy[best], strength, notePrev);
    }
    // Soft entries are judged on the whole signal (one wash per swell, not one per band)
    swellVoice.lastAttack = lastAttack;
    maybeBleed(swellVoice, AV.BAND_CFG.mid, energy.total, notePrev);
    notePrev = AV.state.note || null;
    // Bowed / sung line moved to a new note without an attack (cello legato) -> soft note
    if (AV.state.toneSeq !== bowVoice.toneSeq) {
      bowVoice.toneSeq = AV.state.toneSeq;
      if (AV.state.tone && time - lastAttack > BOW_AFTER_ATTACK) {
        bowNote(bowVoice, AV.BAND_CFG.mid, energy.total, AV.state.tone);
      }
    }
    for (const name of Object.keys(bands)) updateFeeder(bands[name], AV.BAND_CFG[name], energy[name]);
    updateFeeder(bowVoice, AV.BAND_CFG.mid, energy.total);
    tick();
  }
  const swellVoice = newVoice();
  const bowVoice = newVoice();
  const BOW_AFTER_ATTACK = 0.4;   // s: a pitch change this soon after an attack is that attack's own note

  // ---- separated-stem path ---------------------------------------------------------------

  /** Call once per frame with AV.audio.stems: [{name, energy, flux, note}] (each analysed alone) */
  function updateStems(stems, canvasAspect) {
    aspect = canvasAspect;
    const time = AV.state.time;
    for (const st of stems) {
      const cfg = AV.STEM_CFG[st.name] || AV.STEM_CFG.other;
      const v = stemVoices[st.name] || (stemVoices[st.name] = newVoice());
      const audible = st.energy > cfg.floor;                 // ignore separation bleed during silence
      const r = onset(v, st.flux, cfg, audible);
      if (r > 0 && time - v.lastAttack > cfg.gap) {
        v.lastAttack = time;
        const strength = Math.min(1.2, st.energy * 0.7 + Math.min(r, 3.5) * 0.15);
        spawn(v, cfg, st.energy, strength, cfg.pitch ? v.note1 : null, cfg.yRange || null);
        lastAttack = time;
      }
      if (cfg.pitch && audible) maybeBleed(v, cfg, st.energy, v.note1, cfg.yRange || null);
      // Legato note change inside this instrument (no attack) -> soft note
      if (st.toneSeq !== v.toneSeq) {
        v.toneSeq = st.toneSeq;
        if (cfg.pitch && audible && st.tone && time - v.lastAttack > BOW_AFTER_ATTACK) {
          bowNote(v, cfg, st.energy, st.tone, cfg.yRange || null);
          lastAttack = time;
        }
      }
      v.note1 = st.note || null;
      updateFeeder(v, cfg, st.energy);
    }
    swell(swellVoice, AV.state.energy.total);                // fades are judged on the whole signal
    tick();
  }

  function clearVoices() {
    bowVoice.feeder = null;
    for (const k of Object.keys(bands)) bands[k].feeder = null;
    for (const k of Object.keys(stemVoices)) stemVoices[k].feeder = null;
  }

  /** Call once per frame when nothing is playing */
  function idle() {
    for (const v of [...Object.values(bands), ...Object.values(stemVoices), bowVoice]) {
      v.feeder = null;
      v.fluxMean = AV.lerp(v.fluxMean, 0, 0.1);
      v.f1 = v.f2 = v.r1 = 0;
    }
  }

  /** A single drop (used when playback starts) */
  function dropRandom(radius, pigment, wetness) {
    const pos = pickPosition(null);
    queueDrop(pos.x, pos.y, radius, pigment * AV.INK_DENSITY, wetness, Math.random(), 0);
  }

  /** Hand the queued drops to the renderer and reset */
  function take() {
    const out = queue;
    queue = [];
    return out;
  }

  function reset() {
    queue = [];
    pendingWater.length = 0;
    pendingSplat.length = 0;
    noteLog.length = 0;
    density.fill(0);
    densityCool.fill(0);
    clearVoices();
  }

  return { update, updateStems, idle, dropRandom, take, reset };
})();
