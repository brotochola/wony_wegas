// Helpers shared by the editor and the AI worker. No DOM here.

export const SR = 16000;

// Where to split long audio: the longest pause between minLen and maxLen seconds after the
// previous split. A pause is a run of 20 ms frames 30 dB or more under the loudest frame nearby.
// Splitting in pauses means no word is cut in half between two pieces.
export function splitPoints(pcm, minLen = 15, maxLen = 28) {
  const frame = SR / 50;
  const n = Math.floor(pcm.length / frame);
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = i * frame; j < (i + 1) * frame; j++) s += pcm[j] * pcm[j];
    db[i] = 10 * Math.log10(s / frame + 1e-12);
  }
  const cuts = [0];
  let start = 0;
  while (n - start > maxLen * 50) {
    const a = start + minLen * 50, b = Math.min(n, start + maxLen * 50);
    let peak = -Infinity;
    for (let i = start; i < b; i++) peak = Math.max(peak, db[i]);
    let best = -1, bestLen = 0, run = 0;
    for (let i = a; i < b; i++) {
      run = db[i] < peak - 30 ? run + 1 : 0;
      if (run > bestLen) { bestLen = run; best = i - Math.floor(run / 2); }
    }
    if (bestLen < 10) {
      let low = Infinity;
      for (let i = a; i < b; i++) if (db[i] < low) { low = db[i]; best = i; }
    }
    cuts.push(best * frame);
    start = best;
  }
  cuts.push(pcm.length);
  return cuts;
}

// Speech spans from VAD probabilities, with hysteresis (on above `on`, off below `off`).
export function speechSpans(probs, hop, { on = 0.5, off = 0.35, minSpeech = 0.15 } = {}) {
  const spans = [];
  let cur = null;
  for (let k = 0; k < probs.length; k++) {
    const t = k * hop;
    const p = probs[k];
    if (!cur && p >= on) cur = [t, t + hop];
    else if (cur) {
      if (p >= off) cur[1] = t + hop;
      else {
        if (cur[1] - cur[0] >= minSpeech) spans.push(cur);
        cur = null;
      }
    }
  }
  if (cur && cur[1] - cur[0] >= minSpeech) spans.push(cur);
  return spans;
}

// How much air to keep, from 0 (gentle) to 1 (aggressive). 0.5 is close to wony_edit.py.
export function cutParams(aggressiveness) {
  const t = Math.max(0, Math.min(1, aggressiveness));
  const lerp = (a, b) => a + (b - a) * t;
  return { pad: lerp(0.2, 0.06), minGap: lerp(0.9, 0.25), keepPause: lerp(0.6, 0.12) };
}

// Ranges to keep: speech plus a little air; pauses shorter than minGap stay whole,
// longer ones are cut down to about keepPause. Same rules as speech_ranges() in wony_edit.py.
export function keepRanges(spans, duration, { pad, minGap, keepPause }) {
  if (!spans.length) return [[0, duration]];
  const merged = [[...spans[0]]];
  for (const [s, e] of spans.slice(1)) {
    if (s - merged.at(-1)[1] < minGap) merged.at(-1)[1] = Math.max(merged.at(-1)[1], e);
    else merged.push([s, e]);
  }
  const half = keepPause / 2;
  const keep = [];
  merged.forEach(([s, e], i) => {
    const lead = i === 0 ? pad : Math.max(pad, half);
    const tail = i === merged.length - 1 ? pad : Math.max(pad, half);
    const a = Math.max(0, s - lead);
    const b = Math.min(duration, e + tail);
    if (keep.length && a <= keep.at(-1)[1]) keep.at(-1)[1] = Math.max(keep.at(-1)[1], b);
    else keep.push([a, b]);
  });
  return keep;
}

// 16-bit mono WAV, for uploading pieces of audio.
export function encodeWav(pcm, sampleRate = SR) {
  const buf = new ArrayBuffer(44 + pcm.length * 2);
  const v = new DataView(buf);
  const text = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  text(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  text(36, 'data'); v.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}
