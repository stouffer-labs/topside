let addon = null;
let loadError = null;

function loadAddon() {
  if (addon) return addon;
  if (loadError) return null;
  try {
    addon = require('./build/Release/active_window.node');
    return addon;
  } catch (err) {
    loadError = err;
    return null;
  }
}

function getActiveWindow() {
  const mod = loadAddon();
  if (!mod) return null;
  return mod.getActiveWindow();
}

module.exports = { getActiveWindow, loadError: () => loadError };
