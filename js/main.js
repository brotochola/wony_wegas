import { state, pushHistory, undo, redo, resetHistory, assetById, flash, uid } from './state.js';
import {
  importFiles, bindMediaDrop, setMediaHooks, replacePool, poolRecords, renderMediaPool
} from './media.js';
import {
  bindTimeline, renderTimeline, addTrack, addTextClip, setZoom, toggleSnapping,
  splitSelected, deleteSelected, duplicateSelected, unlinkSelected, insertAsset, setFirstVideoHandler
} from './timeline.js';
import {
  initPreview, resizePreview, setSpanListener, togglePlay, seekToStart, seekToEnd, seek, stopPlaying, previewNow, measureFps
} from './playback.js';
import { openExportModal, closeExportModal, applyExportPreset, checkCodecSupport, startExport } from './export.js';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('vegas-web', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function showBox(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}

function hideBox(id) {
  const el = document.getElementById(id);
  el.classList.add('hidden');
  el.classList.remove('flex');
}

function ask(text) {
  return new Promise((resolve) => {
    document.getElementById('ask-text').textContent = text;
    showBox('ask-modal');
    const yes = document.getElementById('ask-yes');
    const no = document.getElementById('ask-no');
    const done = (value) => {
      hideBox('ask-modal');
      yes.onclick = null;
      no.onclick = null;
      resolve(value);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
  });
}

function askName(current) {
  return new Promise((resolve) => {
    document.getElementById('library-title').textContent = 'Guardar proyecto';
    document.getElementById('library-save').classList.remove('hidden');
    document.getElementById('library-list').classList.add('hidden');
    const input = document.getElementById('library-name');
    input.value = current || '';
    showBox('library-modal');
    input.focus();
    input.select();
    const ok = document.getElementById('library-save-ok');
    const cancel = document.getElementById('library-save-cancel');
    const close = document.getElementById('library-close');
    const finish = (name) => {
      hideBox('library-modal');
      ok.onclick = null;
      cancel.onclick = null;
      close.onclick = null;
      input.onkeydown = null;
      resolve(name);
    };
    ok.onclick = () => {
      const name = input.value.trim();
      if (!name) return;
      finish(name);
    };
    cancel.onclick = () => finish('');
    close.onclick = () => finish('');
    input.onkeydown = (e) => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') finish('');
    };
  });
}

function listProjects(db) {
  return new Promise((resolve, reject) => {
    const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function putProject(db, record) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function syncProjectInputs() {
  document.getElementById('proj-w').value = state.projectWidth;
  document.getElementById('proj-h').value = state.projectHeight;
  document.getElementById('proj-fps').value = state.fps;
}

function applyProject(width, height, fps) {
  state.projectWidth = Math.max(2, Math.round(Number(width) || 2));
  state.projectHeight = Math.max(2, Math.round(Number(height) || 2));
  state.fps = Math.max(1, Math.round(Number(fps) || 30));
  syncProjectInputs();
  resizePreview();
  seek(state.currentTime);
  state.dirty = true;
}

async function saveProject() {
  try {
    const name = await askName(state.projectName || 'Proyecto');
    if (!name) return;
    const db = await openDb();
    const all = await listProjects(db);
    const existing = all.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing && !await ask(`Ya existe «${existing.name}». ¿Reemplazarlo?`)) {
      db.close();
      return;
    }
    await putProject(db, {
      id: existing?.id || uid('proj'),
      name,
      savedAt: Date.now(),
      width: state.projectWidth,
      height: state.projectHeight,
      fps: state.fps,
      tracks: state.tracks,
      clips: state.clips,
      media: poolRecords()
    });
    db.close();
    state.projectName = name;
    state.dirty = false;
    document.getElementById('project-title').textContent = name;
    flash(`Guardado: ${name}`);
  } catch (err) {
    console.warn(err);
    flash('No se pudo guardar', 'error');
  }
}

async function restoreProject(project) {
  stopPlaying({ paint: false });
  state.projectName = project.name || '';
  state.projectWidth = project.width || 1920;
  state.projectHeight = project.height || 1080;
  state.fps = project.fps || 30;
  state.askedFirstClip = true;
  state.tracks = project.tracks?.length ? project.tracks : state.tracks;
  state.clips = project.clips || [];
  state.selectedClipId = null;
  state.currentTime = 0;
  state.span = 0;
  document.getElementById('project-title').textContent = state.projectName || 'Proyecto_Vegas_01.veg';
  syncProjectInputs();
  resizePreview();
  await replacePool(project.media || []);
  resetHistory();
  state.dirty = false;
  renderTimeline();
  seek(0);
  updateInspector();
  flash(`Proyecto cargado: ${state.projectName}`);
}

function pickProject(projects) {
  return new Promise((resolve) => {
    document.getElementById('library-title').textContent = 'Cargar proyecto';
    document.getElementById('library-save').classList.add('hidden');
    const list = document.getElementById('library-list');
    list.classList.remove('hidden');
    list.replaceChildren();
    for (const project of projects) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'w-full text-left px-3 py-2 rounded hover:bg-vegas-panelLight flex items-center justify-between gap-3';
      const when = new Date(project.savedAt || 0).toLocaleString();
      const label = document.createElement('span');
      const title = document.createElement('b');
      title.className = 'text-slate-100 block';
      title.textContent = project.name;
      const meta = document.createElement('span');
      meta.className = 'text-slate-500';
      meta.textContent = `${project.width || '—'}×${project.height || '—'} · ${project.fps || '—'} fps · ${when}`;
      label.append(title, meta);
      row.appendChild(label);
      row.addEventListener('click', () => finish(project));
      list.appendChild(row);
    }
    showBox('library-modal');
    const close = document.getElementById('library-close');
    const finish = (project) => {
      hideBox('library-modal');
      close.onclick = null;
      resolve(project);
    };
    close.onclick = () => finish(null);
  });
}

async function loadProject() {
  try {
    const db = await openDb();
    const all = (await listProjects(db)).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    db.close();
    if (!all.length) {
      flash('No hay proyectos guardados');
      return;
    }
    const picked = await pickProject(all);
    if (!picked) return;
    if (state.dirty && !await ask('Hay cambios sin guardar. ¿Cargar este proyecto igual?')) return;
    await restoreProject(picked);
  } catch (err) {
    console.warn(err);
    flash('No se pudo cargar', 'error');
  }
}

async function offerProjectMatch(asset) {
  if (state.askedFirstClip || !asset?.width || !asset?.height) return;
  state.askedFirstClip = true;
  let fps = asset.fps || 0;
  if (!fps && asset.element) {
    fps = await measureFps(asset.element);
    if (fps) asset.fps = fps;
    seek(state.currentTime);
  }
  const fpsText = fps ? `${fps} fps` : `${state.fps} fps (no se pudo leer el del video)`;
  const yes = await ask(`Este video es ${asset.width}×${asset.height} a ${fpsText}. ¿Usar ese tamaño y fps para el proyecto?`);
  if (!yes) return;
  applyProject(asset.width, asset.height, fps || state.fps);
  state.dirty = true;
}

async function useClipForProject() {
  const clip = state.clips.find(c => c.id === state.selectedClipId);
  const asset = clip ? assetById(clip.assetId) : null;
  if (!asset?.width || !asset?.height) {
    flash('Este clip no tiene tamaño de imagen', 'error');
    return;
  }
  let fps = state.fps;
  if (asset.type === 'video') {
    fps = asset.fps || await measureFps(asset.element) || state.fps;
    if (fps) asset.fps = fps;
  }
  applyProject(asset.width, asset.height, fps);
  flash(`Proyecto ${state.projectWidth}×${state.projectHeight} a ${state.fps} fps`);
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
  const asset = assetById(clip.assetId);
  document.getElementById('insp-use-project').classList.toggle('hidden', !(asset?.width && asset?.height));
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
  document.getElementById('proj-apply').addEventListener('click', () => {
    applyProject(
      document.getElementById('proj-w').value,
      document.getElementById('proj-h').value,
      document.getElementById('proj-fps').value
    );
  });
  document.getElementById('insp-use-project').addEventListener('click', useClipForProject);
  window.addEventListener('beforeunload', (e) => {
    if (!state.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
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
  syncProjectInputs();
  setFirstVideoHandler(offerProjectMatch);
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
