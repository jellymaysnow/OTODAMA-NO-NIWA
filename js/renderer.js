/* WebGL ping-pong simulation + display pass */
window.AV = window.AV || {};

AV.renderer = (() => {
  let canvas, gl;
  let simProgram, renderProgram, quadBuffer;
  let fboA, fboB;
  let simWidth = 512;
  let simHeight = 512;
  let clearRequested = false;
  const loc = { sim: {}, render: {} };

  function compile(type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error('Shader compile error:', gl.getShaderInfoLog(shader));
      return null;
    }
    return shader;
  }

  function createProgram(vs, fs) {
    const v = compile(gl.VERTEX_SHADER, vs);
    const f = compile(gl.FRAGMENT_SHADER, fs);
    if (!v || !f) return null;
    const prog = gl.createProgram();
    gl.attachShader(prog, v);
    gl.attachShader(prog, f);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.error('Program link error:', gl.getProgramInfoLog(prog));
      return null;
    }
    return prog;
  }

  function uniforms(prog, names) {
    const out = {};
    names.forEach(n => { out[n] = gl.getUniformLocation(prog, n); });
    return out;
  }

  function createFBO(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const half = gl.getExtension('OES_texture_half_float');
    gl.getExtension('OES_texture_half_float_linear');
    const type = half ? half.HALF_FLOAT_OES : gl.UNSIGNED_BYTE;
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, type, null);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { framebuffer: fb, texture: tex };
  }

  function destroyFBO(f) {
    if (!f) return;
    gl.deleteFramebuffer(f.framebuffer);
    gl.deleteTexture(f.texture);
  }

  function resize() {
    if (!gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(window.innerWidth * dpr));
    const h = Math.max(1, Math.floor(window.innerHeight * dpr));
    canvas.width = w;
    canvas.height = h;

    const maxSimDim = 640;
    const aspect = w / h;
    if (aspect >= 1) {
      simWidth = maxSimDim;
      simHeight = Math.max(64, Math.round(maxSimDim / aspect));
    } else {
      simHeight = maxSimDim;
      simWidth = Math.max(64, Math.round(maxSimDim * aspect));
    }
    destroyFBO(fboA);
    destroyFBO(fboB);
    fboA = createFBO(simWidth, simHeight);
    fboB = createFBO(simWidth, simHeight);
  }

  function init(canvasEl) {
    canvas = canvasEl;
    gl = canvas.getContext('webgl', { antialias: true, preserveDrawingBuffer: false });
    if (!gl) return false;

    simProgram = createProgram(AV.shaders.vertex, AV.shaders.sim);
    renderProgram = createProgram(AV.shaders.vertex, AV.shaders.render);
    if (!simProgram || !renderProgram) return false;

    loc.sim = uniforms(simProgram, ['u_prevState', 'u_texelSize', 'u_aspect', 'u_time', 'u_clear', 'u_drops', 'u_dropMeta']);
    loc.sim.a_position = gl.getAttribLocation(simProgram, 'a_position');
    loc.render = uniforms(renderProgram, ['u_state', 'u_resolution', 'u_simTexel', 'u_time', 'u_colWash', 'u_colMid', 'u_colDeep', 'u_lightCol']);
    loc.render.a_position = gl.getAttribLocation(renderProgram, 'a_position');

    quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    resize();
    window.addEventListener('resize', resize);
    return true;
  }

  function bindQuad(positionLoc) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
    gl.enableVertexAttribArray(positionLoc);
    gl.vertexAttribPointer(positionLoc, 2, gl.FLOAT, false, 0, 0);
  }

  /** drops: [{x,y,radius,pigment,wetness,seed,kind}], palette: {wash,mid,deep} */
  function frame(time, drops, palette) {
    if (!gl || !simProgram || !renderProgram || !fboA || !fboB) return;
    const aspect = canvas.width / Math.max(canvas.height, 1);

    // 1. simulation pass (fboA -> fboB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.framebuffer);
    gl.viewport(0, 0, simWidth, simHeight);
    gl.useProgram(simProgram);
    bindQuad(loc.sim.a_position);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fboA.texture);
    gl.uniform1i(loc.sim.u_prevState, 0);
    gl.uniform2f(loc.sim.u_texelSize, 1.0 / simWidth, 1.0 / simHeight);
    gl.uniform1f(loc.sim.u_aspect, aspect);
    gl.uniform1f(loc.sim.u_time, time);
    gl.uniform1f(loc.sim.u_clear, clearRequested ? 1.0 : 0.0);
    clearRequested = false;

    const n = AV.MAX_DROPS;
    const dropsArr = new Float32Array(n * 4);
    const metaArr = new Float32Array(n * 3);
    for (let i = 0; i < n && i < drops.length; i++) {
      const d = drops[i];
      dropsArr.set([d.x, d.y, d.radius, d.pigment], i * 4);
      metaArr.set([d.wetness, d.seed, d.kind], i * 3);
    }
    gl.uniform4fv(loc.sim.u_drops, dropsArr);
    gl.uniform3fv(loc.sim.u_dropMeta, metaArr);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const tmp = fboA; fboA = fboB; fboB = tmp;

    // 2. display pass
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(renderProgram);
    bindQuad(loc.render.a_position);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, fboA.texture);
    gl.uniform1i(loc.render.u_state, 0);
    gl.uniform2f(loc.render.u_resolution, canvas.width, canvas.height);
    gl.uniform2f(loc.render.u_simTexel, 1.0 / simWidth, 1.0 / simHeight);
    gl.uniform1f(loc.render.u_time, time);
    gl.uniform3fv(loc.render.u_colWash, palette.wash);
    gl.uniform3fv(loc.render.u_colMid, palette.mid);
    gl.uniform3fv(loc.render.u_colDeep, palette.deep);
    gl.uniform3fv(loc.render.u_lightCol, AV.LIGHT_COLOR);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  function clear() { clearRequested = true; }

  return { init, frame, clear };
})();
