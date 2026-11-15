/* Records the painting as a video with its sound.
   Pressing record clears the paper and plays the piece from the start; the recording runs while the song
   plays and stops by itself a moment after the finished work has been signed. The video holds only the
   painting and its signature (no UI): each frame the watercolor and the seal layer are composited onto a
   hidden canvas whose stream, together with the audio mix, goes into a MediaRecorder. */
window.AV = window.AV || {};

AV.recorder = (() => {
  const FPS = 60;
  const BITRATE = 16e6;                // ~16 Mbps: clean gradients in the washes
  const TAIL_MS = 2500;                // keep filming the signed work this long before stopping

  let armed = false;
  let rec = null, chunks = [], mime = '';
  let display = null;                  // tab capture stream when recording with the UI visible
  let comp = null, cg = null;
  let stopTimer = 0;
  let title = '';
  let onChange = () => {};

  function pickMime() {
    if (!window.MediaRecorder) return '';
    const candidates = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',          // MP4 (H.264 + AAC): plays everywhere
      'video/mp4',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm'
    ];
    return candidates.find(m => MediaRecorder.isTypeSupported(m)) || '';
  }

  function titleNow() {
    const S = AV.state;
    if (S.mode === 'file' && S.fileName) return S.fileName.replace(/\.[^.]+$/, '');
    if (S.mode === 'synth' && AV.BUILTIN_AUDIO) return AV.BUILTIN_AUDIO.name;
    return '音霊の庭';
  }

  /** Press record: clean paper, play from the top, start filming as soon as the sound starts.
      With AV.RECORD_WITH_UI the browser first asks to share this tab, so buttons and panels are filmed too. */
  async function start() {
    mime = pickMime();
    if (!mime) { AV.ui.showToast('このブラウザは録画に対応していません'); return false; }
    if (AV.RECORD_WITH_UI) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
        AV.ui.showToast('このブラウザは画面ごとの録画に対応していません');
        return false;
      }
      try {
        display = await navigator.mediaDevices.getDisplayMedia({
          video: { frameRate: FPS },
          audio: false,                                    // the sound comes straight from the mix instead
          preferCurrentTab: true,                          // Chrome / Edge: offer "this tab" directly
          selfBrowserSurface: 'include',
          surfaceSwitching: 'exclude'
        });
      } catch (e) {
        AV.ui.showToast('録画をキャンセルしました');
        return false;
      }
      // Sharing stopped from the browser's own bar -> finish the recording
      display.getVideoTracks()[0].addEventListener('ended', () => { if (rec || armed) stop(); });
    }
    armed = true;
    AV.renderer.clear();
    AV.ink.reset();
    AV.finish.clear();
    if (AV.state.mode !== 'mic') AV.audio.restart();     // the mic just records from now on
    onChange();
    return true;
  }

  function begin(glCanvas) {
    armed = false;
    title = titleNow();
    let stream;
    if (display) {
      // Whole tab as the browser shows it (UI included)
      stream = new MediaStream(display.getVideoTracks());
    } else {
      // Painting only: watercolor + seal composited each frame
      comp = document.createElement('canvas');
      comp.width = glCanvas.width & ~1;                   // even size for H.264
      comp.height = glCanvas.height & ~1;
      cg = comp.getContext('2d');
      stream = comp.captureStream(FPS);
    }
    AV.audio.audioStream().getAudioTracks().forEach(t => stream.addTrack(t));
    chunks = [];
    rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: BITRATE, audioBitsPerSecond: 192000 });
    rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onstop = save;
    rec.start(1000);
    onChange();
  }

  function save() {
    const blob = new Blob(chunks, { type: mime.split(';')[0] });
    chunks = [];
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const name = `${title}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name.replace(/[\\/:*?"<>|]/g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    AV.ui.showToast(`動画を保存しました（${ext.toUpperCase()}）`);
  }

  /** Stop now (button pressed again, or automatically after the signature) */
  function stop() {
    clearTimeout(stopTimer);
    armed = false;
    if (rec && rec.state !== 'inactive') rec.stop();
    rec = null;
    comp = cg = null;
    if (display) { display.getTracks().forEach(t => t.stop()); display = null; }
    onChange();
  }

  /** Called by the main loop right after the watercolor frame is drawn */
  function afterFrame(glCanvas) {
    if (!rec) {
      if (armed && AV.state.isPlaying && !AV.state.preparing) begin(glCanvas);
      else return;
    }
    if (!cg) return;                                       // tab capture: the browser films the page itself
    if (glCanvas.width !== comp.width + (glCanvas.width & 1) || glCanvas.height !== comp.height + (glCanvas.height & 1)) {
      // window resized mid-recording: keep the video size, scale the painting into it
      cg.drawImage(glCanvas, 0, 0, comp.width, comp.height);
    } else {
      cg.drawImage(glCanvas, 0, 0);
    }
    if (AV.finish.isSigned) cg.drawImage(document.getElementById('sealCanvas'), 0, 0, comp.width, comp.height);
  }

  /** The finished work has been signed: film it a little longer, then stop */
  function onSigned() {
    if (rec) { clearTimeout(stopTimer); stopTimer = setTimeout(stop, TAIL_MS); }
  }

  return {
    start, stop, afterFrame, onSigned,
    get active() { return armed || !!rec; },
    get recording() { return !!rec; },
    setHandler(fn) { onChange = fn; }
  };
})();
