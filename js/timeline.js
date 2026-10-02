import { state, uid, assetById, pushHistory, contentEnd, flash } from './state.js';
import { assetRows, attachTip, hideTip } from './media.js';
import {
  beginScrub, scrubTo, endScrub, commitPlayback, previewNow
} from './playback.js';

const BAR = { video: '#3b82f6', audio: '#10b981', image: '#f59e0b', text: '#8b5cf6' };

let scrollLock = false;
let onFirstVideo = () => {};

export function setFirstVideoHandler(fn) {
  onFirstVideo = fn;
}

function notify() {
  document.dispatchEvent(new CustomEvent('clip-selected'));
}

function viewSeconds() {
  const el = document.getElementById('timeline-scroll-container');
  return Math.max(8, (el?.clientWidth || 800) / state.zoom);
}

function ensureSpan() {
  const need = contentEnd() + viewSeconds() * 2;
  if (state.span < need) state.span = need;
}

function selectedClip() {
  return state.clips.find(c => c.id === state.selectedClipId) || null;
}

function clipTypeFor(asset, track) {
  if (track.type === 'audio') return asset.type === 'image' ? null : 'audio';
  if (asset.type === 'audio') return null;
  return asset.type;
}

function hideSnap() {
  document.getElementById('snap-line')?.classList.add('hidden');
}

function snapMark(time, ignoreId) {
  if (!state.isSnapping) return time;
  const threshold = 8 / state.zoom;
  const marks = [0, state.currentTime];
  const skip = new Set();
  if (ignoreId) {
    skip.add(ignoreId);
    const self = state.clips.find(c => c.id === ignoreId);
    if (self?.linkedClipId) skip.add(self.linkedClipId);
  }
  for (const clip of state.clips) {
    if (skip.has(clip.id)) continue;
    marks.push(clip.startTime, clip.startTime + clip.duration);
  }
  let best = time;
  let diff = threshold;
  for (const mark of marks) {
    const d = Math.abs(mark - time);
    if (d < diff) {
      diff = d;
      best = mark;
    }
  }
  const line = document.getElementById('snap-line');
  if (best !== time && line) {
    line.style.left = `${best * state.zoom}px`;
    line.classList.remove('hidden');
  } else {
    line?.classList.add('hidden');
  }
  return best;
}

function snapStart(start, duration, ignoreId) {
  const snapped = snapMark(start, ignoreId);
  if (snapped !== start) return Math.max(0, snapped);
  const endSnap = snapMark(start + duration, ignoreId);
  if (endSnap !== start + duration) return Math.max(0, endSnap - duration);
  return Math.max(0, start);
}

function maxDuration(clip, offset) {
  if (clip.type === 'image' || clip.type === 'text') return Infinity;
  const asset = assetById(clip.assetId);
  if (!asset?.duration) return Infinity;
  return Math.max(0.2, asset.duration - offset);
}

function partnerOf(clip) {
  if (!clip?.linkedClipId) return null;
  return state.clips.find(c => c.id === clip.linkedClipId) || null;
}

function overlapEdges(clip) {
  let inn = 0;
  let out = 0;
  const end = clip.startTime + clip.duration;
  for (const other of state.clips) {
    if (other.id === clip.id || other.trackId !== clip.trackId) continue;
    if ((other.type === 'audio') !== (clip.type === 'audio')) continue;
    const otherEnd = other.startTime + other.duration;
    const len = Math.min(end, otherEnd) - Math.max(clip.startTime, other.startTime);
    if (len <= 0.03) continue;
    if (other.startTime < clip.startTime) inn = Math.max(inn, len);
    else if (other.startTime > clip.startTime) out = Math.max(out, len);
  }
  return { inn, out };
}

function makeAudioPartner(videoClip) {
  let track = state.tracks.find(t => t.type === 'audio');
  if (!track) track = createTrack('audio');
  const audioClip = {
    ...videoClip,
    id: uid('clip'),
    trackId: track.id,
    type: 'audio',
    muteAudio: false,
    linkedClipId: videoClip.id,
    color: BAR.audio,
    opacity: 1
  };
  videoClip.muteAudio = true;
  videoClip.linkedClipId = audioClip.id;
  state.clips.push(audioClip);
  return audioClip;
}

function createTrack(type) {
  const n = state.tracks.filter(t => t.type === type).length + 1;
  const track = {
    id: uid('track'),
    name: `${type === 'video' ? 'Video' : 'Audio'} Track ${n}`,
    type,
    muted: false
  };
  state.tracks.push(track);
  return track;
}

