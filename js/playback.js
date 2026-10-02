import { state, assetById, formatTimecode, contentEnd, pushHistory } from './state.js';

let previewCanvas = null;
let previewCtx = null;
let audioCtx = null;
let masterGain = null;
let analyser = null;
let timeData = null;
let raf = 0;
let playAnchor = null;
let lastRaf = 0;
let sources = [];
let gains = [];
let gen = 0;
let held = false;
let scrubbing = false;
let onSpanGrow = () => {};
const clipVideos = new Map();

function parkEl(el) {
  let bin = document.getElementById('media-bin');
  if (!bin) {
    bin = document.createElement('div');
    bin.id = 'media-bin';
    document.body.appendChild(bin);
  }
  bin.appendChild(el);
}

export function videoFor(clip) {
  if (!clip || clip.type !== 'video') return null;
  const cached = clipVideos.get(clip.id);
  if (cached) return cached;
  const asset = assetById(clip.assetId);
  if (!asset?.url) return null;
  const el = document.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.src = asset.url;
  parkEl(el);
  clipVideos.set(clip.id, el);
  return el;
}

export function releaseClipVideo(id) {
  const el = clipVideos.get(id);
  if (!el) return;
  el.pause();
  el.removeAttribute('src');
  el.load();
  el.remove();
  clipVideos.delete(id);
}

export function releaseAllClipVideos() {
  for (const id of [...clipVideos.keys()]) releaseClipVideo(id);
}

export function sweepClipVideos() {
  const ids = new Set(state.clips.map(clip => clip.id));
  for (const id of [...clipVideos.keys()]) {
    if (!ids.has(id)) releaseClipVideo(id);
  }
}

export function pauseClipVideos() {
  for (const el of clipVideos.values()) el.pause();
}

export function setSpanListener(fn) {
  onSpanGrow = fn;
}

export function audioContext() {
  if (audioCtx) return audioCtx;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  masterGain = audioCtx.createGain();
  analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  timeData = new Uint8Array(analyser.fftSize);
  masterGain.connect(analyser);
  analyser.connect(audioCtx.destination);
  return audioCtx;
}

export function resizePreview() {
  if (!previewCanvas) return;
  previewCanvas.width = state.projectWidth;
  previewCanvas.height = state.projectHeight;
  previewCanvas.style.aspectRatio = `${state.projectWidth} / ${state.projectHeight}`;
  if (previewCtx) paint(previewCtx, previewCanvas.width, previewCanvas.height, state.currentTime);
  updateTimecode();
}

export function initPreview() {
  previewCanvas = document.getElementById('preview-canvas');
  previewCtx = previewCanvas.getContext('2d', { alpha: false });
  previewCtx.imageSmoothingQuality = 'high';
  resizePreview();
  bindTransform();
}

export function measureFps(video) {
  return new Promise((resolve) => {
    if (!video?.requestVideoFrameCallback) { resolve(0); return; }
    const origin = video.currentTime || 0;
    let frames = 0;
    let start = 0;
    let settled = false;
    const finish = (fps) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { video.pause(); video.currentTime = origin; } catch { /* el elemento puede haber fallado */ }
      resolve(fps);
    };
    const timer = setTimeout(() => finish(0), 1200);
    const onFrame = (_now, meta) => {
      if (!start) start = meta.mediaTime;
      frames++;
      const span = meta.mediaTime - start;
      if (frames >= 6 && span > 0.12) {
        const raw = (frames - 1) / span;
        const presets = [24, 25, 30, 50, 60];
        let best = Math.round(raw);
        let diff = Infinity;
        for (const preset of presets) {
          const d = Math.abs(preset - raw);
          if (d < diff) { diff = d; best = preset; }
        }
        finish(diff < 1.5 ? best : Math.max(1, Math.round(raw)));
        return;
      }
      video.requestVideoFrameCallback(onFrame);
    };
    video.muted = true;
    const pending = video.play();
    if (!pending?.then) { finish(0); return; }
    pending.then(() => video.requestVideoFrameCallback(onFrame)).catch(() => finish(0));
  });
}

export function holdPreview(on) {
  held = on;
  if (on) {
    gen++;
    if (state.isPlaying) stopPlaying({ paint: false });
  }
}

