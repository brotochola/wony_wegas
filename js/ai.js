// Transcript and silence removal.
//
// - Speech is found with Silero VAD (in ai-worker.js). Cuts come only from the VAD, so they do not
//   depend on which transcription engine is used (in the benchmark the VAD shortened every long pause
//   and lost the least speech; cutting by word times deleted sentences the model skipped).
// - Transcripts come from local Whisper (WebGPU or WASM, in the worker) or from Groq with your own key.
// - Everything is computed once per file and cached in IndexedDB by file key.
import { state, uid, assetById, pushHistory, flash, formatDuration } from './state.js';
import { renderTimeline } from './timeline.js';
import { seek, commitPlayback, audioContext } from './playback.js';
import { SR, splitPoints, speechSpans, cutParams, keepRanges, encodeWav } from './ai-shared.js';
import { createCaptions, fitCaptions } from './captions-ui.js';
import { aiSupport, findHighlights, translateWords, detectLanguage } from './smart.js';

const SETTINGS_KEY = 'wony-ai';
const DOUBT = 0.5; // words under this confidence are marked for review
const settings = { engine: 'local:base', language: 'es', aggressiveness: 0.5, groqKey: '' };

const $ = (id) => document.getElementById(id);

// ---------- settings ----------

function loadSettings() {
  try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* defaults */ }
}

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* private mode */ }
}

// ---------- IndexedDB cache ----------

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('wony-ai', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('vad')) db.createObjectStore('vad');
      if (!db.objectStoreNames.contains('transcripts')) db.createObjectStore('transcripts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function cacheGet(store, key) {
  try {
    const db = await openDb();
    const value = await new Promise((resolve, reject) => {
      const req = db.transaction(store, 'readonly').objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return value || null;
  } catch (err) {
    console.warn(err);
    return null;
  }
}

async function cachePut(store, key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch (err) {
    console.warn(err);
  }
}

function assetKey(asset) {
  return asset.fileKey || `${asset.name}|${Math.round((asset.duration || 0) * 1000)}`;
}

function transcriptKey(asset) {
  return `${assetKey(asset)}|${settings.engine}|${settings.language}`;
}

// ---------- audio at 16 kHz mono ----------

const pcmCache = new Map();

async function pcm16k(asset) {
  if (pcmCache.has(asset.id)) return pcmCache.get(asset.id);
  let buffer = asset.audioBuffer;
  if (!buffer) {
    const raw = asset.file ? await asset.file.arrayBuffer() : await (await fetch(asset.url)).arrayBuffer();
    try {
      buffer = await audioContext().decodeAudioData(raw.slice(0));
    } catch {
      throw new Error(`Could not read the audio of "${asset.name}". Does it have sound?`);
    }
  }
  const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * SR), SR);
  const src = off.createBufferSource();
  src.buffer = buffer;
  src.connect(off.destination); // stereo is mixed down to mono here
  src.start();
  const pcm = (await off.startRendering()).getChannelData(0).slice();
  pcmCache.set(asset.id, pcm);
  return pcm;
}

// ---------- worker jobs ----------

let worker = null;
let jobSeq = 0;
const jobs = new Map();

