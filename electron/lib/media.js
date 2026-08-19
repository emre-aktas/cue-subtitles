'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const { DIRS } = require('./config');
const { downloadFile, extractArchive } = require('./download');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

let cached = { ffmpeg: null, ffprobe: null };

/**
 * Prebuilt ffmpeg bundles, so a machine without ffmpeg on PATH can be fixed from
 * inside the app instead of sending the user off to install it by hand.
 */
const FFMPEG_BUILDS = {
  win32: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
    archive: 'ffmpeg-win64-gpl.zip',
    downloadMB: 163,
  },
  linux: {
    url: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz',
    archive: 'ffmpeg-linux64-gpl.tar.xz',
    downloadMB: 123,
  },
};

function ffmpegBuild() {
  return FFMPEG_BUILDS[process.platform] || null;
}

/** Look for a binary the app installed itself, anywhere under tools-bin/. */
function findBundled(name, dir = DIRS.tools, depth = 0) {
  if (depth > 4 || !fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const target = name + EXE;
  for (const e of entries) {
    if (e.isFile() && e.name.toLowerCase() === target.toLowerCase()) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findBundled(name, path.join(dir, e.name), depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function bundledTools() {
  return { ffmpeg: findBundled('ffmpeg'), ffprobe: findBundled('ffprobe') };
}

/**
 * Download and unpack ffmpeg into tools-bin/. Nothing is added to PATH — the app
 * resolves its own copy first, so the system install is left untouched.
 */
async function installFfmpeg({ onProgress, signal } = {}) {
  const build = ffmpegBuild();
  if (!build) {
    throw new Error(
      `No prebuilt ffmpeg is published for ${process.platform}. Install it with your package manager (e.g. brew install ffmpeg).`
    );
  }

  const archivePath = path.join(DIRS.tools, '_cache', build.archive);
  let cachedArchive = false;
  try {
    cachedArchive = fs.statSync(archivePath).size > build.downloadMB * 1024 * 1024 * 0.9;
  } catch {}

  if (cachedArchive) {
    onProgress?.({ stage: 'download', percent: 100, label: 'Using the already-downloaded archive…' });
  } else {
    await downloadFile({
      url: build.url,
      dest: archivePath,
      signal,
      onProgress: ({ percent, received, total, bps }) =>
        onProgress?.({
          stage: 'download',
          percent,
          received,
          total,
          bps,
          label: `Downloading ffmpeg… ${percent.toFixed(0)}%`,
        }),
    });
  }

  onProgress?.({ stage: 'extract', percent: 100, label: 'Extracting ffmpeg…' });
  const dest = path.join(DIRS.tools, 'ffmpeg');
  fs.rmSync(dest, { recursive: true, force: true });
  await extractArchive(archivePath, dest);

  const found = bundledTools();
  if (!found.ffmpeg || !found.ffprobe) {
    throw new Error('ffmpeg or ffprobe was not found inside the archive.');
  }
  if (!IS_WIN) {
    for (const p of [found.ffmpeg, found.ffprobe]) {
      try {
        fs.chmodSync(p, 0o755);
      } catch {}
    }
  }

  try {
    fs.rmSync(archivePath, { force: true });
  } catch {}

  cached = { ffmpeg: null, ffprobe: null }; // force re-resolution
  return found;
}

function which(cmd) {
  return new Promise((resolve) => {
    const finder = IS_WIN ? 'where' : 'which';
    execFile(finder, [cmd], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).find((l) => l.trim());
      resolve(first ? first.trim() : null);
    });
  });
}

/** Locate ffmpeg + ffprobe: explicit override -> the app's own copy -> PATH. */
async function resolveTools(override = {}) {
  const out = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const custom = override[name];
    if (custom && fs.existsSync(custom)) {
      out[name] = custom;
      continue;
    }
    if (cached[name] && fs.existsSync(cached[name])) {
      out[name] = cached[name];
      continue;
    }
    const bundled = findBundled(name);
    const found = bundled || (await which(name + EXE));
    if (!found) {
      throw new Error(
        `${name} was not found. Install it from the Setup tab, or set its path under Settings.`
      );
    }
    cached[name] = found;
    out[name] = found;
  }
  return out;
}

/** Where each tool would come from, for the requirements list. */
async function toolStatus(override = {}) {
  const result = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const custom = override[name];
    if (custom && fs.existsSync(custom)) {
      result[name] = { path: custom, source: 'custom' };
      continue;
    }
    const bundled = findBundled(name);
    if (bundled) {
      result[name] = { path: bundled, source: 'bundled' };
      continue;
    }
    const onPath = await which(name + EXE);
    result[name] = onPath ? { path: onPath, source: 'path' } : { path: null, source: null };
  }
  return result;
}

