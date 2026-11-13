// Exposes `window.quillDesktop`: the same interface as the Android QuillNative plugin
// (see src/platform/native.ts), plus openExternal and http. Runs sandboxed.
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const call = (name) => (opts) => ipcRenderer.invoke('qf:' + name, opts);
const methods = ['openDocument', 'saveAs', 'writeUri', 'readUri', 'print', 'share', 'getLaunchFile', 'keepAwake', 'secureSet', 'secureGet', 'secureRemove', 'secureInfo', 'readClipboard', 'writeClipboard', 'startLoopback', 'stopLoopback', 'openExternal', 'openWith', 'http'];

const api = { platform: process.platform };
for (const m of methods) api[m] = call(m);
api.addListener = (event, cb) => {
  if (event !== 'fileOpened' && event !== 'oauthCallback') return Promise.reject(new Error('Unknown event'));
  const listener = (_e, data) => cb(data);
  ipcRenderer.on('qf:' + event, listener);
  return Promise.resolve({ remove: () => ipcRenderer.removeListener('qf:' + event, listener) });
};

contextBridge.exposeInMainWorld('quillDesktop', api);