function runJob(type, payload, onProgress) {
  if (!worker) {
    worker = new Worker(new URL('./ai-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const job = jobs.get(e.data.id);
      if (!job) return;
      if (e.data.type === 'progress') job.onProgress?.(e.data.value, e.data.text);
      else {
        jobs.delete(e.data.id);
        if (e.data.type === 'done') job.resolve(e.data.result);
        else job.reject(new Error(e.data.message));
      }
    };
    worker.onerror = (e) => {
      for (const job of jobs.values()) job.reject(new Error(e.message || 'AI worker failed'));
      jobs.clear();
      worker = null;
    };
  }
  return new Promise((resolve, reject) => {
    const id = ++jobSeq;
    jobs.set(id, { resolve, reject, onProgress });
    const pcm = payload.pcm.slice(); // the copy travels to the worker, the cache keeps the original
    worker.postMessage({ id, type, ...payload, pcm }, [pcm.buffer]);
  });
}

// ---------- progress ----------

let busy = false;

function progress(value, text) {
  $('ai-progress').classList.remove('hidden');
  $('ai-progress-bar').style.width = `${Math.round(Math.max(0, Math.min(1, value || 0)) * 100)}%`;
  if (text) $('ai-progress-text').textContent = text;
}

function progressDone() {
  $('ai-progress').classList.add('hidden');
}

async function withBusy(fn) {
  if (busy) return;
  busy = true;
  syncButtons();
  try {
    await fn();
  } catch (err) {
    console.error(err);
    flash(err.message || String(err), 'error');
  } finally {
    busy = false;
    progressDone();
    syncButtons();
  }
}

// ---------- which clip ----------

function isMedia(clip) {
  return clip && (clip.type === 'video' || clip.type === 'audio');
}

// The selected clip, or the only video clip when nothing is selected, together with every other piece
// of the same file on that track (after cutting, "this video" is many pieces). Each piece brings its
// linked audio when both cover the same stretch of the file.
function target() {
  let clip = state.clips.find(c => c.id === state.selectedClipId);
  if (!isMedia(clip)) {
    const videos = new Set(state.clips.filter(c => c.type === 'video').map(c => c.assetId));
    const media = new Set(state.clips.filter(isMedia).map(c => c.assetId));
    const only = videos.size === 1 ? [...videos][0] : (!videos.size && media.size === 1 ? [...media][0] : null);
    clip = only ? state.clips.find(c => c.assetId === only && (videos.size ? c.type === 'video' : true)) : null;
  }
  if (!clip) return null;
  const asset = assetById(clip.assetId);
  if (!asset?.duration) return null;
  const near = (x, y) => Math.abs(x - y) < 0.01;
  const units = state.clips
    .filter(c => c.assetId === clip.assetId && c.trackId === clip.trackId)
    .sort((a, b) => a.startTime - b.startTime)
    .map((c) => {
      const partner = c.linkedClipId ? state.clips.find(o => o.id === c.linkedClipId) : null;
      const aligned = partner && near(partner.startTime, c.startTime) && near(partner.duration, c.duration)
        && near(partner.startOffset || 0, c.startOffset || 0);
      return { clip: c, group: aligned ? [c, partner] : [c] };
    });
  const total = units.reduce((sum, u) => sum + u.clip.duration, 0);
  return { clip, asset, units, total };
}

// ---------- silences ----------

const vadMem = new Map(); // asset id -> { probs, hop, duration }

async function getVad(asset) {
  if (vadMem.has(asset.id)) return vadMem.get(asset.id);
  let vad = await cacheGet('vad', assetKey(asset));
  if (!vad) {
    progress(0, 'Reading the audio');
    const pcm = await pcm16k(asset);
    const result = await runJob('vad', { pcm }, progress);
    vad = { probs: result.probs, hop: result.hop, duration: pcm.length / SR };
    await cachePut('vad', assetKey(asset), vad);
  }
  vadMem.set(asset.id, vad);
  return vad;
}

const snap = (t) => Math.round(t * state.fps) / state.fps;

// What to keep of a file: speech with a little air (silences), or the chosen sentences (highlights).
function keepFor(asset) {
  if (previewMode === 'highlights') return hlMem.get(asset.id)?.ranges || null;
  const vad = vadMem.get(asset.id);
  if (!vad) return null;
  const spans = speechSpans(vad.probs, vad.hop);
  if (!spans.length) return [];
  return keepRanges(spans, vad.duration, cutParams(settings.aggressiveness));
}

// The pieces of one clip to keep, in file time.
function planCuts(clip, keep) {
  if (!keep.length) return { pieces: [], removed: 0, cuts: 0, noSpeech: true };
  const a = clip.startOffset || 0;
  const b = a + clip.duration;
  const pieces = [];
  for (const [s, e] of keep) {
    const from = snap(Math.max(s, a));
    const to = snap(Math.min(e, b));
    if (to - from <= 0.001) continue;
    // a removal shorter than 0.1 s is not worth a cut
    if (pieces.length && from - pieces.at(-1)[1] < 0.1) pieces.at(-1)[1] = to;
    else pieces.push([from, to]);
  }
  // the editor's shortest clip is 0.2 s: join tiny pieces to a neighbour, keeping the gap
  for (let i = 0; i < pieces.length; i++) {
    if (pieces[i][1] - pieces[i][0] >= 0.2 || pieces.length === 1) continue;
    if (i > 0) { pieces[i - 1][1] = pieces[i][1]; pieces.splice(i, 1); }
    else { pieces[1][0] = pieces[0][0]; pieces.splice(0, 1); }
    i--;
  }
  const kept = pieces.reduce((sum, [s, e]) => sum + (e - s), 0);
  const removedRegions = [];
  let cursor = a;
  for (const [s, e] of pieces) {
    if (s - cursor > 0.001) removedRegions.push([cursor, s]);
    cursor = e;
  }
  if (b - cursor > 0.001) removedRegions.push([cursor, b]);
  return { pieces, removed: clip.duration - kept, cuts: removedRegions.length, removedRegions };
}

let previewOn = false;
let previewMode = 'silence'; // or 'highlights'
const hlMem = new Map(); // asset id -> { ranges, ids, summary, title, method }

function refreshPreview() {
  const t = target();
  const keep = t && keepFor(t.asset);
  const info = $(previewMode === 'highlights' ? 'ai-hl-info' : 'ai-cut-info');
  $(previewMode === 'highlights' ? 'ai-cut-info' : 'ai-hl-info').textContent = '';
  if (!previewOn || !t || !keep) {
    state.cutPreview = null;
    info.textContent = previewOn && t ? (previewMode === 'highlights' ? 'Press "Find highlights" for this clip.' : 'Press "Find silences" for this clip.') : '';
    renderTimeline();
    syncButtons();
    return;
  }
  const regions = [];
  let removed = 0, cuts = 0, noSpeech = false;
  for (const u of t.units) {
    const plan = planCuts(u.clip, keep);
    noSpeech ||= !!plan.noSpeech;
    removed += plan.removed;
    cuts += plan.cuts;
    const start = u.clip.startTime;
    const off = u.clip.startOffset || 0;
    for (const [s, e] of plan.removedRegions || []) regions.push([start + s - off, start + e - off]);
  }
  state.cutPreview = { regions };
  info.textContent = noSpeech && !cuts
    ? (previewMode === 'highlights' ? 'No highlights in this clip.' : 'No speech found.')
    : cuts
      ? previewMode === 'highlights'
        ? `Keeps ${formatDuration(t.total - removed)} of ${formatDuration(t.total)} in ${hlParts(t)} part${hlParts(t) === 1 ? '' : 's'}`
        : `Removes ${formatDuration(removed)} in ${cuts} cut${cuts === 1 ? '' : 's'}: ${formatDuration(t.total)} → ${formatDuration(t.total - removed)}`
      : 'Nothing to cut at this setting.';
  renderTimeline();
  syncButtons();
}

function hlParts(t) {
  return hlMem.get(t.asset.id)?.ranges.length || 0;
}

async function findSilences() {
  const t = target();
  if (!t) { flash('Select a video or audio clip first', 'error'); return; }
  await withBusy(async () => {
    await getVad(t.asset);
    previewOn = true;
    previewMode = 'silence';
    refreshPreview();
  });
}

// ---------- highlights ----------

function currentTranscript(t) {
  return t ? transcriptMem.get(transcriptKey(t.asset)) : null;
}

function hlSeconds(t) {
  const v = $('ai-hl-length').value;
  return v.endsWith('%') ? t.total * parseFloat(v) / 100 : parseFloat(v);
}

async function findHl() {
  const t = target();
  const tr = currentTranscript(t);
  if (!tr) { flash('Transcribe first', 'error'); return; }
  const seconds = Math.min(hlSeconds(t), t.total);
  const words = tr.words.map(w => ({ w: w.w, s: w.start, e: w.end }));
  // only the part of the file that is on the timeline
  const onTimeline = words.filter(w => timelineTime(t.asset, t.clip.type, (w.s + w.e) / 2) != null);
  await withBusy(async () => {
    progress(0, "Starting Chrome's built-in AI");
    const lang = settings.language === 'auto' ? (await detectLanguage(onTimeline.map(w => w.w).join(' '))) || 'en' : settings.language;
    const result = await findHighlights(onTimeline, seconds, lang, progress);
    hlMem.set(t.asset.id, result);
    previewOn = true;
    previewMode = 'highlights';
    renderSummary(result);
    refreshPreview();
    renderTranscript();
  });
}

function renderSummary(result) {
  const box = $('ai-summary');
  box.replaceChildren();
  if (!result) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  if (result.title) {
    const h = document.createElement('p');
    h.className = 'font-bold text-slate-100';
    h.textContent = result.title;
    box.append(h);
  }
  const points = (result.summary || '').split(/\n+/).map(l => l.replace(/^[\s*•\-–]+/, '').trim()).filter(Boolean);
  if (points.length) {
    const ul = document.createElement('ul');
    ul.className = 'list-disc pl-4 space-y-0.5';
    for (const p of points) {
      const li = document.createElement('li');
      li.textContent = p;
      ul.append(li);
    }
    box.append(ul);
  }
  const how = document.createElement('p');
  how.className = 'text-slate-500 mt-1';
  how.textContent = `Chosen with ${result.method} · ${result.ids.length} sentences, in green in the transcript`;
  box.append(how);
}

// ---------- translated subtitles ----------

async function translateCaptions() {
  const t = target();
  const tr = currentTranscript(t);
  if (!tr) { flash('Transcribe first', 'error'); return; }
  const to = $('ai-tr-lang').value;
  // corrected subtitle words win over the raw transcript
  const fixed = state.clips.find(c => c.type === 'captions' && c.captionAsset === t.asset.id && !c.captionLang);
  const words = fixed?.words?.length ? fixed.words : tr.words.map(w => ({ w: w.w, s: w.start, e: w.end }));
  await withBusy(async () => {
    progress(0, 'Starting the translator');
    const from = settings.language === 'auto' ? (await detectLanguage(words.map(w => w.w).join(' '))) || 'en' : settings.language;
    if (from === to) throw new Error('The transcript is already in that language');
    const out = await translateWords(words, from, to, progress);
    createCaptions(t.asset, out.map(w => ({ w: w.w, start: w.s, end: w.e })), settings.captionStyle || 'tiktok', { lang: to });
  });
}

// Replaces one clip (and its linked audio) by the pieces to keep and closes the gaps on its tracks.
function applyUnit(unit, plan) {
  const { clip, group } = unit;
  const start = clip.startTime;
  const end = start + clip.duration;
  const ids = new Set(group.map(c => c.id));
  const tracks = new Set(group.map(c => c.trackId));
  // close the gap on the same tracks, like Delete with auto ripple
  for (const other of state.clips) {
    if (ids.has(other.id) || !tracks.has(other.trackId)) continue;
    if (other.startTime >= end - 0.02) other.startTime = Math.max(0, other.startTime - plan.removed);
  }
  const last = plan.pieces.length - 1;
  const made = group.map((c) => {
    let cursor = start;
    return plan.pieces.map(([s, e], i) => {
      const audio = c.type === 'audio';
      const piece = {
        ...c,
        id: uid('clip'),
        startTime: cursor,
        duration: e - s,
        startOffset: s,
        // 20 ms fades on the inner audio joins avoid clicks; the outer fades stay as they were
        fadeIn: i === 0 ? c.fadeIn || 0 : (audio ? 0.02 : 0),
        fadeOut: i === last ? c.fadeOut || 0 : (audio ? 0.02 : 0),
        linkedClipId: null,
      };
      cursor += e - s;
      return piece;
    });
  });
  if (made.length === 2) {
    made[0].forEach((p, i) => { p.linkedClipId = made[1][i].id; made[1][i].linkedClipId = p.id; });
  }
  state.clips = state.clips.filter(c => !ids.has(c.id)).concat(made.flat());
  return made[0][0].id;
}

function applyCuts() {
  const t = target();
  const keep = t && keepFor(t.asset);
  if (!keep) return;
  const mode = previewMode;
  let removed = 0, cuts = 0, first = null;
  // right to left, so each ripple only moves pieces that are already done
  for (const u of [...t.units].reverse()) {
    const plan = planCuts(u.clip, keep);
    if (!plan.cuts || !plan.pieces.length) continue;
    first = applyUnit(u, plan);
    removed += plan.removed;
    cuts += plan.cuts;
  }
  if (!cuts) { flash('Nothing to cut'); return; }
  state.selectedClipId = first;
  previewOn = false;
  state.cutPreview = null;
  fitCaptions(); // subtitles of this file shrink with it
  pushHistory(); // one step: Ctrl+Z brings everything back
  renderTimeline();
  commitPlayback();
  document.dispatchEvent(new CustomEvent('clip-selected'));
  flash(mode === 'highlights'
    ? `Kept the highlights, removed ${formatDuration(removed)}. Ctrl+Z undoes it.`
    : `Removed ${formatDuration(removed)} in ${cuts} cuts. Ctrl+Z undoes it.`);
  $('ai-cut-info').textContent = '';
  $('ai-hl-info').textContent = '';
  renderTranscript();
}

// ---------- transcription ----------

const transcriptMem = new Map(); // transcript key -> { words, engine, device }

async function groqFetch(form, attempt = 0) {
  const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${settings.groqKey}` },
    body: form,
  });
  if (resp.status === 429 && attempt < 4) {
    const wait = Math.min(60, parseFloat(resp.headers.get('retry-after')) || 10);
    progress(undefined, `Groq limit reached, waiting ${Math.round(wait)} s`);
    await new Promise(r => setTimeout(r, wait * 1000));
    return groqFetch(form, attempt + 1);
  }
  if (resp.status === 401) throw new Error('Groq rejected the API key. Check it in Options.');
  if (!resp.ok) throw new Error(`Groq: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function transcribeGroq(asset, model) {
  if (!settings.groqKey) throw new Error('Add your Groq API key in Options (the gear icon).');
  progress(0, 'Reading the audio');
  const pcm = await pcm16k(asset);
  // Free plan: 25 MB per file. 16 kHz WAV is about 1.9 MB a minute, so pieces of 8 to 10 minutes.
  const cuts = splitPoints(pcm, 480, 600);
  const words = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const offset = cuts[i] / SR;
    progress(offset / (pcm.length / SR), `Transcribing with Groq ${model} (${i + 1}/${cuts.length - 1})`);
    const form = new FormData();
    form.append('file', encodeWav(pcm.subarray(cuts[i], cuts[i + 1])), 'audio.wav');
    form.append('model', model);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
    form.append('temperature', '0');
    if (settings.language !== 'auto') form.append('language', settings.language);
    const data = await groqFetch(form);
    const segments = data.segments || [];
    for (const w of data.words || []) {
      // Groq gives confidence per segment, not per word
      const seg = segments.find(s => w.start >= s.start - 0.01 && w.start < s.end + 0.01);
      const conf = seg?.avg_logprob != null ? Math.exp(seg.avg_logprob) : null;
      words.push({ w: w.word.trim(), start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3), conf: conf == null ? null : +conf.toFixed(3) });
    }
  }
  return { words, engine: `groq:${model}`, device: 'Groq' };
}