function frameRect(source, cw, ch, clip) {
  if (!source) return null;
  if (source instanceof HTMLImageElement && !source.complete) return null;
  const sw0 = source.videoWidth || source.naturalWidth || 0;
  const sh0 = source.videoHeight || source.naturalHeight || 0;
  if (!sw0 || !sh0) return null;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return null;
  const cl = clip?.cropL || 0;
  const cr = clip?.cropR || 0;
  const ct = clip?.cropT || 0;
  const cb = clip?.cropB || 0;
  const sw = sw0 * (1 - cl - cr);
  const sh = sh0 * (1 - ct - cb);
  if (sw < 2 || sh < 2) return null;
  const fit = Math.min(cw / sw, ch / sh) * (clip?.scale ?? 1);
  const dw = sw * fit;
  const dh = sh * fit;
  return {
    sx: sw0 * cl,
    sy: sh0 * ct,
    sw,
    sh,
    dx: (cw - dw) / 2 + (clip?.x || 0),
    dy: (ch - dh) / 2 + (clip?.y || 0),
    dw,
    dh
  };
}

export function drawContain(ctx, source, cw, ch, clip) {
  const rect = frameRect(source, cw, ch, clip);
  if (!rect) return false;
  ctx.drawImage(source, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
  return true;
}

export function seekMedia(el, time, timeout = 800) {
  return new Promise((resolve) => {
    if (!el) { resolve(); return; }
    const t = clampMediaTime(el, time);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      el.removeEventListener('seeked', onSeeked);
      clearTimeout(timer);
      resolve();
    };
    const onSeeked = () => {
      if (el.readyState >= 2) finish();
    };
    const timer = setTimeout(finish, timeout);
    if (el.readyState >= 2 && Math.abs((el.currentTime || 0) - t) < 0.03) {
      finish();
      return;
    }
    el.addEventListener('seeked', onSeeked);
    const assign = () => {
      try { el.currentTime = t; } catch { finish(); }
    };
    // Setting currentTime to the value it already has does not fire `seeked`.
    if (el.readyState < 2 && Math.abs((el.currentTime || 0) - t) < 0.03 && el.play) {
      const pending = el.play();
      if (pending && typeof pending.then === 'function') {
        pending.then(() => {
          el.pause();
          if (!done && el.readyState >= 2) finish();
          else if (!done) assign();
        }).catch(() => { if (!done) assign(); });
        return;
      }
    }
    assign();
  });
}

function clampMediaTime(el, time) {
  const d = el.duration;
  const t = Math.max(0, time || 0);
  if (!isFinite(d) || d <= 0.05) return t;
  return Math.min(t, d - 0.04);
}

function sourceTime(clip, time) {
  return (clip.startOffset || 0) + (time - clip.startTime);
}

function fadeMul(clip, local) {
  let m = 1;
  if (clip.fadeIn > 0 && local < clip.fadeIn) m *= local / clip.fadeIn;
  if (clip.fadeOut > 0 && clip.duration - local < clip.fadeOut) {
    m *= Math.max(0, (clip.duration - local) / clip.fadeOut);
  }
  return m;
}

function crossMul(clip, time) {
  let mul = 1;
  const end = clip.startTime + clip.duration;
  for (const other of state.clips) {
    if (other === clip || other.trackId !== clip.trackId) continue;
    if ((other.type === 'audio') !== (clip.type === 'audio')) continue;
    const otherEnd = other.startTime + other.duration;
    const from = Math.max(clip.startTime, other.startTime);
    const to = Math.min(end, otherEnd);
    if (to - from < 0.03 || time < from || time >= to) continue;
    const p = (time - from) / (to - from);
    const outgoing = clip.startTime < other.startTime || (clip.startTime === other.startTime && clip.id < other.id);
    mul *= outgoing ? (1 - p) : p;
  }
  return mul;
}

function gainFor(clip, time) {
  const track = state.tracks.find(t => t.id === clip.trackId);
  if (!track || track.muted || clip.muteAudio) return 0;
  const local = time - clip.startTime;
  if (local < 0 || local >= clip.duration) return 0;
  return (clip.volume ?? 1) * fadeMul(clip, local) * crossMul(clip, time);
}

export function clipGain(clip, time) {
  return gainFor(clip, time);
}

