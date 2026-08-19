'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DIRS } = require('./config');
const { downloadFile, extractArchive } = require('./download');

const WHISPER_RELEASE = 'v1.9.2';
const REL_BASE = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}`;
const HF_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';
const VAD_URL = 'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';
const VAD_FILE = 'ggml-silero-v5.1.2.bin';

const IS_WIN = process.platform === 'win32';
const CLI_NAME = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli';

/** Prebuilt whisper.cpp packages, best-first per platform. */
const ENGINE_VARIANTS = [
  {
    id: 'cuda12',
    label: 'NVIDIA GPU (CUDA 12)',
    detail: 'Fastest option. RTX 20-series or newer with a current driver.',
    platform: 'win32',
    gpu: true,
    downloadMB: 640,
    url: `${REL_BASE}/whisper-cublas-12.4.0-bin-x64.zip`,
    archive: 'whisper-cublas-12.4.0-bin-x64.zip',
  },
  {
    id: 'cuda11',
    label: 'NVIDIA GPU (CUDA 11.8)',
    detail: 'Smaller CUDA package for older drivers.',
    platform: 'win32',
    gpu: true,
    downloadMB: 257,
    url: `${REL_BASE}/whisper-cublas-11.8.0-bin-x64.zip`,
    archive: 'whisper-cublas-11.8.0-bin-x64.zip',
  },
  {
    id: 'cpu',
    label: 'CPU (OpenBLAS)',
    detail: 'No GPU needed. Runs anywhere, but slow on the large models.',
    platform: 'win32',
    gpu: false,
    downloadMB: 20,
    url: `${REL_BASE}/whisper-blas-bin-x64.zip`,
    archive: 'whisper-blas-bin-x64.zip',
  },
  {
    id: 'linux-x64',
    label: 'Linux x64 (CPU)',
    detail: 'Ubuntu x64 build.',
    platform: 'linux',
    gpu: false,
    downloadMB: 9,
    url: `${REL_BASE}/whisper-bin-ubuntu-x64.tar.gz`,
    archive: 'whisper-bin-ubuntu-x64.tar.gz',
  },
  {
    id: 'linux-arm64',
    label: 'Linux arm64 (CPU)',
    detail: 'Ubuntu arm64 build.',
    platform: 'linux',
    gpu: false,
    downloadMB: 4,
    url: `${REL_BASE}/whisper-bin-ubuntu-arm64.tar.gz`,
    archive: 'whisper-bin-ubuntu-arm64.tar.gz',
  },
];

/**
 * Model catalog. `dtw` is the alignment-head preset name accepted by whisper-cli's
 * -dtw flag (verified against v1.9.2; null means the model has no preset).
 */
const MODELS = [
  {
    id: 'large-v3',
    file: 'ggml-large-v3.bin',
    label: 'large-v3',
    sizeMB: 2952,
    vramMB: 3900,
    dtw: 'large.v3',
    tier: 'best',
    detail: 'Highest accuracy across all 99 supported languages.',
  },
  {
    id: 'large-v3-q5',
    file: 'ggml-large-v3-q5_0.bin',
    label: 'large-v3 (q5_0)',
    sizeMB: 1031,
    vramMB: 1900,
    dtw: 'large.v3',
    tier: 'best',
    detail: 'Quantised large-v3: near-identical accuracy, a third of the size.',
  },
  {
    id: 'large-v3-turbo',
    file: 'ggml-large-v3-turbo.bin',
    label: 'large-v3-turbo',
    sizeMB: 1549,
    vramMB: 1800,
    dtw: 'large.v3.turbo',
    tier: 'fast',
    detail: 'Very close to large-v3 and ~4× faster. Ideal for long videos.',
  },
  {
    id: 'large-v3-turbo-q5',
    file: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'large-v3-turbo (q5_0)',
    sizeMB: 547,
    vramMB: 1100,
    dtw: 'large.v3.turbo',
    tier: 'fast',
    detail: 'The best balance of speed, size and accuracy. Start here.',
  },
  {
    id: 'medium',
    file: 'ggml-medium.bin',
    label: 'medium',
    sizeMB: 1463,
    vramMB: 1600,
    dtw: 'medium',
    tier: 'mid',
    detail: 'Previous-generation mid model. Turbo is usually better.',
  },
  {
    id: 'small',
    file: 'ggml-small.bin',
    label: 'small',
    sizeMB: 465,
    vramMB: 700,
    dtw: 'small',
    tier: 'mid',
    detail: 'For quick drafts.',
  },
  {
    id: 'base',
    file: 'ggml-base.bin',
    label: 'base',
    sizeMB: 141,
    vramMB: 300,
    dtw: 'base',
    tier: 'draft',
    detail: 'Testing only — accuracy is low.',
  },
];

function modelById(id) {
  return MODELS.find((m) => m.id === id) || null;
}

function variantById(id) {
  return ENGINE_VARIANTS.find((v) => v.id === id) || null;
}

function variantsForPlatform() {
  return ENGINE_VARIANTS.filter((v) => v.platform === process.platform);
}

/** Recursively look for the whisper-cli binary inside an extracted package. */
function findCli(dir, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === CLI_NAME) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findCli(path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function variantDir(id) {
  return path.join(DIRS.engine, id);
}

function engineStatus(id) {
  const dir = variantDir(id);
  const cli = findCli(dir);
  return { id, installed: Boolean(cli), cliPath: cli, dir };
}

function installedEngines() {
  return variantsForPlatform().map((v) => ({ ...v, ...engineStatus(v.id) }));
}

function modelPath(model) {
  return path.join(DIRS.models, model.file);
}

function modelStatus(model) {
  const p = modelPath(model);
  let ok = false;
  let actualMB = 0;
  try {
    const st = fs.statSync(p);
    actualMB = st.size / (1024 * 1024);
    // Guard against a truncated file from an interrupted download.
    ok = actualMB > model.sizeMB * 0.9;
  } catch {}
  return { installed: ok, path: p, actualMB: Math.round(actualMB) };
}

function modelCatalog() {
  return MODELS.map((m) => ({ ...m, ...modelStatus(m) }));
}

function vadPath() {
  return path.join(DIRS.models, VAD_FILE);
}

function vadInstalled() {
  try {
    return fs.statSync(vadPath()).size > 500 * 1024;
  } catch {
    return false;
  }
}

/** Download + extract a prebuilt engine package. */
async function installEngine(id, { onProgress, signal } = {}) {
  const v = variantById(id);
  if (!v) throw new Error(`Unknown engine: ${id}`);
  if (v.platform !== process.platform) {
    throw new Error(`${v.label} is not available on this platform.`);
  }

  const archivePath = path.join(DIRS.engine, '_cache', v.archive);

  // A previous attempt may have downloaded the archive and only failed to extract it;
  // 640 MB is worth not fetching twice.
  let cached = false;
  try {
    cached = fs.statSync(archivePath).size > v.downloadMB * 1024 * 1024 * 0.9;
  } catch {}

  if (cached) {
    onProgress?.({ stage: 'download', percent: 100, label: 'Using the already-downloaded archive…' });
  } else {
    onProgress?.({ stage: 'download', percent: 0, label: `Downloading ${v.label}…` });
    await downloadFile({
      url: v.url,
      dest: archivePath,
      signal,
      onProgress: ({ percent, received, total, bps }) =>
        onProgress?.({
          stage: 'download',
          percent,
          received,
          total,
          bps,
          label: `Downloading ${v.label}… ${percent.toFixed(0)}%`,
        }),
    });
  }

  onProgress?.({ stage: 'extract', percent: 100, label: 'Extracting archive…' });
  const dir = variantDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
  await extractArchive(archivePath, dir);

  const cli = findCli(dir);
  if (!cli) throw new Error('whisper-cli was not found inside the archive.');
  if (!IS_WIN) {
    try {
      fs.chmodSync(cli, 0o755);
    } catch {}
  }

  // The archive is large; drop it once extraction succeeded.
  try {
    fs.rmSync(archivePath, { force: true });
  } catch {}

  return engineStatus(id);
}

async function installModel(id, { onProgress, signal } = {}) {
  const m = modelById(id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  await downloadFile({
    url: `${HF_BASE}/${m.file}`,
    dest: modelPath(m),
    signal,
    onProgress: ({ percent, received, total, bps }) =>
      onProgress?.({
        stage: 'download',
        percent,
        received,
        total,
        bps,
        label: `Downloading ${m.label}… ${percent.toFixed(0)}%`,
      }),
  });
  return { id, ...modelStatus(m) };
}

async function installVad({ onProgress, signal } = {}) {
  if (vadInstalled()) return { installed: true, path: vadPath() };
  await downloadFile({
    url: VAD_URL,
    dest: vadPath(),
    signal,
    onProgress: ({ percent }) =>
      onProgress?.({ stage: 'download', percent, label: `Downloading VAD model… ${percent.toFixed(0)}%` }),
  });
  return { installed: vadInstalled(), path: vadPath() };
}

function deleteModel(id) {
  const m = modelById(id);
  if (!m) throw new Error(`Unknown model: ${id}`);
  fs.rmSync(modelPath(m), { force: true });
  fs.rmSync(`${modelPath(m)}.part`, { force: true });
  return { id, ...modelStatus(m) };
}

/**
 * Assemble whisper-cli arguments.
 *
 * Two dependencies are enforced here because whisper.cpp fails *silently* otherwise:
 *  - DTW token timestamps only get computed when flash attention is OFF, so enabling
 *    `dtw` forces `-nfa`. (Verified on v1.9.2: with -fa every t_dtw stays -1.)
 *  - `--vad` is useless without `-vm`, so we drop VAD if the model file is missing.
 */
function buildArgs({ model, wavPath, outBase, settings, detectOnly = false }) {
  const s = settings;
  const args = ['-m', modelPath(model), '-f', wavPath];

  args.push('-t', String(Math.max(1, s.threads)));
  if (!s.useGpu) args.push('-ng');

  if (detectOnly) {
    args.push('-l', 'auto', '-dl');
    return args;
  }

  args.push('-l', s.language || 'auto');
  if (s.translateToEnglish) args.push('-tr');

  // Decoding quality
  args.push('-bs', String(s.beamSize), '-bo', String(s.bestOf));
  args.push('-et', String(s.entropyThold));
  args.push('-lpt', String(s.logprobThold));
  args.push('-nth', String(s.noSpeechThold));
  args.push('-tp', String(s.temperature));
  args.push('-tpi', String(s.temperatureInc));

  const mc = s.contextMode === 'off' ? 0 : s.contextMode === 'balanced' ? 64 : -1;
  args.push('-mc', String(mc));

  if (s.suppressNonSpeech) args.push('-sns');
  if (s.initialPrompt && s.initialPrompt.trim()) {
    args.push('--prompt', s.initialPrompt.trim(), '--carry-initial-prompt');
  }

  // DTW refinement is mutually exclusive with flash attention.
  const useDtw = Boolean(s.dtw && model.dtw);
  if (useDtw) args.push('-dtw', model.dtw, '-nfa');
  else if (s.flashAttn) args.push('-fa');
  else args.push('-nfa');

  if (s.vad && vadInstalled()) {
    args.push('--vad', '-vm', vadPath());
    args.push('-vt', String(s.vadThreshold));
    args.push('-vspd', String(s.vadMinSpeechMs));
    args.push('-vsd', String(s.vadMinSilenceMs));
    args.push('-vmsd', String(s.vadMaxSpeechSec));
    args.push('-vp', String(s.vadSpeechPadMs));
  }

  // Full JSON carries per-token times + probabilities, which the segmenter needs.
  args.push('-ojf', '-of', outBase, '-pp');
  return args;
}

const SEGMENT_LINE = /^\[(\d\d):(\d\d):(\d\d)\.(\d{3}) --> (\d\d):(\d\d):(\d\d)\.(\d{3})\]\s*(.*)$/;
const PROGRESS_LINE = /progress\s*=\s*(\d+)%/;
const DETECT_LINE = /auto-detected language:\s*([a-z]{2,3})\s*\(p\s*=\s*([\d.]+)\)/i;

// With --vad, whisper.cpp strips the silence and transcribes a shortened waveform.
// It maps *segment* boundaries back to the original timeline but leaves *token*
// timestamps in the shortened one, so word times drift earlier by the accumulated
// silence. These log lines are the exact chunk mapping needed to undo that.
const VAD_INFO_LINE =
  /vad_segment_info:\s*orig_start:\s*([\d.]+),\s*orig_end:\s*([\d.]+),\s*vad_start:\s*([\d.]+),\s*vad_end:\s*([\d.]+)/;

function hhmmssToMs(h, m, sec, ms) {
  return (Number(h) * 3600 + Number(m) * 60 + Number(sec)) * 1000 + Number(ms);
}

/** Spawn whisper-cli, streaming progress + live segments back to the caller. */
function runWhisper({ cliPath, args, cwd, onProgress, onSegment, onLog, signal }) {
  return new Promise((resolve, reject) => {
    const child = spawn(cliPath, args, {
      cwd: cwd || path.dirname(cliPath),
      windowsHide: true,
    });

    let killed = false;
    let tail = '';
    let detected = null;
    const vadChunks = [];

    const onAbort = () => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const handleLine = (line) => {
      const t = line.trim();
      if (!t) return;

      const seg = SEGMENT_LINE.exec(t);
      if (seg) {
        onSegment?.({
          startMs: hhmmssToMs(seg[1], seg[2], seg[3], seg[4]),
          endMs: hhmmssToMs(seg[5], seg[6], seg[7], seg[8]),
          text: seg[9].trim(),
        });
        return;
      }

      const pr = PROGRESS_LINE.exec(t);
      if (pr) {
        onProgress?.(Math.min(100, Number(pr[1])));
        return;
      }

      const vi = VAD_INFO_LINE.exec(t);
      if (vi) {
        vadChunks.push({
          origStart: Number(vi[1]),
          origEnd: Number(vi[2]),
          vadStart: Number(vi[3]),
          vadEnd: Number(vi[4]),
        });
        return;
      }

      const dl = DETECT_LINE.exec(t);
      if (dl) {
        detected = { language: dl[1].toLowerCase(), probability: Number(dl[2]) };
      }

      onLog?.(t);
      tail = `${tail}\n${t}`.slice(-4000);
    };

    const mkReader = () => {
      let buf = '';
      return (chunk) => {
        buf += chunk.toString('utf8');
        const lines = buf.split(/\r?\n/);
        buf = lines.pop() || '';
        lines.forEach(handleLine);
      };
    };

    child.stdout.on('data', mkReader());
    child.stderr.on('data', mkReader());

    child.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(`Could not start whisper-cli: ${e.message}`));
    });

    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (killed) return reject(new Error('Job cancelled'));
      if (code !== 0) return reject(new Error(`whisper-cli failed (${code}):${tail}`));
      vadChunks.sort((a, b) => a.vadStart - b.vadStart);
      resolve({ detected, vadChunks });
    });
  });
}

/** Language detection on one slice. Returns {language, probability} or null. */
async function detectLanguage({ cliPath, model, wavPath, settings, signal, onLog }) {
  const args = buildArgs({ model, wavPath, outBase: null, settings, detectOnly: true });
  try {
    const { detected } = await runWhisper({ cliPath, args, signal, onLog });
    return detected;
  } catch (e) {
    // -dl exits non-zero by design on some builds; the log line is what matters.
    if (/iptal/.test(e.message)) throw e;
    const m = DETECT_LINE.exec(e.message);
    return m ? { language: m[1].toLowerCase(), probability: Number(m[2]) } : null;
  }
}

// whisper.cpp renders control tokens as [_BEG_], [_EOT_], [_TT_290], [_LANG_tr] …
// (note the digits — an [A-Z]+ pattern silently lets timestamp tokens through and
// they end up glued onto the preceding word), plus the <|...|> form.
/**
 * Build a compressed-timeline -> original-timeline converter from the VAD chunk map.
 * Each chunk keeps its duration, so inside a chunk the correction is a plain offset.
 *
 * Times that land in a removed silence need a direction, and it must depend on which
 * edge of a word we are converting: a *start* belongs to the speech that follows it,
 * an *end* to the speech that precedes it. Snapping both the same way is what makes
 * either the first word of a burst jump backwards or the last word run forwards into
 * the next burst — both produce absurd multi-second cues.
 */
function makeVadMapper(chunks) {
  if (!chunks || !chunks.length) return null;
  const sorted = [...chunks].sort((a, b) => a.vadStart - b.vadStart);

  /**
   * @param {number} ms    time in the shortened timeline
   * @param {'start'|'end'} kind
   * @param {{lo:number,hi:number}|null} win  the segment's already-correct bounds in
   *   the original timeline; used as a guard rail, since a snap that leaves the
   *   segment is provably wrong (this is what rescues sentence-final punctuation,
   *   whose timestamp often lands in the silence after the phrase).
   */
  return (ms, kind = 'start', win = null) => {
    const t = ms / 1000;
    const EPS = 1e-6;
    const inWin = (v) => !win || (v >= win.lo && v <= win.hi);
    const fit = (v) => (win ? Math.min(Math.max(v, win.lo), win.hi) : v);

    if (t <= sorted[0].vadStart + EPS) return Math.round(fit(sorted[0].origStart * 1000));

    for (let i = 0; i < sorted.length; i++) {
      const c = sorted[i];
      if (t >= c.vadStart - EPS && t <= c.vadEnd + EPS) {
        return Math.round(fit((c.origStart + (t - c.vadStart)) * 1000));
      }
      const next = sorted[i + 1];
      if (next && t > c.vadEnd && t < next.vadStart) {
        const forward = next.origStart * 1000;
        const backward = c.origEnd * 1000;
        const primary = kind === 'end' ? backward : forward;
        const secondary = kind === 'end' ? forward : backward;
        if (inWin(primary)) return Math.round(primary);
        if (inWin(secondary)) return Math.round(secondary);
        return Math.round(fit(primary));
      }
    }

    const last = sorted[sorted.length - 1];
    return Math.round(fit((last.origEnd + (t - last.vadEnd)) * 1000));
  };
}

const SPECIAL_TOKEN = /^\s*(\[_[^\]]*\]|<\|[^|]*\|>)\s*$/;

/**
 * Flatten whisper's full-JSON tokens into words.
 *
 * Whisper emits sub-word tokens where a leading space marks a word boundary, so we
 * accumulate pieces until the next space-prefixed token. `t_dtw` (centiseconds) is
 * preferred when present because it is acoustically aligned rather than heuristic.
 */
function parseWhisperJson(jsonPath, { vadChunks = null } = {}) {
  const raw = fs.readFileSync(jsonPath, 'utf8');
  const data = JSON.parse(raw);
  const language = data?.result?.language || null;
  const segments = Array.isArray(data.transcription) ? data.transcription : [];

  const vadMapper = makeVadMapper(vadChunks);
  let remappedSegments = 0;

  const words = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    // Second line of defence: strip control tokens that were concatenated onto a
    // word rather than emitted standalone.
    const text = cur.text.replace(/\[_[^\]]*\]|<\|[^|]*\|>/g, '').trim();
    if (text) {
      words.push({
        text,
        start: cur.start,
        end: Math.max(cur.end, cur.start + 10),
        p: cur.pSum / Math.max(1, cur.pCount),
      });
    }
    cur = null;
  };

  for (const seg of segments) {
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
    if (!tokens.length) {
      // No token detail (shouldn't happen with -ojf, but stay resilient).
      const text = String(seg.text || '').trim();
      if (text) {
        words.push({ text, start: seg.offsets?.from ?? 0, end: seg.offsets?.to ?? 0, p: 1 });
      }
      continue;
    }

    const textTokens = tokens.filter((tk) => {
      const t = String(tk.text ?? '');
      return t.trim() && !SPECIAL_TOKEN.test(t);
    });
    if (!textTokens.length) continue;

    const segFrom = seg.offsets?.from ?? 0;
    const segTo = seg.offsets?.to ?? segFrom;
    const tokLo = Math.min(...textTokens.map((tk) => tk.offsets?.from ?? 0));
    const tokHi = Math.max(...textTokens.map((tk) => tk.offsets?.to ?? 0));

    // Pick the correction for this segment: the exact VAD chunk map when we captured
    // it, otherwise a linear stretch onto the segment's own (already-correct)
    // boundaries, and nothing at all when the two timelines already agree.
    let transform = (ms) => ms;
    const segWindow = segTo > segFrom ? { lo: segFrom, hi: segTo } : null;
    const skewed = Math.abs(tokLo - segFrom) > 200 || Math.abs(tokHi - segTo) > 200;
    if (vadMapper) {
      transform = vadMapper;
      if (skewed) remappedSegments += 1;
    } else if (skewed && tokHi > tokLo && segTo > segFrom) {
      const scale = (segTo - segFrom) / (tokHi - tokLo);
      transform = (ms) => Math.round(segFrom + (ms - tokLo) * scale);
      remappedSegments += 1;
    }

    for (const tk of textTokens) {
      const rawText = String(tk.text ?? '');

      // t_dtw is in centiseconds and lives in the same timeline as the offsets.
      const dtwMs = typeof tk.t_dtw === 'number' && tk.t_dtw >= 0 ? tk.t_dtw * 10 : null;
      const rawFrom = dtwMs != null ? dtwMs : (tk.offsets?.from ?? 0);
      const rawTo = Math.max(tk.offsets?.to ?? rawFrom, rawFrom);
      const from = transform(rawFrom, 'start', segWindow);
      const to = Math.max(transform(rawTo, 'end', segWindow), from);
      const p = typeof tk.p === 'number' ? tk.p : 1;

      const startsWord = /^\s/.test(rawText) || cur === null;
      if (startsWord) {
        flush();
        cur = { text: rawText.trim(), start: from, end: to, pSum: p, pCount: 1 };
      } else {
        cur.text += rawText;
        cur.end = Math.max(cur.end, to);
        cur.pSum += p;
        cur.pCount += 1;
      }
    }
    flush();
  }

  // Monotonic guard: token times can jitter backwards across segment seams.
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].start) words[i].start = words[i - 1].start;
    if (words[i].end < words[i].start) words[i].end = words[i].start + 10;
  }

  const rawSegments = segments.map((s) => ({
    start: s.offsets?.from ?? 0,
    end: s.offsets?.to ?? 0,
    text: String(s.text || '').trim(),
  }));

  return { language, words, rawSegments, remappedSegments };
}

module.exports = {
  WHISPER_RELEASE,
  ENGINE_VARIANTS,
  MODELS,
  modelById,
  variantById,
  variantsForPlatform,
  installedEngines,
  engineStatus,
  modelCatalog,
  modelStatus,
  modelPath,
  vadPath,
  vadInstalled,
  installEngine,
  installModel,
  installVad,
  deleteModel,
  buildArgs,
  runWhisper,
  detectLanguage,
  parseWhisperJson,
  makeVadMapper,
  findCli,
};