async function transcribe() {
  const t = target();
  if (!t) { flash('Select a video or audio clip first', 'error'); return; }
  await withBusy(async () => {
    const [engine, model] = settings.engine.split(':');
    let result;
    if (engine === 'groq') result = await transcribeGroq(t.asset, model);
    else {
      progress(0, 'Reading the audio');
      const pcm = await pcm16k(t.asset);
      result = await runJob('transcribe', { pcm, model, language: settings.language }, progress);
    }
    result.at = Date.now();
    const key = transcriptKey(t.asset);
    transcriptMem.set(key, result);
    await cachePut('transcripts', key, result);
    renderTranscript();
    const doubtful = result.words.filter(w => w.conf != null && w.conf < DOUBT).length;
    flash(`Transcribed ${result.words.length} words${doubtful ? `, ${doubtful} to review` : ''}`);
  });
}

// Where a moment of the file sits on the timeline now (it may have been cut or moved).
function timelineTime(asset, trackType, s) {
  for (const c of state.clips) {
    if (c.assetId !== asset.id || (c.type === 'audio') !== (trackType === 'audio')) continue;
    const off = c.startOffset || 0;
    if (s >= off - 0.001 && s < off + c.duration) return c.startTime + (s - off);
  }
  return null;
}

let shownKey = '';