function place(asset, track, startTime) {
  const type = clipTypeFor(asset, track);
  if (!type) {
    flash(track.type === 'audio' ? 'That file does not belong on an audio track' : 'Audio belongs on an audio track');
    return;
  }
  const duration = Math.max(0.2, asset.duration || 5);
  const clip = {
    id: uid('clip'),
    trackId: track.id,
    assetId: asset.id,
    name: asset.name,
    type,
    startTime: snapStart(Math.max(0, startTime), duration, null),
    duration,
    startOffset: 0,
    volume: 1,
    opacity: 1,
    fadeIn: 0,
    fadeOut: 0,
    muteAudio: false,
    linkedClipId: null,
    color: BAR[type] || BAR.video,
    text: '',
    textColor: '#00d2ff',
    x: 0,
    y: 0,
    scale: 1,
    cropL: 0,
    cropR: 0,
    cropT: 0,
    cropB: 0
  };
  const firstVideo = state.clips.length === 0 && type === 'video';
  hideSnap();
  state.clips.push(clip);
  if (type === 'video') makeAudioPartner(clip);
  state.selectedClipId = clip.id;
  if (firstVideo) onFirstVideo(asset);
  pushHistory();
  renderTimeline();
  commitPlayback();
  notify();
}

export function insertAsset(assetId) {
  const asset = assetById(assetId);
  if (!asset) return;
  let track = state.tracks.find(t => clipTypeFor(asset, t));
  if (!track) track = createTrack(asset.type === 'audio' ? 'audio' : 'video');
  place(asset, track, contentEnd());
}

export function addTextClip() {
  const text = document.getElementById('text-gen-input').value.trim() || 'Text';
  const textColor = document.getElementById('text-gen-color').value || '#00d2ff';
  const fontSize = Math.max(8, parseFloat(document.getElementById('text-gen-size')?.value) || 72);
  const fontFamily = document.getElementById('text-gen-font')?.value || 'Inter, sans-serif';
  const strokeWidth = Math.max(0, parseFloat(document.getElementById('text-gen-stroke')?.value) || 0);
  const strokeColor = document.getElementById('text-gen-stroke-color')?.value || '#000000';
  let track = state.tracks.find(t => t.type === 'video');
  if (!track) track = createTrack('video');
  const clip = {
    id: uid('clip'),
    trackId: track.id,
    assetId: null,
    name: text,
    type: 'text',
    text,
    textColor,
    startTime: state.currentTime,
    duration: 4,
    startOffset: 0,
    volume: 1,
    opacity: 1,
    fadeIn: 0.3,
    fadeOut: 0.3,
    muteAudio: true,
    linkedClipId: null,
    color: BAR.text,
    x: 0,
    y: 0,
    scale: 1,
    fontSize,
    fontFamily,
    strokeWidth,
    strokeColor
  };
  state.clips.push(clip);
  state.selectedClipId = clip.id;
  pushHistory();
  renderTimeline();
  commitPlayback();
  notify();
}

export function addTrack(type) {
  createTrack(type);
  pushHistory();
  renderTimeline();
}

export function deleteTrack(trackId) {
  state.tracks = state.tracks.filter(t => t.id !== trackId);
  const removed = new Set(state.clips.filter(c => c.trackId === trackId).map(c => c.id));
  state.clips = state.clips.filter(c => c.trackId !== trackId);
  for (const clip of state.clips) {
    if (removed.has(clip.linkedClipId)) clip.linkedClipId = null;
  }
  if (removed.has(state.selectedClipId)) state.selectedClipId = null;
  pushHistory();
  renderTimeline();
  commitPlayback();
  notify();
}

export function toggleHidden(trackId) {
  const track = state.tracks.find(t => t.id === trackId);
  if (!track || track.type !== 'video') return;
  track.hidden = !track.hidden;
  pushHistory();
  renderTimeline();
  commitPlayback();
}

export function toggleMute(trackId) {
  const track = state.tracks.find(t => t.id === trackId);
  if (!track) return;
  track.muted = !track.muted;
  pushHistory();
  renderTimeline();
  commitPlayback();
}

