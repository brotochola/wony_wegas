import { state, pushHistory, undo, redo, resetHistory, assetById, flash, uid } from './state.js';
import {
  importFiles, bindMediaDrop, setMediaHooks, openMedia, attachFiles, removeUnused, poolRecords, renderMediaPool
} from './media.js';
import {
  bindTimeline, renderTimeline, addTrack, addTextClip, setZoom, toggleSnapping,
  splitSelected, deleteSelected, duplicateSelected, unlinkSelected, insertAsset, setFirstVideoHandler,
  copySelected, pasteClipboard, setInPoint, setOutPoint, clearPoints, zoomToFit
} from './timeline.js';
import {
  initPreview, resizePreview, setSpanListener, togglePlay, seekToStart, seekToEnd, seek, stopPlaying, previewNow, measureFps, syncTransformBox
} from './playback.js';
import { openExportModal, closeExportModal, applyExportPreset, checkCodecSupport, startExport, cancelExport } from './export.js';

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
  scheduleAutosave();
}

function saveSessionJson() {
  const payload = {
    version: 1,
    name: state.projectName,
    savedAt: Date.now(),
    width: state.projectWidth,
    height: state.projectHeight,
    fps: state.fps,
    tracks: state.tracks,
    clips: state.clips,
    inPoint: state.inPoint,
    outPoint: state.outPoint,
    media: poolRecords()
  };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const a = document.createElement('a');
  const safe = (state.projectName || 'sesion').replace(/[^\w\-]+/g, '_');
  a.href = URL.createObjectURL(blob);
  a.download = `${safe}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  state.dirty = false;
  flash('Sesión guardada en JSON');
}

async function openSessionJson(file) {
  try {
    const project = JSON.parse(await file.text());
    if (!project || !Array.isArray(project.clips)) throw new Error('formato');
    if (state.dirty && !await ask('Hay cambios sin guardar. ¿Abrir esta sesión igual?')) return;
    await restoreProject(project);
  } catch (err) {
    console.warn(err);
    flash('Ese JSON no es una sesión de este editor', 'error');
  }
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
      inPoint: state.inPoint,
      outPoint: state.outPoint,
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
  state.inPoint = project.inPoint ?? null;
  state.outPoint = project.outPoint ?? null;
  state.selectedClipId = null;
  state.currentTime = 0;
  state.span = 0;
  document.getElementById('project-title').textContent = state.projectName || 'Proyecto_01';
  syncProjectInputs();
  resizePreview();
  const records = project.media || [];
  let missing = await openMedia(records);
  if (missing.length) {
    const files = await askRelink(missing);
    if (files.length) missing = await attachFiles(missing, files);
    if (missing.length) flash(`Faltan: ${missing.map(rec => rec.name || 'archivo').join(', ')}`, 'error');
  }
  resetHistory();
  state.dirty = false;
  renderTimeline();
  seek(0);
  updateInspector();
  flash(`Proyecto cargado: ${state.projectName}`);
}

function askRelink(missing) {
  return new Promise((resolve) => {
    document.getElementById('library-title').textContent = 'Volver a elegir archivos';
    document.getElementById('library-save').classList.add('hidden');
    const list = document.getElementById('library-list');
    list.classList.remove('hidden');
    list.replaceChildren();
    const note = document.createElement('p');
    note.className = 'px-3 py-2 text-slate-300';
    note.textContent = 'La URL guardada ya no abre estos archivos. Elegí los mismos de nuevo. El proyecto no copia los videos.';
    const names = document.createElement('ul');
    names.className = 'px-5 pb-2 list-disc text-slate-400';
    for (const rec of missing) {
      const item = document.createElement('li');
      item.textContent = rec.name || 'archivo';
      names.appendChild(item);
    }
    const row = document.createElement('div');
    row.className = 'flex justify-end gap-2 px-2 py-2';
    const pick = document.createElement('label');
    pick.className = 'px-3 py-1.5 rounded bg-cyan-500 text-slate-950 font-bold cursor-pointer';
    pick.textContent = 'Elegir archivos';
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'video/*,audio/*,image/*';
    input.className = 'hidden';
    pick.appendChild(input);
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'px-3 py-1.5 text-slate-400 hover:text-white';
    skip.textContent = 'Seguir sin ellos';
    row.append(skip, pick);
    list.append(note, names, row);
    showBox('library-modal');
    const close = document.getElementById('library-close');
    const finish = (files) => {
      hideBox('library-modal');
      close.onclick = null;
      input.onchange = null;
      skip.onclick = null;
      resolve(files);
    };
    input.onchange = () => finish([...input.files]);
    skip.onclick = () => finish([]);
    close.onclick = () => finish([]);
  });
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
    syncTransformBox();
    return;
  }
  none.classList.add('hidden');
  form.classList.remove('hidden');
  const visual = clip.type !== 'audio';
  document.getElementById('insp-video-opts').classList.toggle('hidden', clip.type === 'audio');
  document.getElementById('insp-audio-opts').classList.toggle('hidden', clip.type === 'image' || clip.type === 'text');
  document.getElementById('insp-transform').classList.toggle('hidden', !visual);
  document.getElementById('insp-crop').classList.toggle('hidden', clip.type === 'text' || clip.type === 'audio');
  document.getElementById('insp-text').classList.toggle('hidden', clip.type !== 'text');
  document.getElementById('insp-scale-wrap').classList.toggle('hidden', clip.type === 'text');
  document.getElementById('insp-name').value = clip.name;
  document.getElementById('insp-start').value = clip.startTime.toFixed(2);
  document.getElementById('insp-duration').value = clip.duration.toFixed(2);
  document.getElementById('insp-opacity').value = clip.opacity ?? 1;
  document.getElementById('insp-opacity-val').textContent = `${Math.round((clip.opacity ?? 1) * 100)}%`;
  document.getElementById('insp-fade-in').value = (clip.fadeIn || 0).toFixed(2);
  document.getElementById('insp-fade-out').value = (clip.fadeOut || 0).toFixed(2);
  document.getElementById('insp-volume').value = clip.volume ?? 1;
  document.getElementById('insp-volume-val').textContent = `${Math.round((clip.volume ?? 1) * 100)}%`;
  document.getElementById('insp-scale').value = clip.scale ?? 1;
  document.getElementById('insp-scale-val').textContent = `${Math.round((clip.scale ?? 1) * 100)}%`;
  document.getElementById('insp-x').value = Math.round(clip.x || 0);
  document.getElementById('insp-y').value = Math.round(clip.y || 0);
  document.getElementById('insp-crop-l').value = Math.round((clip.cropL || 0) * 100);
  document.getElementById('insp-crop-r').value = Math.round((clip.cropR || 0) * 100);
  document.getElementById('insp-crop-t').value = Math.round((clip.cropT || 0) * 100);
  document.getElementById('insp-crop-b').value = Math.round((clip.cropB || 0) * 100);
  document.getElementById('insp-font-size').value = clip.fontSize || Math.round(state.projectHeight / 15);
  document.getElementById('insp-font').value = clip.fontFamily || 'Inter, sans-serif';
  document.getElementById('insp-stroke').value = clip.strokeWidth || 0;
  document.getElementById('insp-stroke-color').value = clip.strokeColor || '#000000';
  const asset = assetById(clip.assetId);
  document.getElementById('insp-use-project').classList.toggle('hidden', !(asset?.width && asset?.height));
  syncTransformBox();
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
  clip.x = parseFloat(document.getElementById('insp-x').value) || 0;
  clip.y = parseFloat(document.getElementById('insp-y').value) || 0;
  clip.scale = Math.max(0.1, parseFloat(document.getElementById('insp-scale').value) || 1);
  const crop = (id) => Math.max(0, Math.min(0.8, (parseFloat(document.getElementById(id).value) || 0) / 100));
  clip.cropL = crop('insp-crop-l');
  clip.cropR = crop('insp-crop-r');
  clip.cropT = crop('insp-crop-t');
  clip.cropB = crop('insp-crop-b');
  if (clip.cropL + clip.cropR > 0.9) clip.cropR = Math.max(0, 0.9 - clip.cropL);
  if (clip.cropT + clip.cropB > 0.9) clip.cropB = Math.max(0, 0.9 - clip.cropT);
  if (clip.type === 'text') {
    clip.fontSize = Math.max(8, parseFloat(document.getElementById('insp-font-size').value) || 72);
    clip.fontFamily = document.getElementById('insp-font').value || 'Inter, sans-serif';
    clip.strokeWidth = Math.max(0, parseFloat(document.getElementById('insp-stroke').value) || 0);
    clip.strokeColor = document.getElementById('insp-stroke-color').value || '#000000';
  }
  document.getElementById('insp-opacity-val').textContent = `${Math.round((clip.opacity ?? 1) * 100)}%`;
  document.getElementById('insp-volume-val').textContent = `${Math.round((clip.volume ?? 1) * 100)}%`;
  document.getElementById('insp-scale-val').textContent = `${Math.round((clip.scale ?? 1) * 100)}%`;
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
  document.getElementById('btn-save-json').addEventListener('click', saveSessionJson);
  document.getElementById('btn-open-json').addEventListener('click', () => document.getElementById('json-input').click());
  document.getElementById('json-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) openSessionJson(file);
  });
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
  document.getElementById('btn-abort-export').addEventListener('click', cancelExport);
  document.getElementById('btn-unused').addEventListener('click', removeUnused);
  document.getElementById('preset-169').addEventListener('click', () => applyProject(1920, 1080, state.fps));
  document.getElementById('preset-916').addEventListener('click', () => applyProject(1080, 1920, state.fps));
  document.getElementById('preset-11').addEventListener('click', () => applyProject(1080, 1080, state.fps));
  document.getElementById('help-close').addEventListener('click', () => hideBox('help-modal'));
  document.addEventListener('project-dirty', scheduleAutosave);
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

  for (const id of ['insp-name', 'insp-start', 'insp-duration', 'insp-fade-in', 'insp-fade-out', 'insp-x', 'insp-y', 'insp-crop-l', 'insp-crop-r', 'insp-crop-t', 'insp-crop-b', 'insp-font-size', 'insp-font', 'insp-stroke', 'insp-stroke-color']) {
    document.getElementById(id).addEventListener('change', () => applyInspector(true));
  }
  for (const id of ['insp-opacity', 'insp-volume', 'insp-scale']) {
    const el = document.getElementById(id);
    el.addEventListener('input', () => applyInspector(false));
    el.addEventListener('change', () => applyInspector(true));
  }

  document.addEventListener('clip-selected', updateInspector);
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
    if (['help-modal', 'export-modal', 'library-modal', 'ask-modal'].some(id => !document.getElementById(id)?.classList.contains('hidden'))) return;
    if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const frame = 1 / (state.fps || 30);
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); seek(state.currentTime + (e.shiftKey ? 1 : frame)); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); seek(state.currentTime - (e.shiftKey ? 1 : frame)); }
    else if (!e.ctrlKey && !e.metaKey && (e.key === 's' || e.key === 'S')) splitSelected();
    else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey) { e.preventDefault(); deleteSelected(false); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(true); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); }
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); }
    else if (e.altKey && (e.key === 'i' || e.key === 'I')) clearPoints();
    else if (e.key === 'i' || e.key === 'I') setInPoint();
    else if (e.key === 'o' || e.key === 'O') setOutPoint();
    else if (!e.ctrlKey && (e.key === 'f' || e.key === 'F')) zoomToFit();
    else if (!e.ctrlKey && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(state.zoom * 1.15); }
    else if (!e.ctrlKey && (e.key === '-' || e.key === '_')) { e.preventDefault(); setZoom(state.zoom / 1.15); }
    else if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) toggleHelp();
    else if (e.ctrlKey && e.key === 'z') { e.preventDefault(); document.getElementById('btn-undo').click(); }
    else if (e.ctrlKey && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) {
      e.preventDefault();
      document.getElementById('btn-redo').click();
    }
  });
}

function toggleHelp() {
  const modal = document.getElementById('help-modal');
  if (modal.classList.contains('hidden')) showBox('help-modal');
  else hideBox('help-modal');
}

function bindTimelineResize() {
  const handle = document.getElementById('timeline-resize');
  const panel = document.getElementById('timeline-panel');
  if (!handle || !panel) return;
  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startY = event.clientY;
    const startH = panel.offsetHeight;
    const move = (ev) => {
      const next = startH + (startY - ev.clientY);
      panel.style.height = `${Math.max(160, Math.min(window.innerHeight * 0.75, next))}px`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      renderTimeline();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

let autosaveOn = false;
let autosaveTimer = 0;

async function writeAutosave() {
  try {
    const db = await openDb();
    await putProject(db, {
      id: 'autosave',
      name: state.projectName || 'Autoguardado',
      savedAt: Date.now(),
      width: state.projectWidth,
      height: state.projectHeight,
      fps: state.fps,
      tracks: state.tracks,
      clips: state.clips,
      inPoint: state.inPoint,
      outPoint: state.outPoint,
      media: poolRecords()
    });
    db.close();
  } catch (err) {
    console.warn(err);
  }
}

function scheduleAutosave() {
  if (!autosaveOn) return;
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => { writeAutosave(); }, 800);
}

function boot() {
  initPreview();
  syncProjectInputs();
  setFirstVideoHandler(offerProjectMatch);
  setSpanListener(() => renderTimeline());
  setMediaHooks({ ready: () => renderTimeline(), insert: insertAsset });
  bindMediaDrop();
  bindTimeline();
  bindTimelineResize();
  bindUi();
  renderMediaPool();
  pushHistory();
  renderTimeline();
  requestAnimationFrame(() => renderTimeline());
  autosaveOn = true;
}

boot();
