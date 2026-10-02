import { state, uid, formatDuration, formatBytes, flash } from './state.js';
import { audioContext, drawContain, seekMedia, releaseAllClipVideos } from './playback.js';

let onReady = () => {};
let onInsert = () => {};

export function setMediaHooks({ ready, insert }) {
  if (ready) onReady = ready;
  if (insert) onInsert = insert;
}

function kindOf(file) {
  const t = (file.type || '').toLowerCase();
  const n = file.name.toLowerCase();
  if (t.startsWith('video/') || /\.(mp4|webm|mov|mkv|m4v|ogv)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/.test(n)) return 'audio';
  if (t.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif)$/.test(n)) return 'image';
  return null;
}

function waitMedia(el, event, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('timeout')); }, ms);
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('media')); };
    const cleanup = () => {
      clearTimeout(timer);
      el.removeEventListener(event, ok);
      el.removeEventListener('error', bad);
    };
    el.addEventListener(event, ok);
    el.addEventListener('error', bad);
  });
}

function codecMessage(name) {
  return `No se puede reproducir «${name}». El navegador no soporta ese códec.`;
}

function park(el) {
  let bin = document.getElementById('media-bin');
  if (!bin) {
    bin = document.createElement('div');
    bin.id = 'media-bin';
    document.body.appendChild(bin);
  }
  bin.appendChild(el);
}

export async function loadAsset(file, id = uid('asset')) {
  const type = kindOf(file);
  if (!type) throw new Error('tipo');
  return mountAsset({
    id,
    name: file.name,
    type,
    mime: file.type || (file.name.includes('.') ? file.name.split('.').pop().toUpperCase() : type),
    size: file.size,
    url: URL.createObjectURL(file),
    file,
    ownedUrl: true
  });
}

export async function loadFromRecord(rec) {
  if (rec.blob) {
    const mime = rec.mime && rec.mime.includes('/') ? rec.mime : (rec.blob.type || '');
    const file = new File([rec.blob], rec.name, { type: mime });
    return loadAsset(file, rec.id);
  }
  if (!rec.url) throw new Error('sin url');
  const type = rec.type || kindOf({ name: rec.name || '', type: rec.mime || '' });
  if (!type) throw new Error('tipo');
  return mountAsset({
    id: rec.id || uid('asset'),
    name: rec.name || 'asset',
    type,
    mime: rec.mime || type,
    size: 0,
    url: rec.url,
    file: null,
    ownedUrl: false
  });
}

async function mountAsset(source) {
  const { id, name, type, mime, size, url, file, ownedUrl } = source;
  const asset = {
    id,
    name,
    type,
    url,
    file,
    mime,
    size,
    duration: type === 'image' ? 5 : 0,
    width: 0,
    height: 0,
    element: null,
    audioEl: null,
    audioBuffer: null,
    mediaSource: null,
    elementGain: null,
    waveform: '',
    thumbnails: []
  };
  try {
    if (type === 'video') {
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('error', () => {
        asset.unreadable = true;
        if (state.mediaPool.includes(asset) && !asset.warned) {
          asset.warned = true;
          flash(codecMessage(asset.name), 'error');
        }
      });
      video.src = url;
      asset.element = video;
      park(video);
      await waitMedia(video, 'loadedmetadata', 20000);
      if (video.readyState < 2) {
        try { await waitMedia(video, 'loadeddata', 4000); } catch { /* frame may still arrive on seek */ }
      }
      asset.duration = video.duration || 0;
      asset.width = video.videoWidth || 0;
      asset.height = video.videoHeight || 0;
      if (!asset.duration) throw new Error(video.error ? codecMessage(name) : 'duración');
      try { await video.play(); video.pause(); video.currentTime = 0; } catch { /* el gesto de importar a veces no alcanza para el autoplay */ }
      asset.width = video.videoWidth || asset.width;
      asset.height = video.videoHeight || asset.height;
      if (video.error) {
        asset.unreadable = true;
        asset.warned = true;
        flash(codecMessage(name), 'error');
      }
    } else if (type === 'audio') {
      const audio = document.createElement('audio');
      audio.preload = 'auto';
      audio.src = url;
      await waitMedia(audio, 'loadedmetadata', 20000);
      asset.duration = audio.duration || 0;
      audio.removeAttribute('src');
      audio.load();
      if (!asset.duration) throw new Error('duración');
    } else {
      const img = new Image();
      img.src = url;
      asset.element = img;
      await waitMedia(img, 'load', 20000);
      asset.width = img.naturalWidth || 0;
      asset.height = img.naturalHeight || 0;
    }
    return asset;
  } catch (err) {
    if (ownedUrl) URL.revokeObjectURL(url);
    if (asset.element?.error) throw new Error(codecMessage(name));
    throw err;
  }
}