export function setZoom(value) {
  const el = document.getElementById('timeline-scroll-container');
  const old = state.zoom;
  const anchor = el ? state.currentTime * old - el.scrollLeft : 0;
  state.zoom = Math.min(200, Math.max(0.25, Number(value) || 40));
  ensureSpan();
  renderTimeline();
  if (el) el.scrollLeft = Math.max(0, state.currentTime * state.zoom - anchor);
  const slider = document.getElementById('zoom-slider');
  if (slider && document.activeElement !== slider) slider.value = String(Math.round(state.zoom));
}

export function zoomToFit() {
  const el = document.getElementById('timeline-scroll-container');
  const end = Math.max(contentEnd(), 1);
  const width = el?.clientWidth || 800;
  setZoom(width / end);
  if (el) el.scrollLeft = 0;
}

function rulerStep() {
  if (state.zoom >= 40) return 1;
  if (state.zoom >= 20) return 2;
  if (state.zoom >= 10) return 5;
  return 10;
}

function rulerLabel(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderRuler(widthPx) {
  const ruler = document.getElementById('timeline-ruler');
  ruler.style.width = `${widthPx}px`;
  ruler.replaceChildren();
  const step = rulerStep();
  const total = Math.ceil(state.span);
  for (let s = 0; s <= total; s += step) {
    const mark = document.createElement('div');
    mark.className = 'absolute top-0 bottom-0 timeline-ruler-tick text-[9px] font-mono text-slate-400 pl-1 no-select pointer-events-none';
    mark.style.left = `${s * state.zoom}px`;
    mark.textContent = rulerLabel(s);
    ruler.appendChild(mark);
  }
}

function makeHandle(className, handle, title) {
  const el = document.createElement('div');
  el.className = className;
  el.dataset.handle = handle;
  el.title = title;
  return el;
}

function placeWaveform(img, clip, asset) {
  const total = Math.max(0.05, asset?.duration || clip.duration);
  const offset = Math.max(0, clip.startOffset || 0);
  const span = Math.max(0.05, clip.duration);
  img.style.height = '100%';
  img.style.width = `${(total / span) * 100}%`;
  img.style.maxWidth = 'none';
  img.style.flex = 'none';
  img.style.objectFit = 'fill';
  img.style.marginLeft = `${-(offset / span) * 100}%`;
}

function buildClip(clip) {
  const el = document.createElement('div');
  const selected = state.selectedClipId === clip.id;
  el.dataset.clipId = clip.id;
  el.className = `absolute top-1 bottom-1 rounded border overflow-hidden cursor-grab flex flex-col shadow-md ${selected ? 'border-cyan-400 ring-2 ring-cyan-400/50 z-20' : 'border-slate-700 hover:border-slate-500 z-10'}`;
  el.style.left = `${clip.startTime * state.zoom}px`;
  el.style.width = `${Math.max(4, clip.duration * state.zoom)}px`;
  el.style.backgroundColor = clip.type === 'audio' ? '#022c22' : (BAR[clip.type] || clip.color || BAR.video);

  const asset = assetById(clip.assetId);
  const bg = document.createElement('div');
  bg.className = 'absolute inset-0 flex pointer-events-none overflow-hidden';
  if (clip.type === 'audio' && asset?.waveform) {
    const img = document.createElement('img');
    img.src = asset.waveform;
    img.alt = '';
    img.dataset.wave = '1';
    img.draggable = false;
    placeWaveform(img, clip, asset);
    bg.appendChild(img);
  } else if (clip.type !== 'audio' && asset?.type === 'image' && asset.url) {
    const img = document.createElement('img');
    img.src = asset.url;
    img.alt = '';
    img.className = 'w-full h-full object-contain';
    bg.appendChild(img);
  } else if (clip.type !== 'audio' && asset?.thumbnails?.length) {
    for (const src of asset.thumbnails) {
      const img = document.createElement('img');
      img.src = src;
      img.alt = '';
      img.className = 'h-full w-auto flex-none max-w-none';
      img.style.aspectRatio = '16 / 9';
      bg.appendChild(img);
    }
  }
  el.appendChild(bg);

  const label = document.createElement('div');
  label.className = 'relative z-10 px-1.5 py-0.5 text-[11px] text-white truncate drop-shadow max-w-full pointer-events-none';
  label.textContent = clip.name;
  el.appendChild(label);
  if (clip.linkedClipId) {
    const link = document.createElement('i');
    link.className = 'fa-solid fa-link absolute bottom-0.5 right-1 text-[9px] text-white/80 z-10 pointer-events-none';
    link.title = 'Audio and video are linked and move together';
    el.appendChild(link);
  }

  const edges = overlapEdges(clip);
  const inPx = Math.max(clip.fadeIn || 0, edges.inn) * state.zoom;
  const outPx = Math.max(clip.fadeOut || 0, edges.out) * state.zoom;
  if (inPx > 2) {
    const wedge = document.createElement('div');
    wedge.className = 'clip-fade clip-fade-in pointer-events-none';
    wedge.style.width = `${inPx}px`;
    el.appendChild(wedge);
  }
  if (outPx > 2) {
    const wedge = document.createElement('div');
    wedge.className = 'clip-fade clip-fade-out pointer-events-none';
    wedge.style.width = `${outPx}px`;
    el.appendChild(wedge);
  }
  const fadeIn = makeHandle('absolute top-0 w-3 h-3 bg-white/70 hover:bg-cyan-300 clip-handle-fade cursor-ew-resize z-30', 'fade-in', 'Fade in');
  const fadeOut = makeHandle('absolute top-0 w-3 h-3 bg-white/70 hover:bg-cyan-300 clip-handle-fade-out cursor-ew-resize z-30', 'fade-out', 'Fade out');
  fadeIn.style.left = `${Math.max(0, (clip.fadeIn || 0) * state.zoom)}px`;
  fadeOut.style.right = `${Math.max(0, (clip.fadeOut || 0) * state.zoom)}px`;
  const trimL = makeHandle('absolute top-0 bottom-0 left-0 w-2 hover:bg-cyan-400/50 cursor-ew-resize z-20', 'trim-left', 'Trim start');
  const trimR = makeHandle('absolute top-0 bottom-0 right-0 w-2 hover:bg-cyan-400/50 cursor-ew-resize z-20', 'trim-right', 'Trim end');
  for (const handle of [fadeIn, fadeOut, trimL, trimR]) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      if (handle.dataset.handle.startsWith('fade')) startFade(e, clip, handle.dataset.handle);
      else startTrim(e, clip, handle.dataset.handle);
    });
  }
  el.append(fadeIn, fadeOut, trimL, trimR);

  el.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('[data-handle]')) return;
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.id;
    notify();
    startMove(e, clip);
  });
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    state.selectedClipId = clip.id;
    notify();
    renderTimeline();
    showContextMenu(e.clientX, e.clientY);
  });
  attachTip(el, () => {
    if (asset) return { title: asset.name, rows: assetRows(asset, clip) };
    return {
      title: clip.name,
      rows: [
        ['Type', 'Text'],
        ['Duration', `${clip.duration.toFixed(1)} s`],
        ['Start', `${clip.startTime.toFixed(1)} s`]
      ]
    };
  });
  return el;
}

