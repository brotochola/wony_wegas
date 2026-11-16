// Worker for the local AI jobs, so the editor never freezes:
//   vad         Silero VAD (2 MB): speech probability every 32 ms
//   transcribe  Whisper (Transformers.js, WebGPU when available, WASM otherwise) with word times and confidence
//
// Messages in:  { id, type: 'vad', pcm }  |  { id, type: 'transcribe', pcm, model, language }
// Messages out: { id, type: 'progress', value, text } | { id, type: 'done', result } | { id, type: 'error', message }
import { SR, splitPoints } from './ai-shared.js';

// A dynamic import: a static cross-origin import inside a module worker is refused under some
// content security policies, the dynamic one is not.
let pipeline, AutoModel, Tensor, env;
function configure(env) {
  env.allowLocalModels = false;
}
const ready = import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2').then((m) => {
  ({ pipeline, AutoModel, Tensor, env } = m);
  configure(env);
});


let vadModel = null;
const asrCache = new Map(); // model name -> { asr, device }

function post(id, type, payload = {}) {
  self.postMessage({ id, type, ...payload });
}

// ---------- device ----------

async function gpuInfo() {
  if (!self.navigator?.gpu) return null;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return null;
    return { f16: adapter.features.has('shader-f16') };
  } catch {
    return null;
  }
}