async function renderTranscript() {
  const box = $('ai-transcript');
  const t = target();
  if (!t) {
    shownKey = '';
    box.innerHTML = '<p class="text-slate-500">Select a video or audio clip.</p>';
    return;
  }
  const key = transcriptKey(t.asset);
  let tr = transcriptMem.get(key);
  if (!tr) {
    tr = await cacheGet('transcripts', key);
    if (tr) transcriptMem.set(key, tr);
  }
  if (!tr) {
    shownKey = '';
    box.innerHTML = '<p class="text-slate-500">No transcript yet for this file with this engine and language.</p>';
    syncButtons();
    return;
  }
  shownKey = key;
  const type = t.clip.type;
  const picks = previewOn && previewMode === 'highlights' ? hlMem.get(t.asset.id)?.ranges : null;
  const frag = document.createDocumentFragment();
  for (const w of tr.words) {
    const span = document.createElement('span');
    span.className = 'ai-word';
    span.textContent = w.w;
    const at = timelineTime(t.asset, type, (w.start + w.end) / 2);
    if (at == null) span.classList.add('ai-gone');
    if (w.conf != null && w.conf < DOUBT) span.classList.add('ai-doubt');
    if (picks && picks.some(([a, b]) => w.start >= a - 0.01 && w.end <= b + 0.01)) span.classList.add('ai-pick');
    span.title = `${formatDuration(w.start)}${w.conf != null ? ` · ${Math.round(w.conf * 100)}% sure` : ''}${at == null ? ' · not on the timeline' : ''}`;
    span.dataset.s = w.start;
    frag.append(span, ' ');
  }
  const meta = document.createElement('p');
  meta.className = 'ai-meta';
  meta.textContent = `${tr.words.length} words · ${tr.engine.replace(':', ' ')} · ${tr.device}`;
  box.replaceChildren(meta, frag);
  syncButtons();
}