function drawWave(peaks) {
  const w = peaks.length;
  const h = 64;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const mid = h / 2;
  ctx.fillStyle = '#bbf7d0';
  for (let i = 0; i < w; i++) {
    const amp = Math.max(1, Math.abs(peaks[i].max - peaks[i].min) * mid);
    ctx.fillRect(i, mid - amp / 2, 1, amp);
  }
  return canvas.toDataURL('image/png');
}

function waveformFromBuffer(buffer) {
  const w = 480;
  const data = buffer.getChannelData(0);
  const step = Math.max(1, Math.floor(data.length / w));
  const hop = Math.max(1, Math.floor(step / 32));
  const peaks = [];
  for (let i = 0; i < w; i++) {
    let min = 1;
    let max = -1;
    const start = i * step;
    for (let j = 0; j < step; j += hop) {
      const v = data[start + j] || 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    peaks.push({ min, max });
  }
  return drawWave(peaks);
}

async function waveformFromElement(url, duration) {
  if (!duration || !isFinite(duration)) return '';
  const el = document.createElement('audio');
  el.preload = 'auto';
  el.src = url;
  park(el);
  try {
    await waitMedia(el, 'loadeddata', 8000);
    const ctx = audioContext();
    await ctx.resume();
    const src = ctx.createMediaElementSource(el);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const columns = 360;
    const peaks = Array.from({ length: columns }, () => ({ min: 0, max: 0 }));
    const buf = new Uint8Array(analyser.fftSize);
    const grab = (col) => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i += 8) {
        const v = Math.abs(buf[i] - 128) / 128;
        if (v > peak) peak = v;
      }
      if (peak > peaks[col].max) {
        peaks[col].max = peak;
        peaks[col].min = -peak;
      }
    };
    el.preservesPitch = false;
    el.playbackRate = 16;
    await el.play();
    // ponytail: if the file is longer than ~3 min, jump instead of playing it all. Real samples when decodeAudioData works.
    if (duration <= 16 * 12) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, (duration / 16) * 1000 + 800);
        const tick = () => {
          if (el.ended || el.currentTime >= duration - 0.05) {
            clearTimeout(timer);
            resolve();
            return;
          }
          grab(Math.min(columns - 1, Math.floor((el.currentTime / duration) * columns)));
          requestAnimationFrame(tick);
        };
        tick();
      });
    } else {
      const slice = duration / columns;
      for (let i = 0; i < columns; i++) {
        el.currentTime = i * slice;
        await new Promise((resolve) => {
          const done = () => { el.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
          const timer = setTimeout(done, 40);
          el.addEventListener('seeked', done);
        });
        await new Promise(r => setTimeout(r, 16));
        grab(i);
      }
    }
    try { el.pause(); } catch { /* already ended */ }
    src.disconnect();
    return drawWave(peaks);
  } catch {
    return '';
  } finally {
    el.removeAttribute('src');
    el.load();
    el.remove();
  }
}

