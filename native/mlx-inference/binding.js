let addon = null;
let loadError = null;

function loadAddon() {
  if (addon) return addon;
  if (loadError) return null;
  try {
    addon = require('./build/Release/mlx_inference.node');
    return addon;
  } catch (err) {
    loadError = err;
    return null;
  }
}

module.exports = { loadAddon, loadError: () => loadError };
