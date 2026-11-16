// Chrome's built-in AI on top of the transcript:
//   - highlights: the Summarizer writes the key points; Gemini Nano (Prompt API) picks the sentences
//     to keep, or, without it, the sentences that best cover the Summarizer's key points are chosen
//   - translation: whole sentences go to the Translator, and the translated words are spread over
//     the time the original sentence was spoken (skipping its pauses)
// Everything runs on this computer. Sessions must be created from a click (the models may download).

const SUMMARY_LANGS = ['en', 'es', 'ja', 'de', 'fr'];

export function aiSupport() {
  return {
    summarizer: 'Summarizer' in self,
    prompt: 'LanguageModel' in self,
    translator: 'Translator' in self,
    detector: 'LanguageDetector' in self,
  };
}

// ---------- sentences ----------

// Whole sentences from timed words: end punctuation, a long pause, or a very long run.
export function sentencesFrom(words) {
  const out = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    out.push({ id: out.length, words: cur, text: cur.map(w => w.w).join(' '), s: cur[0].s, e: cur.at(-1).e });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = cur.at(-1);
    if (prev && (w.s - prev.e > 1.0 || cur.length >= 45)) flush();
    cur.push(w);
    if (/[.!?…]["»”')]?$/.test(w.w) && i < words.length - 1) flush();
  });
  flush();
  return out;
}

// ---------- monitor helper ----------

function monitorFor(label, onProgress) {
  return (m) => m.addEventListener('downloadprogress', (e) => onProgress?.(e.loaded, `Downloading ${label} (only the first time)`));
}

// ---------- summary ----------

async function makeSummarizer(lang, onProgress) {
  if (!('Summarizer' in self)) return null;
  const outputLanguage = SUMMARY_LANGS.includes(lang) ? lang : 'en';
  const options = {
    type: 'key-points',
    format: 'plain-text',
    length: 'long',
    sharedContext: 'The transcript of a spoken video.',
    expectedInputLanguages: [SUMMARY_LANGS.includes(lang) ? lang : 'en'],
    outputLanguage,
  };
  if (await Summarizer.availability(options) === 'unavailable') return null;
  return Summarizer.create({ ...options, monitor: monitorFor('the summarizer', onProgress) });
}

async function fits(api, text) {
  if (!api.measureInputUsage || !api.inputQuota) return text.length < 12000;
  return (await api.measureInputUsage(text)) <= api.inputQuota * 0.9;
}

// Splits sentences into pieces of text that fit the model.
async function chunksFor(api, sentences, render) {
  const chunks = [];
  let cur = [];
  for (const s of sentences) {
    const next = [...cur, s];
    if (cur.length && !(await fits(api, render(next)))) { chunks.push(cur); cur = [s]; } else cur = next;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

async function summarize(summarizer, sentences, onProgress) {
  const render = (list) => list.map(s => s.text).join(' ');
  const chunks = await chunksFor(summarizer, sentences, render);
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i / chunks.length, 'Summarizing');
    parts.push(await summarizer.summarize(render(chunks[i]), { context: 'Write the key points of what is said.' }));
  }
  if (parts.length === 1) return parts[0];
  const joined = parts.join('\n');
  return (await fits(summarizer, joined)) ? summarizer.summarize(joined) : joined;
}

// ---------- ranking ----------

const STOP = new Set(('a al algo como con de del el ella ellos en entre era es esa ese eso esta este esto fue ha hay la las le les lo los mas me mi muy no nos o para pero por que se si sin sobre son su sus te tu un una uno y ya yo '
  + 'the a an and are as at be but by for from has have he her his i if in is it its me my not of on or our she so that the their them they this to was we were what when which who will with you your').split(' '));

function terms(text) {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9ñ]+/)
    .filter(t => t.length > 2 && !STOP.has(t)).map(t => t.slice(0, 5));
}