async function decodeAudio(asset) {
  if (!state.mediaPool.includes(asset)) return;
  const ctx = audioContext();
  try {
    const raw = asset.file ? await asset.file.arrayBuffer() : await (await fetch(asset.url)).arrayBuffer();
    const copy = raw.slice(0);
    asset.audioBuffer = await ctx.decodeAudioData(copy);
    asset.waveform = waveformFromBuffer(asset.audioBuffer);
    if (asset.type === 'audio' && !asset.duration) asset.duration = asset.audioBuffer.duration;
  } catch {
    asset.audioBuffer = null;
    const el = document.createElement('audio');
    el.preload = 'auto';
    el.src = asset.url;
    asset.audioEl = el;
    park(el);
    asset.waveform = await waveformFromElement(asset.url, asset.duration);
  }
}

async function makeThumbs(asset) {
  if (!state.mediaPool.includes(asset) || asset.type !== 'video') return;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = asset.url;
  park(video);
  try {
    await waitMedia(video, 'loadeddata', 8000);
    try { await video.play(); video.pause(); } catch { /* seek still works after loadeddata */ }
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const ctx = canvas.getContext('2d');
    const thumbs = [];
    const count = 6;
    for (let i = 0; i < count; i++) {
      const t = Math.min(asset.duration * (i + 0.5) / count, Math.max(0, asset.duration - 0.05));
      await seekMedia(video, t, 800);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      try {
        if (drawContain(ctx, video, canvas.width, canvas.height)) {
          thumbs.push(canvas.toDataURL('image/jpeg', 0.7));
        }
      } catch { /* frame not ready */ }
    }
    if (state.mediaPool.includes(asset)) asset.thumbnails = thumbs;
  } catch (err) {
    console.warn('thumbnails', err);
  } finally {
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
}

function warm(asset) {
  const jobs = [];
  if (asset.type === 'video') jobs.push(makeThumbs(asset));
  if (asset.type === 'video' || asset.type === 'audio') jobs.push(decodeAudio(asset));
  Promise.allSettled(jobs).then(() => {
    renderMediaPool();
    onReady();
  });
}

export async function importFiles(fileList) {
  audioContext();
  const files = [...fileList];
  let added = 0;
  for (const file of files) {
    try {
      const asset = await loadAsset(file);
      state.mediaPool.push(asset);
      added++;
      renderMediaPool();
      warm(asset);
    } catch (err) {
      console.warn(err);
      flash(err.message && err.message.includes('soporta') ? err.message : `No se pudo leer ${file.name}`, 'error');
    }
  }
  if (added) {
    state.dirty = true;
    document.dispatchEvent(new CustomEvent('project-dirty'));
    flash(added === 1 ? '1 archivo importado' : `${added} archivos importados`);
  }
}

function dropAsset(asset, keep) {
  try { asset.mediaSource?.disconnect(); } catch { /* already gone */ }
  try { asset.elementGain?.disconnect(); } catch { /* already gone */ }
  asset.element?.pause?.();
  asset.audioEl?.pause?.();
  asset.element?.remove?.();
  asset.audioEl?.remove?.();
  if (asset.url && asset.url.startsWith('blob:') && !keep.has(asset.url)) URL.revokeObjectURL(asset.url);
}

async function urlAlive(url) {
  if (!url) return false;
  if (!url.startsWith('blob:')) return true;
  try {
    const res = await fetch(url);
    res.body?.cancel?.();
    return res.ok;
  } catch {
    return false;
  }
}

export async function openMedia(records) {
  audioContext();
  releaseAllClipVideos();
  const keep = new Set(records.map(rec => rec.url).filter(url => url && url.startsWith('blob:')));
  for (const asset of state.mediaPool) dropAsset(asset, keep);
  state.mediaPool = [];
  renderMediaPool();
  const missing = [];
  for (const rec of records) {
    try {
      if (!await urlAlive(rec.url)) throw new Error('url');
      const asset = await loadFromRecord(rec);
      state.mediaPool.push(asset);
      warm(asset);
    } catch (err) {
      if (err?.message !== 'url') console.warn(err);
      missing.push(rec);
    }
  }
  renderMediaPool();
  return missing;
}

export async function attachFiles(records, files) {
  const buckets = new Map();
  for (const file of files || []) {
    const key = file.name.toLowerCase();
    const list = buckets.get(key) || [];
    list.push(file);
    buckets.set(key, list);
  }
  const missing = [];
  for (const rec of records) {
    if (state.mediaPool.some(asset => asset.id === rec.id)) continue;
    const list = buckets.get((rec.name || '').toLowerCase());
    const file = list?.shift();
    if (!file) {
      missing.push(rec);
      continue;
    }
    try {
      const asset = await loadAsset(file, rec.id);
      state.mediaPool.push(asset);
      warm(asset);
    } catch (err) {
      console.warn(err);
      missing.push(rec);
    }
  }
  renderMediaPool();
  return missing;
}

export function removeAsset(id) {
  if (state.clips.some(clip => clip.assetId === id)) {
    flash('Ese archivo está en la línea de tiempo', 'error');
    return false;
  }
  const asset = state.mediaPool.find(item => item.id === id);
  if (!asset) return false;
  dropAsset(asset, new Set());
  state.mediaPool = state.mediaPool.filter(item => item.id !== id);
  state.dirty = true;
  document.dispatchEvent(new CustomEvent('project-dirty'));
  renderMediaPool();
  return true;
}

export function removeUnused() {
  const used = new Set(state.clips.map(clip => clip.assetId));
  const unused = state.mediaPool.filter(asset => !used.has(asset.id));
  if (!unused.length) {
    flash('No hay archivos sin usar');
    return;
  }
  for (const asset of unused) dropAsset(asset, new Set());
  state.mediaPool = state.mediaPool.filter(asset => used.has(asset.id));
  state.dirty = true;
  document.dispatchEvent(new CustomEvent('project-dirty'));
  renderMediaPool();
  flash(unused.length === 1 ? '1 archivo quitado' : `${unused.length} archivos quitados`);
}

export async function replacePool(records) {
  const missing = await openMedia(records);
  for (const rec of missing) flash(`No se pudo leer ${rec.name || 'un asset'}`, 'error');
}

const TYPE_LABEL = { video: 'Video', audio: 'Audio', image: 'Imagen', text: 'Texto' };

export function assetRows(asset, clip) {
  const rows = [
    ['Tipo', TYPE_LABEL[asset.type] || asset.type],
    ['Duración', formatDuration(asset.duration)],
    ['Tamaño', formatBytes(asset.size)],
    ['MIME', asset.mime || '—']
  ];
  if (asset.width && asset.height) rows.splice(2, 0, ['Resolución', `${asset.width}×${asset.height}`]);
  if (asset.audioBuffer) {
    rows.push(['Audio', `${asset.audioBuffer.numberOfChannels} ch · ${asset.audioBuffer.sampleRate} Hz`]);
  } else if (asset.audioEl) {
    rows.push(['Audio', 'reproducción nativa']);
  }
  if (clip) rows.push(['En timeline', `${formatDuration(clip.startTime)} · ${formatDuration(clip.duration)}`]);
  return rows;
}

function showTip(x, y, title, rows) {
  const tip = document.getElementById('media-tip');
  tip.replaceChildren();
  const name = document.createElement('div');
  name.className = 'tip-name';
  name.textContent = title;
  tip.appendChild(name);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'tip-row';
    const k = document.createElement('span');
    k.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    row.append(k, v);
    tip.appendChild(row);
  }
  tip.classList.remove('hidden');
  const left = Math.min(x + 14, window.innerWidth - tip.offsetWidth - 8);
  const top = Math.min(y + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = `${Math.max(8, left)}px`;
  tip.style.top = `${Math.max(8, top)}px`;
}

export function hideTip() {
  document.getElementById('media-tip')?.classList.add('hidden');
}

export function attachTip(el, getInfo) {
  el.addEventListener('mouseenter', (e) => {
    const info = getInfo();
    if (info) showTip(e.clientX, e.clientY, info.title, info.rows);
  });
  el.addEventListener('mousemove', (e) => {
    const tip = document.getElementById('media-tip');
    if (!tip || tip.classList.contains('hidden')) return;
    const left = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
    const top = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  });
  el.addEventListener('mouseleave', hideTip);
}

export function renderMediaPool() {
  const grid = document.getElementById('media-grid');
  const empty = document.getElementById('media-empty-msg');
  const count = document.getElementById('media-count');
  if (!grid) return;
  count.textContent = String(state.mediaPool.length);
  empty.classList.toggle('hidden', state.mediaPool.length > 0);
  grid.querySelectorAll('.media-item').forEach(el => el.remove());

  for (const asset of state.mediaPool) {
    const item = document.createElement('div');
    item.className = 'media-item bg-vegas-panelLight hover:border-cyan-400 border border-vegas-border rounded p-1.5 flex flex-col cursor-grab text-xs group relative';
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      hideTip();
      e.dataTransfer.setData('text/plain', JSON.stringify({ type: 'asset', assetId: asset.id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    item.addEventListener('dblclick', () => onInsert(asset.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'absolute top-1 left-1 z-10 w-4 h-4 rounded bg-black/70 text-slate-300 hover:text-red-400';
    del.title = 'Quitar del proyecto';
    del.innerHTML = '<i class="fa-solid fa-xmark text-[9px]"></i>';
    del.addEventListener('mousedown', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeAsset(asset.id);
    });
    item.appendChild(del);
    attachTip(item, () => ({ title: asset.name, rows: assetRows(asset) }));

    const thumb = document.createElement('div');
    thumb.className = 'h-16 bg-black rounded mb-1 overflow-hidden flex items-center justify-center relative';
    const src = asset.type === 'image' ? asset.url
      : asset.type === 'audio' ? asset.waveform
        : (asset.thumbnails[0] || '');
    if (src) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.className = asset.type === 'audio'
        ? 'w-full h-full object-fill'
        : 'w-full h-full object-contain';
      thumb.appendChild(img);
    } else {
      const icon = document.createElement('i');
      const glyph = asset.type === 'video' ? 'fa-video' : asset.type === 'audio' ? 'fa-music' : 'fa-image';
      icon.className = `fa-solid ${glyph} text-slate-500 text-xl`;
      thumb.appendChild(icon);
    }
    const badge = document.createElement('span');
    badge.className = 'absolute bottom-1 right-1 bg-black/70 text-[9px] font-mono px-1 rounded text-slate-300';
    badge.textContent = `${(asset.duration || 0).toFixed(1)}s`;
    thumb.appendChild(badge);

    const name = document.createElement('span');
    name.className = 'truncate font-medium text-slate-300 group-hover:text-cyan-400';
    name.textContent = asset.name;

    item.append(thumb, name);
    grid.appendChild(item);
  }
}

export function bindMediaDrop() {
  const zone = document.getElementById('tab-content-media');
  const grid = document.getElementById('media-grid');
  zone.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    grid.classList.add('ring-1', 'ring-cyan-400');
  });
  zone.addEventListener('dragleave', (e) => {
    if (!zone.contains(e.relatedTarget)) grid.classList.remove('ring-1', 'ring-cyan-400');
  });
  zone.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files?.length) return;
    e.preventDefault();
    grid.classList.remove('ring-1', 'ring-cyan-400');
    importFiles(e.dataTransfer.files);
  });
  document.addEventListener('dragover', (e) => {
    if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (![...e.dataTransfer.types].includes('Files')) return;
    e.preventDefault();
    if (zone.contains(e.target) || !e.dataTransfer.files?.length) return;
    importFiles(e.dataTransfer.files);
  });
}

export function poolRecords() {
  return state.mediaPool.map(asset => ({
    id: asset.id,
    name: asset.name,
    type: asset.type,
    mime: asset.mime,
    url: asset.url
  }));
}
