export const state = {
  currentTime: 0,
  zoom: 40,
  span: 0,
  isPlaying: false,
  isSnapping: true,
  selectedClipId: null,
  history: [],
  historyIndex: -1,
  mediaPool: [],
  tracks: [
    { id: 'track-v1', name: 'Video Track 1', type: 'video', muted: false },
    { id: 'track-a1', name: 'Audio Track 1', type: 'audio', muted: false }
  ],
  clips: [],
  projectWidth: 1920,
  projectHeight: 1080,
  fps: 30,
  projectName: '',
  dirty: false,
  askedFirstClip: false
};

export function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function assetById(id) {
  return state.mediaPool.find(a => a.id === id) || null;
}

export function contentEnd() {
  let end = 0;
  for (const clip of state.clips) end = Math.max(end, clip.startTime + clip.duration);
  return end;
}

export function formatTimecode(seconds, fps = state.fps) {
  const s = Math.max(0, seconds || 0);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = Math.floor(s % 60);
  const frames = Math.floor((s % 1) * fps);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(hrs)}:${p(mins)}:${p(secs)}:${p(frames)}`;
}

export function formatDuration(seconds) {
  if (!isFinite(seconds)) return '—';
  const s = Math.max(0, seconds);
  const totalMins = Math.floor(s / 60);
  const rem = (s - totalMins * 60).toFixed(1).padStart(4, '0');
  const hrs = Math.floor(totalMins / 60);
  if (hrs) return `${hrs}:${String(totalMins % 60).padStart(2, '0')}:${rem}`;
  return `${totalMins}:${rem}`;
}

export function formatBytes(n) {
  if (n == null || !isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function pushHistory() {
  const snapshot = JSON.stringify({ tracks: state.tracks, clips: state.clips });
  if (state.history[state.historyIndex] === snapshot) {
    updateHistoryButtons();
    return;
  }
  const hadHistory = state.historyIndex >= 0;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot);
  state.historyIndex = state.history.length - 1;
  if (hadHistory) state.dirty = true;
  updateHistoryButtons();
}

export function undo() {
  if (state.historyIndex <= 0) return false;
  state.historyIndex--;
  restoreHistory();
  state.dirty = true;
  return true;
}

export function redo() {
  if (state.historyIndex >= state.history.length - 1) return false;
  state.historyIndex++;
  restoreHistory();
  state.dirty = true;
  return true;
}

export function resetHistory() {
  state.history = [];
  state.historyIndex = -1;
  pushHistory();
}

function restoreHistory() {
  const snap = JSON.parse(state.history[state.historyIndex]);
  state.tracks = snap.tracks;
  state.clips = snap.clips;
  if (!state.clips.some(c => c.id === state.selectedClipId)) state.selectedClipId = null;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  const undoBtn = document.getElementById('btn-undo');
  const redoBtn = document.getElementById('btn-redo');
  if (undoBtn) undoBtn.disabled = state.historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = state.historyIndex >= state.history.length - 1;
}

export function flash(text, kind = 'info') {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }
  const item = document.createElement('div');
  item.className = kind === 'error' ? 'toast toast-error' : 'toast';
  item.textContent = text;
  stack.appendChild(item);
  setTimeout(() => item.remove(), 4600);
}
