import { state, assetById, contentEnd, flash } from './state.js';
import { audioContext, drawAtTime, holdPreview, renderPaused } from './playback.js';

const MUX = {
  'avc1.640028': 'avc',
  'vp09.00.10.08': 'vp9',
  'av01.0.04M.08': 'av1'
};

function even(n) {
  const v = Math.max(2, Math.round(Number(n) || 2));
  return v - (v % 2);
}

function setBadge(ok, text) {
  const badge = document.getElementById('codec-status-badge');
  if (!badge) return;
  badge.textContent = ok ? `✓ ${text}` : text;
  badge.className = ok
    ? 'mt-1 inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800'
    : 'mt-1 inline-block text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 border border-amber-800';
}

export async function checkCodecSupport() {
  const codec = document.getElementById('exp-codec').value;
  const width = even(document.getElementById('exp-width').value);
  const height = even(document.getElementById('exp-height').value);
  const bitrate = Math.max(1, Number(document.getElementById('exp-bitrate').value) || 8) * 1e6;
  const framerate = Number(document.getElementById('exp-fps').value) || 30;
  if (!('VideoEncoder' in window)) {
    setBadge(false, 'Sin WebCodecs, se usará MediaRecorder');
    return;
  }
  try {
    const res = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate, framerate });
    setBadge(!!res.supported, res.supported ? 'Hardware compatible' : 'Códec no disponible');
  } catch {
    setBadge(false, 'No se pudo comprobar el códec');
  }
}

export function applyExportPreset(val) {
  const width = document.getElementById('exp-width');
  const height = document.getElementById('exp-height');
  if (val === '1080p') { width.value = 1920; height.value = 1080; }
  else if (val === '4k') { width.value = 3840; height.value = 2160; }
  else if (val === '720p') { width.value = 1280; height.value = 720; }
  checkCodecSupport();
}

function exportSettings() {
  return {
    width: even(document.getElementById('exp-width').value),
    height: even(document.getElementById('exp-height').value),
    fps: Number(document.getElementById('exp-fps').value) || 30,
    bitrate: Math.max(1, Number(document.getElementById('exp-bitrate').value) || 8) * 1e6,
    codec: document.getElementById('exp-codec').value
  };
}

function audibleBuffers() {
  return state.clips.some(clip => {
    if (clip.muteAudio || (clip.type !== 'video' && clip.type !== 'audio')) return false;
    const track = state.tracks.find(t => t.id === clip.trackId);
    if (!track || track.muted) return false;
    return !!assetById(clip.assetId)?.audioBuffer;
  });
}

async function mixAudio(duration) {
  if (!audibleBuffers()) return null;
  const sampleRate = 48000;
  const length = Math.max(1, Math.ceil(duration * sampleRate));
  const offline = new OfflineAudioContext(2, length, sampleRate);
  for (const clip of state.clips) {
    if (clip.muteAudio || (clip.type !== 'video' && clip.type !== 'audio')) continue;
    const track = state.tracks.find(t => t.id === clip.trackId);
    if (!track || track.muted) continue;
    const asset = assetById(clip.assetId);
    if (!asset?.audioBuffer) continue;
    const offset = clip.startOffset || 0;
    const available = asset.audioBuffer.duration - offset;
    if (available <= 0.02) continue;
    const src = offline.createBufferSource();
    src.buffer = asset.audioBuffer;
    const gain = offline.createGain();
    const vol = clip.volume ?? 1;
    const t0 = Math.max(0, clip.startTime);
    const t1 = t0 + clip.duration;
    const fadeIn = clip.fadeIn || 0;
    const fadeOut = clip.fadeOut || 0;
    const fadeInEnd = Math.min(t1, t0 + fadeIn);
    const g = gain.gain;
    g.setValueAtTime(fadeIn > 0 ? 0 : vol, t0);
    if (fadeIn > 0 && fadeInEnd > t0) g.linearRampToValueAtTime(vol, fadeInEnd);
    if (fadeOut > 0 && t1 > fadeInEnd) {
      const fadeStart = Math.max(fadeInEnd, t1 - fadeOut);
      if (fadeStart > fadeInEnd + 0.001) g.setValueAtTime(vol, fadeStart);
      g.linearRampToValueAtTime(0, t1);
    }
    src.connect(gain);
    gain.connect(offline.destination);
    src.start(t0, offset, Math.min(clip.duration, available));
  }
  return offline.startRendering();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function encodePcm(encoder, buffer) {
  const channels = 2;
  const rate = buffer.sampleRate;
  const size = 1024;
  for (let i = 0; i < buffer.length; i += size) {
    const n = Math.min(size, buffer.length - i);
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) {
      const ch = buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1));
      data.set(ch.subarray(i, i + n), c * n);
    }
    const audioData = new AudioData({
      format: 'f32-planar',
      sampleRate: rate,
      numberOfFrames: n,
      numberOfChannels: channels,
      timestamp: Math.round((i / rate) * 1e6),
      data
    });
    encoder.encode(audioData);
    audioData.close();
  }
}