function trackAt(clientY) {
  const lanes = document.querySelectorAll('#track-lanes > div');
  for (let i = 0; i < lanes.length; i++) {
    const rect = lanes[i].getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) return { track: state.tracks[i], lane: lanes[i] };
  }
  return null;
}

function clipFits(clip, track) {
  if (!track) return false;
  if (clip.type === 'audio') return track.type === 'audio';
  return track.type === 'video';
}

function laneOf(trackId) {
  const index = state.tracks.findIndex(t => t.id === trackId);
  return document.querySelectorAll('#track-lanes > div')[index] || null;
}

function showGhost(id, lane, time, duration, ok) {
  const lanes = document.getElementById('track-lanes');
  let ghost = document.getElementById(id);
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = id;
    ghost.className = 'clip-ghost absolute rounded pointer-events-none';
    lanes.appendChild(ghost);
  }
  ghost.classList.toggle('bad', !ok);
  ghost.classList.remove('hidden');
  ghost.style.left = `${Math.max(0, time) * state.zoom}px`;
  ghost.style.width = `${Math.max(4, duration * state.zoom)}px`;
  ghost.style.top = `${lane.offsetTop + 4}px`;
  ghost.style.height = `${Math.max(8, lane.clientHeight - 8)}px`;
}

function hideGhosts() {
  document.getElementById('clip-ghost')?.remove();
  document.getElementById('clip-ghost-link')?.remove();
}

