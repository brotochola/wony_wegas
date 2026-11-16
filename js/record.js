// Record from the webcam, the microphone, or both. The recording becomes a normal media file:
// it goes into Project Media and, if asked, onto the timeline. In Chrome it can also be saved
// as a real file, so a saved project can reopen it later.
import { state, flash } from './state.js';
import { importEntries, fileKey } from './media.js';
import { insertAsset } from './timeline.js';

const MODES = {
  both: { video: true, audio: true },
  mic: { video: false, audio: true },
  cam: { video: true, audio: false },
};
const VIDEO_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const AUDIO_TYPES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
const PREFS_KEY = 'wony-record';

const $ = (id) => document.getElementById(id);
const prefs = { mode: 'both', camera: '', mic: '', toTimeline: true, saveFile: true };

let stream = null;
let recorder = null;
let chunks = [];
let startedAt = 0;
let tick = 0;
let meter = null;
let opening = 0;

function loadPrefs() {
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || '{}')); } catch { /* defaults */ }
}

function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ }
}

function pickType(list) {
  return list.find(t => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

function stopStream() {
  cancelAnimationFrame(meter?.raf || 0);
  meter?.ctx.close().catch(() => {});
  meter = null;
  for (const track of stream?.getTracks() || []) track.stop();
  stream = null;
  $('rec-preview').srcObject = null;
}

function showModal(on) {
  const el = $('record-modal');
  el.classList.toggle('hidden', !on);
  el.classList.toggle('flex', on);
}

async function fillDevices() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const fill = (select, kind, current) => {
    const list = devices.filter(d => d.kind === kind);
    select.replaceChildren(...list.map((d, i) => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `${kind === 'videoinput' ? 'Camera' : 'Microphone'} ${i + 1}`;
      return opt;
    }));
    if (list.some(d => d.deviceId === current)) select.value = current;
  };
  fill($('rec-camera'), 'videoinput', prefs.camera);
  fill($('rec-mic'), 'audioinput', prefs.mic);
}

function startMeter() {
  if (!stream?.getAudioTracks().length) return;
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  const bar = $('rec-level');
  meter = { ctx, raf: 0 };
  const draw = () => {
    analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    const db = 20 * Math.log10(peak + 1e-6); // -60 dB empty, 0 dB full
    bar.style.width = `${Math.max(0, Math.min(100, (db + 60) / 60 * 100))}%`;
    bar.className = `h-full ${db > -3 ? 'bg-red-500' : db > -12 ? 'bg-amber-400' : 'bg-emerald-500'}`;
    meter.raf = requestAnimationFrame(draw);
  };
  draw();
}

// Ask for the camera and/or microphone of the chosen mode and show the preview.
async function openStream() {
  const mine = ++opening;
  stopStream();
  const mode = MODES[prefs.mode];
  syncModeUi();
  $('rec-status').textContent = 'Asking for permission…';
  try {
    const next = await navigator.mediaDevices.getUserMedia({
      video: mode.video ? {
        deviceId: prefs.camera ? { exact: prefs.camera } : undefined,
        width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 },
      } : false,
      audio: mode.audio ? { deviceId: prefs.mic ? { exact: prefs.mic } : undefined } : false,
    });
    if (mine !== opening) { for (const t of next.getTracks()) t.stop(); return; }
    stream = next;
  } catch (err) {
    if (mine !== opening) return;
    console.warn(err);
    const denied = err?.name === 'NotAllowedError';
    $('rec-status').textContent = denied
      ? 'The browser did not allow the camera or microphone. Allow them in the address bar and try again.'
      : `Could not open the ${mode.video ? 'camera' : 'microphone'}: ${err?.message || err}`;
    // a device that disappeared: forget it and use the default next time
    if (err?.name === 'OverconstrainedError') { prefs.camera = ''; prefs.mic = ''; savePrefs(); }
    $('rec-start').disabled = true;
    return;
  }
  await fillDevices();
  if (mode.video) {
    $('rec-preview').srcObject = stream;
    $('rec-preview').play().catch(() => {});
    const s = stream.getVideoTracks()[0]?.getSettings() || {};
    // a mirror only for the camera that looks at you; the back camera shows the world as it is
    $('rec-preview').classList.toggle('-scale-x-100', s.facingMode !== 'environment');
    $('rec-flip').classList.toggle('hidden', $('rec-camera').options.length < 2);
    $('rec-status').textContent = `${s.width || '?'}×${s.height || '?'}${s.frameRate ? ` · ${Math.round(s.frameRate)} fps` : ''}${mode.audio ? ' · with sound' : ' · no sound'}`;
  } else {
    $('rec-status').textContent = 'Microphone ready';
  }
  startMeter();
  $('rec-start').disabled = false;
}

function syncModeUi() {
  const mode = MODES[prefs.mode];
  for (const btn of document.querySelectorAll('[data-rec-mode]')) {
    const on = btn.dataset.recMode === prefs.mode;
    btn.className = `flex-1 px-2 py-1.5 rounded border ${on ? 'border-cyan-400 bg-cyan-500/15 text-cyan-300 font-bold' : 'border-vegas-border text-slate-300 hover:border-slate-500'}`;
    btn.disabled = !!recorder;
  }
  $('rec-camera-wrap').classList.toggle('hidden', !mode.video);
  $('rec-mic-wrap').classList.toggle('hidden', !mode.audio);
  $('rec-preview').classList.toggle('hidden', !mode.video);
  $('rec-mic-only').classList.toggle('hidden', mode.video);
  $('rec-level-wrap').classList.toggle('hidden', !mode.audio);
  $('rec-camera').disabled = $('rec-mic').disabled = $('rec-flip').disabled = !!recorder;
}

