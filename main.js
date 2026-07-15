const { app, BrowserWindow, BrowserView, ipcMain, dialog, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const scraper = require('./scraper');
const { SESSION_PARTITION, USER_AGENT } = require('./constants');

Menu.setApplicationMenu(null);

let mainWindow = null;
let detailView = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: '#14161b',
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    detailView = null;
  });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------------------------------------------------------------------------
// Pencere kontrolleri (frameless pencere için özel başlık çubuğu butonları)
// ---------------------------------------------------------------------------
ipcMain.on('window:minimize', () => {
  mainWindow?.minimize();
});

ipcMain.on('window:close', () => {
  mainWindow?.close();
});

// ---------------------------------------------------------------------------
// Tarama (scraper) IPC uçları
// ---------------------------------------------------------------------------
ipcMain.handle('scraper:search', async (_event, term) => {
  return scraper.searchProduct(term);
});

ipcMain.handle('scraper:get-sellers', async (_event, detailUrl) => {
  return scraper.getSellers(detailUrl);
});

ipcMain.handle('dialog:pick-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Arama terimleri dosyasını seçin (.txt veya .csv)',
    filters: [{ name: 'Metin / CSV Dosyaları', extensions: ['txt', 'csv'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const filePath = result.filePaths[0];
  let content = '';
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { error: e.message };
  }

  const terms = Array.from(
    new Set(
      content
        .split(/\r?\n/)
        .map((line) => line.split(',')[0].trim())
        .filter(Boolean)
    )
  );

  return { filePath, terms };
});

// ---------------------------------------------------------------------------
// Uygulama içi gömülü tarayıcı (Detay görünümü) - gerçek BrowserView
// ---------------------------------------------------------------------------
function ensureDetailView() {
  if (detailView) return detailView;
  detailView = new BrowserView({
    webPreferences: {
      session: session.fromPartition(SESSION_PARTITION),
      contextIsolation: true,
    },
  });
  detailView.webContents.setUserAgent(USER_AGENT);
  detailView.webContents.on('did-navigate', sendNavState);
  detailView.webContents.on('did-navigate-in-page', sendNavState);
  detailView.webContents.on('did-start-loading', () => sendNavState());
  detailView.webContents.on('did-stop-loading', () => sendNavState());
  mainWindow.addBrowserView(detailView);
  return detailView;
}

function sendNavState() {
  if (!mainWindow || !detailView) return;
  mainWindow.webContents.send('detail:nav-changed', {
    url: detailView.webContents.getURL(),
    canGoBack: detailView.webContents.canGoBack(),
    canGoForward: detailView.webContents.canGoForward(),
    loading: detailView.webContents.isLoading(),
  });
}

ipcMain.handle('detail:open', async (_event, url) => {
  if (!mainWindow) return false;
  const view = ensureDetailView();
  await view.webContents.loadURL(url);
  return true;
});

ipcMain.on('detail:bounds', (_event, bounds) => {
  if (detailView && bounds) {
    detailView.setBounds({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.round(bounds.width),
      height: Math.round(bounds.height),
    });
  }
});

ipcMain.handle('detail:close', async () => {
  if (mainWindow && detailView) {
    mainWindow.removeBrowserView(detailView);
    detailView = null;
  }
  return true;
});

ipcMain.handle('detail:back', async () => {
  if (detailView?.webContents.canGoBack()) detailView.webContents.goBack();
});

ipcMain.handle('detail:forward', async () => {
  if (detailView?.webContents.canGoForward()) detailView.webContents.goForward();
});

ipcMain.handle('detail:reload', async () => {
  detailView?.webContents.reload();
});
