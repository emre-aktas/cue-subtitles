'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { DIRS } = require('./config');
const media = require('./media');
const engine = require('./engine');
const { buildCues } = require('./segmenter');
const subtitles = require('./subtitles');

// Relative cost of each stage, used to turn per-stage progress into one overall bar.
const WEIGHTS = { extract: 0.10, detect: 0.05, transcribe: 0.80, post: 0.05 };

const STAGE_LABELS = {
  probe: 'Inspecting video',
  extract: 'Extracting audio',
  detect: 'Detecting language',
  transcribe: 'Transcribing speech',
  post: 'Building subtitle cues',
  write: 'Writing file',
  done: 'Done',
};

function newJobId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Run the full video -> subtitle pipeline for one file.
 *
 * Returns { id, promise, cancel }. Progress, live segments and log lines arrive
 * through `onEvent` so the UI can show work as it happens rather than at the end.
 */
function createJob({ videoPath, settings, onEvent }) {
  const id = newJobId();
  const controller = new AbortController();
  const { signal } = controller;

  const workDir = path.join(DIRS.work, id);
  const emit = (type, payload = {}) => {
    try {
      onEvent?.({ jobId: id, type, ...payload });
    } catch {}
  };

  let stageBase = 0;
  const setStage = (stage) => {
    emit('stage', { stage, label: STAGE_LABELS[stage] || stage });
  };
  const setStageProgress = (weightKey, percentWithinStage) => {
    const overall = stageBase + (WEIGHTS[weightKey] || 0) * (Math.max(0, Math.min(100, percentWithinStage)) / 100);
    emit('progress', { percent: Math.max(0, Math.min(100, overall * 100)) });
  };
  const finishStage = (weightKey) => {
    stageBase += WEIGHTS[weightKey] || 0;
    emit('progress', { percent: Math.min(100, stageBase * 100) });
  };

  const cleanup = () => {
    try {
      fs.rmSync(workDir, { recursive: true, force: true });
    } catch {}
  };

  const promise = (async () => {
    const startedAt = Date.now();
    fs.mkdirSync(workDir, { recursive: true });

    const toolOverride = { ffmpeg: settings.ffmpegPath, ffprobe: settings.ffprobePath };

    /* ---------------- 1. probe ---------------- */
    setStage('probe');
    const info = await media.probe(videoPath, toolOverride);
    if (!info.audioStreams.length) {
      throw new Error('This file has no audio track, so there is nothing to transcribe.');
    }
    emit('probed', { info });

    const audioOrder =
      settings.audioOrder != null && info.audioStreams[settings.audioOrder]
        ? settings.audioOrder
        : Math.max(0, info.audioStreams.findIndex((a) => a.isDefault));

    const durationMs = Math.round(info.durationSec * 1000);

    /* ---------------- 2. extract audio ---------------- */
    setStage('extract');
    const wavPath = path.join(workDir, 'audio.wav');
    await media.extractAudio({
      input: videoPath,
      output: wavPath,
      audioOrder,
      filters: {
        highpass: settings.audioHighpass,
        denoise: settings.audioDenoise,
        loudnorm: settings.audioLoudnorm,
      },
      totalDurationSec: info.durationSec,
      onProgress: ({ percent }) => setStageProgress('extract', percent),
      signal,
      override: toolOverride,
    });
    finishStage('extract');
    if (signal.aborted) throw new Error('Job cancelled');

    /* ---------------- engine + model ---------------- */
    const variant = engine.engineStatus(settings.engineVariant);
    if (!variant.installed) {
      throw new Error('No engine installed. Install one from the Setup tab.');
    }
    const model = engine.modelById(settings.modelId);
    if (!model) throw new Error('No model selected.');
    const mStatus = engine.modelStatus(model);
    if (!mStatus.installed) {
      throw new Error(`${model.label} has not been downloaded.`);
    }

    /* ---------------- 3. language detection ---------------- */
    let language = settings.language;
    if (language === 'auto') {
      setStage('detect');
      if (settings.detectLanguageBySampling && info.durationSec > 120) {
        language = await detectBySampling({
          cliPath: variant.cliPath,
          model,
          wavPath,
          workDir,
          durationSec: info.durationSec,
          settings,
          signal,
          toolOverride,
          onProgress: (p) => setStageProgress('detect', p),
          emit,
        });
      } else {
        const det = await engine.detectLanguage({
          cliPath: variant.cliPath,
          model,
          wavPath,
          settings,
          signal,
          onLog: (l) => emit('log', { line: l }),
        });
        language = det?.language || 'auto';
      }
      emit('language', { language });
    }
    finishStage('detect');
    if (signal.aborted) throw new Error('Job cancelled');

    /* ---------------- 4. transcribe ---------------- */
    setStage('transcribe');
    const outBase = path.join(workDir, 'result');
    const runSettings = { ...settings, language: language || 'auto' };
    const args = engine.buildArgs({ model, wavPath, outBase, settings: runSettings });

    emit('log', { line: `whisper-cli ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}` });

    const { vadChunks } = await engine.runWhisper({
      cliPath: variant.cliPath,
      args,
      signal,
      onProgress: (p) => setStageProgress('transcribe', p),
      onSegment: (seg) => emit('segment', { segment: seg }),
      onLog: (line) => emit('log', { line }),
    });
    finishStage('transcribe');
    if (signal.aborted) throw new Error('Job cancelled');

    /* ---------------- 5. parse + segment ---------------- */
    setStage('post');
    const jsonPath = `${outBase}.json`;
    if (!fs.existsSync(jsonPath)) {
      throw new Error('The whisper JSON output is missing.');
    }
    const parsed = engine.parseWhisperJson(jsonPath, { vadChunks });
    if (parsed.remappedSegments) {
      emit('log', {
        line: `VAD timeline correction applied to ${parsed.remappedSegments} segments (${
          vadChunks?.length ? `${vadChunks.length} speech chunks` : 'linear approximation'
        })`,
      });
    }
    setStageProgress('post', 40);

    let cues = [];
    let stats = {};
    if (parsed.words.length) {
      const built = buildCues(parsed.words, runSettings, durationMs);
      cues = built.cues;
      stats = built.stats;
    } else if (parsed.rawSegments.length) {
      // Fall back to whisper's own segments if token detail is unexpectedly missing.
      cues = parsed.rawSegments
        .filter((s) => s.text)
        .map((s, i) => ({
          index: i + 1,
          start: s.start,
          end: s.end,
          text: s.text,
          lines: [s.text],
          confidence: 1,
          warnings: [],
          cps: 0,
        }));
    }
    setStageProgress('post', 90);
    finishStage('post');

    if (!cues.length) {
      throw new Error('No speech found. Check the audio track or lower the VAD threshold.');
    }

    /* ---------------- 6. write ---------------- */
    setStage('write');
    const outPath = subtitles.buildOutputPath({
      videoPath,
      outputDir: settings.outputDir,
      format: settings.outputFormat,
      language: settings.langSuffix ? parsed.language || language : null,
    });
    subtitles.writeSubtitleFile({
      cues,
      filePath: outPath,
      format: settings.outputFormat,
      utf8Bom: settings.utf8Bom,
    });

    const elapsedSec = (Date.now() - startedAt) / 1000;
    const result = {
      jobId: id,
      videoPath,
      outputPath: outPath,
      language: parsed.language || language,
      cues,
      stats: {
        ...stats,
        cueCount: cues.length,
        wordCount: parsed.words.length,
        durationSec: info.durationSec,
        elapsedSec: Math.round(elapsedSec),
        speedFactor: info.durationSec > 0 ? Math.round((info.durationSec / elapsedSec) * 10) / 10 : 0,
        model: model.label,
        engine: settings.engineVariant,
      },
      info,
    };

    emit('progress', { percent: 100 });
    setStage('done');
    emit('done', { result });
    cleanup();
    return result;
  })().catch((err) => {
    cleanup();
    emit('error', { message: err.message });
    throw err;
  });

  return {
    id,
    promise,
    cancel: () => controller.abort(),
  };
}

