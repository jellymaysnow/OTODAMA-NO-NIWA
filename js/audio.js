/* Audio sources (built-in synth, microphone, file) and band analysis */
window.AV = window.AV || {};

AV.audio = (() => {
  const S = AV.state;
  const player = document.getElementById('htmlAudioPlayer');

  let ctx = null;
  let analyser = null;
  let freqData = null;
  let prevFreq = null;
  let anL = null;
  let anR = null;
  let micStream = null;
  let micNode = null;
  let fileNode = null;
  let synthNodes = null;
  let synthTimer = null;

  let pitchAn = null;
  let pitchData = null;
  let pitchPrev = null;

  let onChange = () => {};
  let notify = () => {};

  function ensureContext() {
    if (!ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctx = new Ctx();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2; // low: keeps note attacks sharp
      freqData = new Uint8Array(analyser.frequencyBinCount);
      prevFreq = new Uint8Array(analyser.frequencyBinCount);

      // Stereo tap for the goniometer: analyser -> splitter -> one analyser per channel
      const splitter = ctx.createChannelSplitter(2);
      anL = ctx.createAnalyser();
      anR = ctx.createAnalyser();
      anL.fftSize = anR.fftSize = 1024;
      analyser.connect(splitter);
      splitter.connect(anL, 0);
      splitter.connect(anR, 1);

      // Fine-resolution tap (~11 Hz per bin) used only to name the pitch of each new note
      pitchAn = ctx.createAnalyser();
      pitchAn.fftSize = 4096;
      pitchAn.smoothingTimeConstant = 0.2;
      pitchData = new Uint8Array(pitchAn.frequencyBinCount);
      pitchPrev = new Uint8Array(pitchAn.frequencyBinCount);
      analyser.connect(pitchAn);
    }
    if (ctx.state === 'suspended') ctx.resume();
  }

  // ---- pitch of the newest note -> horizontal position ----

  /** The note that just started: { midi, pc (0 = C .. 11 = B), raw (0 low .. 1 high, log ~60 Hz .. 4 kHz) } or null.
      Takes the LOWEST of the strongly rising bins: that is the note's fundamental. (The bin with the largest
      rise is nearly always a high harmonic.) The frequency is refined between bins by parabolic interpolation. */
  function noteOf(data, prev, fftSize) {
    const binHz = ctx.sampleRate / fftSize;
    const first = Math.max(2, Math.ceil(50 / binHz));
    const last = Math.min(data.length - 2, Math.floor(4000 / binHz));
    let max = 0;
    for (let i = first; i <= last; i++) { const d = data[i] - prev[i]; if (d > max) max = d; }
    if (max <= 8) return null;
    for (let i = first; i <= last; i++) {
      if (data[i] - prev[i] < max * 0.5) continue;
      let k = i;                                             // climb to the spectral peak of this partial
      while (k < last && data[k + 1] > data[k]) k++;
      const a = data[k - 1], b = data[k], c = data[k + 1];
      const den = a - 2 * b + c;
      // Parabolic refinement only on a real peak, and never more than half a bin
      // (an unbounded offset could give a negative frequency -> NaN -> the whole simulation turns to ink)
      const delta = b >= a && b >= c && den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
      const hz = (k + delta) * binHz;
      if (!(hz > 20)) return null;
      const midi = 69 + 12 * Math.log2(hz / 440);
      return {
        midi,
        pc: ((Math.round(midi) % 12) + 12) % 12,
        raw: Math.min(1, Math.max(0, Math.log2(hz / 60) / Math.log2(4000 / 60)))
      };
    }
    return null;
  }

  /** Steady-tone tracker for bowed / sung lines (cello, strings, voice) that have no sharp attack.
      Follows the strongest sustained pitch; when it settles on a NEW pitch class for ~0.15 s, that is a
      new note (legato change). An octave flip of the same pitch class counts as the same note. */
  function makeToneTracker() {
    let cand = -1, cnt = 0, cur = -1;
    return {
      seq: 0,
      note: null,
      update(data, fftSize) {
        const binHz = ctx.sampleRate / fftSize;
        const lo = Math.max(2, Math.floor(60 / binHz)), hi = Math.min(data.length - 2, Math.floor(2000 / binHz));
        let mx = 0;
        for (let i = lo; i <= hi; i++) if (data[i] > mx) mx = data[i];
        if (mx < 120) { cand = -1; cnt = 0; cur = -1; return; }      // silence: the next tone is a new note
        let i = lo;
        while (i < hi && data[i] < mx - 12) i++;                       // lowest strong peak = fundamental
        while (i < hi && data[i + 1] > data[i]) i++;
        const a = data[i - 1], b = data[i], c = data[i + 1], den = a - 2 * b + c;
        const delta = b >= a && b >= c && den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0;
        const hz = (i + delta) * binHz;
        if (!(hz > 20)) return;
        const midi = 69 + 12 * Math.log2(hz / 440);
        const m = Math.round(midi);
        if (m === cand) cnt++; else { cand = m; cnt = 1; }
        if (cnt !== 9) return;
        const samePc = cur >= 0 && ((m % 12) + 12) % 12 === ((cur % 12) + 12) % 12;
        cur = m;
        if (samePc) return;
        this.seq++;
        this.note = {
          midi, pc: ((m % 12) + 12) % 12,
          raw: Math.min(1, Math.max(0, Math.log2(hz / 60) / Math.log2(4000 / 60)))
        };
      }
    };
  }

  /** Histogram equalisation: spreads whatever pitch range the music uses evenly over the canvas width,
      so a song that lives in a narrow band still fills the whole paper. Higher notes still land further right. */
  function makePitchMap() {
    const BINS = 48;
    const c = new Float32Array(BINS).fill(0.25);              // flat prior: starts as the plain log mapping
    return {
      map(v) {
        const i = Math.min(BINS - 1, Math.floor(v * BINS));
        let below = 0, total = 0;
        for (let k = 0; k < BINS; k++) { c[k] *= 0.999; }     // slowly forget: follows the song as it changes
        c[i] += 1;
        for (let k = 0; k < BINS; k++) { total += c[k]; if (k < i) below += c[k]; }
        return (below + c[i] * 0.5) / total;
      }
    };
  }
  const legacyPitchMap = makePitchMap();
  let legacyTone = null;    // created with the audio context (needs its sample rate)

  // ---- separated stems: silent, analysis-only copies of each instrument, slaved to the main player ----
  let stems = [];
  let startToken = 0;       // invalidates pending stem loads when playback is stopped or restarted

  function disposeStems() {
    for (const st of stems) {
      try { st.el.pause(); st.node.disconnect(); st.an.disconnect(); } catch (e) {}
      st.el.removeAttribute('src');
      st.el.load();
    }
    stems = [];
  }

  function loadOneStem(url) {
    return new Promise(resolve => {
      const el = new Audio();
      el.crossOrigin = 'anonymous';
      el.preload = 'auto';
      const timer = setTimeout(() => resolve(el.readyState >= 2 ? el : null), 15000);
      el.addEventListener('canplay', () => { clearTimeout(timer); resolve(el); }, { once: true });
      el.addEventListener('error', () => { clearTimeout(timer); resolve(null); }, { once: true });
      el.src = url;
    });
  }

  /** Load whatever stems exist; join them to the running main player once they are ready.
      list: [{ name, url }] (pre-separated files or blob URLs from the in-browser separator) */
  async function attachStems(list, token) {
    const els = await Promise.all(list.map(s => loadOneStem(s.url)));
    if (token !== startToken) return true;                  // stopped / restarted meanwhile: nothing to do
    const loaded = [];
    els.forEach((el, i) => {
      if (!el) return;
      const node = ctx.createMediaElementSource(el);        // not routed to the speakers: silent
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0.2;
      node.connect(an);
      loaded.push({
        name: list[i].name, el, node, an,
        data: new Uint8Array(an.frequencyBinCount), prev: new Uint8Array(an.frequencyBinCount),
        energy: 0, flux: 0, pitchX: 0.5, note: null, pitchMap: makePitchMap()
      });
    });
    if (!loaded.length) return false;                       // none found: caller decides what to do
    loaded.forEach(st => { st.el.currentTime = player.currentTime; });
    stems = loaded;
    notify('stems');
    return true;
  }

  // What is currently loaded in the main player: { key, getBytes, preStems? } or null (mic / generated tones)
  let currentSource = null;
  let attachingToken = -1;  // playback (startToken) for which stems are already being prepared

  /** Per-instrument analysis is possible for anything played from the main player (not mic / generated tones) */
  function stemsSupported() {
    return !!currentSource || !!(AV.BUILTIN_AUDIO && AV.BUILTIN_AUDIO.src);
  }

  /** In 'stem' mode: attach instrument stems to the current source (pre-separated files, else separate in the browser).
      Playback never waits: the mixed-signal analysis runs until the stems are ready. */
  function ensureStems() {
    if (S.analysis !== 'stem' || stems.length || !currentSource) return;
    if (!S.isPlaying || (S.mode !== 'synth' && S.mode !== 'file')) return;
    const token = startToken;
    if (attachingToken === token) return;                    // already on its way for this playback
    attachingToken = token;
    const src = currentSource;
    const fail = () => { if (attachingToken === token) attachingToken = -1; };
    const separate = () => AV.separator.get(src)
      .then(list => { if (token === startToken) return attachStems(list, token); })
      .then(ok => { if (ok === false) fail(); })
      .catch(e => { fail(); if (e.message !== 'cancelled') notify('separation-error'); });
    if (src.preStems) {
      const p = src.preStems;
      attachStems(p.names.map(n => ({ name: n, url: p.dir + n + '.' + p.ext })), token).then(ok => {
        if (!ok) { notify('stems-missing'); separate(); }   // not generated yet: separate in the browser instead
      });
    } else {
      separate();
    }
  }

  /** Separation mode: get the stems ready BEFORE playback starts (resolves either way; failures fall back to normal) */
  async function prepareStems(token) {
    const src = currentSource;
    if (!src) return;
    attachingToken = token;                                  // keeps ensureStems from retrying a failed run
    try {
      let ok = false;
      if (src.preStems) {
        const p = src.preStems;
        ok = await attachStems(p.names.map(n => ({ name: n, url: p.dir + n + '.' + p.ext })), token);
        if (!ok && token === startToken) notify('stems-missing');
      }
      if (!ok && token === startToken) {
        const list = await AV.separator.get(src);
        if (token === startToken) await attachStems(list, token);
      }
    } catch (e) {
      if (e.message !== 'cancelled') notify('separation-error');
    }
  }

  /** Start the main player. In separation mode it waits until the instruments have been separated. */
  async function beginPlayback(mode, after) {
    S.mode = mode;
    S.isPlaying = false;
    const token = startToken;
    if (S.analysis === 'stem' && currentSource) {
      S.preparing = true;
      onChange();
      await prepareStems(token);
      if (token !== startToken) return;                      // stopped, or another source was chosen meanwhile
      S.preparing = false;
    }
    player.play().then(() => {
      S.isPlaying = true;
      onChange();
      notify('start');
      if (after) after();
      ensureStems();
    }).catch(() => notify('file-error'));
  }

  // ---- recording tap: the same mix that reaches the speakers, as a MediaStream ----
  let recDest = null;
  function audioStream() {
    ensureContext();
    if (!recDest) {
      recDest = ctx.createMediaStreamDestination();
      analyser.connect(recDest);
    }
    return recDest.stream;
  }

  /** Start the current piece again from the beginning (used when recording a whole song) */
  function restart() {
    if (S.hasFile && S.mode === 'file') {
      player.currentTime = 0;
      if (!S.isPlaying) toggleFile();
    } else {
      startSynth();
    }
  }

  function pauseStems() { stems.forEach(st => st.el.pause()); }

  /** Switch between 'normal' and 'stem' analysis, also while playing */
  function setAnalysis(mode) {
    S.analysis = mode;
    if (mode === 'normal') {
      const waiting = S.preparing;
      startToken++;                                          // cancel stems still loading
      attachingToken = -1;
      disposeStems();
      if (waiting) { S.preparing = false; beginPlayback(S.mode); }   // stop waiting: play right away
    } else {
      ensureStems();
    }
    onChange();
  }

  function syncStems() {
    for (const st of stems) {
      const el = st.el;
      if (player.paused) { if (!el.paused) el.pause(); continue; }
      if (el.paused) el.play().catch(() => {});
      if (Math.abs(el.currentTime - player.currentTime) > 0.06) el.currentTime = player.currentTime;   // keep drops on the beat
    }
  }

  function analyseStems() {
    const k = S.sensitivity;
    for (const st of stems) {
      st.an.getByteFrequencyData(st.data);
      let sum = 0, total = 0;
      for (let i = 1; i <= 300; i++) total += st.data[i];
      for (let i = 2; i <= 400; i++) {                       // ~40 Hz .. 8.6 kHz
        const d = st.data[i] - st.prev[i];
        if (d > 0) sum += d;
      }
      const nt = noteOf(st.data, st.prev, st.an.fftSize);
      if (nt) { nt.pitchX = st.pitchMap.map(nt.raw); st.note = nt; st.pitchX = nt.pitchX; }
      if (!st.toneTr) st.toneTr = makeToneTracker();
      st.toneTr.update(st.data, st.an.fftSize);
      if (st.toneTr.note && st.toneTr.note.pitchX == null) st.toneTr.note.pitchX = st.pitchMap.map(st.toneTr.note.raw);
      st.tone = st.toneTr.note;
      st.toneSeq = st.toneTr.seq;
      st.prev.set(st.data);
      st.flux = sum / 255 / 8 * k;
      st.energy = AV.lerp(st.energy, Math.min(1.5, total / 300 / 255 * 4 * k), 0.35);
    }
  }

  function stopAll() {
    startToken++;
    S.preparing = false;
    disposeStems();
    if (synthTimer) {
      clearInterval(synthTimer);
      synthTimer = null;
    }
    if (synthNodes) {
      const nodes = synthNodes;
      try {
        nodes.masterGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.15);
        setTimeout(() => nodes.oscs.forEach(o => { try { o.stop(); o.disconnect(); } catch (e) {} }), 300);
      } catch (e) {}
      synthNodes = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (micNode) {
      try { micNode.disconnect(); } catch (e) {}
      micNode = null;
    }
    if (!player.paused) player.pause();
    S.isPlaying = false;
    onChange();
  }

  // Built-in ambient soundscape: cello-like drone + water-drop pentatonic notes
  // Built-in sound = the audio file named in AV.BUILTIN_AUDIO (config.js).
  // Falls back to the generated soundscape below when none is set.
  function startSynth() {
    const src = AV.BUILTIN_AUDIO && AV.BUILTIN_AUDIO.src;
    if (!src) return startGeneratedSynth();
    ensureContext();
    stopAll();
    player.src = src;
    AV.wave.loadUrl(src);
    currentSource = {
      key: 'builtin:' + src,
      ext: src,
      getBytes: () => fetch(src).then(r => r.arrayBuffer()),
      preStems: AV.BUILTIN_AUDIO.stems || null            // already separated: no in-browser run needed
    };
    if (!fileNode) fileNode = ctx.createMediaElementSource(player);
    connectFile();
    beginPlayback('synth');
  }

  function startGeneratedSynth() {
    AV.wave.hide();
    currentSource = null;
    ensureContext();
    stopAll();
    S.mode = 'synth';

    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.001, now);
    masterGain.gain.exponentialRampToValueAtTime(0.32, now + 1.2);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1100, now);

    filter.connect(masterGain);
    masterGain.connect(analyser);
    analyser.connect(ctx.destination);

    const oscs = [];
    [65.41, 98.00].forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = idx === 0 ? 'triangle' : 'sine';
      osc.frequency.setValueAtTime(freq, now);
      g.gain.setValueAtTime(idx === 0 ? 0.36 : 0.22, now);
      osc.connect(g);
      g.connect(filter);
      osc.start(now);
      oscs.push(osc);
    });

    synthNodes = { masterGain, oscs, filter };
    S.isPlaying = true;
    onChange();
    notify('start');

    const scale = [130.81, 196.00, 261.63, 293.66, 329.63, 392.00, 440.00, 523.25, 659.25];
    const celloNotes = [65.41, 73.42, 82.41, 98.00];
    let step = 0;

    synthTimer = setInterval(() => {
      if (!ctx || !S.isPlaying) return;
      const t = ctx.currentTime;

      if (step % 4 === 0) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(celloNotes[(step / 4) % celloNotes.length], t);
        g.gain.setValueAtTime(0.001, t);
        g.gain.linearRampToValueAtTime(0.45, t + 0.18);
        g.gain.exponentialRampToValueAtTime(0.001, t + 2.4);
        osc.connect(g);
        g.connect(filter);
        osc.start(t);
        osc.stop(t + 2.5);
      }

      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(scale[Math.floor(Math.random() * scale.length)], t);
      g.gain.setValueAtTime(0.001, t);
      g.gain.linearRampToValueAtTime(0.28, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0008, t + 1.6);
      osc.connect(g);
      g.connect(masterGain);
      osc.start(t);
      osc.stop(t + 1.7);

      step++;
    }, 680);
  }

  async function startMic() {
    try {
      ensureContext();
      stopAll();
      AV.wave.hide();
      currentSource = null;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStream = stream;
      micNode = ctx.createMediaStreamSource(stream);
      try { analyser.disconnect(ctx.destination); } catch (e) {}
      micNode.connect(analyser);
      S.mode = 'mic';
      S.isPlaying = true;
      onChange();
      notify('start');
      notify('mic');
    } catch (err) {
      notify('mic-denied');
    }
  }

  function connectFile() {
    try { analyser.disconnect(ctx.destination); } catch (e) {}
    fileNode.connect(analyser);
    analyser.connect(ctx.destination);
  }

  function loadFile(file) {
    if (!file) return;
    ensureContext();
    stopAll();
    player.src = URL.createObjectURL(file);
    AV.wave.loadFile(file);
    currentSource = { key: 'file:' + file.name + file.size + file.lastModified, ext: file.name, getBytes: () => file.arrayBuffer(), preStems: null };
    if (!fileNode) fileNode = ctx.createMediaElementSource(player);
    connectFile();
    S.hasFile = true;
    S.fileName = file.name;
    beginPlayback('file', () => notify('file-loaded'));
  }

  function toggleFile() {
    if (!S.hasFile || !fileNode) return;
    if (S.mode === 'file' && S.isPlaying) {
      player.pause();
      pauseStems();
      S.isPlaying = false;
      onChange();
      return;
    }
    ensureContext();
    stopAll();
    connectFile();
    player.play().then(() => {
      S.mode = 'file';
      S.isPlaying = true;
      onChange();
      ensureStems();
    }).catch(() => notify('file-error'));
  }

  function stopFile() {
    if (!S.hasFile) return;
    player.pause();
    pauseStems();
    player.currentTime = 0;
    if (S.mode === 'file') S.isPlaying = false;
    onChange();
  }

  player.addEventListener('ended', () => {
    if (S.mode === 'file' || S.mode === 'synth') {
      S.isPlaying = false;
      pauseStems();
      onChange();
      notify('ended');                                       // the piece is complete
    }
  });

  /** Update S.energy from the analyser. Returns true while live audio is being analysed. */
  function analyse() {
    const e = S.energy;
    if (analyser && S.isPlaying && freqData) {
      analyser.getByteFrequencyData(freqData);
      let bass = 0, mid = 0, high = 0;
      for (let i = 1; i <= 7; i++) bass += freqData[i];     // ~40-300 Hz
      for (let i = 8; i <= 45; i++) mid += freqData[i];     // ~300 Hz - 2 kHz
      for (let i = 46; i <= 180; i++) high += freqData[i];  // ~2 - 8 kHz

      // Spectral flux: only the *increase* per bin since the last frame -> sharp note attacks
      const fl = S.flux;
      const flux = (a, b) => {
        let sum = 0;
        for (let i = a; i <= b; i++) {
          const d = freqData[i] - prevFreq[i];
          if (d > 0) sum += d;
        }
        return sum / ((b - a + 1) * 255) * S.sensitivity;
      };
      fl.bass = flux(1, 7);
      fl.mid = flux(8, 45);
      fl.high = flux(46, 180);
      pitchAn.getByteFrequencyData(pitchData);
      const nt = noteOf(pitchData, pitchPrev, pitchAn.fftSize);
      pitchPrev.set(pitchData);
      if (nt) { nt.pitchX = legacyPitchMap.map(nt.raw); S.note = nt; S.pitchX = nt.pitchX; }
      if (!legacyTone) legacyTone = makeToneTracker();
      legacyTone.update(pitchData, pitchAn.fftSize);
      if (legacyTone.note) {
        if (legacyTone.note.pitchX == null) legacyTone.note.pitchX = legacyPitchMap.map(legacyTone.note.raw);
        S.tone = legacyTone.note;
      }
      S.toneSeq = legacyTone.seq;
      prevFreq.set(freqData);
      if (stems.length) { syncStems(); analyseStems(); }
      const k = S.sensitivity / 255;
      e.bass = AV.lerp(e.bass, Math.min(1.5, bass / 7 * k), 0.35);
      e.mid = AV.lerp(e.mid, Math.min(1.5, mid / 38 * k), 0.35);
      e.high = AV.lerp(e.high, Math.min(1.5, high / 135 * k), 0.35);
    } else {
      e.bass = AV.lerp(e.bass, 0, 0.08);
      e.mid = AV.lerp(e.mid, 0, 0.08);
      e.high = AV.lerp(e.high, 0, 0.08);
      S.flux.bass = S.flux.mid = S.flux.high = 0;
      if (prevFreq) prevFreq.fill(0);
    }
    e.total = Math.min(1.0, e.bass * 0.45 + e.mid * 0.35 + e.high * 0.2);
    return !!(analyser && S.isPlaying && freqData);
  }

  /** Fill l/r (Float32Array(1024)) with the latest stereo samples. Returns false if unavailable. */
  function readStereo(l, r) {
    if (!anL || !S.isPlaying) return false;
    anL.getFloatTimeDomainData(l);
    anR.getFloatTimeDomainData(r);
    return true;
  }

  return {
    setAnalysis, stemsSupported, audioStream, restart, readStereo, startSynth, startMic, loadFile, toggleFile, stopFile, stopAll, analyse,
    setHandlers(handlers) { onChange = handlers.onChange; notify = handlers.notify; },
    get player() { return player; },
    /** Per-instrument analysis results while separated stems are playing, otherwise null */
    get stems() { return stems.length && S.isPlaying ? stems : null; }
  };
})();
