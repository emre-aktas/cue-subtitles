'use strict';

/**
 * End-to-end check of the non-Electron core: ffmpeg extraction -> whisper.cpp ->
 * JSON parsing -> cue segmentation -> SRT.
 *
 *   node tools/selftest.js <video-or-audio-file> [modelId]
 *
 * Prints the resulting SRT plus formatting diagnostics so regressions in the
 * segmenter are visible without launching the UI.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../electron/lib/config');
const media = require('../electron/lib/media');
const engine = require('../electron/lib/engine');
const { buildCues } = require('../electron/lib/segmenter');
const subtitles = require('../electron/lib/subtitles');

async function main() {
  const input = process.argv[2];
  const modelId = process.argv[3] || null;
  if (!input || !fs.existsSync(input)) {
    console.error('Usage: node tools/selftest.js <file> [modelId]');
    process.exit(1);
  }

  config.ensureDirs();
  const settings = config.loadSettings();

  const variant =
    engine.installedEngines().find((v) => v.id === settings.engineVariant && v.installed) ||
    engine.installedEngines().find((v) => v.installed);
  if (!variant) throw new Error('No engine installed.');

  const model =
    engine.modelById(modelId || settings.modelId) ||
    engine.modelCatalog().find((m) => m.installed);
  if (!model) throw new Error('No model installed.');
  if (!engine.modelStatus(model).installed) throw new Error(`${model.label} has not been downloaded.`);

  console.log(`engine : ${variant.id} (${variant.cliPath})`);
  console.log(`model  : ${model.label}`);
  console.log(`VAD    : ${engine.vadInstalled() ? 'present' : 'MISSING'}`);

  const info = await media.probe(input);
  console.log(`input  : ${info.fileName} · ${info.durationSec.toFixed(1)}s · ${info.audioStreams.length} audio track(s)`);

  const work = path.join(config.DIRS.work, 'selftest');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  const wav = path.join(work, 'audio.wav');
  const tExtract = Date.now();
  await media.extractAudio({
    input,
    output: wav,
    audioOrder: 0,
    filters: {
      highpass: settings.audioHighpass,
      denoise: settings.audioDenoise,
      loudnorm: settings.audioLoudnorm,
    },
    totalDurationSec: info.durationSec,
  });
  console.log(`audio extraction: ${((Date.now() - tExtract) / 1000).toFixed(1)}s`);

  const outBase = path.join(work, 'result');
  const args = engine.buildArgs({ model, wavPath: wav, outBase, settings });
  console.log(`\ncommand:\n  whisper-cli ${args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}\n`);

  const tRun = Date.now();
  const { vadChunks } = await engine.runWhisper({
    cliPath: variant.cliPath,
    args,
    onProgress: (p) => process.stdout.write(`\rtranscribing: ${p}%   `),
    onSegment: () => {},
    onLog: () => {},
  });
  const runSec = (Date.now() - tRun) / 1000;
  console.log(`\ntranscribing: ${runSec.toFixed(1)}s (${(info.durationSec / runSec).toFixed(1)}x realtime)`);

  const parsed = engine.parseWhisperJson(`${outBase}.json`, { vadChunks });
  console.log(`language: ${parsed.language} · ${parsed.words.length} words · ${parsed.rawSegments.length} whisper segments`);
  console.log(
    `VAD chunks: ${vadChunks?.length || 0} · segments time-corrected: ${parsed.remappedSegments || 0}`
  );

  const lastWord = parsed.words[parsed.words.length - 1];
  if (lastWord) {
    console.log(
      `last word ends at: ${(lastWord.end / 1000).toFixed(2)}s (media: ${info.durationSec.toFixed(2)}s)`
    );
  }

  const { cues, stats } = buildCues(parsed.words, settings, Math.round(info.durationSec * 1000));
  console.log(`cues: ${cues.length} · removed: ${JSON.stringify(stats)}`);

  /* ---- formatting diagnostics ---- */
  const problems = { longLine: 0, tooManyLines: 0, fastCps: 0, tooShort: 0, tooLong: 0, overlap: 0 };
  let maxCps = 0;
  let maxLine = 0;

  cues.forEach((c, i) => {
    const lines = c.lines || [c.text];
    lines.forEach((l) => {
      maxLine = Math.max(maxLine, l.length);
      if (l.length > settings.maxCharsPerLine) problems.longLine += 1;
    });
    if (lines.length > settings.maxLines) problems.tooManyLines += 1;
    const dur = (c.end - c.start) / 1000;
    const cps = dur > 0 ? c.text.replace(/\n/g, '').length / dur : 0;
    maxCps = Math.max(maxCps, cps);
    if (cps > settings.maxCharsPerSec + 0.5) problems.fastCps += 1;
    if (dur < settings.minCueDurationMs / 1000 - 0.01) problems.tooShort += 1;
    if (dur > settings.maxCueDurationMs / 1000 + 0.01) problems.tooLong += 1;
    const next = cues[i + 1];
    if (next && c.end > next.start) problems.overlap += 1;
  });

  console.log('\n--- formatting audit ---');
  console.log(`longest line: ${maxLine} / ${settings.maxCharsPerLine} chars`);
  console.log(`peak reading speed: ${maxCps.toFixed(1)} / ${settings.maxCharsPerSec} cps`);
  console.log(JSON.stringify(problems, null, 2));

  const srt = subtitles.toSrt(cues);
  const outFile = path.join(work, 'selftest.srt');
  fs.writeFileSync(outFile, srt, 'utf8');

  console.log('\n--- SRT (first 40 lines) ---');
  console.log(srt.split('\n').slice(0, 40).join('\n'));
  console.log(`\nfull file: ${outFile}`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
