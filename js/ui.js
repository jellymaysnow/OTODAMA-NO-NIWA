/* DOM wiring: dock buttons, toast, HUD, drag & drop */
window.AV = window.AV || {};

AV.ui = (() => {
  const S = AV.state;
  const $ = id => document.getElementById(id);

  const welcomeOverlay = $('welcomeOverlay');
  const controlDock = $('controlDock');
  const synthBtn = $('synthBtn');
  const synthPlayIcon = $('synthPlayIcon');
  const synthBtnLabel = $('synthBtnLabel');
  const micBtn = $('micBtn');
  const uploadBtn = $('uploadBtn');
  const sourceStatusText = $('sourceStatusText');
  const fileTransport = $('fileTransport');
  const filePlayBtn = $('filePlayBtn');
  const filePlayIcon = $('filePlayIcon');
  const filePlayLabel = $('filePlayLabel');
  const fileStopBtn = $('fileStopBtn');
  const paletteBtns = document.querySelectorAll('.palette-btn');
  const analysisBtns = document.querySelectorAll('.analysis-btn');
  const vitalityOrb = $('vitalityOrb');
  const vitalityBar = $('vitalityBar');
  const vitalityLabel = $('vitalityLabel');
  const toastBox = $('toastBox');
  const toastMessage = $('toastMessage');
  const dropOverlay = $('dropOverlay');

  const PLAY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4"/></svg>';
  const PAUSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>';
  const IDLE_BG = 'rgba(15, 23, 42, 0.05)';
  const IDLE_FG = '#334155';

  let hudVisible = true;

  function showToast(msg) {
    toastMessage.textContent = msg;
    toastBox.style.opacity = '1';
    toastBox.style.transform = 'translate(-50%, 0)';
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toastBox.style.opacity = '0';
      toastBox.style.transform = 'translate(-50%, -8px)';
    }, 2600);
  }

  function setActive(btn, active) {
    btn.style.backgroundColor = active ? S.palette.hex : IDLE_BG;
    btn.style.color = active ? '#FFFFFF' : IDLE_FG;
  }

  function hideWelcome() {
    welcomeOverlay.style.opacity = '0';
    welcomeOverlay.style.pointerEvents = 'none';
  }

  function refresh() {
    const playing = S.isPlaying;
    const player = AV.audio.player;
    if (playing && AV.finish.isSigned) AV.finish.clear();   // painting goes on: the signature comes off

    synthBtn.style.backgroundColor = S.mode === 'synth' ? S.palette.hex : 'rgba(15, 23, 42, 0.06)';
    synthBtn.style.color = S.mode === 'synth' ? '#FFFFFF' : IDLE_FG;
    setActive(micBtn, S.mode === 'mic' && playing);
    setActive(uploadBtn, S.mode === 'file' && playing);

    // Analysis mode toggle
    analysisBtns.forEach(b => {
      const on = b.getAttribute('data-analysis') === S.analysis;
      b.style.backgroundColor = on ? S.palette.hex : 'transparent';
      b.style.color = on ? '#FFFFFF' : IDLE_FG;
    });

    // File transport
    fileTransport.classList.toggle('hidden', !S.hasFile);
    fileTransport.classList.toggle('flex', S.hasFile);
    const filePlaying = S.mode === 'file' && playing;
    filePlayIcon.innerHTML = filePlaying ? PAUSE_SVG : PLAY_SVG;
    filePlayLabel.textContent = filePlaying ? '一時停止' : '再生';
    setActive(filePlayBtn, filePlaying);

    synthPlayIcon.innerHTML = PLAY_SVG;
    synthBtnLabel.textContent = '内蔵サウンド';
    if (S.mode === 'synth' && playing) {
      synthPlayIcon.innerHTML = PAUSE_SVG;
      synthBtnLabel.textContent = '一時停止';
      sourceStatusText.textContent = AV.BUILTIN_AUDIO ? '再生中: ' + AV.BUILTIN_AUDIO.name : '演奏中: チェロと水滴の余韻';
    } else if (S.mode === 'mic' && playing) {
      sourceStatusText.textContent = '収音中: 周囲の音でインクが滴下';
    } else if (S.mode === 'file' && playing) {
      sourceStatusText.textContent = '再生中: ' + S.fileName;
    } else if (S.mode === 'file' && S.hasFile) {
      sourceStatusText.textContent = (player.currentTime > 0 ? '一時停止中: ' : '停止中: ') + S.fileName;
    } else {
      sourceStatusText.textContent = '待機中 — 音でインクが落ちます';
    }

    // In-browser separation progress goes in front of the name (the name is what gets truncated)
    const sp = S.separation;
    const busy = S.analysis === 'stem' && (S.mode === 'synth' || S.mode === 'file') && (playing || S.preparing);
    if (S.preparing) {
      const name = S.mode === 'file' ? S.fileName : (AV.BUILTIN_AUDIO ? AV.BUILTIN_AUDIO.name : '');
      sourceStatusText.textContent = name;
    }
    let prefix = '';
    if (busy && sp.state === 'upload') prefix = '送信中 ・ ';
    else if (busy && sp.state === 'queued') prefix = '分離待ち ・ ';
    else if (busy && sp.state === 'run') prefix = `分離中 ${Math.round(sp.pct * 100)}% ・ `;
    else if (S.preparing) prefix = '分離の準備中 ・ ';
    sourceStatusText.textContent = prefix + sourceStatusText.textContent;
    sourceStatusText.parentElement.title = sourceStatusText.textContent;
  }

  function updateHud() {
    const total = S.energy.total;
    vitalityBar.style.width = `${Math.max(8, Math.round(total * 100))}%`;
    vitalityBar.style.backgroundColor = S.palette.hex;
    vitalityOrb.style.backgroundColor = S.palette.hex;

    let label;
    if (!S.isPlaying && total < 0.05) label = '白紙';
    else if (total < 0.25) label = '静かな滲み';
    else if (total < 0.55) label = '花開く余韻';
    else label = '深い響き';
    if (vitalityLabel.textContent !== label) vitalityLabel.textContent = label;
  }

  function toggleHud() {
    hudVisible = !hudVisible;
    controlDock.style.opacity = hudVisible ? '1' : '0';
    controlDock.style.pointerEvents = hudVisible ? 'auto' : 'none';
    controlDock.style.transform = hudVisible ? 'translate(-50%, 0)' : 'translate(-50%, 24px)';
    $('scopeBox').style.opacity = hudVisible ? '1' : '0';
    document.querySelector('header').style.opacity = hudVisible ? '1' : '0';
  }

  /** The piece has been signed: step the UI aside so the painting is seen as a whole */
  function onFinished() {
    if (hudVisible) toggleHud();
    showToast('完成しました ― 右上のボタンで保存 / Hキーで操作パネル');
  }

  function init() {
    AV.audio.setHandlers({
      onChange: refresh,
      notify: (event) => {
        if (event === 'start') hideWelcome();
        if (event === 'ended') AV.finish.complete();
        if (event === 'stems') showToast('分離モード: 楽器ごとに解析します');
        if (event === 'stems-missing') showToast('分離済みデータがないため、ローカルサーバーで分離します');
        if (event === 'separation-error') showToast('分離に失敗しました: ' + String(S.separation.msg).slice(0, 60) + '（通常モードで続行）');
        if (event === 'mic')showToast('マイク入力を開始しました');
        if (event === 'mic-denied') showToast('マイクへのアクセスが許可されませんでした');
        if (event === 'file-loaded') showToast(`読込完了: ${S.fileName}`);
        if (event === 'file-error') showToast('音声ファイルの再生に失敗しました');
        if (event === 'start') AV.ink.dropRandom(0.06, 0.36, 0.8);
      }
    });

    AV.separator.setHandler(refresh);
    $('welcomeStartBtn').addEventListener('click', AV.audio.startSynth);

    synthBtn.addEventListener('click', () => {
      if (S.mode === 'synth' && S.isPlaying) AV.audio.stopAll();
      else AV.audio.startSynth();
    });
    micBtn.addEventListener('click', () => {
      if (S.mode === 'mic' && S.isPlaying) AV.audio.stopAll();
      else AV.audio.startMic();
    });
    uploadBtn.addEventListener('click', () => $('audioFileInput').click());
    $('audioFileInput').addEventListener('change', (e) => {
      if (e.target.files && e.target.files[0]) AV.audio.loadFile(e.target.files[0]);
    });
    filePlayBtn.addEventListener('click', AV.audio.toggleFile);
    fileStopBtn.addEventListener('click', AV.audio.stopFile);

    paletteBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-palette');
        if (!AV.PALETTES[key]) return;
        S.paletteKey = key;
        S.palette = AV.PALETTES[key];
        paletteBtns.forEach(b => {
          b.classList.remove('active', 'border-slate-900/25', 'bg-slate-900/10', 'shadow-sm', 'text-slate-900');
          b.classList.add('border-transparent', 'text-slate-600');
        });
        btn.classList.add('active', 'border-slate-900/25', 'bg-slate-900/10', 'shadow-sm', 'text-slate-900');
        btn.classList.remove('border-transparent', 'text-slate-600');
        refresh();
        showToast(`インク色を変更: ${S.palette.name}`);
      });
    });

    // Free colour choice: the picker rebuilds the "custom" tonal scale
    const customInput = $('customColorInput');
    $('customPaletteBtn').addEventListener('click', () => {
      try { customInput.showPicker(); } catch (e) { customInput.click(); }
    });
    customInput.addEventListener('input', () => {
      AV.PALETTES.custom = AV.makePalette(customInput.value, '自由選択');
      $('customSwatch').style.backgroundColor = customInput.value;
      S.paletteKey = 'custom';
      S.palette = AV.PALETTES.custom;
      refresh();
    });

    analysisBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.getAttribute('data-analysis');
        if (mode === S.analysis) return;
        AV.audio.setAnalysis(mode);
        if (mode === 'normal') showToast('通常モード: 音全体を帯域で解析');
        else if (S.isPlaying && S.mode === 'mic') showToast('マイクでは通常モードで解析します');
        else if (!['127.0.0.1', 'localhost'].includes(location.hostname)) showToast('分離モードはローカル限定です（tools/server.py の起動が必要）。接続できない場合は通常モードで続行します');
        else showToast('分離モード: 音声を楽器ごとに分離して解析（ローカルサーバーを使用）');
      });
    });

    $('sensitivitySlider').addEventListener('input', (e) => {
      S.sensitivity = parseFloat(e.target.value);
    });

    // Video recording: whole piece from the start, stops itself after the signature
    const recordDot = $('recordDot'), recordLabel = $('recordLabel');
    const refreshRecord = () => {
      const on = AV.recorder.active;
      recordDot.style.backgroundColor = on ? '#DC2626' : 'transparent';
      recordDot.style.borderColor = on ? '#DC2626' : '';
      recordDot.classList.toggle('animate-pulse', AV.recorder.recording);
      recordLabel.classList.toggle('hidden', !on);
      recordLabel.textContent = AV.recorder.recording ? '録画中' : '準備中';
    };
    AV.recorder.setHandler(refreshRecord);
    $('recordBtn').addEventListener('click', async () => {
      if (AV.recorder.active) { AV.recorder.stop(); return; }
      if (!(await AV.recorder.start())) return;
      showToast(S.mode === 'mic' ? '録画を開始しました（もう一度押すと停止）' : '最初から再生して録画します ― 完成すると自動で保存');
    });

    $('saveArtBtn').addEventListener('click', () => {
      AV.finish.save();
      showToast(AV.finish.isSigned ? '作品を保存しました' : '現在の絵を保存しました');
    });

    $('clearCanvasBtn').addEventListener('click', () => {
      AV.renderer.clear();
      AV.ink.reset();
      AV.finish.clear();
      showToast('キャンバスを白紙に戻しました');
    });

    $('toggleHudBtn').addEventListener('click', toggleHud);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'h' || e.key === 'H') toggleHud();
    });

    // Drag and drop audio file
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropOverlay.style.opacity = '1';
    });
    window.addEventListener('dragleave', (e) => {
      if (e.relatedTarget === null) dropOverlay.style.opacity = '0';
    });
    window.addEventListener('drop', (e) => {
      e.preventDefault();
      dropOverlay.style.opacity = '0';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        AV.audio.loadFile(e.dataTransfer.files[0]);
      }
    });

    refresh();
  }

  return { init, refresh, updateHud, showToast, onFinished };
})();