export function visualClipsAt(time) {
  const out = [];
  for (let i = state.tracks.length - 1; i >= 0; i--) {
    const track = state.tracks[i];
    if (track.type === 'audio' || track.hidden) continue;
    const clips = state.clips
      .filter(c => c.trackId === track.id && c.type !== 'audio' && time >= c.startTime && time < c.startTime + c.duration)
      .sort((a, b) => a.startTime - b.startTime || (a.id < b.id ? -1 : 1));
    out.push(...clips);
  }
  return out;
}

function drawUnsupported(ctx, w, h, name) {
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `bold ${Math.round(h / 22)}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('Unsupported codec', w / 2, h / 2 - h / 18);
  ctx.font = `${Math.round(h / 32)}px Inter, sans-serif`;
  ctx.fillStyle = '#94a3b8';
  const label = name.length > 60 ? `${name.slice(0, 57)}…` : name;
  ctx.fillText(label, w / 2, h / 2 + h / 16);
}

function paintClip(ctx, w, h, clip, time) {
  const local = time - clip.startTime;
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, (clip.opacity ?? 1) * fadeMul(clip, local) * crossMul(clip, time)));
  if (clip.type === 'text') {
    const size = clip.fontSize || Math.round(h / 15);
    const x = w / 2 + (clip.x || 0);
    const y = h / 2 + (clip.y || 0);
    ctx.fillStyle = clip.textColor || clip.color || '#00d2ff';
    ctx.font = `bold ${size}px ${clip.fontFamily || 'Inter, sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    const label = clip.text || clip.name || '';
    if (clip.strokeWidth > 0) {
      ctx.lineWidth = clip.strokeWidth;
      ctx.strokeStyle = clip.strokeColor || '#000000';
      ctx.strokeText(label, x, y);
    }
    ctx.fillText(label, x, y);
  } else if (clip.type === 'video') {
    const el = videoFor(clip);
    const asset = assetById(clip.assetId);
    if (asset?.unreadable || el?.error || asset?.element?.error) drawUnsupported(ctx, w, h, asset?.name || clip.name);
    else if (el) drawContain(ctx, el, w, h, clip);
  } else {
    const asset = assetById(clip.assetId);
    if (asset?.element) drawContain(ctx, asset.element, w, h, clip);
  }
  ctx.restore();
}

export function paint(ctx, w, h, time) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  for (const clip of visualClipsAt(time)) paintClip(ctx, w, h, clip, time);
  ctx.globalAlpha = 1;
}

function paintPreview() {
  if (!previewCtx || held) return;
  paint(previewCtx, previewCanvas.width, previewCanvas.height, state.currentTime);
  syncTransformBox();
}

function waitMediaTime(el, target, ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      if (el.currentTime >= target - 0.012 || performance.now() - start > ms) {
        resolve();
        return;
      }
      requestAnimationFrame(tick);
    };
    tick();
  });
}

export function renderPaused() {
  if (held) return;
  const token = ++gen;
  const time = state.currentTime;
  sweepClipVideos();
  const clips = visualClipsAt(time);
  (async () => {
    for (const clip of clips) {
      if (clip.type !== 'video') continue;
      const el = videoFor(clip);
      if (!el) continue;
      await seekMedia(el, sourceTime(clip, time), 700);
      if (token !== gen || held) return;
    }
    if (token !== gen || state.isPlaying || held) return;
    paint(previewCtx, previewCanvas.width, previewCanvas.height, time);
    syncTransformBox();
  })();
}

export async function drawAtTime(ctx, w, h, time, opts = {}) {
  sweepClipVideos();
  const clips = visualClipsAt(time);
  const used = new Set();
  const frame = 1 / (state.fps || 30);
  for (const clip of clips) {
    if (clip.type !== 'video') continue;
    const el = videoFor(clip);
    if (!el) continue;
    used.add(clip.id);
    const target = clampMediaTime(el, sourceTime(clip, time));
    const ahead = target - el.currentTime;
    if (el.readyState >= 2 && ahead >= -frame && ahead <= frame * 0.35) {
      /* el decoder ya está en este fotograma */
    } else if (opts.fast && ahead > 0 && ahead < 0.8 && el.readyState >= 2 && !el.seeking) {
      if (el.paused) {
        try { await el.play(); } catch { /* seek */ }
      }
      if (!el.paused) await waitMediaTime(el, target, Math.min(400, ahead * 1000 + 50));
      if (target - el.currentTime > frame) {
        el.pause();
        await seekMedia(el, target, 800);
      }
    } else {
      if (!el.paused) el.pause();
      await seekMedia(el, target, opts.fast ? 800 : 1200);
    }
  }
  for (const [id, el] of clipVideos) {
    if (!used.has(id)) el.pause();
  }
  paint(ctx, w, h, time);
}

