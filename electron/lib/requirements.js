'use strict';

/**
 * What the app needs before it can transcribe, and how to install whatever is
 * missing. Kept out of main.js so the whole flow can be exercised headlessly.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');

const config = require('./config');
const media = require('./media');
const engine = require('./engine');

/** Order matters: ffmpeg first, then the engine, then its models. */
const ORDER = ['ffmpeg', 'engine', 'vad', 'model'];

function detectNvidiaGpu() {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        if (err || !stdout) return resolve(null);
        const line = String(stdout).split(/\r?\n/).find((l) => l.trim());
        if (!line) return resolve(null);
        const [name, vram, driver] = line.split(',').map((s) => s.trim());
        resolve({ name, vramMB: Number(vram) || null, driver });
      }
    );
  });
}

function diskFree(targetPath) {
  try {
    const st = fs.statfsSync(targetPath);
    return { freeBytes: st.bfree * st.bsize, totalBytes: st.blocks * st.bsize };
  } catch {
    return { freeBytes: null, totalBytes: null };
  }
}

/** The engine package that suits this machine. */
async function recommendVariant(gpu) {
  const detected = gpu === undefined ? await detectNvidiaGpu() : gpu;
  const available = engine.variantsForPlatform();
  if (detected && available.some((v) => v.id === 'cuda12')) return 'cuda12';
  const cpuVariant = available.find((v) => !v.gpu);
  return cpuVariant ? cpuVariant.id : available[0]?.id || null;
}

/**
 * Default model, chosen by what the GPU can actually hold. A model that spills out
 * of VRAM is a poor first suggestion however accurate it is on paper.
 */
function recommendModel(gpu) {
  const vram = gpu?.vramMB || 0;
  if (!gpu) return 'large-v3-turbo-q5'; // CPU: the smallest capable package
  if (vram >= 4000) return 'large-v3-turbo-q5';
  if (vram >= 2000) return 'small';
  return 'base';
}

/** Inspect the machine and report each requirement. */
async function check() {
  const settings = config.loadSettings();
  const gpu = await detectNvidiaGpu();

  const tools = await media.toolStatus({
    ffmpeg: settings.ffmpegPath,
    ffprobe: settings.ffprobePath,
  });
  const ffmpegOk = Boolean(tools.ffmpeg.path && tools.ffprobe.path);
  const ffmpegBuild = media.ffmpegBuild();

  const installedEngine = engine.installedEngines().find((v) => v.installed);
  const recommendedVariantId = await recommendVariant(gpu);
  const recommendedVariant = engine.variantById(recommendedVariantId);

  const installedModel = engine.modelCatalog().find((m) => m.installed);
  const recommendedModelId = recommendModel(gpu);
  const recommendedModel = engine.modelById(recommendedModelId);

  const items = [
    {
      id: 'ffmpeg',
      label: 'ffmpeg + ffprobe',
      detail: ffmpegOk
        ? `Found (${tools.ffmpeg.source === 'bundled' ? 'installed by Cue' : tools.ffmpeg.source})`
        : 'Decodes any container into the audio the model needs.',
      ok: ffmpegOk,
      installable: Boolean(ffmpegBuild),
      sizeMB: ffmpegBuild?.downloadMB || 0,
      target: null,
    },
    {
      id: 'engine',
      label: 'Transcription engine',
      detail: installedEngine
        ? `${installedEngine.label} installed`
        : recommendedVariant
          ? `${recommendedVariant.label} suits this machine.`
          : 'No prebuilt package for this platform.',
      ok: Boolean(installedEngine),
      installable: Boolean(recommendedVariant),
      sizeMB: recommendedVariant?.downloadMB || 0,
      target: recommendedVariantId,
    },
    {
      id: 'vad',
      label: 'Silero VAD',
      detail: engine.vadInstalled()
        ? 'Installed'
        : 'Stops the model inventing lines over silence. Strongly recommended.',
      ok: engine.vadInstalled(),
      installable: true,
      sizeMB: 1,
      target: null,
    },
    {
      id: 'model',
      label: 'Speech model',
      detail: installedModel
        ? `${installedModel.label} installed`
        : `${recommendedModel?.label || recommendedModelId} is the best fit for this hardware.`,
      ok: Boolean(installedModel),
      installable: true,
      sizeMB: recommendedModel?.sizeMB || 0,
      target: recommendedModelId,
    },
  ].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

  const missing = items.filter((i) => !i.ok);
  return {
    items,
    ready: missing.length === 0,
    missingCount: missing.length,
    missingMB: missing.reduce((sum, i) => sum + (i.sizeMB || 0), 0),
    disk: diskFree(config.DIRS.appRoot),
    gpu,
  };
}

/**
 * Install every missing, installable requirement in dependency order.
 *
 * `onProgress` receives the download progress of the item currently being installed,
 * tagged with its requirement id; `onItem` reports each item's lifecycle so a UI can
 * mark rows as busy, done or failed.
 */
async function installMissing({ onItem, onProgress, signal } = {}) {
  const state = await check();
  const results = [];

  for (const item of state.items) {
    if (item.ok) continue;
    if (!item.installable) {
      results.push({ id: item.id, status: 'skipped', reason: 'no automatic installer' });
      onItem?.({ id: item.id, status: 'skipped' });
      continue;
    }

    onItem?.({ id: item.id, status: 'installing' });
    const report = (p) => onProgress?.({ id: item.id, ...p });

    try {
      if (item.id === 'ffmpeg') {
        await media.installFfmpeg({ onProgress: report, signal });
      } else if (item.id === 'engine') {
        await engine.installEngine(item.target, { onProgress: report, signal });
        config.saveSettings({ engineVariant: item.target });
      } else if (item.id === 'vad') {
        await engine.installVad({ onProgress: report, signal });
      } else if (item.id === 'model') {
        await engine.installModel(item.target, { onProgress: report, signal });
        config.saveSettings({ modelId: item.target });
      }
      results.push({ id: item.id, status: 'installed' });
      onItem?.({ id: item.id, status: 'installed' });
    } catch (err) {
      results.push({ id: item.id, status: 'failed', reason: err.message });
      onItem?.({ id: item.id, status: 'failed', reason: err.message });
      if (/cancel/i.test(err.message)) break;
    }
  }

  return { results, state: await check() };
}

module.exports = { check, installMissing, recommendVariant, recommendModel, detectNvidiaGpu, diskFree };
