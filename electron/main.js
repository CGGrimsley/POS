'use strict';

// Windows app shell: starts the local POS server and shows it in a window.
// Settings (including the encrypted API key) live in
// %APPDATA%\Brushbeater POS\settings.json, never in the install folder.

const { app, BrowserWindow, Menu, shell, safeStorage, dialog } = require('electron');
const path = require('path');
const { SettingsStore } = require('../lib/settings');
const { createPosServer } = require('../lib/app');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let server = null;

  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  async function start() {
    const dataDir = app.getPath('userData');
    const cipher = safeStorage.isEncryptionAvailable()
      ? {
          encrypt: (s) => safeStorage.encryptString(s).toString('base64'),
          decrypt: (b) => safeStorage.decryptString(Buffer.from(b, 'base64')),
        }
      : null;
    const store = new SettingsStore(path.join(dataDir, 'settings.json'), cipher);
    server = createPosServer({ store, dataDir, log: (m) => console.log(m) });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${server.address().port}/`;

    win = new BrowserWindow({
      width: 1366,
      height: 800,
      minWidth: 1000,
      minHeight: 600,
      backgroundColor: '#141412',
      title: 'Brushbeater POS',
      icon: path.join(__dirname, '..', 'build', 'icon.png'),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false },
    });
    // Only our own page loads in the window; any other link opens in the normal browser.
    win.webContents.setWindowOpenHandler(({ url: u }) => {
      if (/^https:\/\//.test(u)) shell.openExternal(u);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, u) => {
      if (!u.startsWith(url)) { e.preventDefault(); if (/^https:\/\//.test(u)) shell.openExternal(u); }
    });
    win.maximize();
    await win.loadURL(url);
  }

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'POS', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
  ]));

  app.whenReady().then(start).catch((e) => {
    dialog.showErrorBox('Brushbeater POS could not start', String(e && e.message ? e.message : e));
    app.quit();
  });
  app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
}
