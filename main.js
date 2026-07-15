const { app, BrowserWindow, BrowserView, ipcMain, dialog, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Chromium önbellek / log ayarları (app.ready ÖNCESİNDE çalışmalı)
// ---------------------------------------------------------------------------
// Varsayılan "Electron" userData klasörü birden fazla npm start ile çakışınca
// "Erişim engellendi (0x5)" ve quota_database hataları üretir. Uygulamaya özel
// bir klasör + tek örnek kilidi bu sorunları büyük ölçüde önler.
const userDataPath = path.join(app.getPath('appData'), 'akakce-urun-analiz');
app.setPath('userData', userDataPath);

const cacheDir = path.join(userDataPath, 'chromium-cache');
try {
  fs.mkdirSync(cacheDir, { recursive: true });
} catch (_) {
  /* klasör zaten var veya oluşturulamadı */
}

app.commandLine.appendSwitch('disk-cache-dir', cacheDir);
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
// Akakçe sayfalarının WebRTC/STUN denemelerinden gelen terminal gürültüsünü azaltır.
app.commandLine.appendSwitch('force-webrtc-ip-handling-policy', 'disable_non_proxied_udp');
app.commandLine.appendSwitch('disable-logging');
app.commandLine.appendSwitch('log-level', '3');

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

const scraper = require('./scraper');
const XLSX = require('xlsx');
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

app.whenReady().then(() => {
  const akakceSession = session.fromPartition(SESSION_PARTITION);
  akakceSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    const blocked = ['media', 'display-capture', 'pointerLock', 'fullscreen'];
    callback(!blocked.includes(permission));
  });

  createWindow();
});

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

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

ipcMain.handle('dialog:export-excel', async (_event, payload) => {
  if (!mainWindow) return { cancelled: true };
  const defaultName = (payload && payload.defaultName) || 'akakce-sonuclar.xlsx';
  const rows = (payload && payload.rows) || [];
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Sonuçları Excel olarak dışa aktar',
    defaultPath: defaultName,
    filters: [
      { name: 'Excel Çalışma Kitabı', extensions: ['xlsx'] },
      { name: 'Tüm dosyalar', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return { cancelled: true };
  let filePath = result.filePath;
  if (!filePath.toLowerCase().endsWith('.xlsx')) {
    filePath += '.xlsx';
  }
  try {
    const worksheet = XLSX.utils.aoa_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Sonuçlar');
    XLSX.writeFile(workbook, filePath);
    return { ok: true, filePath };
  } catch (e) {
    return { error: e.message };
  }
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
  try {
    await view.webContents.loadURL(url);
  } catch (err) {
    // ERR_ABORTED (-3) genellikle bir sayfanın hemen yönlendirme (redirect)
    // yapması sırasında orijinal isteğin yeni istekle değiştirilmesinden
    // kaynaklanır ve zararsızdır; navigasyon normal şekilde tamamlanır.
    if (err && err.code !== 'ERR_ABORTED') {
      throw err;
    }
  }
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
