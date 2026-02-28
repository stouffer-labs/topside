const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,

  config: {
    get(key) {
      return ipcRenderer.invoke('config:get', key);
    },
    set(key, value) {
      return ipcRenderer.invoke('config:set', key, value);
    },
    getAll() {
      return ipcRenderer.invoke('config:getAll');
    },
  },

  secrets: {
    get(key) {
      return ipcRenderer.invoke('secrets:get', key);
    },
    set(key, value) {
      return ipcRenderer.invoke('secrets:set', key, value);
    },
    delete(key) {
      return ipcRenderer.invoke('secrets:delete', key);
    },
    has(key) {
      return ipcRenderer.invoke('secrets:has', key);
    },
  },

  providers: {
    ai() {
      return ipcRenderer.invoke('providers:ai');
    },
    transcribe() {
      return ipcRenderer.invoke('providers:transcribe');
    },
    awsProfiles() {
      return ipcRenderer.invoke('providers:aws-profiles');
    },
    whisperModels() {
      return ipcRenderer.invoke('providers:whisper-models');
    },
    validate(providerType, providerId) {
      return ipcRenderer.invoke('providers:validate', providerType, providerId);
    },
    validateEnterprise(configJson) {
      return ipcRenderer.invoke('providers:validate-enterprise', configJson);
    },
  },

  whisper: {
    downloadModel(modelFile) {
      return ipcRenderer.invoke('whisper:download-model', modelFile);
    },
    onDownloadProgress(callback) {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('whisper:download-progress', listener);
      return () => ipcRenderer.removeListener('whisper:download-progress', listener);
    },
  },

  localAI: {
    getStatus() {
      return ipcRenderer.invoke('local-ai:get-status');
    },
    downloadModel(modelId) {
      return ipcRenderer.invoke('local-ai:download-model', modelId);
    },
    onDownloadProgress(callback) {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('local-ai:download-progress', listener);
      return () => ipcRenderer.removeListener('local-ai:download-progress', listener);
    },
  },

  hotkey: {
    set(hotkey) {
      return ipcRenderer.invoke('hotkey:set', hotkey);
    },
    clear() {
      return ipcRenderer.invoke('hotkey:clear');
    },
  },

  history: {
    getAll() {
      return ipcRenderer.invoke('history:getAll');
    },
    delete(id) {
      return ipcRenderer.invoke('history:delete', id);
    },
    clear() {
      return ipcRenderer.invoke('history:clear');
    },
    openDetail(entry) {
      return ipcRenderer.invoke('history:open-detail', entry);
    },
    getScreenshot(id) {
      return ipcRenderer.invoke('history:get-screenshot', id);
    },
    openScreenshot(id) {
      return ipcRenderer.invoke('history:open-screenshot', id);
    },
    search(query) {
      return ipcRenderer.invoke('history:search', query);
    },
  },

  embedding: {
    getStatus() {
      return ipcRenderer.invoke('embedding:get-status');
    },
    downloadModel() {
      return ipcRenderer.invoke('embedding:download-model');
    },
    indexAll() {
      return ipcRenderer.invoke('embedding:index-all');
    },
    onDownloadProgress(callback) {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('embedding:download-progress', listener);
      return () => ipcRenderer.removeListener('embedding:download-progress', listener);
    },
    onIndexProgress(callback) {
      const listener = (event, progress) => callback(progress);
      ipcRenderer.on('embedding:index-progress', listener);
      return () => ipcRenderer.removeListener('embedding:index-progress', listener);
    },
  },

  getDefaultPrompt() {
    return ipcRenderer.invoke('ai:default-prompt');
  },

  breakout: {
    detectTools() {
      return ipcRenderer.invoke('breakout:detect-tools');
    },
  },

  appInfo() {
    return ipcRenderer.invoke('app:info');
  },

  // Popover actions
  popover: {
    close() {
      return ipcRenderer.invoke('popover:close');
    },
    startRecording() {
      return ipcRenderer.invoke('popover:start-recording');
    },
    quit() {
      return ipcRenderer.invoke('popover:quit');
    },
  },

  // Help preferences
  help: {
    getShowOnStartup() {
      return ipcRenderer.invoke('help:get-show-on-startup');
    },
    setShowOnStartup(value) {
      return ipcRenderer.invoke('help:set-show-on-startup', value);
    },
  },

  // View switching from main process
  onSwitchView(callback) {
    const listener = (event, view) => callback(view);
    ipcRenderer.on('switch-view', listener);
    return () => ipcRenderer.removeListener('switch-view', listener);
  },

  // Legacy alias — kept for any code still referencing it
  onSwitchTab(callback) {
    const listener = (event, tab) => callback(tab);
    ipcRenderer.on('switch-view', listener);
    return () => ipcRenderer.removeListener('switch-view', listener);
  },

  closeSettings() {
    return ipcRenderer.invoke('popover:close');
  },
});
