const { contextBridge, ipcRenderer } = require('electron');

const ok = ch => typeof ch === 'string' && ch.startsWith('cap:');
contextBridge.exposeInMainWorld('host', {
  on: (ch, fn) => { if (ok(ch)) ipcRenderer.on(ch, (_e, data) => fn(data)); },
  send: (ch, data) => { if (ok(ch)) ipcRenderer.send(ch, data); },
});
