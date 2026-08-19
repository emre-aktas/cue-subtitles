'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

const config = require('./lib/config');
const media = require('./lib/media');
const engine = require('./lib/engine');
const requirements = require('./lib/requirements');
const subtitles = require('./lib/subtitles');
const { createJob } = require('./lib/pipeline');

const IS_DEV = process.argv.includes('--dev');

let mainWindow = null;
/** @type {Map<string, {cancel:Function}>} */
const jobs = new Map();
/** @type {Map<string, AbortController>} */
const downloads = new Map();

const VIDEO_EXTENSIONS = [
  'mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv',
];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma'];

// Windows picks the best size out of a multi-resolution .ico; everywhere else wants a
// plain PNG. Regenerate both with `npm run icon`.
const APP_ICON = path.join(
  __dirname,
  '..',
  'build',
  process.platform === 'win32' ? 'icon.ico' : 'icon.png'
);

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 1020,
    minHeight: 680,
    backgroundColor: '#0b0b0d',
    show: false,
    title: 'Cue',
    icon: APP_ICON,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });

  // Keep external links out of the app shell.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

/* ------------------------------------------------------------------ *
 * System probing
 * ------------------------------------------------------------------ */

const diskFreeFor = requirements.diskFree;
const detectNvidiaGpu = requirements.detectNvidiaGpu;

