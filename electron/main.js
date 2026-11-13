'use strict';

// Windows app shell: starts the local POS server and shows it in a window.
// Settings (including the encrypted API key) live in
// %APPDATA%\Brushbeater POS\settings.json, never in the install folder.

const { app, BrowserWindow, Menu, shell, safeStorage, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, preload: path.join(__dirname, 'preload.js') },
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

  // Updates come from the GitHub releases of CGGrimsley/POS. A new version
  // downloads in the background and installs the next time the app closes.
  let updateReady = false;
  function setupUpdates() {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('error', (e) => console.log('Update check failed: ' + (e && e.message)));
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = true;
      if (!win) return;
      dialog.showMessageBox(win, {
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 1,
        cancelId: 1,
        title: 'Update ready',
        message: `Brushbeater POS ${info.version} is ready.`,
        detail: 'Restart now to use it, or it will install the next time you close the app. Anything waiting to send is kept.',
      }).then((r) => { if (r.response === 0) autoUpdater.quitAndInstall(); });
    });
    const check = () => autoUpdater.checkForUpdates().catch(() => {});
    setTimeout(check, 15000);
    setInterval(check, 4 * 60 * 60 * 1000);
  }

  async function checkNow() {
    if (!app.isPackaged) return;
    if (updateReady) { autoUpdater.quitAndInstall(); return; }
    try {
      const r = await autoUpdater.checkForUpdates();
      const latest = r && r.updateInfo && r.updateInfo.version;
      if (!latest || latest === app.getVersion()) {
        dialog.showMessageBox(win, { type: 'info', message: `You're on the latest version (${app.getVersion()}).` });
      } else {
        dialog.showMessageBox(win, { type: 'info', message: `Version ${latest} is downloading. You'll be asked to restart when it's ready.` });
      }
    } catch (e) {
      dialog.showMessageBox(win, { type: 'warning', message: 'Could not check for updates.', detail: String(e && e.message) });
    }
  }

  ipcMain.handle('pos:check-updates', () => checkNow());

  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'POS', submenu: [{ label: 'Check for updates', click: checkNow }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'View', submenu: [{ role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'resetZoom' }, { role: 'togglefullscreen' }] },
  ]));

  app.whenReady().then(start).then(setupUpdates).catch((e) => {
    dialog.showErrorBox('Brushbeater POS could not start', String(e && e.message ? e.message : e));
    app.quit();
  });
  app.on('window-all-closed', () => { if (server) server.close(); app.quit(); });
}
