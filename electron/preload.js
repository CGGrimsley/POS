'use strict';

// The only thing the POS page can ask the Windows app to do.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('posApp', {
  checkForUpdates: () => ipcRenderer.invoke('pos:check-updates'),
});