function startMove(e, clip) {
  const origin = clip.startTime;
  const partner = partnerOf(clip);
  const partnerOrigin = partner ? partner.startTime : 0;
  const clipEl = e.currentTarget;
  const grab = (e.clientX - clipEl.getBoundingClientRect().left) / state.zoom;
  clipEl.style.opacity = '0.4';
  const partnerEl = partner ? document.querySelector(`[data-clip-id="${partner.id}"]`) : null;
  if (partnerEl) partnerEl.style.opacity = '0.4';
  document.body.style.cursor = 'grabbing';
  let drop = { time: origin, track: state.tracks.find(t => t.id === clip.trackId), ok: true };

  const move = (ev) => {
    hideTip();
    const scroller = document.getElementById('timeline-scroll-container');
    const view = scroller.getBoundingClientRect();
    if (ev.clientX > view.right - 28) scroller.scrollLeft += 16;
    else if (ev.clientX < view.left + 28) scroller.scrollLeft -= 16;

    const hit = trackAt(ev.clientY);
    const lane = hit?.lane || laneOf(clip.trackId);
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    let time = (ev.clientX - rect.left) / state.zoom - grab;
    if (partner && partnerOrigin + (time - origin) < 0) time = origin - partnerOrigin;
    time = Math.max(0, time);
    time = snapStart(time, clip.duration, clip.id);
    if (partner && partnerOrigin + (time - origin) < 0) time = Math.max(0, origin - partnerOrigin);
    const track = hit?.track || null;
    const ok = clipFits(clip, track);
    drop = { time, track: ok ? track : state.tracks.find(t => t.id === clip.trackId), ok };
    showGhost('clip-ghost', ok && hit?.lane ? hit.lane : laneOf(clip.trackId), time, clip.duration, ok);
    if (partner) {
      const partnerLane = laneOf(partner.trackId);
      if (partnerLane) showGhost('clip-ghost-link', partnerLane, partnerOrigin + (time - origin), partner.duration, true);
    }
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.style.cursor = '';
    hideSnap();
    hideTip();
    hideGhosts();
    clip.startTime = drop.time;
    if (drop.ok && drop.track) clip.trackId = drop.track.id;
    if (partner) partner.startTime = Math.max(0, partnerOrigin + (clip.startTime - origin));
    pushHistory();
    renderTimeline();
    commitPlayback();
    notify();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function layoutClip(clip) {
  const el = document.querySelector(`[data-clip-id="${clip.id}"]`);
  if (!el) return;
  el.style.left = `${clip.startTime * state.zoom}px`;
  el.style.width = `${Math.max(4, clip.duration * state.zoom)}px`;
  const edges = overlapEdges(clip);
  const fadeIn = el.querySelector('.clip-fade-in');
  const fadeOut = el.querySelector('.clip-fade-out');
  if (fadeIn) fadeIn.style.width = `${Math.max(clip.fadeIn || 0, edges.inn) * state.zoom}px`;
  if (fadeOut) fadeOut.style.width = `${Math.max(clip.fadeOut || 0, edges.out) * state.zoom}px`;
  const handleIn = el.querySelector('[data-handle="fade-in"]');
  const handleOut = el.querySelector('[data-handle="fade-out"]');
  if (handleIn) handleIn.style.left = `${Math.max(0, (clip.fadeIn || 0) * state.zoom)}px`;
  if (handleOut) handleOut.style.right = `${Math.max(0, (clip.fadeOut || 0) * state.zoom)}px`;
  const wave = el.querySelector('[data-wave]');
  if (wave) placeWaveform(wave, clip, assetById(clip.assetId));
}

function startTrim(e, clip, handle) {
  const originX = e.clientX;
  const originStart = clip.startTime;
  const originDur = clip.duration;
  const originOffset = clip.startOffset || 0;
  const partner = partnerOf(clip);
  const partnerStart = partner ? partner.startTime : 0;
  const partnerDur = partner ? partner.duration : 0;
  const partnerOffset = partner ? (partner.startOffset || 0) : 0;
  const move = (ev) => {
    const delta = (ev.clientX - originX) / state.zoom;
    if (handle === 'trim-right') {
      clip.duration = Math.max(0.2, Math.min(originDur + delta, maxDuration(clip, originOffset)));
    } else {
      let used = delta;
      if (used < -originOffset) used = -originOffset;
      if (originDur - used < 0.2) used = originDur - 0.2;
      if (originStart + used < 0) used = -originStart;
      clip.startTime = originStart + used;
      clip.duration = originDur - used;
      clip.startOffset = originOffset + used;
    }
    if (partner) {
      const dStart = clip.startTime - originStart;
      const dDur = clip.duration - originDur;
      const dOff = (clip.startOffset || 0) - originOffset;
      partner.startTime = Math.max(0, partnerStart + dStart);
      partner.duration = Math.max(0.2, partnerDur + dDur);
      partner.startOffset = Math.max(0, partnerOffset + dOff);
    }
    layoutClip(clip);
    if (partner) layoutClip(partner);
    previewNow();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    pushHistory();
    renderTimeline();
    commitPlayback();
    notify();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function startFade(e, clip, handle) {
  const originX = e.clientX;
  const origin = handle === 'fade-in' ? (clip.fadeIn || 0) : (clip.fadeOut || 0);
  const partner = partnerOf(clip);
  const move = (ev) => {
    const delta = (ev.clientX - originX) / state.zoom;
    const cap = clip.duration / 2;
    if (handle === 'fade-in') clip.fadeIn = Math.max(0, Math.min(cap, origin + delta));
    else clip.fadeOut = Math.max(0, Math.min(cap, origin - delta));
    if (partner) {
      partner.fadeIn = clip.fadeIn;
      partner.fadeOut = clip.fadeOut;
    }
    layoutClip(clip);
    if (partner) layoutClip(partner);
    previewNow();
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    pushHistory();
    renderTimeline();
    commitPlayback();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function showContextMenu(x, y) {
  const menu = document.getElementById('context-menu');
  menu.classList.remove('hidden');
  menu.style.left = `${Math.min(x, window.innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - menu.offsetHeight - 8)}px`;
}

export function renderTimeline() {
  ensureSpan();
  const headers = document.getElementById('track-header-list');
  const lanes = document.getElementById('track-lanes');
  const ruler = document.getElementById('timeline-ruler');
  const playhead = document.getElementById('playhead');
  const snap = document.getElementById('snap-line');
  if (!headers || !lanes) return;

  const widthPx = Math.max(1, Math.ceil(state.span * state.zoom));
  renderRuler(widthPx);
  lanes.style.width = `${widthPx}px`;
  headers.replaceChildren();
  lanes.replaceChildren();

  for (const track of state.tracks) {
    const header = document.createElement('div');
    header.className = 'h-16 border-b border-vegas-border p-2 flex flex-col justify-between bg-vegas-panelLight text-xs';
    const top = document.createElement('div');
    top.className = 'flex items-center justify-between gap-2';
    const name = document.createElement('span');
    name.className = 'font-bold text-slate-300 truncate';
    name.textContent = track.name;
    const kind = document.createElement('span');
    kind.className = `text-[9px] uppercase px-1 rounded ${track.type === 'video' ? 'bg-blue-950 text-blue-400' : 'bg-emerald-950 text-emerald-400'}`;
    kind.textContent = track.type;
    top.append(name, kind);

    const bottom = document.createElement('div');
    bottom.className = 'flex items-center space-x-1';
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = `px-1.5 py-0.5 rounded text-[10px] ${track.muted ? 'bg-red-600 text-white' : 'bg-slate-700 text-slate-300'}`;
    mute.textContent = 'M';
    mute.title = track.muted ? 'Unmute track' : 'Mute track';
    mute.addEventListener('click', () => toggleMute(track.id));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'p-1 text-slate-500 hover:text-red-400 ml-auto';
    del.title = 'Delete track';
    del.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    del.addEventListener('click', () => deleteTrack(track.id));
    bottom.append(mute);
    if (track.type === 'video') {
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = `px-1.5 py-0.5 rounded text-[10px] ${track.hidden ? 'bg-slate-900 text-slate-500' : 'bg-slate-700 text-slate-300'}`;
      eye.innerHTML = `<i class="fa-solid ${track.hidden ? 'fa-eye-slash' : 'fa-eye'}"></i>`;
      eye.title = track.hidden ? 'Show picture' : 'Hide picture';
      eye.addEventListener('click', () => toggleHidden(track.id));
      bottom.append(eye);
    }
    bottom.append(del);
    header.append(top, bottom);
    headers.appendChild(header);

    const lane = document.createElement('div');
    lane.className = 'h-16 border-b border-vegas-border/50 relative bg-vegas-bg/50';
    lane.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      let data;
      try { data = JSON.parse(e.dataTransfer.getData('text/plain')); } catch { return; }
      if (data?.type !== 'asset') return;
      const asset = assetById(data.assetId);
      if (!asset) return;
      const rect = lane.getBoundingClientRect();
      place(asset, track, Math.max(0, (e.clientX - rect.left) / state.zoom));
    });
    lane.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target !== lane) return;
      state.selectedClipId = null;
      notify();
      const rect = lane.getBoundingClientRect();
      const at = (ev) => scrubTo(Math.max(0, (ev.clientX - rect.left) / state.zoom));
      beginScrub();
      at(e);
      const move = (ev) => at(ev);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        endScrub();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });

    for (const clip of state.clips) {
      if (clip.trackId === track.id) lane.appendChild(buildClip(clip));
    }
    lanes.appendChild(lane);
  }

  if (state.inPoint != null || state.outPoint != null) {
    const shade = document.createElement('div');
    shade.className = 'absolute top-0 bottom-0 bg-cyan-400/10 pointer-events-none z-0';
    const a = state.inPoint ?? 0;
    const b = state.outPoint ?? state.span;
    shade.style.left = `${Math.min(a, b) * state.zoom}px`;
    shade.style.width = `${Math.max(0, Math.abs(b - a)) * state.zoom}px`;
    lanes.appendChild(shade);
  }

  const height = (ruler?.offsetHeight || 24) + lanes.offsetHeight;
  if (playhead) {
    playhead.style.left = `${state.currentTime * state.zoom}px`;
    playhead.style.height = `${height}px`;
  }
  if (snap) snap.style.height = `${height}px`;
}

function timeFromRuler(e) {
  const rect = document.getElementById('timeline-ruler').getBoundingClientRect();
  return Math.max(0, (e.clientX - rect.left) / state.zoom);
}

function onTimelineScroll() {
  if (scrollLock) return;
  const el = document.getElementById('timeline-scroll-container');
  const headers = document.getElementById('track-header-list');
  if (headers) headers.scrollTop = el.scrollTop;
  const remain = el.scrollWidth - el.scrollLeft - el.clientWidth;
  if (remain < 64) {
    const left = el.scrollLeft;
    const top = el.scrollTop;
    state.span += viewSeconds();
    scrollLock = true;
    renderTimeline();
    el.scrollLeft = left;
    el.scrollTop = top;
    scrollLock = false;
  }
}

export function bindTimeline() {
  const ruler = document.getElementById('timeline-ruler');
  const scroller = document.getElementById('timeline-scroll-container');
  scroller.addEventListener('scroll', onTimelineScroll);
  scroller.parentElement.addEventListener('wheel', (e) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    const delta = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    const factor = delta > 0 ? 1 / 1.12 : 1.12;
    setZoom(state.zoom * factor);
  }, { passive: false });
  document.getElementById('playhead-hit')?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    beginScrub();
    scrubTo(timeFromRuler(e));
    const move = (ev) => scrubTo(timeFromRuler(ev));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      endScrub();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  ruler.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    beginScrub();
    scrubTo(timeFromRuler(e));
    const move = (ev) => scrubTo(timeFromRuler(ev));
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      endScrub();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (menu && !menu.contains(e.target)) menu.classList.add('hidden');
  });
  scroller.addEventListener('scroll', hideTip);
}