async function systemInfo() {
  const settings = config.loadSettings();
  const gpu = await detectNvidiaGpu();
  let ffmpegOk = true;
  let ffmpegError = null;
  try {
    await media.resolveTools({ ffmpeg: settings.ffmpegPath, ffprobe: settings.ffprobePath });
  } catch (e) {
    ffmpegOk = false;
    ffmpegError = e.message;
  }

  return {
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model || 'unknown',
    cores: os.cpus().length,
    totalRamGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    gpu,
    ffmpegOk,
    ffmpegError,
    dirs: config.DIRS,
    disk: diskFreeFor(config.DIRS.appRoot),
    whisperRelease: engine.WHISPER_RELEASE,
    versions: {
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
    },
  };
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */


function registerIpc() {
  ipcMain.handle('app:info', () => systemInfo());
  ipcMain.handle('app:recommendVariant', () => requirements.recommendVariant());
  ipcMain.handle('app:requirements', () => requirements.check());

  // One call installs every missing requirement; progress arrives tagged with the
  // requirement id so the setup list can drive a bar per row.
  ipcMain.handle('app:installMissing', async (_e, { token }) => {
    const controller = new AbortController();
    downloads.set(token, controller);
    try {
      return await requirements.installMissing({
        signal: controller.signal,
        onItem: (info) => send('setup:item', { token, ...info }),
        onProgress: (p) => send('setup:progress', { token, ...p }),
      });
    } finally {
      downloads.delete(token);
    }
  });

  ipcMain.handle('tools:installFfmpeg', async (_e, { token }) => {
    const controller = new AbortController();
    downloads.set(token, controller);
    try {
      return await media.installFfmpeg({
        signal: controller.signal,
        onProgress: (p) => send('download:progress', { token, kind: 'ffmpeg', id: 'ffmpeg', ...p }),
      });
    } finally {
      downloads.delete(token);
    }
  });

  ipcMain.handle('settings:get', () => config.loadSettings());
  ipcMain.handle('settings:set', (_e, patch) => config.saveSettings(patch || {}));
  ipcMain.handle('settings:defaults', () => config.DEFAULT_SETTINGS);

  ipcMain.handle('dialog:pickVideo', async () => {
    const settings = config.loadSettings();
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a video or audio file',
      defaultPath: settings.lastOpenDir || undefined,
      properties: ['openFile'],
      filters: [
        { name: 'Video', extensions: VIDEO_EXTENSIONS },
        { name: 'Audio', extensions: AUDIO_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const picked = res.filePaths[0];
    config.saveSettings({ lastOpenDir: path.dirname(picked) });
    return picked;
  });

  ipcMain.handle('dialog:pickDir', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('dialog:saveSubtitle', async (_e, { defaultPath, format }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save subtitle',
      defaultPath,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (res.canceled || !res.filePath) return null;
    return res.filePath;
  });

  ipcMain.handle('media:probe', async (_e, filePath) => {
    const s = config.loadSettings();
    return media.probe(filePath, { ffmpeg: s.ffmpegPath, ffprobe: s.ffprobePath });
  });

  ipcMain.handle('media:fileUrl', (_e, filePath) => pathToFileURL(filePath).href);

  /* ---- engine + models ---- */
  ipcMain.handle('engine:list', () => ({
    variants: engine.installedEngines(),
    platform: process.platform,
  }));

  ipcMain.handle('engine:install', async (_e, { id, token }) => {
    const controller = new AbortController();
    downloads.set(token, controller);
    try {
      const res = await engine.installEngine(id, {
        signal: controller.signal,
        onProgress: (p) => send('download:progress', { token, kind: 'engine', id, ...p }),
      });
      return res;
    } finally {
      downloads.delete(token);
    }
  });

  ipcMain.handle('model:list', () => ({
    models: engine.modelCatalog(),
    vad: { installed: engine.vadInstalled(), path: engine.vadPath() },
    disk: diskFreeFor(config.DIRS.models),
  }));

  ipcMain.handle('model:install', async (_e, { id, token }) => {
    const controller = new AbortController();
    downloads.set(token, controller);
    try {
      return await engine.installModel(id, {
        signal: controller.signal,
        onProgress: (p) => send('download:progress', { token, kind: 'model', id, ...p }),
      });
    } finally {
      downloads.delete(token);
    }
  });

  ipcMain.handle('model:delete', (_e, id) => engine.deleteModel(id));

  ipcMain.handle('vad:install', async (_e, { token }) => {
    const controller = new AbortController();
    downloads.set(token, controller);
    try {
      return await engine.installVad({
        signal: controller.signal,
        onProgress: (p) => send('download:progress', { token, kind: 'vad', id: 'vad', ...p }),
      });
    } finally {
      downloads.delete(token);
    }
  });

  ipcMain.handle('download:cancel', (_e, token) => {
    const c = downloads.get(token);
    if (c) {
      c.abort();
      return true;
    }
    return false;
  });

  /* ---- transcription jobs ---- */
  ipcMain.handle('job:start', (_e, { videoPath, overrides }) => {
    const settings = { ...config.loadSettings(), ...(overrides || {}) };
    const job = createJob({
      videoPath,
      settings,
      onEvent: (ev) => send('job:event', ev),
    });
    jobs.set(job.id, job);
    job.promise
      .catch(() => {}) // errors already surface through job:event
      .finally(() => jobs.delete(job.id));
    return { jobId: job.id };
  });

  ipcMain.handle('job:cancel', (_e, jobId) => {
    const job = jobs.get(jobId);
    if (!job) return false;
    job.cancel();
    return true;
  });

  /* ---- export edited cues ---- */
  ipcMain.handle('subs:export', (_e, { cues, filePath, format }) => {
    const s = config.loadSettings();
    subtitles.writeSubtitleFile({ cues, filePath, format, utf8Bom: s.utf8Bom });
    return filePath;
  });

  ipcMain.handle('subs:preview', (_e, { cues, format }) => subtitles.serialize(cues, format));

  /* ---- shell helpers ---- */
  ipcMain.handle('shell:showItem', (_e, filePath) => {
    shell.showItemInFolder(filePath);
  });
  ipcMain.handle('shell:openPath', async (_e, target) => shell.openPath(target));
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    if (/^https?:\/\//i.test(url)) await shell.openExternal(url);
  });
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    config.ensureDirs();
    registerIpc();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    for (const job of jobs.values()) job.cancel();
    for (const c of downloads.values()) c.abort();
    if (process.platform !== 'darwin') app.quit();
  });
}