function updateTimecode() {
  const el = document.getElementById('timecode-display');
  if (el) el.textContent = formatTimecode(state.currentTime);
}

function movePlayhead() {
  const ph = document.getElementById('playhead');
  if (ph) ph.style.left = (state.currentTime * state.zoom) + 'px';
}

function setPlayIcon(playing) {
  const btn = document.getElementById('btn-play');
  if (!btn) return;
  btn.innerHTML = playing
    ? '<i class="fa-solid fa-pause text-sm"></i>'
    : '<i class="fa-solid fa-play text-sm ml-0.5"></i>';
}

function audibleClips() {
  return state.clips.filter(clip => {
    if (clip.type !== 'video' && clip.type !== 'audio') return false;
    if (clip.muteAudio) return false;
    const track = state.tracks.find(t => t.id === clip.trackId);
    return track && !track.muted;
  });
}

function stopSources() {
  for (const src of sources) {
    try { src.onended = null; src.stop(); } catch { /* already stopped */ }
  }
  sources = [];
  gains = [];
}

function startAudio() {
  stopSources();
  const ctx = audioContext();
  const now = state.currentTime;
  for (const clip of audibleClips()) {
    const asset = assetById(clip.assetId);
    if (!asset?.audioBuffer) continue;
    const end = clip.startTime + clip.duration;
    if (now >= end) continue;
    const offset = (clip.startOffset || 0) + Math.max(0, now - clip.startTime);
    const playFor = end - Math.max(now, clip.startTime);
    if (playFor <= 0.02 || offset >= asset.audioBuffer.duration - 0.01) continue;
    const src = ctx.createBufferSource();
    src.buffer = asset.audioBuffer;
    const gain = ctx.createGain();
    gain.gain.value = gainFor(clip, now);
    src.connect(gain);
    gain.connect(masterGain);
    const delay = Math.max(0, clip.startTime - now);
    src.start(ctx.currentTime + delay, offset, Math.min(playFor, asset.audioBuffer.duration - offset));
    sources.push(src);
    gains.push({ gain, clip });
  }
}

function connectElement(asset) {
  if (asset.mediaSource || !asset.audioEl) return;
  const ctx = audioContext();
  asset.mediaSource = ctx.createMediaElementSource(asset.audioEl);
  asset.elementGain = ctx.createGain();
  asset.mediaSource.connect(asset.elementGain);
  asset.elementGain.connect(masterGain);
}

function driverClip(asset, time) {
  for (const clip of audibleClips()) {
    if (clip.assetId !== asset.id) continue;
    if (time >= clip.startTime && time < clip.startTime + clip.duration) return clip;
  }
  return null;
}

function syncElements() {
  for (const asset of state.mediaPool) {
    if (!asset.audioEl) continue;
    connectElement(asset);
    const clip = state.isPlaying ? driverClip(asset, state.currentTime) : null;
    if (!clip) {
      asset.audioEl.pause();
      continue;
    }
    const target = clampMediaTime(asset.audioEl, sourceTime(clip, state.currentTime));
    if (Math.abs(asset.audioEl.currentTime - target) > 0.3) asset.audioEl.currentTime = target;
    if (asset.audioEl.paused) asset.audioEl.play().catch(() => {});
    asset.elementGain.gain.value = gainFor(clip, state.currentTime);
  }
}

const videoSeeking = new WeakSet();

function syncVideos() {
  sweepClipVideos();
  const visuals = visualClipsAt(state.currentTime).filter(c => c.type === 'video');
  const used = new Set();
  for (let i = visuals.length - 1; i >= 0; i--) {
    const clip = visuals[i];
    const el = videoFor(clip);
    if (!el || used.has(clip.id)) continue;
    used.add(clip.id);
    const target = clampMediaTime(el, sourceTime(clip, state.currentTime));
    el.playbackRate = 1;
    if (!videoSeeking.has(el) && Math.abs(el.currentTime - target) > 0.25) {
      videoSeeking.add(el);
      const release = () => {
        videoSeeking.delete(el);
        el.removeEventListener('seeked', release);
      };
      el.addEventListener('seeked', release);
      setTimeout(release, 500);
      try { el.currentTime = target; } catch { release(); }
    }
    if (el.paused) el.play().catch(() => {});
  }
  for (const [id, el] of clipVideos) {
    if (!used.has(id)) el.pause();
  }
}