// Without the Prompt API: for each key point, the sentence that says it best.
function rankByKeyPoints(sentences, summary) {
  const docs = sentences.map(s => terms(s.text));
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((sentences.length + 1) / ((df.get(t) || 0) + 1)) + 1;
  const vec = (list) => {
    const v = new Map();
    for (const t of list) v.set(t, (v.get(t) || 0) + idf(t));
    return v;
  };
  const cos = (a, b) => {
    let dot = 0, na = 0, nb = 0;
    for (const [t, x] of a) { na += x * x; if (b.has(t)) dot += x * b.get(t); }
    for (const x of b.values()) nb += x * x;
    return dot / (Math.sqrt(na * nb) || 1);
  };
  const svecs = docs.map(vec);
  const points = summary.split(/\n+/).map(l => l.replace(/^[\s*•\-–\d.)]+/, '').trim()).filter(Boolean);
  const best = new Array(sentences.length).fill(0);
  const ranked = [];
  for (const p of points) {
    const pv = vec(terms(p));
    let top = -1, topScore = 0;
    svecs.forEach((sv, i) => {
      const c = cos(pv, sv);
      best[i] = Math.max(best[i], c);
      if (c > topScore && !ranked.includes(i)) { topScore = c; top = i; }
    });
    if (top >= 0) ranked.push(top);
  }
  const rest = sentences.map((_, i) => i).filter(i => !ranked.includes(i)).sort((a, b) => best[b] - best[a]);
  return [...ranked, ...rest];
}

const HIGHLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    ids: { type: 'array', items: { type: 'integer' } },
  },
  required: ['title', 'ids'],
};

async function rankWithNano(sentences, seconds, lang, onProgress) {
  const langs = ['en', 'es', 'ja'].includes(lang) ? [lang] : ['en'];
  const options = {
    expectedInputs: [{ type: 'text', languages: langs }],
    expectedOutputs: [{ type: 'text', languages: langs }],
  };
  if (await LanguageModel.availability(options) === 'unavailable') return null;
  const base = await LanguageModel.create({
    ...options,
    initialPrompts: [{ role: 'system', content: 'You choose the best moments of a video from its transcript to cut a short highlight. Answer only with JSON.' }],
    monitor: monitorFor('Gemini Nano', onProgress),
  });
  const render = (list, target) => [
    'Transcript of a video, one sentence per line: [id] (seconds) text',
    ...list.map(s => `[${s.id}] (${(s.e - s.s).toFixed(1)}) ${s.text}`),
    '',
    `Choose sentences for a highlight of about ${Math.round(target)} seconds that keeps the main ideas and makes sense on its own.`,
    'Prefer complete thoughts, strong or surprising statements and the conclusion. Skip greetings, filler and repeated ideas.',
    'Return "ids" ordered from most to least important (listing more than needed is fine) and a short "title" in the language of the transcript.',
  ].join('\n');
  const total = sentences.reduce((n, s) => n + s.e - s.s, 0);
  const chunks = await chunksFor(base, sentences, (list) => render(list, seconds));
  const rankings = [];
  let title = '';
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i / chunks.length, `Gemini Nano is choosing (${i + 1}/${chunks.length})`);
    const share = seconds * chunks[i].reduce((n, s) => n + s.e - s.s, 0) / total;
    const session = chunks.length > 1 && base.clone ? await base.clone() : base;
    const raw = await session.prompt(render(chunks[i], share), { responseConstraint: HIGHLIGHT_SCHEMA });
    const data = JSON.parse(raw);
    const valid = new Set(chunks[i].map(s => s.id));
    rankings.push([...new Set((data.ids || []).filter(id => valid.has(id)))]);
    title ||= data.title || '';
    if (session !== base) session.destroy?.();
  }
  base.destroy?.();
  // interleave the chunks' rankings so every part of a long video gets its turn
  const ranked = [];
  for (let r = 0; rankings.some(list => r < list.length); r++) for (const list of rankings) if (r < list.length) ranked.push(list[r]);
  return { ranked, title };
}

