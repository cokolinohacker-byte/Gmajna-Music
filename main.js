const {
  app, BrowserWindow, session, ipcMain, dialog, Notification, globalShortcut,
} = require('electron');
const path = require('path');
const { ElectronBlocker } = require('@ghostery/adblocker-electron');
const { autoUpdater } = require('electron-updater');

app.setPath('userData', path.join(app.getPath('appData'), app.getName()));

let mainWindow = null;
let pendingInvite = null;
let updatePromptOpen = false;
let lastPlaybackVideoId = '';
const inviteServer = 'https://gmajna-server.onrender.com';

function parseInvite(rawUrl) {
  try {
    const invite = new URL(rawUrl);
    if (invite.protocol !== 'gmajna:' || invite.hostname !== 'join') return null;
    const server = invite.searchParams.get('server');
    const room = invite.searchParams.get('room');
    if (!server || !/^https:\/\/gmajna-server\.onrender\.com$/i.test(server)
        || !room || !/^[\w-]{1,100}$/.test(room)) return null;
    return { server, room };
  } catch (error) {
    console.error('Povabilne povezave ni mogoče prebrati:', error);
    return null;
  }
}

function receiveInvite(rawUrl) {
  const invite = parseInvite(rawUrl);
  if (!invite) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (mainWindow.webContents.isLoading()) pendingInvite = invite;
    else mainWindow.webContents.send('jam-invite', invite);
  } else pendingInvite = invite;
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    const inviteUrl = commandLine.find((arg) => arg.startsWith('gmajna://'));
    if (inviteUrl) receiveInvite(inviteUrl);
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    receiveInvite(url);
  });
}

ipcMain.handle('consume-jam-invite', () => {
  const invite = pendingInvite;
  pendingInvite = null;
  return invite;
});

function checkForUpdates() {
  autoUpdater.checkForUpdates().catch((error) => {
    console.error('Samodejno preverjanje posodobitev ni uspelo:', error);
  });
}

function configureAutoUpdates() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => console.info('Preverjam posodobitve Gmajna Music.'));
  autoUpdater.on('update-available', (info) => {
    console.info(`Na voljo je Gmajna Music ${info.version}; prenašam posodobitev.`);
  });
  autoUpdater.on('update-not-available', (info) => {
    console.info(`Gmajna Music ${info.version} je posodobljen.`);
  });
  autoUpdater.on('error', (error) => {
    console.error('Samodejna posodobitev Gmajna Music ni uspela:', error);
  });
  autoUpdater.on('update-downloaded', async (info) => {
    if (updatePromptOpen || !mainWindow || mainWindow.isDestroyed()) return;
    updatePromptOpen = true;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'Gmajna Music je posodobljen',
        message: `Različica ${info.version} je prenesena.`,
        detail: 'Znova zaženi aplikacijo za namestitev posodobitve.',
        buttons: ['Znova zaženi zdaj', 'Pozneje'],
        defaultId: 0,
        cancelId: 1,
      });
      if (result.response === 0) autoUpdater.quitAndInstall();
    } catch (error) {
      console.error('Obvestila o pripravljeni posodobitvi ni mogoče prikazati:', error);
    } finally {
      updatePromptOpen = false;
    }
  });

  setTimeout(checkForUpdates, 10000);
  const updateCheckTimer = setInterval(checkForUpdates, 6 * 60 * 60 * 1000);
  updateCheckTimer.unref();
}

ipcMain.on('gm-window-control', (_event, action) => {
  if (!mainWindow || mainWindow.isDestroyed() || _event.sender !== mainWindow.webContents) return;
  if (action === 'minimize') mainWindow.minimize();
  else if (action === 'toggle-maximize') {
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  } else if (action === 'close') mainWindow.close();
});

function sendPlaybackAction(action) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('gm-playback-action', action);
}

ipcMain.on('gm-playback-state', (event, state) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (!state || typeof state !== 'object'
      || typeof state.id !== 'string' || !/^[\w-]{11}$/.test(state.id)
      || typeof state.title !== 'string' || typeof state.artist !== 'string'
      || typeof state.playing !== 'boolean') return;
  if (lastPlaybackVideoId && state.id !== lastPlaybackVideoId
      && (!mainWindow.isFocused() || mainWindow.isMinimized())
      && Notification.isSupported()) {
    new Notification({
      title: state.title.slice(0, 200),
      body: state.artist.slice(0, 200),
      icon: path.join(__dirname, 'assets', 'gmajna-logo.png'),
      silent: true,
    }).show();
  }
  lastPlaybackVideoId = state.id;
});

