const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('akakceAPI', {
  windowMinimize: () => ipcRenderer.send('window:minimize'),
  windowClose: () => ipcRenderer.send('window:close'),

  search: (term) => ipcRenderer.invoke('scraper:search', term),
  getSellers: (detailUrl) => ipcRenderer.invoke('scraper:get-sellers', detailUrl),
  pickFile: () => ipcRenderer.invoke('dialog:pick-file'),
  exportExcel: (payload) => ipcRenderer.invoke('dialog:export-excel', payload),

  openDetail: (url) => ipcRenderer.invoke('detail:open', url),
  closeDetail: () => ipcRenderer.invoke('detail:close'),
  detailBack: () => ipcRenderer.invoke('detail:back'),
  detailForward: () => ipcRenderer.invoke('detail:forward'),
  detailReload: () => ipcRenderer.invoke('detail:reload'),
  setDetailBounds: (bounds) => ipcRenderer.send('detail:bounds', bounds),
  onDetailNavChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('detail:nav-changed', listener);
    return () => ipcRenderer.removeListener('detail:nav-changed', listener);
  },
});
