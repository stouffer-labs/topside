const { BrowserWindow, screen } = require('electron');
const { log } = require('./logger');

/**
 * Small floating frameless window that shows a thumbnail of the captured
 * screenshot while the user is recording. Positioned beside the highlight
 * overlay so the user can see what context was captured.
 */

const PREVIEW_WIDTH = 200;
const PREVIEW_HEIGHT = 150;
const GAP = 12;

let previewWindow = null;

function buildHtml(base64) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: 100%; height: 100%; overflow: hidden; background: transparent; }
  .frame {
    width: 100%; height: 100%;
    border-radius: 8px;
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(0,0,0,0.85);
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .label {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 9px; color: rgba(255,255,255,0.35);
    text-transform: uppercase; letter-spacing: 0.06em;
    padding: 4px 6px 2px; flex-shrink: 0;
  }
  img {
    flex: 1; width: 100%; object-fit: cover;
    border-radius: 0 0 7px 7px;
  }
</style></head><body>
  <div class="frame">
    <div class="label">Context</div>
    <img src="${base64.startsWith('data:') ? base64 : 'data:image/jpeg;base64,' + base64}" />
  </div>
</body></html>`;
}

function computePosition(overlayBounds) {
  const display = screen.getDisplayNearestPoint({
    x: overlayBounds.x + (overlayBounds.width || overlayBounds.w || 0) / 2,
    y: overlayBounds.y + (overlayBounds.height || overlayBounds.h || 0) / 2,
  });
  const ow = overlayBounds.width ?? overlayBounds.w ?? 0;
  const oh = overlayBounds.height ?? overlayBounds.h ?? 0;
  const screenBounds = display.workArea;

  // Try right side of overlay, bottom-aligned
  let x = overlayBounds.x + ow + GAP;
  let y = overlayBounds.y + oh - PREVIEW_HEIGHT;

  // Fall back to left side if off-screen
  if (x + PREVIEW_WIDTH > screenBounds.x + screenBounds.width) {
    x = overlayBounds.x - PREVIEW_WIDTH - GAP;
  }
  // Clamp vertical
  if (y < screenBounds.y) y = screenBounds.y;
  if (y + PREVIEW_HEIGHT > screenBounds.y + screenBounds.height) {
    y = screenBounds.y + screenBounds.height - PREVIEW_HEIGHT;
  }

  return { x: Math.round(x), y: Math.round(y) };
}

function show(base64, overlayBounds) {
  const pos = computePosition(overlayBounds);

  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.setBounds({ x: pos.x, y: pos.y, width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT });
    const html = buildHtml(base64);
    previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    if (!previewWindow.isVisible()) previewWindow.showInactive();
    return;
  }

  previewWindow = new BrowserWindow({
    x: pos.x, y: pos.y,
    width: PREVIEW_WIDTH, height: PREVIEW_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: true,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  previewWindow.setIgnoreMouseEvents(true);
  previewWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  const html = buildHtml(base64);
  previewWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

  previewWindow.once('ready-to-show', () => {
    if (previewWindow && !previewWindow.isDestroyed()) {
      previewWindow.showInactive();
    }
  });

  previewWindow.on('closed', () => { previewWindow = null; });
  log('PREVIEW', `Showing screenshot preview at ${pos.x},${pos.y}`);
}

function hide() {
  if (previewWindow && !previewWindow.isDestroyed()) {
    previewWindow.hide();
  }
}

module.exports = { show, hide };
