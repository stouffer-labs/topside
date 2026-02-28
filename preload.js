const { contextBridge, ipcRenderer } = require('electron');

const validChannels = [
  'overlay:update-transcription',
  'overlay:show',
  'overlay:hide',
  'overlay:cancel',
  'overlay:round-complete',
  'overlay:new-round',
  'overlay:button-thinking',
  'overlay:stream-chunk',
  'overlay:mic-level',
  'overlay:resource-stats',
  'overlay:auto-copied',
  'overlay:error',
  'overlay:breakout-clipboard',
  'overlay:screenshot',
  'overlay:finalizing',
];

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  config: {
    get(key) {
      return ipcRenderer.invoke('config:get', key);
    },
  },

  on(channel, callback) {
    if (validChannels.includes(channel)) {
      const listener = (event, ...args) => callback(...args);
      ipcRenderer.on(channel, listener);
      return () => ipcRenderer.removeListener(channel, listener);
    }
  },

  off(channel, callback) {
    if (validChannels.includes(channel)) {
      ipcRenderer.removeListener(channel, callback);
    }
  },

  // Audio capture: renderer sends PCM audio to main process
  sendAudioChunk(pcmData) {
    return ipcRenderer.invoke('audio:chunk', pcmData);
  },

  // Logging from renderer → main process log
  logFromRenderer(msg) {
    return ipcRenderer.invoke('log:renderer', msg);
  },

  // Overlay resize
  resizeOverlay(height) {
    return ipcRenderer.invoke('overlay:resize', height);
  },

  // Session actions
  cancelSession() {
    return ipcRenderer.invoke('session:cancel');
  },

  buttonClick(label) {
    return ipcRenderer.invoke('session:button-click', label);
  },

  sessionAction(action) {
    return ipcRenderer.invoke('session:action', action);
  },

  requestFocus() {
    return ipcRenderer.invoke('overlay:request-focus');
  },

  copyText(text) {
    return ipcRenderer.invoke('clipboard:copy', text);
  },

  openScreenshotPreview() {
    return ipcRenderer.invoke('screenshot:open-preview');
  },
});