// Same choices the benchmark measured: fp16/q4f16 on a GPU with f16, fp32/q4 on other GPUs, q8 on the CPU.
function dtypeFor(device, gpu) {
  if (device === 'webgpu') {
    return gpu?.f16
      ? { encoder_model: 'fp16', decoder_model_merged: 'q4f16' }
      : { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  }
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

async function getAsr(model, id) {
  if (asrCache.has(model)) return asrCache.get(model);
  const gpu = await gpuInfo();
  const devices = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const files = new Map();
  const progress_callback = (p) => {
    if (p.status === 'progress' && p.total) {
      files.set(p.file, { loaded: p.loaded, total: p.total });
      let loaded = 0, total = 0;
      for (const f of files.values()) { loaded += f.loaded; total += f.total; }
      post(id, 'progress', { value: loaded / total, text: `Downloading ${model} (${Math.round(total / 1048576)} MB, only the first time)` });
    }
  };
  let lastError = null;
  for (const device of devices) {
    try {
      const asr = await pipeline('automatic-speech-recognition', `onnx-community/whisper-${model}_timestamped`, {
        device, dtype: dtypeFor(device, gpu), progress_callback,
      });
      const entry = { asr, device: device === 'webgpu' ? `WebGPU${gpu?.f16 ? ' f16' : ''}` : 'CPU (WASM)' };
      asrCache.set(model, entry);
      return entry;
    } catch (err) {
      lastError = err;
      console.warn(`whisper on ${device} failed`, err);
    }
  }
  throw lastError || new Error('Could not load Whisper');
}

// ---------- VAD ----------

async function runVad(id, pcm) {
  if (!vadModel) {
    post(id, 'progress', { value: 0, text: 'Loading the voice detector (2 MB)' });
    vadModel = await AutoModel.from_pretrained('onnx-community/silero-vad', { config: { model_type: 'custom' }, dtype: 'fp32' });
  }
  // Like the official wrapper: 512 new samples plus the last 64 as context, state carried along.
  let state = new Tensor('float32', new Float32Array(256), [2, 1, 128]);
  const sr = new Tensor('int64', [BigInt(SR)], []);
  const ctx = new Float32Array(64);
  const steps = Math.floor(pcm.length / 512);
  const probs = new Float32Array(steps);
  const x = new Float32Array(576);
  for (let k = 0; k < steps; k++) {
    const i = k * 512;
    x.set(ctx);
    x.set(pcm.subarray(i, i + 512), 64);
    const out = await vadModel({ input: new Tensor('float32', x.slice(), [1, 576]), sr, state });
    state = out.stateN;
    probs[k] = out.output.data[0];
    ctx.set(pcm.subarray(i + 448, i + 512));
    if (k % 500 === 0) post(id, 'progress', { value: k / steps, text: 'Finding speech' });
  }
  return { probs, hop: 512 / SR };
}

// ---------- Whisper with word confidence ----------

// The pipeline does not return token probabilities. A logits processor sees each step's
// distribution; the token actually chosen shows up as the last input id of the next step.
function makeRecorder() {
  const steps = [];
  let pending = null;
  const fn = (inputIds, logits) => {
    if (pending) {
      const chosen = Number(inputIds[0].at(-1));
      steps.push({ id: chosen, p: Math.exp(pending[chosen]) });
    }
    const v = logits.data, n = logits.dims.at(-1);
    let max = -Infinity;
    for (let i = 0; i < n; i++) if (v[i] > max) max = v[i];
    let sum = 0;
    for (let i = 0; i < n; i++) sum += Math.exp(v[i] - max);
    const logZ = max + Math.log(sum);
    pending = new Float32Array(n);
    for (let i = 0; i < n; i++) pending[i] = v[i] - logZ;
    return logits;
  };
  return { fn, steps };
}

const norm = (t) => t.toLowerCase().normalize('NFC').replace(/[^\p{L}\p{N}']/gu, '');

// Word confidences from tokens (a new word starts with a space), matched to the pipeline's words.
function wordConfidences(tokenizer, steps, chunks) {
  const eot = 50257; // first special token in the multilingual vocabulary
  const words = [];
  for (const s of steps) {
    if (s.id >= eot) continue;
    const piece = tokenizer.decode([s.id]);
    if (piece.startsWith(' ') || !words.length) words.push({ ids: [s.id], ps: [s.p] });
    else { words.at(-1).ids.push(s.id); words.at(-1).ps.push(s.p); }
  }
  const tokenWords = words.map(w => ({ key: norm(tokenizer.decode(w.ids)), conf: Math.min(...w.ps) })).filter(w => w.key);
  const out = chunks.map(() => null);
  // walk both lists; on a mismatch look a few words ahead on either side
  let j = 0;
  for (let i = 0; i < chunks.length && j < tokenWords.length; i++) {
    const key = norm(chunks[i].text);
    if (!key) continue;
    let k = j;
    while (k < Math.min(tokenWords.length, j + 4) && tokenWords[k].key !== key) k++;
    if (k < tokenWords.length && tokenWords[k].key === key) { out[i] = tokenWords[k].conf; j = k + 1; }
  }
  return out;
}

async function transcribe(id, pcm, model, language) {
  const { asr, device } = await getAsr(model, id);
  const cuts = splitPoints(pcm);
  const words = [];
  const total = pcm.length / SR;
  for (let i = 0; i < cuts.length - 1; i++) {
    const offset = cuts[i] / SR;
    post(id, 'progress', { value: offset / total, text: `Transcribing with ${model} on ${device}` });
    const rec = makeRecorder();
    const opts = { task: 'transcribe', return_timestamps: 'word', logits_processor: [rec.fn] };
    if (language && language !== 'auto') opts.language = language;
    const out = await asr(pcm.subarray(cuts[i], cuts[i + 1]), opts);
    const chunks = out.chunks || [];
    const confs = wordConfidences(asr.tokenizer, rec.steps, chunks);
    chunks.forEach((c, k) => {
      const [a, b] = c.timestamp;
      if (a == null) return;
      words.push({ w: c.text.trim(), start: +(a + offset).toFixed(3), end: +((b ?? a) + offset).toFixed(3), conf: confs[k] == null ? null : +confs[k].toFixed(3) });
    });
  }
  return { words, engine: `local:${model}`, device };
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    await ready;
    let result;
    if (type === 'vad') result = await runVad(id, e.data.pcm);
    else if (type === 'transcribe') result = await transcribe(id, e.data.pcm, e.data.model, e.data.language);
    else throw new Error(`unknown job ${type}`);
    post(id, 'done', { result });
  } catch (err) {
    console.error(err);
    post(id, 'error', { message: err?.message || String(err) });
  }
};