/** ffprobe -> normalized media info. */
async function probe(file, override = {}) {
  const { ffprobe } = await resolveTools(override);
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ];
  const json = await new Promise((resolve, reject) => {
    execFile(ffprobe, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`ffprobe failed: ${stderr || err.message}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`Could not parse ffprobe output: ${e.message}`));
      }
    });
  });

  const streams = json.streams || [];
  const audioStreams = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s, i) => ({
      index: s.index,
      order: i, // position among audio streams, used for -map 0:a:<order>
      codec: s.codec_name,
      channels: s.channels,
      sampleRate: Number(s.sample_rate) || null,
      language: s.tags?.language || null,
      title: s.tags?.title || null,
      isDefault: Boolean(s.disposition?.default),
    }));
  const video = streams.find((s) => s.codec_type === 'video') || null;

  const duration =
    Number(json.format?.duration) ||
    Number(streams.find((s) => Number(s.duration))?.duration) ||
    0;

  return {
    path: file,
    fileName: path.basename(file),
    durationSec: duration,
    sizeBytes: Number(json.format?.size) || 0,
    formatName: json.format?.format_name || '',
    audioStreams,
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: parseFps(video.r_frame_rate),
        }
      : null,
  };
}

function parseFps(rate) {
  if (!rate || typeof rate !== 'string') return null;
  const [n, d] = rate.split('/').map(Number);
  if (!n || !d) return null;
  return Math.round((n / d) * 1000) / 1000;
}

/**
 * Build the ffmpeg audio filter chain. Order is deliberate: cut rumble, then
 * denoise the cleaner signal, then normalize loudness last so the level reflects
 * the processed audio.
 */
function buildFilterChain({ highpass, denoise, loudnorm }) {
  const chain = [];
  if (highpass) chain.push('highpass=f=60');
  if (denoise) chain.push('afftdn=nf=-25');
  if (loudnorm) chain.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  chain.push('aresample=resampler=soxr:precision=28');
  return chain.join(',');
}

/**
 * Decode any container/codec to the 16 kHz mono PCM WAV that whisper.cpp expects.
 * `startSec`/`durationSec` let us grab a slice (used for language sampling).
 */
async function extractAudio({
  input,
  output,
  audioOrder = 0,
  filters = {},
  startSec = null,
  durationSec = null,
  totalDurationSec = 0,
  onProgress,
  signal,
  override = {},
}) {
  const { ffmpeg } = await resolveTools(override);
  fs.mkdirSync(path.dirname(output), { recursive: true });

  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  if (startSec != null) args.push('-ss', String(startSec));
  if (durationSec != null) args.push('-t', String(durationSec));
  args.push('-i', input);
  args.push('-map', `0:a:${audioOrder}?`, '-vn', '-sn', '-dn');

  const chain = buildFilterChain(filters);
  if (chain) args.push('-af', chain);

  args.push('-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav');
  args.push('-progress', 'pipe:1', '-nostats', output);

  const expected = durationSec != null ? durationSec : totalDurationSec;

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { windowsHide: true });
    let stderr = '';
    let killed = false;

    const onAbort = () => {
      killed = true;
      try {
        child.kill('SIGKILL');
      } catch {}
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line.trim());
        if (m && expected > 0 && onProgress) {
          const sec = Number(m[1]) / 1e6;
          onProgress({ seconds: sec, percent: Math.min(100, (sec / expected) * 100) });
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    child.on('error', (e) => reject(new Error(`Could not start ffmpeg: ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort);
      if (killed) return reject(new Error('Job cancelled'));
      if (code !== 0) return reject(new Error(`ffmpeg audio extraction failed (${code}): ${stderr.slice(-800)}`));
      if (!fs.existsSync(output) || fs.statSync(output).size < 1024) {
        return reject(new Error('No audio was extracted — does the file have an audio track?'));
      }
      onProgress?.({ seconds: expected, percent: 100 });
      resolve(output);
    });
  });
}

module.exports = {
  resolveTools,
  toolStatus,
  bundledTools,
  installFfmpeg,
  ffmpegBuild,
  probe,
  extractAudio,
  buildFilterChain,
};
