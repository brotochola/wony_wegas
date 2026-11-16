// Automatic subtitles: a "captions" clip keeps the words with their times in the source file.
// Every frame, those times are mapped onto the timeline through the clips of that file, so
// subtitles follow any cut, trim or move without being regenerated. Drawn on the same canvas as
// the preview and the export, so they are burned into the video.
import { state } from './state.js';

export const CAPTION_STYLES = {
  tiktok: {
    label: 'TikTok', family: 'Montserrat, Inter, sans-serif', weight: 900, size: 0.075, stroke: 0.17,
    words: 3, chars: 22, upper: true, strip: true, pop: true, highlight: '#ffe600', color: '#ffffff', y: 0.2,
  },
  box: {
    label: 'Box', family: 'Montserrat, Inter, sans-serif', weight: 900, size: 0.07, stroke: 0.12,
    words: 3, chars: 22, upper: true, strip: true, pop: true, highlight: '#22c55e', color: '#ffffff', y: 0.2, box: true,
  },
  one: {
    label: 'One word', family: 'Montserrat, Inter, sans-serif', weight: 900, size: 0.11, stroke: 0.17,
    words: 1, chars: 30, upper: true, strip: true, pop: true, highlight: '#ffffff', color: '#ffffff', y: 0.15,
  },
  classic: {
    label: 'Classic', family: 'Inter, sans-serif', weight: 600, size: 0.045, stroke: 0,
    words: 14, chars: 84, upper: false, strip: false, pop: false, highlight: '#ffffff', color: '#ffffff', y: 0.38, band: true,
  },
};

export function styleOf(clip) {
  return CAPTION_STYLES[clip.capStyle] || CAPTION_STYLES.tiktok;
}

const norm = (t) => t.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}']/gu, '');

// ---------- words on the timeline ----------

const cache = new Map(); // clip id -> { sig, words, cards }

function sourceClips(assetId) {
  const media = state.clips.filter(c => c.assetId === assetId && (c.type === 'audio' || c.type === 'video'));
  const audio = media.filter(c => c.type === 'audio');
  return audio.length ? audio : media;
}

function timelineWords(clip, src) {
  const out = [];
  for (const w of clip.words || []) {
    const mid = (w.s + w.e) / 2;
    const c = src.find(c => mid >= (c.startOffset || 0) && mid < (c.startOffset || 0) + c.duration);
    if (!c) continue; // the word was cut out
    const off = c.startOffset || 0;
    const t0 = c.startTime + Math.max(w.s, off) - off;
    const t1 = c.startTime + Math.min(w.e, off + c.duration) - off;
    out.push({ w: w.w, t0, t1: Math.max(t1, t0 + 0.05) });
  }
  return out.sort((a, b) => a.t0 - b.t0);
}

// Group words into cards: a few words at a time, breaking at sentence ends, long pauses and cuts.
export function buildCards(words, maxWords, maxChars, gapBreak = 0.6) {
  const cards = [];
  let cur = null;
  for (const w of words) {
    const prev = cur?.words.at(-1);
    const chars = cur ? cur.words.reduce((n, x) => n + x.w.length + 1, 0) : 0;
    const fresh = !cur
      || cur.words.length >= maxWords
      || chars + w.w.length > maxChars
      || w.t0 - prev.t1 > gapBreak
      || /[.!?…]["»”']?$/.test(prev.w)
      || (/[,;:]$/.test(prev.w) && cur.words.length >= Math.max(2, maxWords - 1));
    if (fresh) { cur = { words: [w] }; cards.push(cur); } else cur.words.push(w);
  }
  cards.forEach((card, i) => {
    card.start = card.words[0].t0;
    const end = card.words.at(-1).t1;
    const next = cards[i + 1]?.words[0].t0 ?? Infinity;
    // stay on screen until the next card when the gap is short, so they don't flicker
    card.end = next - end < 0.5 ? next : Math.min(next, end + 0.3);
  });
  return cards;
}

function entry(clip) {
  const src = sourceClips(clip.captionAsset);
  const st = styleOf(clip);
  const sig = `${src.map(c => `${c.startTime.toFixed(3)},${c.duration.toFixed(3)},${(c.startOffset || 0).toFixed(3)}`).join('|')}#${clip.capStyle}#${clip.capWords}`;
  const hit = cache.get(clip.id);
  if (hit && hit.sig === sig && hit.ref === clip.words) return hit;
  const words = timelineWords(clip, src);
  const cards = buildCards(words, clip.capWords || st.words, st.chars, st.band ? 1.0 : 0.6);
  const value = { sig, ref: clip.words, words, cards };
  cache.set(clip.id, value);
  return value;
}

function cardAt(cards, time) {
  let lo = 0, hi = cards.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (time < cards[mid].start) hi = mid - 1;
    else if (time >= cards[mid].end) lo = mid + 1;
    else return cards[mid];
  }
  return null;
}

