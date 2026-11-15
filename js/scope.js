/* Small polar-sample goniometer (stereo field) shown bottom-left, on a transparent background.
   Each sample pair (L, R) becomes a fine particle: x = side (L-R), y = |mid| (L+R), radius = level.
   Two stacked canvases: a static grid layer and a transparent particle layer that fades out. */
window.AV = window.AV || {};

AV.scope = (() => {
  const W = 230, H = 120;
  const AXIS_W = 30;                 // right strip: correlation meter (+1 / 0 / -1)
  const N = 1024;
  // Particle look: raise STRIDE for fewer dots, PARTICLE_SIZE (px) for coarser, FADE for shorter trails
  const STRIDE = 3;
  const PARTICLE_SIZE = 0.5;
  const PARTICLE_ALPHA = 0.5;
  const FADE = 0.3;
  const GRID = '30, 41, 59';         // slate: readable on the light paper

  let dyn = null;                    // particle layer context
  const L = new Float32Array(N);
  const R = new Float32Array(N);
  let peak = 0.1;
  let corr = 0;

  const geom = () => {
    const cx = (W - AXIS_W) / 2;
    const base = H - 8;
    return { cx, base, rad: Math.min(cx - 4, base - 8) };
  };

  function setup(canvas) {
    const dpr = Math.min(window.devicePixelRatio || 1, 4);
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    const g = canvas.getContext('2d');
    g.scale(dpr, dpr);
    return g;
  }

  function drawGrid(g) {
    const { cx, base, rad } = geom();
    g.lineWidth = 1;

    // Outer arc + baseline
    g.strokeStyle = `rgba(${GRID}, 0.50)`;
    g.beginPath();
    g.arc(cx, base, rad, Math.PI, 2 * Math.PI);
    g.moveTo(cx - rad, base); g.lineTo(cx + rad, base);
    g.stroke();

    // Inner ring + vertical centre + 45-degree L / R guides
    g.strokeStyle = `rgba(${GRID}, 0.26)`;
    g.beginPath();
    g.arc(cx, base, rad * 0.5, Math.PI, 2 * Math.PI);
    g.moveTo(cx, base); g.lineTo(cx, base - rad);
    for (const a of [Math.PI * 0.25, Math.PI * 0.75]) {
      g.moveTo(cx, base);
      g.lineTo(cx - Math.cos(a) * rad, base - Math.sin(a) * rad);
    }
    g.stroke();

    // L / R labels
    g.fillStyle = `rgba(${GRID}, 0.75)`;
    g.font = '600 9px Inter, sans-serif';
    g.textAlign = 'left';
    g.fillText('L', cx - rad + 2, base - 3);
    g.textAlign = 'right';
    g.fillText('R', cx + rad - 2, base - 3);

    // Correlation axis
    const ax = W - 8, top = 12, bot = H - 12;
    g.strokeStyle = `rgba(${GRID}, 0.50)`;
    g.beginPath();
    g.moveTo(ax + 0.5, top); g.lineTo(ax + 0.5, bot);
    for (const y of [top, (top + bot) / 2, bot]) { g.moveTo(ax - 3, y + 0.5); g.lineTo(ax + 4, y + 0.5); }
    g.stroke();
    g.fillStyle = `rgba(${GRID}, 0.80)`;
    g.textAlign = 'right';
    g.fillText('+1', W - 13, top + 3);
    g.fillText('0', W - 13, (top + bot) / 2 + 3);
    g.fillText('-1', W - 13, bot + 3);
  }

  function build() {
    dyn = setup(document.getElementById('scopeCanvas'));
    drawGrid(setup(document.getElementById('scopeGrid')));
  }

  function init() {
    build();
    // Browser zoom / moving to another display changes devicePixelRatio: rebuild at the new density
    window.addEventListener('resize', build);
  }

  function draw() {
    if (!dyn) return;
    const g = dyn;
    const { cx, base, rad } = geom();

    // Fade previous particles toward transparent (keeps the background see-through)
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = 'rgba(0, 0, 0, ' + FADE + ')';
    g.fillRect(0, 0, W, H);
    g.globalCompositeOperation = 'source-over';

    const live = AV.audio.readStereo(L, R);
    let sumLR = 0, sumLL = 0, sumRR = 0, framePeak = 0;

    // Ink colour for both particles and the correlation dot (mid tone reads well on paper)
    const c = AV.state.palette.mid;
    const rgb = `${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}`;

    if (live) {
      for (let i = 0; i < N; i++) {
        const a = Math.abs(L[i]), b = Math.abs(R[i]);
        if (a > framePeak) framePeak = a;
        if (b > framePeak) framePeak = b;
        sumLR += L[i] * R[i]; sumLL += L[i] * L[i]; sumRR += R[i] * R[i];
      }
      peak = Math.max(peak * 0.995, framePeak, 0.05);        // auto gain so quiet music still fills the scope
      const k = (rad * 0.95) / peak;

      // Sparse fine dust: every STRIDE-th sample, sub-pixel jitter
      g.fillStyle = `rgba(${rgb}, ${PARTICLE_ALPHA})`;
      for (let i = 0; i < N; i += STRIDE) {
        let x = (L[i] - R[i]) * 0.7071 * k;
        let y = Math.abs(L[i] + R[i]) * 0.7071 * k;
        const m = Math.hypot(x, y);
        if (m > rad) { x *= rad / m; y *= rad / m; }
        g.fillRect(cx + x + (Math.random() - 0.5) * 0.6, base - y + (Math.random() - 0.5) * 0.6, PARTICLE_SIZE, PARTICLE_SIZE);
      }
    }

    // Correlation dot (+1 mono ... -1 out of phase)
    const target = live && sumLL > 1e-9 && sumRR > 1e-9 ? sumLR / Math.sqrt(sumLL * sumRR) : 0;
    corr = AV.lerp(corr, target, 0.12);
    const top = 12, bot = H - 12;
    g.fillStyle = `rgb(${rgb})`;
    g.beginPath();
    g.arc(W - 7.5, (top + bot) / 2 - corr * (bot - top) / 2, 2.2, 0, Math.PI * 2);
    g.fill();
  }

  return { init, draw };
})();
