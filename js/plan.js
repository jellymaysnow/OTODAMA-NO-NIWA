/* Whole-song pre-analysis: the painting is composed knowing the entire piece in advance.
   From the decoded file it derives
   - an energy curve over time (0 = quietest passage, 1 = the climax) -> how deep the ink goes, where to leave space
   - the key (tonic pitch class) -> the circle of fifths is rotated so the tonic sits at the top of the ensō
   Live input (microphone, generated tones) has no plan: everything falls back to neutral values. */
window.AV = window.AV || {};

AV.plan = (() => {
  const ENV_STEP = 0.25;             // seconds per energy sample
  const FFT = 4096;

  let plan = null;                   // { duration, env: Float32Array (0..1), tonic, mode }

  // ---- small radix-2 FFT (in place, re/im arrays) ----
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k, b = a + len / 2;
          const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  function mono(buffer) {
    const n = buffer.length, ch = buffer.numberOfChannels;
    const out = new Float32Array(n);
    for (let c = 0; c < ch; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < n; i++) out[i] += d[i] / ch;
    }
    return out;
  }

  function percentile(arr, p) {
    const s = Array.from(arr).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
  }

  // Loudness curve: RMS in dB per 0.25 s, normalised between the quiet floor and the peak, smoothed ~2 s
  function energyCurve(x, sr) {
    const step = Math.round(sr * ENV_STEP);
    const n = Math.max(1, Math.floor(x.length / step));
    const db = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      let s = 0;
      for (let i = f * step, e = i + step; i < e; i++) s += x[i] * x[i];
      db[f] = 10 * Math.log10(s / step + 1e-10);
    }
    const lo = percentile(db, 0.1), hi = percentile(db, 0.99);
    const raw = db.map(v => Math.min(1, Math.max(0, (v - lo) / Math.max(1e-3, hi - lo))));
    const env = new Float32Array(n);
    const w = 4;                                            // +-1 s window
    for (let f = 0; f < n; f++) {
      let s = 0, c = 0;
      for (let k = Math.max(0, f - w); k <= Math.min(n - 1, f + w); k++) { s += raw[k]; c++; }
      env[f] = s / c;
    }
    return env;
  }

  // Key: average chroma over the song, correlated with the Krumhansl-Kessler key profiles
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  function estimateKey(x, sr) {
    const chroma = new Float64Array(12);
    const hop = Math.round(sr * 0.5);
    const re = new Float64Array(FFT), im = new Float64Array(FFT);
    const binPc = new Int8Array(FFT / 2).fill(-1);
    for (let k = 1; k < FFT / 2; k++) {
      const f = k * sr / FFT;
      if (f >= 55 && f <= 2000) binPc[k] = ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12;
    }
    for (let s = 0; s + FFT <= x.length; s += hop) {
      for (let i = 0; i < FFT; i++) {
        re[i] = x[s + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FFT - 1)));
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k < FFT / 2; k++) {
        if (binPc[k] >= 0) chroma[binPc[k]] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      }
    }
    const corr = (a, b) => {
      const ma = a.reduce((p, v) => p + v, 0) / 12, mb = b.reduce((p, v) => p + v, 0) / 12;
      let num = 0, da = 0, dbb = 0;
      for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; dbb += (b[i] - mb) ** 2; }
      return num / Math.sqrt(da * dbb + 1e-12);
    };
    let best = { tonic: 0, mode: 'major', score: -2 };
    for (let t = 0; t < 12; t++) {
      const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + t) % 12]);
      const ma = corr(rot, MAJOR), mi = corr(rot, MINOR);
      if (ma > best.score) best = { tonic: t, mode: 'major', score: ma };
      if (mi > best.score) best = { tonic: t, mode: 'minor', score: mi };
    }
    return best;
  }

  /** Analyse a decoded AudioBuffer (called once per song by waveform.js) */
  function analyse(buffer) {
    try {
      const x = mono(buffer);
      const sr = buffer.sampleRate;
      const key = estimateKey(x, sr);
      plan = { duration: buffer.duration, env: energyCurve(x, sr), tonic: key.tonic, mode: key.mode };
      const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      console.info(`[plan] ${buffer.duration.toFixed(1)} s, key ${names[key.tonic]} ${key.mode}`);
    } catch (e) {
      plan = null;
    }
  }

  function reset() { plan = null; }

  /** Energy of the song at time t (0..1); 0.6 when there is no plan */
  function energyAt(t) {
    if (!plan) return 0.6;
    const f = Math.min(plan.env.length - 1, Math.max(0, t / ENV_STEP));
    const i = Math.floor(f), j = Math.min(plan.env.length - 1, i + 1);
    return plan.env[i] + (plan.env[j] - plan.env[i]) * (f - i);
  }

  return {
    analyse, reset, energyAt,
    get ready() { return !!plan; },
    get tonic() { return plan ? plan.tonic : 0; },
    get mode() { return plan ? plan.mode : 'major'; }
  };
})();