function splitOne(clip, time) {
  const offset = time - clip.startTime;
  const origDur = clip.duration;
  const origOut = clip.fadeOut || 0;
  clip.duration = offset;
  clip.fadeOut = 0;
  const second = {
    ...clip,
    id: uid('clip'),
    startTime: time,
    duration: origDur - offset,
    startOffset: (clip.startOffset || 0) + offset,
    fadeIn: 0,
    fadeOut: origOut,
    linkedClipId: null
  };
  state.clips.push(second);
  return second;
}

export function splitSelected() {
  const clip = selectedClip();
  if (!clip) return;
  const time = state.currentTime;
  if (time <= clip.startTime + 0.05 || time >= clip.startTime + clip.duration - 0.05) return;
  const partner = partnerOf(clip);
  const second = splitOne(clip, time);
  if (partner && time > partner.startTime + 0.05 && time < partner.startTime + partner.duration - 0.05) {
    const secondPartner = splitOne(partner, time);
    clip.linkedClipId = partner.id;
    partner.linkedClipId = clip.id;
    second.linkedClipId = secondPartner.id;
    secondPartner.linkedClipId = second.id;
  }
  pushHistory();
  renderTimeline();
  commitPlayback();
}

export function deleteSelected(ripple = true) {
  const clip = selectedClip();
  if (!clip) return;
  const victims = [clip];
  if (ripple && clip.type !== 'audio') {
    const partner = partnerOf(clip);
    if (partner) victims.push(partner);
  }
  const removed = new Set(victims.map(item => item.id));
  if (ripple) {
    for (const victim of victims) {
      const end = victim.startTime + victim.duration;
      for (const other of state.clips) {
        if (removed.has(other.id) || other.trackId !== victim.trackId) continue;
        if (other.startTime >= end - 0.02) other.startTime = Math.max(0, other.startTime - victim.duration);
      }
    }
  }
  state.clips = state.clips.filter(item => !removed.has(item.id));
  for (const item of state.clips) if (removed.has(item.linkedClipId)) item.linkedClipId = null;
  state.selectedClipId = null;
  pushHistory();
  renderTimeline();
  commitPlayback();
  notify();
}

