const { BrowserWindow } = require('electron');
const { log } = require('./logger');

/**
 * Manages a transparent, click-through window that draws a yellow border
 * around the captured area (full screen or active window).
 */

let highlightWindow = null;

const BORDER_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  .border { position: fixed; inset: 0; border: 4px solid #fbbf24; border-radius: 0; pointer-events: none; }
  .flash-overlay {
    position: fixed; inset: 0; background: rgba(255,255,255,0.6);
    pointer-events: none; opacity: 0; border-radius: 0;
  }
  .flash-overlay.active {
    animation: flashFade 350ms ease-out forwards;
  }
  @keyframes flashFade { from { opacity: 1; } to { opacity: 0; } }
  .flash-icon {
    position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) scale(0.5);
    font-size: 80px; pointer-events: none; opacity: 0;
  }
  .flash-icon.active {
    animation: iconPop 2s ease-out forwards;
  }
  @keyframes iconPop {
    0%  { opacity: 1; transform: translate(-50%, -50%) scale(0.5); }
    15% { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
    75% { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
    100%{ opacity: 0; transform: translate(-50%, -50%) scale(1.4); }
  }
</style></head><body>
  <div class="border"></div>
  <div class="flash-overlay"></div>
  <div class="flash-icon">📷</div>
  <script>
    function triggerFlash() {
      var overlay = document.querySelector('.flash-overlay');
      var icon = document.querySelector('.flash-icon');
      overlay.classList.remove('active');
      icon.classList.remove('active');
      void overlay.offsetWidth;
      overlay.classList.add('active');
      icon.classList.add('active');
      overlay.addEventListener('animationend', function() { overlay.classList.remove('active'); }, { once: true });
      icon.addEventListener('animationend', function() { icon.classList.remove('active'); }, { once: true });
    }
  </script>
</body></html>`;

function show(bounds) {
  const { x, y } = bounds;
  const w = bounds.width ?? bounds.w;
  const h = bounds.height ?? bounds.h;

  if (highlightWindow && !highlightWindow.isDestroyed()) {
    highlightWindow.setBounds({ x, y, width: w, height: h });
    if (!highlightWindow.isVisible()) highlightWindow.showInactive();
    return;
  }

  highlightWindow = new BrowserWindow({
    x, y, width: w, height: h,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  highlightWindow.setIgnoreMouseEvents(true);
  highlightWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  highlightWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(BORDER_HTML)}`);

  highlightWindow.once('ready-to-show', () => {
    if (highlightWindow && !highlightWindow.isDestroyed()) {
      highlightWindow.showInactive();
    }
  });

  highlightWindow.on('closed', () => { highlightWindow = null; });
  log('HIGHLIGHT', `Showing highlight at ${x},${y} ${w}x${h}`);
}

function hide() {
  if (highlightWindow && !highlightWindow.isDestroyed()) {
    highlightWindow.hide();
  }
}

function flash() {
  if (highlightWindow && !highlightWindow.isDestroyed()) {
    highlightWindow.webContents.executeJavaScript('triggerFlash()').catch(() => {});
  }
}

module.exports = { show, hide, flash };
