'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// The app root (folder containing package.json). Everything heavy — engine binaries,
// models, temporary WAVs — lives under here by default, deliberately NOT under
// %APPDATA% on C:, because model files are gigabytes and the system drive is often tight.
const APP_ROOT = path.resolve(__dirname, '..', '..');

const DIRS = {
  appRoot: APP_ROOT,
  engine: path.join(APP_ROOT, 'engine'), // whisper.cpp binaries
  models: path.join(APP_ROOT, 'models'), // ggml-*.bin + VAD model
  tools: path.join(APP_ROOT, 'tools-bin'), // ffmpeg/ffprobe when installed by the app
  work: path.join(APP_ROOT, '.work'), // extracted WAVs, whisper json output
};

const SETTINGS_FILE = path.join(APP_ROOT, 'settings.json');

const DEFAULT_SETTINGS = {
  // --- engine ---
  engineVariant: null, // 'cuda12' | 'cuda11' | 'cpu' — null = not installed yet
  modelId: null, // e.g. 'large-v3'
  language: 'auto', // ISO code or 'auto'
  threads: Math.max(1, Math.min(os.cpus().length, 16)),
  useGpu: true,
  flashAttn: true,

  // --- accuracy knobs ---
  beamSize: 5,
  bestOf: 5,
  vad: true, // Silero VAD: the single biggest anti-hallucination win
  vadThreshold: 0.5,
  vadMinSpeechMs: 250,
  vadMinSilenceMs: 100,
  vadMaxSpeechSec: 30,
  vadSpeechPadMs: 30,
  contextMode: 'balanced', // 'off' (-mc 0) | 'balanced' (-mc 64) | 'full' (-mc -1)
  suppressNonSpeech: true, // drop [MUSIC], (laughs), ...
  // DTW gives acoustically-aligned word times, but whisper.cpp only computes them
  // when flash attention is off — so it costs speed. Off by default; the "highest
  // accuracy" profile turns it on.
  dtw: false,
  entropyThold: 2.4,
  logprobThold: -1.0,
  noSpeechThold: 0.6,
  temperature: 0.0,
  temperatureInc: 0.2,
  initialPrompt: '', // custom vocabulary / proper nouns
  translateToEnglish: false,
  detectLanguageBySampling: true, // vote across 3 slices instead of trusting first 30 s

  // --- audio preprocessing ---
  audioHighpass: true, // remove rumble below 60 Hz
  audioLoudnorm: true, // even out quiet/loud speech
  audioDenoise: false, // afftdn — off by default, can smear speech

  // --- subtitle formatting (EBU/Netflix-style defaults) ---
  maxCharsPerLine: 42,
  maxLines: 2,
  maxCharsPerSec: 20,
  minCueDurationMs: 1000,
  maxCueDurationMs: 7000,
  minGapMs: 84, // ~2 frames @ 24 fps
  sentencePauseMs: 700, // pause that forces a new cue
  mergeShortCues: true,
  dropLowConfidence: false,
  lowConfidenceThreshold: 0.35,

  // --- output ---
  outputDir: '', // '' = alongside the source video
  outputFormat: 'srt', // srt | vtt | txt
  utf8Bom: false, // some legacy Windows players need it for Turkish characters
  langSuffix: true, // name files like video.tr.srt so players auto-load them
  lastOpenDir: '',
  ffmpegPath: '',
  ffprobePath: '',
};

function ensureDirs() {
  for (const dir of [DIRS.engine, DIRS.models, DIRS.tools, DIRS.work]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = { APP_ROOT, DIRS, SETTINGS_FILE, DEFAULT_SETTINGS, ensureDirs, loadSettings, saveSettings };