let clipClipboard = null;

export function copySelected() {
  const clip = selectedClip();
  if (!clip) return;
  const partner = partnerOf(clip);
  clipClipboard = JSON.parse(JSON.stringify(partner ? [clip, partner] : [clip]));
  flash('Clip copied');
}

export function pasteClipboard() {
  if (!clipClipboard?.length) {
    flash('Nothing to paste');
    return;
  }
  const base = Math.min(...clipClipboard.map(item => item.startTime));
  const shift = state.currentTime - base;
  const copies = clipClipboard.map(src => ({
    ...src,
    id: uid('clip'),
    startTime: Math.max(0, src.startTime + shift),
    linkedClipId: null
  }));
  const ids = new Map(clipClipboard.map((src, index) => [src.id, copies[index]]));
  clipClipboard.forEach((src, index) => {
    const linked = ids.get(src.linkedClipId);
    if (linked) copies[index].linkedClipId = linked.id;
  });
  state.clips.push(...copies);
  state.selectedClipId = copies[0].id;
  pushHistory();
  renderTimeline();
  commitPlayback();
  notify();
}

export function setInPoint() {
  state.inPoint = state.currentTime;
  if (state.outPoint != null && state.outPoint <= state.inPoint) state.outPoint = null;
  pushHistory();
  renderTimeline();
}

