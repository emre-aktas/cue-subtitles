'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/**
 * Narrow, explicit bridge — the renderer never touches Node or raw IPC channels.
 */
const api = {
  // system + settings
  getAppInfo: () => ipcRenderer.invoke('app:info'),
  recommendVariant: () => ipcRenderer.invoke('app:recommendVariant'),
  checkRequirements: () => ipcRenderer.invoke('app:requirements'),
  installMissing: (token) => ipcRenderer.invoke('app:installMissing', { token }),
  installFfmpeg: (token) => ipcRenderer.invoke('tools:installFfmpeg', { token }),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  getDefaults: () => ipcRenderer.invoke('settings:defaults'),

  // dialogs
  pickVideo: () => ipcRenderer.invoke('dialog:pickVideo'),
  pickDir: () => ipcRenderer.invoke('dialog:pickDir'),
  saveSubtitleAs: (opts) => ipcRenderer.invoke('dialog:saveSubtitle', opts),

  // media
  probe: (filePath) => ipcRenderer.invoke('media:probe', filePath),
  fileUrl: (filePath) => ipcRenderer.invoke('media:fileUrl', filePath),

  // Electron 32+ removed File.path, so dropped files must be resolved here.
  getPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return null;
    }
  },

  // engine + models
  listEngines: () => ipcRenderer.invoke('engine:list'),
  installEngine: (id, token) => ipcRenderer.invoke('engine:install', { id, token }),
  listModels: () => ipcRenderer.invoke('model:list'),
  installModel: (id, token) => ipcRenderer.invoke('model:install', { id, token }),
  deleteModel: (id) => ipcRenderer.invoke('model:delete', id),
  installVad: (token) => ipcRenderer.invoke('vad:install', { token }),
  cancelDownload: (token) => ipcRenderer.invoke('download:cancel', token),

  // jobs
  startJob: (videoPath, overrides) => ipcRenderer.invoke('job:start', { videoPath, overrides }),
  cancelJob: (jobId) => ipcRenderer.invoke('job:cancel', jobId),

  // export
  exportSubtitle: (payload) => ipcRenderer.invoke('subs:export', payload),
  previewSubtitle: (payload) => ipcRenderer.invoke('subs:preview', payload),

  // shell
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),
  openPath: (p) => ipcRenderer.invoke('shell:openPath', p),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // events
  onJobEvent: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('job:event', listener);
    return () => ipcRenderer.removeListener('job:event', listener);
  },
  onDownloadProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('download:progress', listener);
    return () => ipcRenderer.removeListener('download:progress', listener);
  },
  onSetupItem: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:item', listener);
    return () => ipcRenderer.removeListener('setup:item', listener);
  },
  onSetupProgress: (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on('setup:progress', listener);
    return () => ipcRenderer.removeListener('setup:progress', listener);
  },
};

contextBridge.exposeInMainWorld('api', api);
