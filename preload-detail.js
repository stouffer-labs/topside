const { contextBridge, ipcRenderer } = require('electron');

const validChannels = [
  'detail:thinking',
  'detail:stream-chunk',
  'detail:round-complete',
  'detail:error',
];

contextBridge.exposeInMainWorld('detailAPI', {
  getEntry() {
    return ipcRenderer.invoke('detail:get-entry');
  },

  chat(text) {
    return ipcRenderer.invoke('detail:chat', text);
  },

  copy() {
    return ipcRenderer.invoke('detail:copy');
  },

  breakout() {
    return ipcRenderer.invoke('detail:breakout');
  },

  viewScreenshot() {
    return ipcRenderer.invoke('detail:view-screenshot');
  },

  on(channel, callback) {
    if (validChannels.includes(channel)) {
      const listener = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },
});

// Expose minimal electronAPI so shared Markdown CodeBlock copy button works
contextBridge.exposeInMainWorld('electronAPI', {
  copyText(text) {
    return ipcRenderer.invoke('clipboard:copy', text);
  },
});