function pauseElements() {
  for (const asset of state.mediaPool) {
    asset.element?.pause?.();
    asset.audioEl?.pause?.();
  }
  pauseClipVideos();
}

function updateGains() {
  for (const item of gains) item.gain.gain.value = gainFor(item.clip, state.currentTime);
}

function updateVu(reset) {
  const l = document.getElementById('vu-bar-l');
  const r = document.getElementById('vu-bar-r');
  if (!l || !r) return;
  if (reset || !analyser || !state.isPlaying) {
    l.style.width = '0%';
    r.style.width = '0%';
    return;
  }
  analyser.getByteTimeDomainData(timeData);
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = Math.abs(timeData[i] - 128) / 128;
    if (v > peak) peak = v;
  }
  const pct = `${Math.min(100, Math.round(peak * 140))}%`;
  l.style.width = pct;
  r.style.width = pct;
}

function followPlayhead() {
  const el = document.getElementById('timeline-scroll-container');
  if (!el) return;
  const view = Math.max(8, el.clientWidth / state.zoom);
  if (state.span < state.currentTime + view) {
    state.span = state.currentTime + view * 2;
    onSpanGrow();
  }
  const x = state.currentTime * state.zoom;
  const margin = el.clientWidth * 0.2;
  if (x > el.scrollLeft + el.clientWidth - margin) {
    el.scrollLeft = Math.max(0, x - el.clientWidth * 0.3);
  }
}

function playLoop(ts) {
  if (!state.isPlaying) return;
  raf = requestAnimationFrame(playLoop);
  if (held || scrubbing) return;
  if (audioCtx && audioCtx.state === 'running' && playAnchor) {
    state.currentTime = playAnchor.timeline + (audioCtx.currentTime - playAnchor.ctx);
  } else {
    const delta = Math.min(0.1, (ts - lastRaf) / 1000);
    state.currentTime += delta;
  }
  lastRaf = ts;
  movePlayhead();
  updateTimecode();
  followPlayhead();
  syncVideos();
  syncElements();
  updateGains();
  paintPreview();
  updateVu(false);
}

export function stopPlaying({ paint = true } = {}) {
  state.isPlaying = false;
  scrubbing = false;
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  setPlayIcon(false);
  stopSources();
  pauseElements();
  updateVu(true);
  if (paint && !held) renderPaused();
}

export function togglePlay() {
  if (held) return;
  const ctx = audioContext();
  if (state.isPlaying) {
    stopPlaying();
    return;
  }
  ctx.resume();
  gen++;
  state.isPlaying = true;
  setPlayIcon(true);
  playAnchor = { ctx: ctx.currentTime, timeline: state.currentTime };
  lastRaf = performance.now();
  syncVideos();
  syncElements();
  startAudio();
  raf = requestAnimationFrame(playLoop);
}

export function seek(time) {
  state.currentTime = Math.max(0, time);
  movePlayhead();
  updateTimecode();
  commitPlayback();
}

export function seekToStart() { seek(0); }

export function seekToEnd() { seek(contentEnd()); }

export function repaint() {
  if (!previewCtx || held) return;
  paint(previewCtx, previewCanvas.width, previewCanvas.height, state.currentTime);
  syncTransformBox();
}

export function previewNow() {
  movePlayhead();
  updateTimecode();
  if (state.isPlaying) {
    syncVideos();
    paintPreview();
  } else {
    renderPaused();
  }
}

export function commitPlayback() {
  if (state.isPlaying) {
    const ctx = audioContext();
    playAnchor = { ctx: ctx.currentTime, timeline: state.currentTime };
    syncVideos();
    syncElements();
    startAudio();
    paintPreview();
  } else {
    pauseElements();
    renderPaused();
  }
  updateTimecode();
}

export function beginScrub() {
  scrubbing = true;
  stopSources();
  for (const asset of state.mediaPool) asset.audioEl?.pause();
}

export function scrubTo(time) {
  state.currentTime = Math.max(0, time);
  movePlayhead();
  updateTimecode();
  renderPaused();
}

export function endScrub() {
  scrubbing = false;
  commitPlayback();
}

