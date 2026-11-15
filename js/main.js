/* Entry point: init + main loop */
(() => {
  const S = AV.state;
  const canvas = document.getElementById('watercolorCanvas');

  function loop() {
    S.time += 0.016;

    const live = AV.audio.analyse();
    const aspect = canvas.width / Math.max(canvas.height, 1);
    const stems = live ? AV.audio.stems : null;
    if (stems) AV.ink.updateStems(stems, aspect);       // separated instruments: one voice each
    else if (live) AV.ink.update(aspect);               // mixed signal (mic, files without stems)
    else AV.ink.idle();
    AV.ui.updateHud();
    AV.scope.draw();
    AV.wave.draw();

    AV.renderer.frame(S.time, AV.ink.take(), S.palette);
    AV.finish.afterFrame(canvas);                       // PNG capture must happen right after drawing
    AV.recorder.afterFrame(canvas);                     // video frames too
    requestAnimationFrame(loop);
  }

  window.addEventListener('load', () => {
    AV.finish.init();
    AV.ui.init();
    AV.scope.init(document.getElementById('scopeCanvas'));
    if (!AV.renderer.init(canvas)) {
      AV.ui.showToast('WebGLに対応していない環境です');
      return;
    }
    loop();
  });
})();