/**
 * Detect the spoken language from three slices instead of trusting whisper's default
 * first-30-seconds guess, which music, intros or silence can easily fool.
 */
async function detectBySampling({
  cliPath,
  model,
  wavPath,
  workDir,
  durationSec,
  settings,
  signal,
  toolOverride,
  onProgress,
  emit,
}) {
  const points = [0.12, 0.45, 0.78];
  const sliceSec = 30;
  const votes = new Map();

  for (let i = 0; i < points.length; i++) {
    if (signal.aborted) throw new Error('Job cancelled');
    const start = Math.max(0, Math.min(durationSec - sliceSec, durationSec * points[i]));
    const slicePath = path.join(workDir, `sample${i}.wav`);
    try {
      await media.extractAudio({
        input: wavPath,
        output: slicePath,
        audioOrder: 0,
        filters: {},
        startSec: start,
        durationSec: sliceSec,
        signal,
        override: toolOverride,
      });
      const det = await engine.detectLanguage({
        cliPath,
        model,
        wavPath: slicePath,
        settings,
        signal,
        onLog: (l) => emit('log', { line: l }),
      });
      if (det?.language) {
        const prev = votes.get(det.language) || 0;
        votes.set(det.language, prev + (det.probability || 0.5));
        emit('log', { line: `language sample ${i + 1}: ${det.language} (p=${det.probability})` });
      }
    } catch (e) {
      if (/iptal/.test(e.message)) throw e;
      emit('log', { line: `language sample ${i + 1} skipped: ${e.message}` });
    } finally {
      try {
        fs.rmSync(slicePath, { force: true });
      } catch {}
    }
    onProgress?.(((i + 1) / points.length) * 100);
  }

  if (!votes.size) return 'auto';
  return [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

module.exports = { createJob, STAGE_LABELS };