function registerPlaybackShortcuts() {
  const shortcuts = {
    MediaPlayPause: 'playback-toggle',
    MediaNextTrack: 'playback-next',
    MediaPreviousTrack: 'playback-previous',
  };
  for (const [accelerator, action] of Object.entries(shortcuts)) {
    if (!globalShortcut.register(accelerator, () => sendPlaybackAction(action))) {
      console.warn(`Globalne medijske bližnjice ni mogoče registrirati: ${accelerator}`);
    }
  }
}

ipcMain.on('gm-menu-action', (event, action) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  const contents = mainWindow.webContents;
  switch (action) {
    case 'plugins':
    case 'jam':
      contents.send('app-menu-action', action);
      break;
    case 'playback-previous':
    case 'playback-toggle':
    case 'playback-next':
    case 'playback-pip':
      sendPlaybackAction(action);
      break;
    case 'playback-rate-0.75':
    case 'playback-rate-1':
    case 'playback-rate-1.25':
    case 'playback-rate-1.5':
    case 'playback-rate-2':
      sendPlaybackAction(action);
      break;
    case 'reload':
      contents.reload();
      break;
    case 'fullscreen':
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      break;
    case 'zoom-in':
      contents.setZoomLevel(contents.getZoomLevel() + 0.5);
      break;
    case 'zoom-out':
      contents.setZoomLevel(contents.getZoomLevel() - 0.5);
      break;
    case 'zoom-reset':
      contents.setZoomLevel(0);
      break;
    case 'back':
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      break;
    case 'forward':
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      break;
    case 'about':
      dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: 'About Gmajna Music',
        message: 'Gmajna Music',
        detail: `Version ${app.getVersion()}\nMusic together with Gmajna Jam.`,
        buttons: ['OK'],
      }).catch((error) => console.error('Obvestila o aplikaciji ni mogoče prikazati:', error));
      break;
    default:
      console.warn('Neznano dejanje menija namizne aplikacije:', action);
  }
});

app.whenReady().then(async () => {
  registerPlaybackShortcuts();
  if (!app.setAsDefaultProtocolClient('gmajna')) {
    console.warn('Povezav gmajna:// ni bilo mogoče registrirati kot privzeti protokol.');
  }
  const startupInvite = process.argv.find((arg) => arg.startsWith('gmajna://'));
  if (startupInvite) pendingInvite = parseInvite(startupInvite);

  mainWindow = new BrowserWindow({
    width: 1280, height: 800, frame: false, backgroundColor: '#0d0d12',
    icon: path.join(__dirname, 'assets', 'gmajna-logo.ico'),
    title: 'Gmajna Music',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true
    }
  });

  mainWindow.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
    mainWindow.setTitle('Gmajna Music');
  });
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (!input.control || !input.shift) return;
    const shortcuts = {
      Space: 'playback-toggle',
      ArrowLeft: 'playback-previous',
      ArrowRight: 'playback-next',
      KeyP: 'playback-pip',
    };
    const action = shortcuts[input.code];
    if (action) {
      event.preventDefault();
      sendPlaybackAction(action);
    }
  });
  mainWindow.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('gm-window-state', 'maximized'));
  mainWindow.on('unmaximize', () => mainWindow?.webContents.send('gm-window-state', 'restored'));
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('gm-fullscreen-state', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('gm-fullscreen-state', false));

  const blockerReady = ElectronBlocker.fromPrebuiltAdsAndTracking(fetch)
    .then((blocker) => blocker.enableBlockingInSession(session.defaultSession))
    .catch((e) => console.error('Adblock ni uspel:', e));

  const pageLoad = mainWindow.loadURL('https://music.youtube.com')
    .catch((e) => console.error('YouTube Music se ni uspel naložiti:', e));
  await Promise.all([blockerReady, pageLoad]);
  configureAutoUpdates();
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => globalShortcut.unregisterAll());