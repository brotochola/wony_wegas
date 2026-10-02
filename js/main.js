import { state, pushHistory, undo, redo, resetHistory, assetById, flash } from './state.js';
import {
  importFiles, bindMediaDrop, setMediaHooks, replacePool, poolRecords, renderMediaPool
} from './media.js';
import {
  bindTimeline, renderTimeline, addTrack, addTextClip, setZoom, toggleSnapping,
  splitSelected, deleteSelected, duplicateSelected, unlinkSelected, insertAsset
} from './timeline.js';
import {
  initPreview, setSpanListener, togglePlay, seekToStart, seekToEnd, seek, stopPlaying, previewNow
} from './playback.js';
import { openExportModal, closeExportModal, applyExportPreset, checkCodecSupport, startExport } from './export.js';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vegas-web', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('kv')) req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveProject() {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({
        tracks: state.tracks,
        clips: state.clips,
        media: poolRecords()
      }, 'project');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    flash('Guardado en el navegador');
  } catch (err) {
    console.warn(err);
    flash('No se pudo guardar');
  }
}

async function loadProject() {
  try {
    const db = await openDb();
    const project = await new Promise((resolve, reject) => {
      const tx = db.transaction('kv', 'readonly');
      const req = tx.objectStore('kv').get('project');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    if (!project) {
      flash('No hay proyecto guardado');
      return;
    }
    stopPlaying({ paint: false });
    state.tracks = project.tracks?.length ? project.tracks : state.tracks;
    state.clips = project.clips || [];
    state.selectedClipId = null;
    state.currentTime = 0;
    state.span = 0;
    await replacePool(project.media || []);
    resetHistory();
    renderTimeline();
    seek(0);
    updateInspector();
    flash('Proyecto cargado');
  } catch (err) {
    console.warn(err);
    flash('No se pudo cargar');
  }
}

function updateInspector() {
  const none = document.getElementById('inspector-none');
  const form = document.getElementById('inspector-form');
  const clip = state.clips.find(c => c.id === state.selectedClipId);
  if (!clip) {
    none.classList.remove('hidden');
    form.classList.add('hidden');
    return;
  }
  none.classList.add('hidden');
  form.classList.remove('hidden');
  document.getElementById('insp-video-opts').classList.toggle('hidden', clip.type === 'audio');
  document.getElementById('insp-audio-opts').classList.toggle('hidden', clip.type === 'image' || clip.type === 'text');
  document.getElementById('insp-name').value = clip.name;
  document.getElementById('insp-start').value = clip.startTime.toFixed(2);
  document.getElementById('insp-duration').value = clip.duration.toFixed(2);
  document.getElementById('insp-opacity').value = clip.opacity ?? 1;
  document.getElementById('insp-opacity-val').textContent = `${Math.round((clip.opacity ?? 1) * 100)}%`;
  document.getElementById('insp-fade-in').value = (clip.fadeIn || 0).toFixed(2);
  document.getElementById('insp-fade-out').value = (clip.fadeOut || 0).toFixed(2);
  document.getElementById('insp-volume').value = clip.volume ?? 1;
  document.getElementById('insp-volume-val').textContent = `${Math.round((clip.volume ?? 1) * 100)}%`;
}

function applyInspector(commit) {
  const clip = state.clips.find(c => c.id === state.selectedClipId);
  if (!clip) return;
  clip.name = document.getElementById('insp-name').value;
  if (clip.type === 'text') clip.text = clip.name;
  clip.startTime = Math.max(0, parseFloat(document.getElementById('insp-start').value) || 0);
  let dur = Math.max(0.2, parseFloat(document.getElementById('insp-duration').value) || 0.2);
  const asset = assetById(clip.assetId);
  if (asset && (clip.type === 'video' || clip.type === 'audio') && asset.duration) {
    dur = Math.min(dur, Math.max(0.2, asset.duration - (clip.startOffset || 0)));
  }
  clip.duration = dur;
  clip.opacity = parseFloat(document.getElementById('insp-opacity').value);
  clip.fadeIn = Math.max(0, parseFloat(document.getElementById('insp-fade-in').value) || 0);
  clip.fadeOut = Math.max(0, parseFloat(document.getElementById('insp-fade-out').value) || 0);
  clip.volume = parseFloat(document.getElementById('insp-volume').value);
  document.getElementById('insp-opacity-val').textContent = `${Math.round((clip.opacity ?? 1) * 100)}%`;
  document.getElementById('insp-volume-val').textContent = `${Math.round((clip.volume ?? 1) * 100)}%`;
  if (commit) {
    pushHistory();
    renderTimeline();
    seek(state.currentTime);
  } else {
    previewNow();
  }
}

function switchTab(tab) {
  document.getElementById('tab-content-media').classList.toggle('hidden', tab !== 'media');
  document.getElementById('tab-content-titles').classList.toggle('hidden', tab !== 'titles');
  const mediaBtn = document.getElementById('tab-btn-media');
  const titleBtn = document.getElementById('tab-btn-titles');
  mediaBtn.className = tab === 'media'
    ? 'px-3 py-2 border-b-2 border-cyan-400 text-cyan-400 font-bold'
    : 'px-3 py-2 text-slate-400 hover:text-white';
  titleBtn.className = tab === 'titles'
    ? 'px-3 py-2 border-b-2 border-cyan-400 text-cyan-400 font-bold'
    : 'px-3 py-2 text-slate-400 hover:text-white';
}

function bindUi() {
  document.getElementById('file-input').addEventListener('change', (e) => {
    importFiles(e.target.files);
    e.target.value = '';
  });
  document.getElementById('btn-undo').addEventListener('click', () => {
    if (!undo()) return;
    renderTimeline();
    seek(state.currentTime);
    updateInspector();
  });
  document.getElementById('btn-redo').addEventListener('click', () => {
    if (!redo()) return;
    renderTimeline();
    seek(state.currentTime);
    updateInspector();
  });
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-load').addEventListener('click', loadProject);
  document.getElementById('btn-export').addEventListener('click', () => {
    openExportModal();
    checkCodecSupport();
  });
  document.getElementById('btn-close-export').addEventListener('click', closeExportModal);
  document.getElementById('btn-cancel-export').addEventListener('click', closeExportModal);
  document.getElementById('exp-preset').addEventListener('change', (e) => applyExportPreset(e.target.value));
  document.getElementById('exp-codec').addEventListener('change', checkCodecSupport);
  document.getElementById('btn-start-export').addEventListener('click', startExport);
  document.getElementById('tab-btn-media').addEventListener('click', () => switchTab('media'));
  document.getElementById('tab-btn-titles').addEventListener('click', () => switchTab('titles'));
  document.getElementById('btn-add-text').addEventListener('click', addTextClip);
  document.getElementById('btn-play').addEventListener('click', togglePlay);
  document.getElementById('btn-seek-start').addEventListener('click', seekToStart);
  document.getElementById('btn-seek-end').addEventListener('click', seekToEnd);
  document.getElementById('btn-split').addEventListener('click', splitSelected);
  document.getElementById('btn-delete').addEventListener('click', deleteSelected);
  document.getElementById('btn-snap').addEventListener('click', toggleSnapping);
  document.getElementById('btn-add-video').addEventListener('click', () => addTrack('video'));
  document.getElementById('btn-add-audio').addEventListener('click', () => addTrack('audio'));
  document.getElementById('zoom-slider').addEventListener('input', (e) => setZoom(e.target.value));
  document.getElementById('ctx-split').addEventListener('click', splitSelected);
  document.getElementById('ctx-unlink').addEventListener('click', unlinkSelected);
  document.getElementById('ctx-duplicate').addEventListener('click', duplicateSelected);
  document.getElementById('ctx-delete').addEventListener('click', deleteSelected);

  for (const id of ['insp-name', 'insp-start', 'insp-duration', 'insp-fade-in', 'insp-fade-out']) {
    document.getElementById(id).addEventListener('change', () => applyInspector(true));
  }
  for (const id of ['insp-opacity', 'insp-volume']) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => applyInspector(false));
    el.addEventListener('change', () => applyInspector(true));
  }

  document.addEventListener('clip-selected', updateInspector);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (e.repeat) return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 's' || e.key === 'S') splitSelected();
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (e.ctrlKey && e.key === 'z') { e.preventDefault(); document.getElementById('btn-undo').click(); }
    else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      document.getElementById('btn-redo').click();
    }
  });
}

function boot() {
  initPreview();
  setSpanListener(() => renderTimeline());
  setMediaHooks({ ready: () => renderTimeline(), insert: insertAsset });
  bindMediaDrop();
  bindTimeline();
  bindUi();
  renderMediaPool();
  pushHistory();
  renderTimeline();
  requestAnimationFrame(() => renderTimeline());
}

boot();