async function exportWebCodecs(canvas, ctx, settings, duration, mixed) {
  const { Muxer, ArrayBufferTarget } = await import('https://cdn.jsdelivr.net/npm/mp4-muxer@5.2.2/build/mp4-muxer.mjs');
  const { width, height, fps, bitrate, codec } = settings;
  let audioOn = false;
  if (mixed && 'AudioEncoder' in window) {
    const support = await AudioEncoder.isConfigSupported({
      codec: 'mp4a.40.2',
      sampleRate: mixed.sampleRate,
      numberOfChannels: 2,
      bitrate: 128000
    });
    audioOn = !!support.supported;
  }
  const muxerOptions = {
    target: new ArrayBufferTarget(),
    video: { codec: MUX[codec] || 'avc', width, height },
    firstTimestampBehavior: 'offset',
    fastStart: 'in-memory'
  };
  if (audioOn) {
    muxerOptions.audio = { codec: 'aac', numberOfChannels: 2, sampleRate: mixed.sampleRate };
  }
  const muxer = new Muxer(muxerOptions);
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (err) => console.error(err)
  });
  videoEncoder.configure({ codec, width, height, bitrate, framerate: fps });
  let audioEncoder = null;
  if (audioOn) {
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (err) => console.error(err)
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: mixed.sampleRate,
      numberOfChannels: 2,
      bitrate: 128000
    });
    encodePcm(audioEncoder, mixed);
  }
  const total = Math.max(1, Math.round(duration * fps));
  const bar = document.getElementById('exp-progress-bar');
  const label = document.getElementById('exp-progress-label');
  const percent = document.getElementById('exp-progress-percent');
  for (let frame = 0; frame < total; frame++) {
    await drawAtTime(ctx, width, height, frame / fps);
    const videoFrame = new VideoFrame(canvas, { timestamp: Math.round((frame * 1e6) / fps) });
    videoEncoder.encode(videoFrame, { keyFrame: frame % fps === 0 });
    videoFrame.close();
    const pct = Math.round(((frame + 1) / total) * 100);
    bar.style.width = `${pct}%`;
    percent.textContent = `${pct}%`;
    label.textContent = `Fotograma ${frame + 1} / ${total}`;
    if (frame % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }
  await videoEncoder.flush();
  if (audioEncoder) await audioEncoder.flush();
  muxer.finalize();
  download(new Blob([muxer.target.buffer], { type: 'video/mp4' }), 'Render_Vegas_Pro.mp4');
}

async function exportRecorder(canvas, ctx, settings, duration, mixed) {
  const { width, height, fps } = settings;
  const stream = canvas.captureStream(fps);
  let source = null;
  if (mixed) {
    const actx = audioContext();
    await actx.resume();
    const dest = actx.createMediaStreamDestination();
    source = actx.createBufferSource();
    source.buffer = mixed;
    source.connect(dest);
    source.start();
    for (const track of dest.stream.getAudioTracks()) stream.addTrack(track);
  }
  const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(type => MediaRecorder.isTypeSupported(type)) || '';
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  const done = new Promise((resolve) => {
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => resolve();
  });
  rec.start();
  const total = Math.max(1, Math.round(duration * fps));
  const bar = document.getElementById('exp-progress-bar');
  const label = document.getElementById('exp-progress-label');
  const percent = document.getElementById('exp-progress-percent');
  for (let frame = 0; frame < total; frame++) {
    await drawAtTime(ctx, width, height, frame / fps);
    const pct = Math.round(((frame + 1) / total) * 100);
    bar.style.width = `${pct}%`;
    percent.textContent = `${pct}%`;
    label.textContent = `Grabando ${frame + 1} / ${total}`;
    await new Promise(r => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  await done;
  try { source?.stop(); } catch { /* ended */ }
  download(new Blob(chunks, { type: mime || 'video/webm' }), 'Render_Vegas_Pro.webm');
}

export async function startExport() {
  const duration = contentEnd();
  const btn = document.getElementById('btn-start-export');
  const box = document.getElementById('export-progress-box');
  const label = document.getElementById('exp-progress-label');
  const bar = document.getElementById('exp-progress-bar');
  const percent = document.getElementById('exp-progress-percent');
  if (duration <= 0) {
    flash('No hay clips para exportar');
    return;
  }
  btn.disabled = true;
  box.classList.remove('hidden');
  bar.style.width = '0%';
  percent.textContent = '0%';
  label.textContent = 'Preparando…';
  holdPreview(true);
  const settings = exportSettings();
  const canvas = document.createElement('canvas');
  canvas.width = settings.width;
  canvas.height = settings.height;
  const ctx = canvas.getContext('2d', { alpha: false });
  let mixed = null;
  let wantedAudio = state.clips.some(c => (c.type === 'video' || c.type === 'audio') && !c.muteAudio);
  try {
    mixed = await mixAudio(duration);
  } catch (err) {
    console.warn('mix', err);
    mixed = null;
  }
  try {
    if ('VideoEncoder' in window) {
      try {
        await exportWebCodecs(canvas, ctx, settings, duration, mixed);
      } catch (err) {
        console.warn('WebCodecs', err);
        label.textContent = 'WebCodecs falló, grabando…';
        await exportRecorder(canvas, ctx, settings, duration, mixed);
      }
    } else {
      await exportRecorder(canvas, ctx, settings, duration, mixed);
    }
    label.textContent = mixed || !wantedAudio ? 'Exportación lista' : 'Listo, sin audio: el navegador no decodificó la pista';
  } catch (err) {
    console.error(err);
    label.textContent = 'No se pudo exportar';
  } finally {
    btn.disabled = false;
    holdPreview(false);
    renderPaused();
  }
}

export function openExportModal() {
  document.getElementById('export-modal').classList.remove('hidden');
}

export function closeExportModal() {
  document.getElementById('export-modal').classList.add('hidden');
}
