// Creating subtitle clips and editing them in the inspector.
import { state, uid, pushHistory, flash, assetById } from './state.js';
import { renderTimeline } from './timeline.js';
import { commitPlayback, previewNow, repaint } from './playback.js';
import { CAPTION_STYLES, styleOf, toSrt, toVtt, realignWords } from './captions.js';

const $ = (id) => document.getElementById(id);

function mediaSpan(assetId) {
  const media = state.clips.filter(c => c.assetId === assetId && (c.type === 'audio' || c.type === 'video'));
  if (!media.length) return null;
  const start = Math.min(...media.map(c => c.startTime));
  const end = Math.max(...media.map(c => c.startTime + c.duration));
  return { start, end };
}

// Subtitles cover the whole stretch of their file on the timeline; after cuts it shrinks.
export function fitCaptions() {
  for (const clip of state.clips) {
    if (clip.type !== 'captions') continue;
    const span = mediaSpan(clip.captionAsset);
    if (!span) continue;
    clip.startTime = span.start;
    clip.duration = Math.max(0.2, span.end - span.start);
  }
}

function captionsTrack() {
  let track = state.tracks.find(t => t.captions);
  if (!track) {
    track = { id: uid('track'), name: 'Subtitles', type: 'video', muted: false, captions: true };
    state.tracks.unshift(track); // first track is drawn on top
  }
  return track;
}

// words: [{ w, start, end }] in file time, from the transcript
export function createCaptions(asset, words, style = 'tiktok') {
  const span = mediaSpan(asset.id);
  if (!span) { flash('Put the clip on the timeline first', 'error'); return; }
  const st = CAPTION_STYLES[style] || CAPTION_STYLES.tiktok;
  const list = words.map(w => ({ w: w.w, s: w.start, e: w.end }));
  let clip = state.clips.find(c => c.type === 'captions' && c.captionAsset === asset.id);
  if (clip) {
    clip.words = list;
    clip.capStyle = style;
  } else {
    clip = {
      id: uid('clip'),
      trackId: captionsTrack().id,
      assetId: null,
      captionAsset: asset.id,
      name: `Subtitles · ${asset.name}`,
      type: 'captions',
      startTime: span.start,
      duration: span.end - span.start,
      startOffset: 0,
      volume: 1,
      opacity: 1,
      fadeIn: 0,
      fadeOut: 0,
      muteAudio: true,
      linkedClipId: null,
      color: '#db2777',
      x: 0,
      y: Math.round(state.projectHeight * st.y),
      scale: 1,
      fontSize: null,
      words: list,
      capStyle: style,
      capWords: null,
      capUpper: null,
      capHighlight: null,
      textColor: null,
    };
    state.clips.push(clip);
  }
  fitCaptions();
  state.selectedClipId = clip.id;
  pushHistory();
  renderTimeline();
  commitPlayback();
  document.dispatchEvent(new CustomEvent('clip-selected'));
  flash(`Subtitles added: ${list.length} words. Fix any word in the inspector.`);
}

function selected() {
  const clip = state.clips.find(c => c.id === state.selectedClipId);
  return clip?.type === 'captions' ? clip : null;
}

function fill() {
  const clip = selected();
  if (!clip) return;
  const st = styleOf(clip);
  $('cap-style').value = clip.capStyle || 'tiktok';
  $('cap-words').value = clip.capWords || st.words;
  $('cap-size').value = clip.fontSize || Math.round(state.projectHeight * st.size);
  $('cap-color').value = clip.textColor || st.color;
  $('cap-highlight').value = clip.capHighlight || st.highlight;
  $('cap-upper').checked = clip.capUpper ?? st.upper;
  if (document.activeElement !== $('cap-text')) $('cap-text').value = (clip.words || []).map(w => w.w).join(' ');
  const asset = assetById(clip.captionAsset);
  $('cap-source').textContent = asset ? `From ${asset.name}` : 'The source file is not in the project';
}

function apply(commit) {
  const clip = selected();
  if (!clip) return;
  const prevStyle = clip.capStyle;
  clip.capStyle = $('cap-style').value;
  const st = styleOf(clip);
  if (clip.capStyle !== prevStyle) {
    // a new style starts from its own look
    clip.fontSize = null;
    clip.capWords = null;
    clip.capUpper = null;
    clip.capHighlight = null;
    clip.textColor = null;
    clip.y = Math.round(state.projectHeight * st.y);
    fill();
  } else {
    clip.capWords = Math.max(1, Math.min(16, parseInt($('cap-words').value, 10) || st.words));
    clip.fontSize = Math.max(8, parseFloat($('cap-size').value) || Math.round(state.projectHeight * st.size));
    clip.textColor = $('cap-color').value;
    clip.capHighlight = $('cap-highlight').value;
    clip.capUpper = $('cap-upper').checked;
  }
  if (commit) {
    pushHistory();
    document.dispatchEvent(new CustomEvent('clip-selected'));
  }
  previewNow();
}

function applyText() {
  const clip = selected();
  if (!clip) return;
  const text = $('cap-text').value.trim();
  if (!text) { fill(); return; }
  clip.words = realignWords(clip.words || [], text);
  pushHistory();
  repaint();
  flash('Subtitle words updated');
}

function download(text, name, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function exportFile(kind) {
  const clip = selected();
  if (!clip) return;
  // times relative to the export range, like the video file
  const start = state.inPoint != null && state.outPoint != null ? Math.min(state.inPoint, state.outPoint) : 0;
  const base = (assetById(clip.captionAsset)?.name || 'subtitles').replace(/\.[^.]+$/, '');
  if (kind === 'srt') download(toSrt(clip, start), `${base}.srt`, 'application/x-subrip');
  else download(toVtt(clip, start), `${base}.vtt`, 'text/vtt');
}

export function initCaptionsUi() {
  const select = $('cap-style');
  select.replaceChildren(...Object.entries(CAPTION_STYLES).map(([key, st]) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = st.label;
    return opt;
  }));
  $('ai-cap-style').replaceChildren(...[...select.options].map(o => o.cloneNode(true)));
  select.addEventListener('change', () => apply(true));
  for (const id of ['cap-words', 'cap-size', 'cap-upper']) $(id).addEventListener('change', () => apply(true));
  for (const id of ['cap-color', 'cap-highlight']) {
    $(id).addEventListener('input', () => apply(false));
    $(id).addEventListener('change', () => apply(true));
  }
  $('cap-text').addEventListener('change', applyText);
  $('cap-srt').addEventListener('click', () => exportFile('srt'));
  $('cap-vtt').addEventListener('click', () => exportFile('vtt'));
  document.addEventListener('clip-selected', fill);
  // Montserrat Black is the TikTok look; draw again once the font arrives
  document.fonts?.load('900 40px Montserrat').then(() => repaint()).catch(() => {});
}