// Most important first until the target length, then back in the order they were said.
export function pickRanges(sentences, ranked, seconds) {
  const chosen = [];
  let total = 0;
  const seen = new Set();
  for (const id of [...ranked, ...sentences.map(s => s.id)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = sentences[id];
    const d = s.e - s.s + 0.24;
    if (chosen.length && total + d > seconds * 1.15) continue;
    chosen.push(s);
    total += d;
    if (total >= seconds * 0.92) break;
  }
  chosen.sort((a, b) => a.s - b.s);
  const ranges = [];
  for (const s of chosen) {
    const a = Math.max(0, s.s - 0.12), b = s.e + 0.12;
    if (ranges.length && a - ranges.at(-1)[1] < 0.35) ranges.at(-1)[1] = b;
    else ranges.push([a, b]);
  }
  return { ranges, ids: chosen.map(s => s.id), total };
}

// Starts the models right away (inside the click), then does the work.
export async function findHighlights(words, seconds, lang, onProgress) {
  const sentences = sentencesFrom(words);
  if (!sentences.length) throw new Error('The transcript is empty');
  const summarizerP = makeSummarizer(lang, onProgress).catch((err) => { console.warn(err); return null; });
  const useNano = 'LanguageModel' in self;
  const nanoP = useNano ? rankWithNano(sentences, seconds, lang, onProgress).catch((err) => { console.warn(err); return null; }) : Promise.resolve(null);
  const summarizer = await summarizerP;
  let summary = '';
  if (summarizer) {
    summary = await summarize(summarizer, sentences, onProgress);
    summarizer.destroy?.();
  }
  const nano = await nanoP;
  let ranked, method;
  if (nano?.ranked.length) { ranked = nano.ranked; method = 'Gemini Nano'; } else if (summary) { ranked = rankByKeyPoints(sentences, summary); method = 'Summarizer key points'; } else {
    throw new Error("Chrome's built-in AI is not available in this browser (Summarizer and Prompt API).");
  }
  return { ...pickRanges(sentences, ranked, seconds), summary, title: nano?.title || '', method, sentences };
}

// ---------- translation ----------

export async function detectLanguage(text) {
  if (!('LanguageDetector' in self)) return null;
  const detector = await LanguageDetector.create();
  const [top] = await detector.detect(text.slice(0, 2000));
  detector.destroy?.();
  return top?.detectedLanguage && top.detectedLanguage !== 'und' ? top.detectedLanguage : null;
}

// The translated words of one sentence, spread over the time its original words were spoken.
// Pauses inside the sentence get no words, so the translation keeps the rhythm of the speech.
export function spreadWords(srcWords, text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (!tokens.length || !srcWords.length) return [];
  const segs = [];
  for (const w of srcWords) {
    if (segs.length && w.s - segs.at(-1)[1] < 0.25) segs.at(-1)[1] = Math.max(segs.at(-1)[1], w.e);
    else segs.push([w.s, w.e]);
  }
  const speech = segs.reduce((n, [a, b]) => n + (b - a), 0) || 0.001;
  const at = (fraction) => {
    let left = fraction * speech;
    for (const [a, b] of segs) {
      if (left <= b - a) return a + left;
      left -= b - a;
    }
    return segs.at(-1)[1];
  };
  const weights = tokens.map(t => t.length + 1);
  const W = weights.reduce((n, x) => n + x, 0);
  let cum = 0;
  return tokens.map((t, i) => {
    const s = at(cum / W);
    cum += weights[i];
    const e = at(cum / W);
    return { w: t, s: +s.toFixed(3), e: +Math.max(e, s + 0.05).toFixed(3) };
  });
}

// Starts the translator right away (inside the click), then translates sentence by sentence.
export async function translateWords(words, from, to, onProgress) {
  if (!('Translator' in self)) throw new Error("Chrome's Translator API is not available in this browser.");
  const options = { sourceLanguage: from, targetLanguage: to };
  const availability = await Translator.availability(options);
  if (availability === 'unavailable') throw new Error(`Chrome can't translate from ${from} to ${to}.`);
  const translator = await Translator.create({ ...options, monitor: monitorFor(`the ${from}→${to} translator`, onProgress) });
  const sentences = sentencesFrom(words);
  const out = [];
  for (let i = 0; i < sentences.length; i++) {
    onProgress?.(i / sentences.length, `Translating sentence ${i + 1} of ${sentences.length}`);
    const text = await translator.translate(sentences[i].text);
    out.push(...spreadWords(sentences[i].words, text));
  }
  translator.destroy?.();
  return out;
}