function clock() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $('rec-time').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function start() {
  if (!stream || recorder) return;
  const video = MODES[prefs.mode].video;
  const mimeType = pickType(video ? VIDEO_TYPES : AUDIO_TYPES);
  try {
    recorder = new MediaRecorder(stream, mimeType ? {
      mimeType,
      videoBitsPerSecond: video ? 8_000_000 : undefined,
      audioBitsPerSecond: 160_000,
    } : undefined);
  } catch (err) {
    flash(`This browser can't record: ${err.message}`, 'error');
    recorder = null;
    return;
  }
  chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.start(1000);
  startedAt = Date.now();
  clock();
  tick = setInterval(clock, 250);
  $('rec-start').classList.add('hidden');
  $('rec-stop').classList.remove('hidden');
  $('rec-dot').classList.add('animate-pulse');
  $('rec-dot').classList.remove('opacity-30');
  syncModeUi();
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
}

async function stop() {
  if (!recorder) return;
  const rec = recorder;
  const done = new Promise((resolve) => { rec.onstop = resolve; });
  rec.stop();
  await done;
  clearInterval(tick);
  recorder = null;
  const type = (rec.mimeType || chunks[0]?.type || 'video/webm').split(';')[0];
  const ext = type.endsWith('mp4') ? (type.startsWith('audio') ? 'm4a' : 'mp4') : 'webm';
  const name = `Recording ${stamp()}.${ext}`;
  const blob = new Blob(chunks, { type });
  chunks = [];
  let entry = { file: new File([blob], name, { type, lastModified: Date.now() }) };

  if (prefs.saveFile && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: name,
        types: [{ description: 'Recording', accept: { [type]: [`.${ext}`] } }],
      });
      const out = await handle.createWritable();
      await out.write(blob);
      await out.close();
      entry = { file: await handle.getFile(), handle };
    } catch (err) {
      if (err?.name !== 'AbortError') flash(`Could not save the file: ${err.message}`, 'error');
    }
  }

  closeRecorder();
  await importEntries([entry]);
  const key = fileKey(entry.file);
  const asset = state.mediaPool.find(a => a.fileKey === key);
  if (asset && prefs.toTimeline) insertAsset(asset.id);
}

function closeRecorder() {
  if (recorder) {
    recorder.onstop = null;
    recorder.stop();
    recorder = null;
    chunks = [];
  }
  clearInterval(tick);
  opening++;
  stopStream();
  showModal(false);
  $('rec-start').classList.remove('hidden');
  $('rec-stop').classList.add('hidden');
  $('rec-dot').classList.remove('animate-pulse');
  $('rec-dot').classList.add('opacity-30');
  $('rec-time').textContent = '00:00';
}

function openRecorder() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    flash('This browser cannot record. Try Chrome or Edge.', 'error');
    return;
  }
  showModal(true);
  $('rec-to-timeline').checked = prefs.toTimeline;
  $('rec-save-file').checked = prefs.saveFile;
  $('rec-save-wrap').classList.toggle('hidden', !window.showSaveFilePicker);
  openStream();
}

export function isRecording() {
  return !!recorder;
}

export function initRecorder() {
  loadPrefs();
  $('btn-record').addEventListener('click', openRecorder);
  $('rec-close').addEventListener('click', () => {
    if (recorder && !confirmDiscard()) return;
    closeRecorder();
  });
  for (const btn of document.querySelectorAll('[data-rec-mode]')) {
    btn.addEventListener('click', () => {
      if (recorder) return;
      prefs.mode = btn.dataset.recMode;
      savePrefs();
      openStream();
    });
  }
  $('rec-camera').addEventListener('change', (e) => { prefs.camera = e.target.value; savePrefs(); openStream(); });
  // phones: front and back camera with one tap
  $('rec-flip').addEventListener('click', () => {
    const select = $('rec-camera');
    if (recorder || select.options.length < 2) return;
    select.selectedIndex = (select.selectedIndex + 1) % select.options.length;
    prefs.camera = select.value;
    savePrefs();
    openStream();
  });
  $('rec-mic').addEventListener('change', (e) => { prefs.mic = e.target.value; savePrefs(); openStream(); });
  $('rec-to-timeline').addEventListener('change', (e) => { prefs.toTimeline = e.target.checked; savePrefs(); });
  $('rec-save-file').addEventListener('change', (e) => { prefs.saveFile = e.target.checked; savePrefs(); });
  $('rec-start').addEventListener('click', start);
  $('rec-stop').addEventListener('click', stop);
  window.addEventListener('beforeunload', (e) => {
    if (!recorder) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

// The page's own dialogs live in main.js; a plain one is enough to protect a running take.
function confirmDiscard() {
  return window.confirm('Stop and throw away this recording?');
}