// ---------- drawing ----------

function layout(ctx, clip, card, w, h) {
  const st = styleOf(clip);
  const k = h / (state.projectHeight || h);
  const size = (clip.fontSize || Math.round((state.projectHeight || h) * st.size)) * k;
  ctx.font = `${st.weight} ${size}px ${st.family}`;
  const upper = clip.capUpper ?? st.upper;
  const tokens = card.words.map((x) => {
    let t = st.strip ? x.w.replace(/[.,;:!?¡¿…"«»“”]+/g, '') : x.w;
    if (upper) t = t.toLocaleUpperCase();
    return t || x.w;
  });
  const space = ctx.measureText(' ').width;
  const widths = tokens.map(t => ctx.measureText(t).width);
  const maxWidth = w * 0.86;
  const lines = [[]];
  let lineW = 0;
  tokens.forEach((t, i) => {
    const add = (lines.at(-1).length ? space : 0) + widths[i];
    if (lines.at(-1).length && lineW + add > maxWidth) { lines.push([]); lineW = 0; }
    lineW += (lines.at(-1).length ? space : 0) + widths[i];
    lines.at(-1).push(i);
  });
  const lineH = size * 1.18;
  const cx = w / 2 + (clip.x || 0) * k;
  const cy = h / 2 + (clip.y ?? Math.round((state.projectHeight || h) * st.y)) * k;
  const top = cy - (lines.length * lineH) / 2;
  const placed = [];
  let boxW = 0;
  lines.forEach((ids, li) => {
    const total = ids.reduce((n, i, j) => n + widths[i] + (j ? space : 0), 0);
    boxW = Math.max(boxW, total);
    let x = cx - total / 2;
    for (const i of ids) {
      placed.push({ i, text: tokens[i], x, y: top + li * lineH + lineH / 2, w: widths[i] });
      x += widths[i] + space;
    }
  });
  return { st, size, placed, cx, cy, box: { dx: cx - boxW / 2 - size * 0.3, dy: top - size * 0.15, dw: boxW + size * 0.6, dh: lines.length * lineH + size * 0.3 } };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function drawCaptions(ctx, w, h, clip, time) {
  const card = cardAt(entry(clip).cards, time);
  if (!card) return;
  ctx.save();
  const L = layout(ctx, clip, card, w, h);
  const { st, size } = L;
  // the word being said: the last one that has started
  let active = -1;
  card.words.forEach((x, i) => { if (time >= x.t0) active = i; });
  if (st.pop) {
    const age = time - card.start;
    const s = age < 0.09 ? 0.82 + 0.18 * (age / 0.09) : 1;
    ctx.translate(L.cx, L.cy);
    ctx.scale(s, s);
    ctx.translate(-L.cx, -L.cy);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  if (st.band) {
    ctx.fillStyle = 'rgba(0, 0, 0, 0.62)';
    roundRect(ctx, L.box.dx, L.box.dy, L.box.dw, L.box.dh, size * 0.25);
    ctx.fill();
  }
  const color = clip.textColor || st.color;
  const highlight = clip.capHighlight || st.highlight;
  for (const p of L.placed) {
    const on = p.i === active && !st.band;
    if (st.box && on) {
      ctx.fillStyle = highlight;
      roundRect(ctx, p.x - size * 0.14, p.y - size * 0.62, p.w + size * 0.28, size * 1.2, size * 0.2);
      ctx.fill();
    }
    if (st.stroke > 0) {
      ctx.lineWidth = size * st.stroke;
      ctx.strokeStyle = '#000000';
      ctx.strokeText(p.text, p.x, p.y);
    }
    ctx.shadowColor = st.stroke > 0 ? 'rgba(0, 0, 0, 0.45)' : 'transparent';
    ctx.shadowBlur = size * 0.12;
    ctx.shadowOffsetY = size * 0.04;
    ctx.fillStyle = on && !st.box ? highlight : color;
    ctx.fillText(p.text, p.x, p.y);
    ctx.shadowColor = 'transparent';
  }
  ctx.restore();
}

// The box of the card on screen, for the move and scale handles. With nothing on screen,
// a box where the next card will appear.
export function captionRect(ctx, w, h, clip, time) {
  const cards = entry(clip).cards;
  const card = cardAt(cards, time) || cards.find(c => c.start > time) || cards.at(-1);
  if (!card) return null;
  ctx.save();
  const { box } = layout(ctx, clip, card, w, h);
  ctx.restore();
  return box;
}

// ---------- subtitle files ----------

function stampSrt(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

// Reading-speed rules for files: up to 42 characters a line, 2 lines, 1 to 6 seconds.
function fileCards(clip, start = 0) {
  const { words } = entry(clip);
  const cards = buildCards(words, 16, 84, 1.0);
  const out = [];
  for (const c of cards) {
    const text = c.words.map(x => x.w).join(' ');
    let lines = [text];
    if (text.length > 42) {
      // break near the middle, at a space
      const mid = text.length / 2;
      let cut = -1;
      for (let i = 0; i < text.length; i++) if (text[i] === ' ' && (cut < 0 || Math.abs(i - mid) < Math.abs(cut - mid))) cut = i;
      if (cut > 0) lines = [text.slice(0, cut), text.slice(cut + 1)];
    }
    const a = c.start - start;
    const b = Math.max(a + 1, Math.min(c.end - start, a + 6));
    out.push({ a, b, lines });
  }
  return out;
}

export function toSrt(clip, start = 0) {
  return fileCards(clip, start).map((c, i) => `${i + 1}\n${stampSrt(c.a)} --> ${stampSrt(c.b)}\n${c.lines.join('\n')}\n`).join('\n');
}

export function toVtt(clip, start = 0) {
  return `WEBVTT\n\n${fileCards(clip, start).map(c => `${stampSrt(c.a).replace(',', '.')} --> ${stampSrt(c.b).replace(',', '.')}\n${c.lines.join('\n')}\n`).join('\n')}`;
}

// ---------- fixing words ----------

// New text typed over the old words: words that still match keep their times; replaced or
// added words share the time of what they replace (or borrow half of the previous word).
export function realignWords(old, text) {
  const neu = text.split(/\s+/).filter(Boolean);
  const n = old.length, m = neu.length;
  const a = old.map(w => norm(w.w)), b = neu.map(norm);
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      L[i][j] = a[i] && a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    }
  }
  const anchors = [[-1, -1]];
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] && a[i] === b[j]) { anchors.push([i, j]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) i++; else j++;
  }
  anchors.push([n, m]);
  const out = [];
  for (let k = 0; k < anchors.length - 1; k++) {
    const [ia, ja] = anchors[k];
    const [ib, jb] = anchors[k + 1];
    const run = neu.slice(ja + 1, jb);
    if (run.length) {
      const gone = old.slice(ia + 1, ib);
      let s, e;
      if (gone.length) { s = gone[0].s; e = gone.at(-1).e; } else {
        s = ia >= 0 ? old[ia].e : Math.max(0, (old[0]?.s ?? 0) - 0.3);
        e = ib < n ? old[ib].s : s + 0.3;
        if (e - s < 0.08 && out.length) { // no room: take the second half of the previous word
          const prev = out.at(-1);
          s = (prev.s + prev.e) / 2;
          prev.e = s;
        }
        if (e - s < 0.08) e = s + 0.08 * run.length;
      }
      const total = run.reduce((t, w) => t + w.length + 1, 0);
      let t = s;
      for (const w of run) {
        const d = ((e - s) * (w.length + 1)) / total;
        out.push({ w, s: +t.toFixed(3), e: +(t + d).toFixed(3) });
        t += d;
      }
    }
    if (ib < n) out.push({ ...old[ib], w: neu[jb] });
  }
  return out;
}
