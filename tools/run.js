'use strict';

/**
 * Headless runner for the real pipeline — the exact code path the Electron UI uses,
 * including language sampling, cue building and writing the subtitle file.
 *
 *   node tools/run.js <video> [--language en|auto] [--model <id>] [--format srt|vtt|txt]
 *                             [--out <dir>] [--preset accuracy|balanced|speed] [--no-vad]
 *
 * Overrides apply to this run only; settings.json is not modified.
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('../electron/lib/config');
const { createJob } = require('../electron/lib/pipeline');

const PRESETS = {
  accuracy: { beamSize: 5, bestOf: 5, contextMode: 'balanced', vad: true, dtw: true, flashAttn: false },
  balanced: { beamSize: 5, bestOf: 5, contextMode: 'balanced', vad: true, dtw: false, flashAttn: true },
  speed: { beamSize: 1, bestOf: 1, contextMode: 'off', vad: true, dtw: false, flashAttn: true },
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-vad') out.vad = false;
    else if (a === '--verbose') out.verbose = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

function fmtTime(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args._[0];
  if (!input || !fs.existsSync(input)) {
    console.error('Usage: node tools/run.js <video> [--language en] [--model large-v3] [--preset accuracy]');
    process.exit(1);
  }

  config.ensureDirs();
  const settings = { ...config.loadSettings() };

  if (args.preset) {
    if (!PRESETS[args.preset]) throw new Error(`Unknown profile: ${args.preset}`);
    Object.assign(settings, PRESETS[args.preset]);
  }
  if (args.language) settings.language = args.language;
  if (args.model) settings.modelId = args.model;
  if (args.format) settings.outputFormat = args.format;
  if (args.out) settings.outputDir = args.out;
  if (args.vad === false) settings.vad = false;

  console.log(
    `engine=${settings.engineVariant} model=${settings.modelId} language=${settings.language} ` +
      `profile=${args.preset || 'from settings'} vad=${settings.vad}`
  );

  let lastPercent = -1;
  let stage = '';
  const started = Date.now();

  const job = createJob({
    videoPath: path.resolve(input),
    settings,
    onEvent: (ev) => {
      switch (ev.type) {
        case 'stage':
          stage = ev.label;
          process.stdout.write(`\n[${stage}] `);
          break;
        case 'progress': {
          const p = Math.floor(ev.percent);
          if (p !== lastPercent && p % 5 === 0) {
            lastPercent = p;
            process.stdout.write(`${p}% `);
          }
          break;
        }
        case 'language':
          process.stdout.write(`\n  language detected: ${ev.language}\n`);
          break;
        case 'segment':
          if (args.verbose) process.stdout.write(`\n  > ${ev.segment.text}`);
          break;
        case 'log':
          if (args.verbose) process.stdout.write(`\n  . ${ev.line}`);
          break;
        case 'error':
          process.stdout.write(`\n  ERROR: ${ev.message}\n`);
          break;
      }
    },
  });

  process.on('SIGINT', () => {
    console.log('\ncancelling…');
    job.cancel();
  });

  const result = await job.promise;
  const st = result.stats;

  console.log('\n\n=== result ===');
  console.log(`file       : ${result.outputPath}`);
  console.log(`language   : ${result.language}`);
  console.log(`cues       : ${st.cueCount} · words: ${st.wordCount}`);
  console.log(`media      : ${fmtTime(st.durationSec)} · elapsed: ${fmtTime(st.elapsedSec)} · ${st.speedFactor}x realtime`);
  console.log(`model      : ${st.model} · engine: ${st.engine}`);
  const cleaned =
    (st.droppedHallucinations || 0) + (st.droppedLoops || 0) + (st.droppedLowConfidence || 0);
  console.log(
    `removed    : ${cleaned} (invented ${st.droppedHallucinations || 0}, loops ${st.droppedLoops || 0}, low confidence ${
      st.droppedLowConfidence || 0
    })`
  );

  const warned = result.cues.filter((c) => c.warnings?.length);
  console.log(`warnings   : ${warned.length} cues`);
  warned.slice(0, 5).forEach((c) => console.log(`   #${c.index} ${c.warnings.join(', ')}`));

  console.log(`\ntotal time : ${fmtTime((Date.now() - started) / 1000)}`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
