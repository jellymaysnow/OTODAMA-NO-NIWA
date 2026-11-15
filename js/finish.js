/* Finishing ritual: when a song ends the paper is left to dry, then the work is signed with a
   title / date column and a vermilion seal (落款). The painting can be saved as a PNG at any time.
   The signature lives on its own transparent canvas above the watercolor, so the simulation is untouched. */
window.AV = window.AV || {};

AV.finish = (() => {
  const SEAL_TEXT = ['音', '霊', '之', '庭'];     // read right column top->bottom, then left column
  const VERMILION = '#B3312B';
  const INK = 'rgba(38, 42, 50, 0.86)';
  const DRY_DELAY = 2600;                          // ms: let the last wet ink settle before signing

  let canvas = null, g = null, dpr = 1;
  let signed = null;                                // { title, date, seed } once the work is finished
  let anim = 0;                                     // 0..1 signing animation
  let animStart = 0, raf = 0, timer = 0;
  let captureCb = null;

  function setup() {
    canvas = document.getElementById('sealCanvas');
    g = canvas.getContext('2d');
    resize();
    window.addEventListener('resize', () => { resize(); draw(); });
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);    // same density as the watercolor canvas
    canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
    canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
  }

  // ---- kanji numerals for the date: 二〇二六年十一月十五日 ----
  const DIG = '〇一二三四五六七八九';
  const kanjiDigits = n => String(n).split('').map(d => DIG[+d]).join('');
  function kanjiNumber(n) {                         // 1..31
    if (n < 10) return DIG[n];
    const t = Math.floor(n / 10), o = n % 10;
    return (t > 1 ? DIG[t] : '') + '十' + (o ? DIG[o] : '');
  }
  function kanjiDate(d) {
    return `${kanjiDigits(d.getFullYear())}年${kanjiNumber(d.getMonth() + 1)}月${kanjiNumber(d.getDate())}日`;
  }

  // Small deterministic random so the seal keeps its texture between redraws
  function rng(seed) {
    let s = Math.floor(seed * 2 ** 31) || 1;
    return () => ((s = (s * 16807) % 2147483647) / 2147483647);
  }

  function verticalText(text, x, y, size, alpha) {
    g.save();
    g.globalAlpha = alpha;
    g.fillStyle = INK;
    g.font = `500 ${size}px "Shippori Mincho", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    let cy = y;
    for (const ch of text) {
      g.fillText(ch, x, cy);
      cy += size * 1.12;
    }
    g.restore();
    return cy;
  }

  function drawSeal(cx, cy, size, alpha, scale, seed) {
    const r = rng(seed);
    g.save();
    g.globalAlpha = alpha;
    g.translate(cx, cy);
    g.scale(scale, scale);
    g.rotate((r() - 0.5) * 0.06);                   // a hand-pressed seal is never perfectly straight

    // Slightly irregular square
    const h = size / 2;
    const j = () => (r() - 0.5) * size * 0.035;
    g.beginPath();
    g.moveTo(-h + j(), -h + j());
    g.lineTo(h + j(), -h + j());
    g.lineTo(h + j(), h + j());
    g.lineTo(-h + j(), h + j());
    g.closePath();
    g.fillStyle = VERMILION;
    g.fill();

    // 白文: the characters are cut out of the red, so the paper shows through
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000';
    g.font = `600 ${size * 0.4}px "Shippori Mincho", serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const q = size * 0.235;
    g.fillText(SEAL_TEXT[0], q, -q);
    g.fillText(SEAL_TEXT[1], q, q);
    g.fillText(SEAL_TEXT[2], -q, -q);
    g.fillText(SEAL_TEXT[3], -q, q);

    // Worn stamp texture: uneven ink pickup
    for (let i = 0; i < 260; i++) {
      const px = (r() - 0.5) * size, py = (r() - 0.5) * size;
      const rad = size * (0.004 + r() * 0.018);
      g.globalAlpha = alpha * (0.25 + r() * 0.6);
      g.beginPath();
      g.arc(px, py, rad, 0, Math.PI * 2);
      g.fill();
    }
    g.restore();
  }

  function draw() {
    if (!g) return;
    g.clearRect(0, 0, canvas.width, canvas.height);
    if (!signed) return;

    const W = canvas.width, H = canvas.height;
    const margin = Math.round(Math.min(W, H) * 0.06);
    const seal = Math.round(Math.max(40 * dpr, Math.min(W, H) * 0.06));
    const text = Math.round(seal * 0.27);

    const textAlpha = Math.min(1, anim / 0.5);
    const sealT = Math.max(0, Math.min(1, (anim - 0.45) / 0.55));
    const ease = 1 - Math.pow(1 - sealT, 3);

    // Column layout from the right edge: title, then the date to its left, seal under the title
    const colX = W - margin - seal / 2;
    const titleH = signed.title.length * text * 1.12;
    const dateH = signed.date.length * text * 0.9 * 1.12;
    const sealCy = H - margin - seal / 2;
    const topTitle = sealCy - seal / 2 - text * 0.8 - titleH;
    verticalText(signed.title, colX, topTitle, text, textAlpha);
    verticalText(signed.date, colX - text * 1.5, sealCy - seal / 2 - text * 0.8 - dateH, text * 0.9, textAlpha * 0.8);
    if (sealT > 0) drawSeal(colX, sealCy, seal, ease, 1.25 - 0.25 * ease, signed.seed);
  }

  function animate(now) {
    anim = Math.min(1, (now - animStart) / 1600);
    draw();
    if (anim < 1) raf = requestAnimationFrame(animate);
    else if (AV.recorder) AV.recorder.onSigned();         // a recording ends a moment after the seal
  }

  function titleOf() {
    const S = AV.state;
    const raw = S.mode === 'file' ? S.fileName.replace(/\.[^.]+$/, '')
      : S.mode === 'synth' && AV.BUILTIN_AUDIO ? AV.BUILTIN_AUDIO.name : '無題';
    return raw.length > 16 ? raw.slice(0, 16) + '…' : raw;
  }

  /** The song has ended: let the paper dry, then sign it */
  function complete() {
    clearTimeout(timer);
    const title = titleOf();
    timer = setTimeout(async () => {
      try { await document.fonts.load('600 20px "Shippori Mincho"'); } catch (e) {}
      signed = { title, date: kanjiDate(new Date()), seed: Math.random() };
      cancelAnimationFrame(raf);
      animStart = performance.now();
      raf = requestAnimationFrame(animate);
      if (AV.ui) AV.ui.onFinished();
    }, DRY_DELAY);
  }

  /** A new piece begins (playback started, paper cleared): remove the signature */
  function clear() {
    clearTimeout(timer);
    cancelAnimationFrame(raf);
    signed = null;
    anim = 0;
    draw();
  }

  /** Save the painting (with its signature, if signed) as a PNG */
  function save() {
    captureCb = (glCanvas) => {
      const out = document.createElement('canvas');
      out.width = glCanvas.width;
      out.height = glCanvas.height;
      const o = out.getContext('2d');
      o.drawImage(glCanvas, 0, 0);
      if (signed) o.drawImage(canvas, 0, 0, out.width, out.height);
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      const name = `${signed ? signed.title : '音霊の庭'}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.png`;
      out.toBlob(blob => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name.replace(/[\\/:*?"<>|]/g, '_');
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      }, 'image/png');
    };
  }

  /** Called by the main loop right after the watercolor frame is drawn (the WebGL buffer is valid only then) */
  function afterFrame(glCanvas) {
    if (!captureCb) return;
    const cb = captureCb;
    captureCb = null;
    cb(glCanvas);
  }

  return {
    init: setup, complete, clear, save, afterFrame,
    get isSigned() { return !!signed; }
  };
})();
