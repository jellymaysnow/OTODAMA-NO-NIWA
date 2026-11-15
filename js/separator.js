/* Instrument separation through the local server (tools/server.py, Demucs htdemucs_6s).
   The page uploads the chosen audio to this PC's server, polls its progress, and gets back one mp3 per
   instrument. Result: [{ name, url }] in the same shape as pre-separated stems, so audio.js treats both alike. */
window.AV = window.AV || {};

AV.separator = (() => {
  const SOURCES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];
  const NO_SERVER = 'ローカルサーバーに接続できません（python tools/server.py を起動してください）';

  let onChange = () => {};
  let job = null;                          // { key, promise, cancelled }
  let done = null;                         // { key, list } : the latest finished result

  const api = () => String(AV.SEPARATOR_API || '').replace(/\/$/, '');
  const sep = () => AV.state.separation;
  function report(state, pct, msg) {
    Object.assign(sep(), { state, pct, msg: msg || '' });
    onChange();
  }

  const extOf = (name) => { const m = /\.[A-Za-z0-9]{1,5}$/.exec(name || ''); return m ? m[0] : '.mp3'; };

  function upload(bytes, ext) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${api()}/separate?ext=${encodeURIComponent(ext)}`);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) report('upload', e.loaded / e.total); };
      xhr.onerror = () => reject(new Error(NO_SERVER));
      xhr.onload = () => {
        if (xhr.status !== 200) return reject(new Error('upload failed (' + xhr.status + ')'));
        try { resolve(JSON.parse(xhr.responseText).id); } catch (e) { reject(e); }
      };
      xhr.send(bytes);
    });
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function poll(j, id) {
    for (;;) {
      if (j.cancelled) throw new Error('cancelled');
      let s;
      try { s = await (await fetch(`${api()}/status/${id}`, { cache: 'no-store' })).json(); }
      catch (e) { throw new Error(NO_SERVER); }
      if (s.state === 'done') return;
      if (s.state === 'error') throw new Error(s.error || 'separation failed');
      report(s.state === 'queued' ? 'queued' : 'run', (s.pct || 0) / 100);
      await sleep(700);
    }
  }

  async function run(j, source) {
    report('upload', 0);
    const bytes = await source.getBytes();
    if (j.cancelled) throw new Error('cancelled');
    const id = await upload(bytes, extOf(source.ext));
    await poll(j, id);
    report('done', 1);
    return SOURCES.map(name => ({ name, url: `${api()}/stems/${id}/${name}.mp3` }));
  }

  /** source: { key, ext?, getBytes: () => Promise<ArrayBuffer> }. Same key twice = same job / cached result. */
  function get(source) {
    if (done && done.key === source.key) return Promise.resolve(done.list);
    if (job && job.key === source.key && !job.cancelled) return job.promise;
    if (job) job.cancelled = true;                         // another song was picked: stop waiting for the old one
    done = null;
    const j = { key: source.key, cancelled: false, promise: null };
    j.promise = run(j, source).then(list => {
      if (j.cancelled) throw new Error('cancelled');
      done = { key: j.key, list };
      return list;
    }).catch(e => {
      if (job === j) job = null;
      if (!e || e.message !== 'cancelled') {
        console.error('[separator] failed:', e);
        report('error', 0, String((e && e.message) || e));
      }
      throw e;
    });
    job = j;
    return j.promise;
  }

  return { get, setHandler(fn) { onChange = fn; } };
})();
