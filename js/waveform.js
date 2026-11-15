/* Whole-file waveform with a playhead, shown beside the file name. Click to seek. */
window.AV = window.AV || {};

AV.wave = (() => {
  const W = 140, H = 26, BARS = 140;
  let canvas = null, g = null;
  let peaks = null;          // BARS values 0..1
  let key = '';              // identifies the decoded source (avoids re-decoding on restart)
  let token = 0;             // guards against out-of-order async decodes
  let lastPos = -1, lastRgb = '';

  function setup() {
    canvas = document.getElementById('waveCanvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    canvas.addEventListener('click', (e) => {
      const p = AV.audio.player;
      if (!peaks || !isFinite(p.duration)) return;
      const r = canvas.getBoundingClientRect();
      p.currentTime = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * p.duration;
    });
  }

  function compute(buffer) {
    const ch = buffer.numberOfChannels;
    const len = buffer.length;
    const out = new Float32Array(BARS);
    const step = len / BARS;
    for (let b = 0; b < BARS; b++) {
      const a = Math.floor(b * step), e = Math.min(len, Math.floor((b + 1) * step));
      const skip = Math.max(1, Math.floor((e - a) / 400));   // subsample long segments
      let m = 0;
      for (let c = 0; c < ch; c++) {
        const d = buffer.getChannelData(c);
        for (let i = a; i < e; i += skip) { const v = Math.abs(d[i]); if (v > m) m = v; }
      }
      out[b] = m;
    }
    let top = 0;
    for (let b = 0; b < BARS; b++) if (out[b] > top) top = out[b];
    if (top > 0) for (let b = 0; b < BARS; b++) out[b] /= top;
    return out;
  }

  async function decode(k, getBytes) {
    if (!canvas) setup();
    if (k === key && peaks) { show(); return; }
    key = k;
    peaks = null;
    AV.plan.reset();
    lastPos = -1;
    canvas.classList.add('hidden');
    const my = ++token;
    try {
      const bytes = await getBytes();
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      const buffer = await new Ctx(1, 1, 44100).decodeAudioData(bytes);
      if (my !== token) return;
      peaks = compute(buffer);
      show();
      AV.plan.analyse(buffer);                              // whole-song composition plan (energy curve, key)
    } catch (e) {
      peaks = null;          // e.g. file:// blocks fetch: just go without a waveform
    }
  }

  function show() { if (canvas) canvas.classList.remove('hidden'); }
  function hide() { token++; peaks = null; key = ''; AV.plan.reset(); if (canvas) canvas.classList.add('hidden'); }

  function loadUrl(url) { decode('url:' + url, () => fetch(url).then(r => r.arrayBuffer())); }
  function loadFile(file) { decode('file:' + file.name + file.size + file.lastModified, () => file.arrayBuffer()); }

  /** Call every frame: redraws only when the playhead or ink colour changed */
  function draw() {
    if (!peaks || !g) return;
    const p = AV.audio.player;
    const pos = p.duration > 0 ? p.currentTime / p.duration : 0;
    const c = AV.state.palette.mid;
    const rgb = `${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}`;
    if (Math.abs(pos - lastPos) < 0.0005 && rgb === lastRgb) return;
    lastPos = pos; lastRgb = rgb;

    g.clearRect(0, 0, W, H);
    const bw = W / BARS, mid = H / 2;
    for (let b = 0; b < BARS; b++) {
      const h = Math.max(1, peaks[b] * (H - 2));
      const played = (b + 0.5) / BARS <= pos;
      g.fillStyle = played ? `rgba(${rgb}, 0.9)` : 'rgba(30, 41, 59, 0.28)';
      g.fillRect(b * bw, mid - h / 2, Math.max(0.8, bw - 0.4), h);
    }
    const x = pos * W;
    g.fillStyle = `rgb(${rgb})`;
    g.fillRect(Math.min(W - 1, x), 0, 1.2, H);
  }

  return { loadUrl, loadFile, hide, draw };
})();
