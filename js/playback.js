import { state, assetById, formatTimecode, contentEnd } from './state.js';

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

export function drawContain(ctx, source, cw, ch) {
  if (!source) return false;
  if (source instanceof HTMLImageElement && !source.complete) return false;
  const sw = source.videoWidth || source.naturalWidth || 0;
  const sh = source.videoHeight || source.naturalHeight || 0;
  if (!sw || !sh) return false;
  if (source instanceof HTMLVideoElement && source.readyState < 2) return false;
  const scale = Math.min(cw / sw, ch / sh);
  const dw = sw * scale;
  const dh = sh * scale;
  ctx.drawImage(source, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
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

export function visualClipsAt(time) {
  const out = [];
  for (let i = state.tracks.length - 1; i >= 0; i--) {
    const track = state.tracks[i];
    if (track.type === 'audio' || track.muted) continue;
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
  ctx.fillText('Códec no compatible', w / 2, h / 2 - h / 18);
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
    ctx.fillStyle = clip.textColor || clip.color || '#00d2ff';
    ctx.font = `bold ${Math.round(h / 15)}px Inter, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(clip.text || clip.name || '', w / 2, h / 2);
  } else {
    const asset = assetById(clip.assetId);
    if (asset?.unreadable || asset?.element?.error) {
      drawUnsupported(ctx, w, h, asset?.name || clip.name);
    } else {
      const source = clip.type === 'image' || clip.type === 'video' ? asset?.element : null;
      if (source) drawContain(ctx, source, w, h);
    }
  }
  ctx.restore();
}

export function paint(ctx, w, h, time) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);
  // ponytail: one <video> per file, so overlapping clips of the same file share one frame
  for (const clip of visualClipsAt(time)) paintClip(ctx, w, h, clip, time);
  ctx.globalAlpha = 1;
}

function paintPreview() {
  if (!previewCtx || held) return;
  paint(previewCtx, previewCanvas.width, previewCanvas.height, state.currentTime);
}

export function renderPaused() {
  if (held) return;
  const token = ++gen;
  const time = state.currentTime;
  const clips = visualClipsAt(time);
  (async () => {
    for (const clip of clips) {
      if (clip.type !== 'video') continue;
      const asset = assetById(clip.assetId);
      if (!asset?.element) continue;
      await seekMedia(asset.element, sourceTime(clip, time), 700);
      if (token !== gen || held) return;
    }
    if (token !== gen || state.isPlaying || held) return;
    paint(previewCtx, previewCanvas.width, previewCanvas.height, time);
  })();
}

export async function drawAtTime(ctx, w, h, time) {
  const clips = visualClipsAt(time);
  for (const clip of clips) {
    if (clip.type !== 'video') continue;
    const asset = assetById(clip.assetId);
    if (!asset?.element) continue;
    await seekMedia(asset.element, sourceTime(clip, time), 1200);
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
  const visuals = visualClipsAt(state.currentTime).filter(c => c.type === 'video');
  const used = new Set();
  for (let i = visuals.length - 1; i >= 0; i--) {
    const clip = visuals[i];
    const asset = assetById(clip.assetId);
    if (!asset?.element || used.has(asset.id)) continue;
    used.add(asset.id);
    const el = asset.element;
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
  for (const asset of state.mediaPool) {
    if (asset.type === 'video' && asset.element && !used.has(asset.id)) asset.element.pause();
  }
}

function pauseElements() {
  for (const asset of state.mediaPool) {
    asset.element?.pause?.();
    asset.audioEl?.pause?.();
  }
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
