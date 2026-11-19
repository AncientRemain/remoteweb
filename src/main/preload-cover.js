const { contextBridge, ipcRenderer } = require('electron');

// The privacy screen only listens: the app tells it what to show.
contextBridge.exposeInMainWorld('cover', {
  onState: fn => ipcRenderer.on('cover:state', (_e, s) => fn(s)),
});
