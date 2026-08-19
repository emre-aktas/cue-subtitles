'use strict';

/**
 * Headless installer for the engine package, VAD model and whisper models — the same
 * code paths the UI uses, runnable without opening the app.
 *
 *   node tools/install.js engine cuda12
 *   node tools/install.js model large-v3-turbo-q5
 *   node tools/install.js vad
 *   node tools/install.js list
 */

const config = require('../electron/lib/config');
const engine = require('../electron/lib/engine');

function bar(percent) {
  const width = 28;
  const filled = Math.round((percent / 100) * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

function mb(n) {
  return `${(n / 1024 / 1024).toFixed(0)} MB`;
}

let lastLine = 0;
function progress(p) {
  const now = Date.now();
  if (now - lastLine < 500 && p.percent < 100) return;
  lastLine = now;
  const speed = p.bps ? ` ${mb(p.bps)}/s` : '';
  const size = p.total ? ` ${mb(p.received)}/${mb(p.total)}` : '';
  process.stdout.write(`\r${bar(p.percent || 0)} ${(p.percent || 0).toFixed(1)}%${size}${speed}   `);
}

async function main() {
  config.ensureDirs();
  const [what, id] = process.argv.slice(2);

  if (!what || what === 'list') {
    console.log('--- engines ---');
    for (const v of engine.installedEngines()) {
      console.log(`  ${v.installed ? '[x]' : '[ ]'} ${v.id.padEnd(12)} ${v.label} (~${v.downloadMB} MB)`);
    }
    console.log('--- models ---');
    for (const m of engine.modelCatalog()) {
      console.log(`  ${m.installed ? '[x]' : '[ ]'} ${m.id.padEnd(22)} ${String(m.sizeMB).padStart(4)} MB  ${m.detail}`);
    }
    console.log(`--- VAD --- ${engine.vadInstalled() ? 'installed' : 'not installed'}`);
    return;
  }

  if (what === 'engine') {
    if (!id) throw new Error('An engine id is required (e.g. cuda12)');
    console.log(`Installing engine: ${id}`);
    const res = await engine.installEngine(id, { onProgress: progress });
    console.log(`\nDone: ${res.cliPath}`);
    config.saveSettings({ engineVariant: id });
    return;
  }

  if (what === 'model') {
    if (!id) throw new Error('A model id is required (e.g. large-v3-turbo-q5)');
    console.log(`Downloading model: ${id}`);
    const res = await engine.installModel(id, { onProgress: progress });
    console.log(`\nDone: ${res.path} (${res.actualMB} MB)`);
    return;
  }

  if (what === 'vad') {
    console.log('Downloading the VAD model');
    const res = await engine.installVad({ onProgress: progress });
    console.log(`\nDone: ${res.path}`);
    return;
  }

  throw new Error(`Unknown command: ${what}`);
}

main().catch((e) => {
  console.error(`\nERROR: ${e.message}`);
  process.exit(1);
});