// ---------- ui ----------

function syncButtons() {
  const t = target();
  const has = !!t;
  $('ai-find-silences').disabled = busy || !has;
  $('ai-transcribe').disabled = busy || !has;
  $('ai-apply-cuts').disabled = busy || !has || !state.cutPreview?.regions?.length;
  $('ai-add-captions').disabled = busy || !has || !shownKey;
  const ai = aiSupport();
  $('ai-find-hl').disabled = busy || !has || !shownKey || !ai.summarizer;
  $('ai-keep-hl').disabled = busy || !has || !(previewOn && previewMode === 'highlights' && state.cutPreview?.regions?.length);
  $('ai-translate').disabled = busy || !has || !shownKey || !ai.translator;
  $('ai-chrome-note').classList.toggle('hidden', ai.summarizer || ai.translator);
  $('ai-target').textContent = has
    ? `${t.asset.name} · ${t.units.length > 1 ? `${t.units.length} pieces · ` : ''}${formatDuration(t.total)}${t.units[0].group.length > 1 ? ' · video + audio' : ''}`
    : 'Select a video or audio clip.';
  $('ai-aggr-val').textContent = ['Gentle', 'Soft', 'Normal', 'Tight', 'Aggressive'][Math.min(4, Math.floor(settings.aggressiveness * 5))];
  $('ai-groq-note').classList.toggle('hidden', !settings.engine.startsWith('groq') || !!settings.groqKey);
}