export function setOutPoint() {
  state.outPoint = state.currentTime;
  if (state.inPoint != null && state.inPoint >= state.outPoint) state.inPoint = null;
  pushHistory();
  renderTimeline();
}

export function clearPoints() {
  state.inPoint = null;
  state.outPoint = null;
  pushHistory();
  renderTimeline();
}

export function duplicateSelected() {
  const clip = selectedClip();
  if (!clip) return;
  const partner = partnerOf(clip);
  const shift = clip.duration;
  const copy = {
    ...clip,
    id: uid('clip'),
    startTime: clip.startTime + shift,
    linkedClipId: null
  };
  state.clips.push(copy);
  if (partner) {
    const copyPartner = {
      ...partner,
      id: uid('clip'),
      startTime: partner.startTime + shift,
      linkedClipId: copy.id
    };
    copy.linkedClipId = copyPartner.id;
    state.clips.push(copyPartner);
  }
  pushHistory();
  renderTimeline();
  commitPlayback();
}

export function unlinkSelected() {
  document.getElementById('context-menu')?.classList.add('hidden');
  const clip = selectedClip();
  if (!clip) {
    flash('Select a video clip');
    return;
  }
  const partner = partnerOf(clip);
  if (partner) {
    clip.linkedClipId = null;
    partner.linkedClipId = null;
    flash('Audio and video unlinked');
    pushHistory();
    renderTimeline();
    commitPlayback();
    return;
  }
  const videoClip = clip.type === 'video' ? clip : null;
  if (!videoClip || !assetById(videoClip.assetId)) {
    flash('No linked audio to separate');
    return;
  }
  const audioClip = makeAudioPartner(videoClip);
  audioClip.linkedClipId = null;
  videoClip.linkedClipId = null;
  videoClip.muteAudio = true;
  flash('Audio moved to the audio track');
  pushHistory();
  renderTimeline();
  commitPlayback();
}

export function toggleSnapping() {
  state.isSnapping = !state.isSnapping;
  const btn = document.getElementById('btn-snap');
  btn.className = state.isSnapping
    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50 px-2 py-1 rounded flex items-center gap-1'
    : 'bg-vegas-border text-slate-400 px-2 py-1 rounded flex items-center gap-1';
}