function textRect(clip, w, h) {
  const size = clip.fontSize || Math.round(h / 15);
  const ctx = previewCtx;
  ctx.save();
  ctx.font = `bold ${size}px ${clip.fontFamily || 'Inter, sans-serif'}`;
  const measured = ctx.measureText(clip.text || clip.name || '').width;
  ctx.restore();
  const dw = Math.max(size, Math.min(w, measured + size * 0.5));
  const dh = size * 1.5;
  return {
    dx: w / 2 + (clip.x || 0) - dw / 2,
    dy: h / 2 + (clip.y || 0) - dh / 2,
    dw,
    dh
  };
}

function selectedVisual() {
  const clip = state.clips.find(item => item.id === state.selectedClipId);
  if (!clip || clip.type === 'audio') return null;
  const track = state.tracks.find(item => item.id === clip.trackId);
  if (!track || track.hidden || track.type === 'audio') return null;
  const time = state.currentTime;
  if (time < clip.startTime || time >= clip.startTime + clip.duration) return null;
  return clip;
}

function canvasPoint(event) {
  const rect = previewCanvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * previewCanvas.width,
    y: ((event.clientY - rect.top) / rect.height) * previewCanvas.height
  };
}

export function syncTransformBox() {
  const box = document.getElementById('transform-box');
  const stage = document.getElementById('preview-stage');
  if (!box || !stage || !previewCanvas) return;
  const clip = selectedVisual();
  if (!clip) {
    box.classList.add('hidden');
    return;
  }
  let rect = null;
  if (clip.type === 'text') rect = textRect(clip, previewCanvas.width, previewCanvas.height);
  else {
    const source = clip.type === 'video' ? videoFor(clip) : assetById(clip.assetId)?.element;
    rect = frameRect(source, previewCanvas.width, previewCanvas.height, clip);
  }
  if (!rect) {
    box.classList.add('hidden');
    return;
  }
  const canvasRect = previewCanvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  const sx = canvasRect.width / previewCanvas.width;
  const sy = canvasRect.height / previewCanvas.height;
  box.classList.remove('hidden');
  box.style.left = `${canvasRect.left - stageRect.left + rect.dx * sx}px`;
  box.style.top = `${canvasRect.top - stageRect.top + rect.dy * sy}px`;
  box.style.width = `${Math.max(8, rect.dw * sx)}px`;
  box.style.height = `${Math.max(8, rect.dh * sy)}px`;
}

function bindTransform() {
  const move = document.getElementById('transform-move');
  const scale = document.getElementById('transform-scale');
  if (!move || !scale) return;
  move.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const clip = selectedVisual();
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = canvasPoint(event);
    const x0 = clip.x || 0;
    const y0 = clip.y || 0;
    const drag = (ev) => {
      const point = canvasPoint(ev);
      clip.x = x0 + (point.x - origin.x);
      clip.y = y0 + (point.y - origin.y);
      repaint();
    };
    const up = () => {
      window.removeEventListener('mousemove', drag);
      window.removeEventListener('mouseup', up);
      pushHistory();
      document.dispatchEvent(new CustomEvent('clip-selected'));
    };
    window.addEventListener('mousemove', drag);
    window.addEventListener('mouseup', up);
  });
  scale.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    const clip = selectedVisual();
    if (!clip) return;
    event.preventDefault();
    event.stopPropagation();
    const origin = canvasPoint(event);
    const center = {
      x: previewCanvas.width / 2 + (clip.x || 0),
      y: previewCanvas.height / 2 + (clip.y || 0)
    };
    const startDist = Math.max(8, Math.hypot(origin.x - center.x, origin.y - center.y));
    const startScale = clip.scale ?? 1;
    const startSize = clip.fontSize || Math.round(previewCanvas.height / 15);
    const drag = (ev) => {
      const point = canvasPoint(ev);
      const dist = Math.hypot(point.x - center.x, point.y - center.y);
      const factor = dist / startDist;
      if (clip.type === 'text') clip.fontSize = Math.max(8, Math.round(startSize * factor));
      else clip.scale = Math.max(0.1, Math.min(6, startScale * factor));
      repaint();
    };
    const up = () => {
      window.removeEventListener('mousemove', drag);
      window.removeEventListener('mouseup', up);
      pushHistory();
      document.dispatchEvent(new CustomEvent('clip-selected'));
    };
    window.addEventListener('mousemove', drag);
    window.addEventListener('mouseup', up);
  });
}