export function initAi() {
  loadSettings();
  $('ai-aggr').value = Math.round(settings.aggressiveness * 100);
  $('ai-engine').value = settings.engine;
  $('ai-lang').value = settings.language;
  $('opt-groq-key').value = settings.groqKey;

  $('ai-aggr').addEventListener('input', (e) => {
    settings.aggressiveness = e.target.value / 100;
    saveSettings();
    refreshPreview();
  });
  $('ai-engine').addEventListener('change', (e) => { settings.engine = e.target.value; saveSettings(); renderTranscript(); syncButtons(); });
  $('ai-lang').addEventListener('change', (e) => { settings.language = e.target.value; saveSettings(); renderTranscript(); });
  $('opt-groq-key').addEventListener('change', (e) => { settings.groqKey = e.target.value.trim(); saveSettings(); syncButtons(); });
  $('ai-find-silences').addEventListener('click', findSilences);
  $('ai-find-hl').addEventListener('click', findHl);
  $('ai-keep-hl').addEventListener('click', applyCuts);
  $('ai-translate').addEventListener('click', translateCaptions);
  $('ai-hl-length').value = settings.hlLength || '60';
  $('ai-hl-length').addEventListener('change', (e) => { settings.hlLength = e.target.value; saveSettings(); });
  $('ai-tr-lang').value = settings.translateTo || 'en';
  $('ai-tr-lang').addEventListener('change', (e) => { settings.translateTo = e.target.value; saveSettings(); });
  $('ai-apply-cuts').addEventListener('click', applyCuts);
  $('ai-transcribe').addEventListener('click', transcribe);
  $('ai-cap-style').value = settings.captionStyle || 'tiktok';
  $('ai-cap-style').addEventListener('change', (e) => { settings.captionStyle = e.target.value; saveSettings(); });
  $('ai-add-captions').addEventListener('click', () => {
    const t = target();
    const tr = t && transcriptMem.get(transcriptKey(t.asset));
    if (!tr) return;
    createCaptions(t.asset, tr.words, settings.captionStyle || 'tiktok');
  });
  $('ai-transcript').addEventListener('click', (e) => {
    const span = e.target.closest('.ai-word');
    const t = target();
    if (!span || !t) return;
    const at = timelineTime(t.asset, t.clip.type, parseFloat(span.dataset.s));
    if (at != null) seek(at + 0.001);
  });

  const refresh = () => {
    syncButtons();
    if (previewOn) refreshPreview();
    renderTranscript();
  };
  document.addEventListener('clip-selected', refresh);
  document.addEventListener('project-dirty', refresh);
  syncButtons();
  renderTranscript();
}
