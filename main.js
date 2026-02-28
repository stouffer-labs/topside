const { app, BrowserWindow, Tray, ipcMain, nativeImage, nativeTheme, screen, session, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

// Handle Squirrel events for Windows installer
if (require('electron-squirrel-startup')) app.quit();

const { log, initialize: initLogger } = require('./services/logger');
const { getInstance: getConfig } = require('./services/config-service');
const { SecretStore } = require('./services/secrets');
const { getInstance: getInputMonitor } = require('./services/input-monitor');
const { SessionOrchestrator } = require('./services/session-orchestrator');
const { getInstance: getWindowService } = require('./services/window-service');
const { getInstance: getCaptureService } = require('./services/capture-service');
const { getInstance: getTranscribeService } = require('./services/transcribe-service');
const { getInstance: getAIService } = require('./services/ai-service');
const { HistoryService } = require('./services/history-service');
const { EmbeddingService } = require('./services/embedding-service');
const { EmbeddingStore } = require('./services/embedding-store');
const highlightService = require('./services/highlight-service');
const screenshotPreview = require('./services/screenshot-preview-service');

// ─── State ─────────────────────────────────────────────────────────────────────

let tray = null;
let overlayWindow = null;
let popoverWindow = null;
let configService = null;
let secretStore = null;
let inputMonitor = null;
let orchestrator = null;
let historyService = null;
let embeddingService = null;
let embeddingStore = null;
let isAppQuitting = false;
let splashWindow = null;

// ─── Splash Screen ──────────────────────────────────────────────────────────────

const SPLASH_MIN_MS = 2000;
let splashMinDelay = null;

function showSplash() {
  return new Promise((resolve) => {
    const display = screen.getPrimaryDisplay();
    const splashWidth = 280;
    const splashHeight = 180;

    splashWindow = new BrowserWindow({
      width: splashWidth,
      height: splashHeight,
      x: Math.round(display.bounds.x + (display.workAreaSize.width - splashWidth) / 2),
      y: Math.round(display.bounds.y + (display.workAreaSize.height - splashHeight) / 2),
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: false,
      show: false,
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    background: rgba(18, 18, 18, 0.95);
    color: #e5e5e5;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 100vh;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.06);
    -webkit-app-region: no-drag;
    user-select: none;
  }
  svg { margin-bottom: 14px; filter: drop-shadow(0 0 8px rgba(99,102,241,0.3)); }
  .name { font-size: 18px; font-weight: 600; letter-spacing: 0.02em; }
  .author { font-size: 11px; color: #737373; margin-top: 6px; }
  .loading { font-size: 10px; color: #525252; margin-top: 14px; letter-spacing: 0.08em; }
  @keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
  .loading { animation: pulse 1.6s ease-in-out infinite; }
</style></head><body>
  <svg width="36" height="36" viewBox="0 0 260 310" fill="#6366f1">
    <path d="M100,105 C100,105 100,55 130,35 C150,22 185,25 200,45 L225,95 C232,110 220,125 205,125 L155,125 L155,105 Z"/>
    <circle cx="210" cy="72" r="32"/>
    <circle cx="210" cy="72" r="20" fill="white"/>
    <ellipse cx="203" cy="65" rx="7" ry="5" fill="white" opacity="0.6"/>
    <rect x="90" y="115" width="72" height="15" rx="3"/>
    <rect x="100" y="130" width="52" height="100" rx="3"/>
    <path d="M10,240 Q50,225 90,240 Q130,255 170,240 Q210,225 250,240" fill="none" stroke="#6366f1" stroke-width="12" stroke-linecap="round"/>
    <path d="M10,270 Q50,255 90,270 Q130,285 170,270 Q210,255 250,270" fill="none" stroke="#6366f1" stroke-width="10" stroke-linecap="round"/>
  </svg>
  <div class="name">Topside</div>
  <div class="author">Created by Eric Stouffer</div>
  <div class="loading">LOADING</div>
</body></html>`;

    splashWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    splashWindow.once('ready-to-show', () => {
      splashWindow.showInactive();
      splashMinDelay = new Promise(r => setTimeout(r, SPLASH_MIN_MS));
      resolve();
    });
    splashWindow.on('closed', () => { splashWindow = null; });
  });
}

async function closeSplash() {
  if (splashMinDelay) await splashMinDelay;
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
    splashWindow = null;
  }
}

// ─── Popover Window ─────────────────────────────────────────────────────────

const POPOVER_WIDTH = 520;
const POPOVER_HEIGHT = 640;

function showPopover(view) {
  if (popoverWindow && !popoverWindow.isDestroyed()) {
    if (popoverWindow.isVisible()) {
      if (view) {
        // Already visible but a specific view requested — switch to it
        popoverWindow.webContents.send('switch-view', view);
      } else {
        // Toggle off
        hidePopover();
      }
      return;
    }
    // Hidden — reposition and show
    const pos = getTrayPopoverPosition(POPOVER_WIDTH, POPOVER_HEIGHT);
    popoverWindow.setBounds({ x: pos.x, y: pos.y, width: POPOVER_WIDTH, height: POPOVER_HEIGHT });
    if (view) popoverWindow.webContents.send('switch-view', view);
    popoverWindow.show();
    popoverWindow.focus();
    return;
  }

  // Create popover window
  const pos = getTrayPopoverPosition(POPOVER_WIDTH, POPOVER_HEIGHT);

  popoverWindow = new BrowserWindow({
    width: POPOVER_WIDTH,
    height: POPOVER_HEIGHT,
    x: pos.x,
    y: pos.y,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  popoverWindow.loadURL(SETTINGS_WINDOW_WEBPACK_ENTRY);

  popoverWindow.once('ready-to-show', () => {
    if (popoverWindow && !popoverWindow.isDestroyed()) {
      if (view) popoverWindow.webContents.send('switch-view', view);
      popoverWindow.show();
      popoverWindow.focus();
    }
  });

  popoverWindow.on('blur', () => hidePopover());

  popoverWindow.on('closed', () => { popoverWindow = null; });

  log('MAIN', 'Popover window created');
}

function hidePopover() {
  if (popoverWindow && !popoverWindow.isDestroyed() && popoverWindow.isVisible()) {
    popoverWindow.hide();
  }
}

// ─── Window URLs (set by Electron Forge webpack plugin) ────────────────────────
// These globals are injected by the webpack plugin at build time.
/* global OVERLAY_WINDOW_WEBPACK_ENTRY, OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY */
/* global SETTINGS_WINDOW_WEBPACK_ENTRY, SETTINGS_WINDOW_PRELOAD_WEBPACK_ENTRY */
/* global DETAIL_WINDOW_WEBPACK_ENTRY, DETAIL_WINDOW_PRELOAD_WEBPACK_ENTRY */

// ─── Overlay Window ────────────────────────────────────────────────────────────

const OVERLAY_MAX_HEIGHT = 1200;
const OVERLAY_BOTTOM_MARGIN = 40;
let resourceInterval = null;

function getActiveDisplay() {
  const cursor = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(cursor);
}

function createOverlayWindow() {
  const display = getActiveDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: workX, y: workY } = display.workArea;
  const overlayWidth = configService.get('overlay.width') || 500;
  const maxAvailable = screenHeight - OVERLAY_BOTTOM_MARGIN;
  const overlayHeight = Math.min(200, maxAvailable);

  overlayWindow = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: workX + Math.round((screenWidth - overlayWidth) / 2),
    y: workY + screenHeight - overlayHeight - OVERLAY_BOTTOM_MARGIN,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: true,
    movable: true,
    minWidth: 300,
    minHeight: 140,
    hasShadow: true,
    show: false,
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    backgroundMaterial: process.platform === 'win32' ? 'acrylic' : undefined,
    webPreferences: {
      preload: OVERLAY_WINDOW_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  overlayWindow.loadURL(OVERLAY_WINDOW_WEBPACK_ENTRY);
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  overlayWindow.on('closed', () => {
    overlayWindow = null;
  });

  // Persist user-resized width (height is auto-managed by content)
  let resizeDebounce = null;
  overlayWindow.on('resize', () => {
    if (!overlayWindow) return;
    clearTimeout(resizeDebounce);
    resizeDebounce = setTimeout(() => {
      if (!overlayWindow) return;
      const { width } = overlayWindow.getBounds();
      const saved = configService.get('overlay.width') || 500;
      if (width !== saved) {
        configService.set('overlay.width', width);
        log('MAIN', `Overlay width saved: ${width}px`);
      }
    }, 300);
  });

  log('MAIN', 'Overlay window created');
}

function showOverlay() {
  if (!overlayWindow) createOverlayWindow();
  // Reposition to the display where the cursor is
  const display = getActiveDisplay();
  const { width: screenWidth, height: screenHeight } = display.workAreaSize;
  const { x: workX, y: workY } = display.workArea;
  const overlayWidth = configService.get('overlay.width') || 500;
  const maxAvailable = screenHeight - OVERLAY_BOTTOM_MARGIN;
  const bounds = overlayWindow.getBounds();
  const height = Math.min(bounds.height, maxAvailable);
  overlayWindow.setBounds({
    x: workX + Math.round((screenWidth - overlayWidth) / 2),
    y: workY + screenHeight - height - OVERLAY_BOTTOM_MARGIN,
    width: overlayWidth,
    height,
  });
  overlayWindow.showInactive();
  startResourceStats();
}

function hideOverlay() {
  if (overlayWindow) {
    overlayWindow.setFocusable(false);
    overlayWindow.hide();
  }
  stopResourceStats();
}

function startResourceStats() {
  if (resourceInterval) return;
  let lastCpu = process.cpuUsage();
  let lastTime = Date.now();
  resourceInterval = setInterval(() => {
    if (!overlayWindow) return;
    const cur = process.cpuUsage(lastCpu);
    const elapsed = Date.now() - lastTime;
    const cpu = elapsed > 0 ? Math.min(100, Math.round(((cur.user + cur.system) / 1000 / elapsed) * 100)) : 0;
    lastCpu = process.cpuUsage(); lastTime = Date.now();
    const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    overlayWindow.webContents.send('overlay:resource-stats', { cpu, memMB });
  }, 2000);
}

function stopResourceStats() {
  if (resourceInterval) {
    clearInterval(resourceInterval);
    resourceInterval = null;
  }
}

// ─── History Detail Window ─────────────────────────────────────────────────────

const detailWindowState = new Map(); // windowId → { entry, messages, screenshotBase64, windowInfo, aiInFlight }

function openHistoryDetailWindow(entry) {
  const messages = entry.messages || [
    { role: 'user', content: entry.transcript },
    { role: 'assistant', content: entry.aiText },
  ];

  // Load screenshot from disk if available
  let screenshotBase64 = null;
  if (entry.hasScreenshot && historyService) {
    try {
      const imgPath = historyService.getScreenshotPath(entry.id);
      if (fs.existsSync(imgPath)) {
        screenshotBase64 = fs.readFileSync(imgPath).toString('base64');
      }
    } catch (_) {}
  }

  const detailWin = new BrowserWindow({
    width: 600,
    height: 550,
    minWidth: 400,
    minHeight: 350,
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : undefined,
    ...(process.platform === 'darwin' ? { trafficLightPosition: { x: 12, y: 12 } } : {}),
    backgroundColor: '#0f0f0f',
    resizable: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: DETAIL_WINDOW_PRELOAD_WEBPACK_ENTRY,
    },
  });

  // Store state for this window
  detailWindowState.set(detailWin.id, {
    entry,
    messages: messages.map(m => ({ role: m.role, content: m.content, buttons: m.buttons })),
    screenshotBase64,
    windowInfo: entry.windowInfo || (entry.windowTitle ? { title: entry.windowTitle, owner: '' } : null),
    aiInFlight: false,
  });

  detailWin.on('closed', () => {
    detailWindowState.delete(detailWin.id);
  });

  detailWin.loadURL(DETAIL_WINDOW_WEBPACK_ENTRY);
  detailWin.once('ready-to-show', () => detailWin.show());
}

// ─── Screenshot Viewer Window ───────────────────────────────────────────────────

function openScreenshotViewer(base64) {
  if (!base64) return;

  const imgBuffer = Buffer.from(base64, 'base64');
  const img = nativeImage.createFromBuffer(imgBuffer);
  const { width: imgW, height: imgH } = img.getSize();

  // Scale to fit 70% of screen
  const display = screen.getPrimaryDisplay();
  const maxW = Math.round(display.workAreaSize.width * 0.7);
  const maxH = Math.round(display.workAreaSize.height * 0.7);
  const scale = Math.min(1, maxW / imgW, maxH / imgH);
  const winW = Math.round(imgW * scale);
  const winH = Math.round(imgH * scale);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #1a1a1a; overflow: auto; }
  img { display: block; width: 100%; }
</style></head><body>
  <img src="data:image/jpeg;base64,${base64}" />
  <script>
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape') window.close(); });
  </script>
</body></html>`;

  const win = new BrowserWindow({
    width: winW, height: winH,
    title: 'Screenshot',
    backgroundColor: '#1a1a1a',
    resizable: true,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  win.once('ready-to-show', () => win.show());
}

function openScreenshotWindow(imgPath) {
  if (!fs.existsSync(imgPath)) return;
  const base64 = fs.readFileSync(imgPath).toString('base64');
  openScreenshotViewer(base64);
}

// ─── System Tray ───────────────────────────────────────────────────────────────

// Embedded periscope tray icons — light theme (black on white) and dark theme (white on black)
const TRAY_ICONS = {
  light: {
    '16': 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAECUExURf////r6+uvr67i4uM/Pz/7+/rS0tGhoaFJSUkFCQlhZWMbGxhQUFBUVFCcnJ7u+v4qMjIqKivv7+1ZXVgAAAAEBASQlJdTY2cLHx4mKif39/fDw8DM0MwQFBXR3d4WIiKipqe/v7zAwMD4+Pmtra5OTk/Pz89zc3EhISBkaGiMjI6Kioqurq0tLS01OTUtMS3BxcfT09O3t7WdnZ0hJSL6/vzMzMwcHB/Hx8TExMQQEBLW1td7e3vf3983NzVNTUxAQEC0tLamqqunp6Z2enoiIiJ+goIaHh5CQkHh4eGRkZG5ubo6OjoaGhpiYmKCgoN/f38XFxejo6MnJycrKytLS0kYpMVcAAAABYktHRACIBR1IAAAAB3RJTUUH6gIKAxsc0QcIzAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMi0xMFQwMzoyNjoxNyswMDowMGzKapgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDItMTBUMDM6MjY6MTcrMDA6MDAdl9IkAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAyLTEwVDAzOjI3OjI4KzAwOjAw3YfvzwAAAJVJREFUGNNjYMAJGJmYWVgRXFY2dg5OLm6EADMPLx+/gCCcLyQsIiomLiEpBROQlhERkZWTV4CrUFQSEVFWUVWDC6hraGppI9nBoKOrp29giCRgZGyia4rsKkUzEXM2ZAELSxEra5iTbWwZLOzsHRydnIEOBgoYuri6uXt4enn7+Pr5G4HVBAQGMTAF2zAYhoQKYXoaAKo8EEPJmgShAAAAAElFTkSuQmCC',
    '22': 'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAMAAADzapwJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAGDUExURf////n5+ebm5tbW1np6emZmZri4uM7Pz1dXV1xcXDo6OiAiIVpbWkJDQ8TExMvLyykpKQAAADg5OA4ODpyen7m8vWlpanl5efj4+FZWVgICAhERER0eHszP0N7j5ImLi2lqaff399fX1xobGxITE7zAwe3z9L7Cwmtsa/r6+sDAwAoKCgEBAV9hYcXJym1vcJSUlL29vQkJCQwNDRscGykqKmVlZu3t7b2+vgcHBwMDA9ra2tHR0fT09a2urTY2Nh4eHjw8PPz8/ODg4EVGRVBQUF1dXU5PTktLS+jo6KysrEhISFpaWra2tv39/cnJyTM0NDk5OTc4OL6/vwcIBxAQEM/Pz7+/vxMTE9DQ0MHBwRESEtTU1Ovr7MPDw+vr6/Dw8KmqqVtbWxkZGSEhIWdnaKytrf7+/tvc3HZ2dmBgYJ2dnaOjo25vb21ubWFhYXJzcm9wcF9fX3R0dG9wb6qqqpGRks3NzY2NjYmJicXFxYuLi5GSkbe4t4SEhJeXl+rq6tPL0oIAAAABYktHRACIBR1IAAAAB3RJTUUH6gIKAxsc0QcIzAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMi0xMFQwMzoyNjoxNyswMDowMGzKapgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDItMTBUMDM6MjY6MTcrMDA6MDAdl9IkAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAyLTEwVDAzOjI3OjI4KzAwOjAw3YfvzwAAAN5JREFUGNNjYCAbMDIxs7CyoYuyc3BycfPw8qGK8gsICgmLiIqJo4hKSApKScvIyskrKCILKykLCgqqqKqpa2giC2tpC+oICurq6RugGGJoBBQ2NjE1M0cRtrAUFLQysLaxRRFVtLOXcXBkc0JztLOLq5ubu4cnmrCTF4e3t4+vH7of/QMCgwKVMAIkOERQMDQMQzhcW1AwIhJDOArowOgYBD82Lp6BISEuMSk5JTWNX4KBIR0snJGZlZ3DmpuXX1BYVMxaUlpWDlVvU1Hpn+5UVV0TwyBRW1ffQGr0AQC0MyXq4f7GxAAAAABJRU5ErkJggg==',
    '32': 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAJeUExURf////39/f7+/uHh4ZWVlXN0c46Ojt/f3+3t7aCgoHFycbGxsTk5OQAAAAgICAwNDDk7OtnZ2cnJyUNDQwABAUJDQ05OTjQ2NaKkpJWWlz4+PmNjY/v7+8jJyScnJwEBAU5PThgYGAkJCaWoqNzf4Xh4eYOEhDExMdjY2PLy8khJSQICAi4uLQYHBi0tLdja3Ozv8ry/wG5ubkBBQbOzs7O0tAoLCwABAAcHBzo7O+Dj5ecs7dnf4KapqUxNTKmpqQECASIiI83R0uju7ujv79vf3zs8O7i5uFBQUAUFBYqNjevx8e3y85ueni8vL+Li4vj4+EZGRhgZGXV4eH6AgSQlJYKDg0ZHRwwMDAwNDQQEBA4ODmdoaO/v70dISCUlJbW1tcbGxsfHx/f39/n5+URERGVlZfX29r6+vn5/fi4vLh0dHRkaGR8fHzY2NpaWl+Tl5TU2NVpbWoaGhpCRkJCQkIODg0lKSUtMTPb29m9wbxMTEwkJCAgJCQcIBxwcHJKSkqysrIqKint7e3V1dXx8fIuLi/r6+ltbWycnKD09PSIiIoWFhUlJSXl6eklKSnp7e0pKSnt8fElJSvz8/ICAgNPT09zc3PHx8c/Pz8zMzKeopwkKCRsbG3Jycre3uOXm5k1OTiwtLWdnZ9TU1PPz87CwsEVFRi4uLkBBQJaWlZqamqOjozMzNGlpadXW1b29vevr6+jo6MHBwVtcWy0uLT8/PzEyMoqLitra2pGRkTQ0ND4/PjIyMrq6usDBwUhISDw8PZeXl6GhoeDg4Kenp5aWlr+/v5eYl6KiohqO1scAAAABYktHRACIBR1IAAAAB3RJTUUH6gIKAxsc0QcIzAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMi0xMFQwMzoyNjoxNyswMDowMGzKapgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDItMTBUMDM6MjY6MTcrMDA6MDAdl9IkAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAyLTEwVDAzOjI3OjI4KzAwOjAw3YfvzwAAAXxJREFUOMtjYBgQwMjEzMLKxo5LmoOTi5uHl49fQBC7vJCwiKgYr7iEpJS0DDZ5WTleeQVFJWUVVTV1DSzymlq8vNo6unr6BoZGxiZYFJiamfPyWvBaWlnb2NrZY1HAyusgwsvL6+jk7OLq5o4pL+PBKy8vz8vr6eXt4+vnj6kgIBCkAKgkKDgkNAyLDQHhvPJAJbwRkVHRMbHYFMTxgpwQn5DInZSMLRRSUnlBIA1XKKdnZGZl5+Tm5ScyYldQUFhUXFJSWlZekYxdQWVVtUVNbV1dfQMTDjuSG5uaW1rbMnDYwMDQ3tHZJczT3YNLniGlF+yLPtwK+sFBPQG3golgBZNwK5gMtACfgikTQfK8U9HdPm36FBA9Y+as2R5zeOfOmy8EEYCBBQsXLV6SsnTZ8kUrVq5aPXUN69oVi9atT5mxYSNUAeOmzVu29m7bvkNj567de8T2iu1j3r9F78DBbUgpJmDzocPgfHDk6LF9S0FhevzESUEmBroAAHEpZrNB6b2vAAAAAElFTkSuQmCC',
    '44': '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',
  },
  dark: {
    '16': 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAMAAAAoLQ9TAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAECUExURQAAAAUFBRQUFEdHRzAwMAEBAUtLS5eXl62trb69vaempzk5Oevr6+rq69jY2ERBQHVzc3V1dQQEBKmoqf////7+/tva2isnJj04OHZ1dgICAg8PD8zLzPv6+ouIiHp3d1dWVhAQEM/Pz8HBwZSUlGxsbAwMDCMjI7e3t+bl5dzc3F1dXVRUVLS0tLKxsrSztI+OjgsLCxISEpiYmLe2t0FAQMzMzPj4+A4ODs7Ozvv7+0pKSiEhIQgICDIyMqysrO/v79LS0lZVVRYWFmJhYXd3d2BfX3l4eG9vb4eHh5ubm5GRkXFxcXl5eWdnZ19fXyAgIDo6OhcXFzY2NjU1NS0tLUMtTlwAAAABYktHRACIBR1IAAAAB3RJTUUH6gIKAxsc0QcIzAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMi0xMFQwMzoyNjoxNyswMDowMGzKapgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDItMTBUMDM6MjY6MTcrMDA6MDAdl9IkAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAyLTEwVDAzOjI3OjI4KzAwOjAw3YfvzwAAAJVJREFUGNNjYMAJGJmYWVgRXFY2dg5OLm6EADMPLx+/gCCcLyQsIiomLiEpBROQlhERkZWTV4CrUFQSEVFWUVWDC6hraGppI9nBoKOrp29giCRgZGyia4rsKkUzEXM2ZAELSxEra5iTbWwZLOzsHRydnIEOBgoYuri6uXt4enn7+Pr5G4HVBAQGMTAF2zAYhoQKYXoaAKo8EEPJmgShAAAAAElFTkSuQmCC',
    '22': 'iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAMAAADzapwJAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAGDUExURQAAAAYGBhkZGSkpKYWFhZmZmUdHRzEwMKioqKOjo8XFxd/d3qWkpb28vDs7OzQ0NNbW1v///8fGx/Hx8WNhYEZDQpaWlYaGhgcHB6mpqf39/e7u7uLh4TMwLyEcG3Z0dJaVlggICCgoKOXk5O3s7EM/PhIMC0E9PZSTlAUFBT8/P/X19f7+/qCenjo2NZKQj2tra0JCQvb29vPy8uTj5NbV1ZqamRISEkJBQfj4+Pz8/CUlJS4uLgsLClJRUsnJyeHh4cPDwwMDAx8fH7q5uq+vr6KiorGwsbS0tBcXF1NTU7e3t6WlpUlJSQICAjY2NszLy8bGxsjHx0FAQPj3+O/v7zAwMEBAQOzs7C8vLz4+Pu7t7SsrKxQUEzw8PBQUFA8PD1ZVVqSkpObm5t7e3piYl1NSUgEBASQjI4mJiZ+fn2JiYlxcXJGQkJKRkp6eno2MjZCPj6CgoIuLi5CPkFVVVW5ubTIyMnJycnZ2djo6OnR0dG5tbkhHSHt7e2hoaBUVFbdz6sQAAAABYktHRACIBR1IAAAAB3RJTUUH6gIKAxsc0QcIzAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMi0xMFQwMzoyNjoxNyswMDowMGzKapgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDItMTBUMDM6MjY6MTcrMDA6MDAdl9IkAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAyLTEwVDAzOjI3OjI4KzAwOjAw3YfvzwAAAN5JREFUGNNjYCAbMDIxs7CyoYuyc3BycfPw8qGK8gsICgmLiIqJo4hKSApKScvIyskrKCILKykLCgqqqKqpa2giC2tpC+oICurq6RugGGJoBBQ2NjE1M0cRtrAUFLQysLaxRRFVtLOXcXBkc0JztLOLq5ubu4cnmrCTF4e3t4+vH7of/QMCgwKVMAIkOERQMDQMQzhcW1AwIhJDOArowOgYBD82Lp6BISEuMSk5JTWNX4KBIR0snJGZlZ3DmpuXX1BYVMxaUlpWDlVvU1Hpn+5UVV0TwyBRW1ffQGr0AQC0MyXq4f7GxAAAAABJRU5ErkJggg==',
    '32': 'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAMAAABEpIrGAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAJeUExURQAAAAICAgEBAR4eHmpqaoyLjHFxcSAgIBISEl9fX46Njk5OTsbGxv////f39/Py88bExSYmJjY2Nry8vP/+/r28vLGxscvJyl1bW2ppaMHBwZycnAQEBDc2NtjY2P7+/rGwsefn5/b29lpXVyMgHoeHhnx7e87OzicnJw0NDbe2tv39/dHR0vn4+dLS0iclIxMQDUNAP5GRkb++vkxMTExLS/X09P/+//j4+MXExB8cGhgTEiYgH1lWVrOys1ZWVv79/t3d3DIuLRcRERcQECQgIMTDxEdGR6+vr/r6+nVychQODhINDGRhYdDQ0B0dHQcHB7m5uefm5oqHh4F/ftva2n18fLm4uPPz8/Py8vv7+/Hx8ZiXlxAQELi3t9ra2kpKSjk5OTg4OAgICAYGBru7u5qamgoJCUFBQYGAgdHQ0eLi4ubl5uDg4MnJyWlpaBsaGsrJyqWkpXl5eW9ub29vb3x8fLa1trSzswkJCZCPkOzs7Pb29/f29vj3+OPj421tbVNTU3V1dYSEhIqKioODg3R0dAUFBaSkpNjY18LCwt3d3Xp6era2toaFhba1tYWEhLW1tYSDg7a2tQMDA39/fywsLCMjIw4ODjAwMDMzM1hXWPb19uTk5I2NjUhIRxoZGbKxsdPS0piYmCsrKwwMDE9PT7q6udHR0b++v2lpamVlZVxcXMzMy5aWliopKkJCQhQUFBcXFz4+PqSjpNLR0sDAwM7NzXV0dSUlJW5ubsvLy8HAwc3NzUVFRT8+Pre3t8PDwmhoaF5eXh8fH1hYWGlpaUBAQGhnaF1dXe5VVeoAAAABYktHRACIBR1IAAAAB3RJTUUH6gIKAxsc0QcIzAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wMi0xMFQwMzoyNjoxNyswMDowMGzKapgAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDItMTBUMDM6MjY6MTcrMDA6MDAdl9IkAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTAyLTEwVDAzOjI3OjI4KzAwOjAw3YfvzwAAAXxJREFUOMtjYBgQwMjEzMLKxo5LmoOTi5uHl49fQBC7vJCwiKgYr7iEpJS0DDZ5WTleeQVFJWUVVTV1DSzymlq8vNo6unr6BoZGxiZYFJiamfPyWvBaWlnb2NrZY1HAyusgwsvL6+jk7OLq5o4pL+PBKy8vz8vr6eXt4+vnj6kgIBCkAKgkKDgkNAyLDQHhvPJAJbwRkVHRMbHYFMTxgpwQn5DInZSMLRRSUnlBIA1XKKdnZGZl5+Tm5ScyYldQUFhUXFJSWlZekYxdQWVVtUVNbV1dfQMTDjuSG5uaW1rbMnDYwMDQ3tHZJczT3YNLniGlF+yLPtwK+sFBPQG3golgBZNwK5gMtACfgikTQfK8U9HdPm36FBA9Y+as2R5zeOfOmy8EEYCBBQsXLV6SsnTZ8kUrVq5aPXUN69oVi9atT5mxYSNUAeOmzVu29m7bvkNj567de8T2iu1j3r9F78DBbUgpJmDzocPgfHDk6LF9S0FhevzESUEmBroAAHEpZrNB6b2vAAAAAElFTkSuQmCC',
    '44': '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',
  },
};

// Convert an opaque image to a template-ready image: luminance → alpha.
// White (background) becomes transparent, black (artwork) becomes opaque.
// Uses a steep power curve so the icon stays bold even when macOS dims it
// for the inactive menu bar state (~60% opacity).
function luminanceToAlpha(img) {
  const { width, height } = img.getSize();
  const bitmap = img.toBitmap();
  for (let i = 0; i < bitmap.length; i += 4) {
    const lum = 0.299 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.114 * bitmap[i + 2];
    // Normalize: 0 = black (fully opaque), 1 = white (transparent)
    const norm = lum / 255;
    // Steep curve: anything darker than light gray becomes nearly opaque,
    // only the lightest anti-aliased fringe stays partially transparent.
    const alpha = norm > 0.9 ? 0 : Math.min(255, Math.round((1 - norm) * 1.6 * 255));
    bitmap[i] = 0;
    bitmap[i + 1] = 0;
    bitmap[i + 2] = 0;
    bitmap[i + 3] = alpha;
  }
  return nativeImage.createFromBitmap(bitmap, { width, height });
}

function createTrayIcon() {
  const isMac = process.platform === 'darwin';
  const size = isMac ? 22 : 16;
  const size2x = isMac ? 44 : 32;

  // On macOS, use template images — macOS automatically colors them for the menu bar.
  // The embedded PNGs have opaque backgrounds (no alpha channel), so convert luminance → alpha.
  // On other platforms, fall back to manual theme selection.
  const theme = isMac ? 'light' : (nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  const icons = TRAY_ICONS[theme];

  const raw1x = nativeImage.createFromBuffer(Buffer.from(icons[String(size)], 'base64'), { width: size, height: size });
  const raw2x = nativeImage.createFromBuffer(Buffer.from(icons[String(size2x)], 'base64'), { width: size2x, height: size2x });

  if (isMac) {
    const img = luminanceToAlpha(raw1x);
    const img2x = luminanceToAlpha(raw2x);
    img.addRepresentation({ scaleFactor: 2.0, width: size2x, height: size2x, buffer: img2x.toPNG() });
    img.setTemplateImage(true);
    return img;
  }

  raw1x.addRepresentation({ scaleFactor: 2.0, width: size2x, height: size2x, buffer: raw2x.toPNG() });
  return raw1x;
}

function createTray() {
  const trayIcon = createTrayIcon();

  tray = new Tray(trayIcon);
  tray.setToolTip('Topside');

  // Update tray icon when OS theme changes
  nativeTheme.on('updated', () => {
    if (tray && !tray.isDestroyed()) {
      tray.setImage(createTrayIcon());
    }
  });

  tray.on('click', () => showPopover());
  tray.on('right-click', () => showPopover());

  log('MAIN', 'System tray created');
}

// ─── Tray Popover Position ────────────────────────────────────────────────────

function getTrayPopoverPosition(width, height) {
  if (!tray || tray.isDestroyed()) {
    const display = screen.getPrimaryDisplay();
    return { x: Math.round(display.bounds.x + (display.workAreaSize.width - width) / 2), y: display.bounds.y };
  }
  const trayBounds = tray.getBounds();
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y });
  const workArea = display.workArea;

  let x, y;
  if (process.platform === 'darwin') {
    // macOS: menu bar at top, popover below tray icon
    x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    y = trayBounds.y + trayBounds.height + 4;
  } else {
    // Windows: taskbar at bottom, popover above tray icon
    x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
    y = trayBounds.y - height - 4;
  }

  // Clamp to work area
  if (x + width > workArea.x + workArea.width) x = workArea.x + workArea.width - width;
  if (x < workArea.x) x = workArea.x;
  if (y + height > workArea.y + workArea.height) y = workArea.y + workArea.height - height;
  if (y < workArea.y) y = workArea.y;

  return { x, y };
}

// ─── IPC Handlers ──────────────────────────────────────────────────────────────

function registerIpcHandlers() {
  // Config
  ipcMain.handle('config:get', (event, key) => configService.get(key));
  ipcMain.handle('config:set', (event, key, value) => {
    const result = configService.set(key, value);
    // Trigger warmup when switching to whisper or changing whisper model
    if ((key === 'transcribe.provider' && value === 'whisper') ||
        (key === 'transcribe.whisper.model' && configService.get('transcribe.provider') === 'whisper')) {
      const ts = getTranscribeService(configService, secretStore);
      ts.warmup().catch(err => log('MAIN', 'Whisper warmup failed:', err.message));
    }
    return result;
  });
  ipcMain.handle('config:getAll', () => configService.getAll());

  // AI default prompt
  ipcMain.handle('ai:default-prompt', () => {
    const { SYSTEM_PROMPT } = require('./services/ai-service');
    return SYSTEM_PROMPT;
  });

  // App info for settings branding
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    userName: 'Eric Stouffer',
  }));

  // Popover actions
  ipcMain.handle('popover:close', () => {
    hidePopover();
  });
  ipcMain.handle('popover:start-recording', () => {
    hidePopover();
    if (orchestrator) orchestrator.onTriggerDown();
  });
  ipcMain.handle('popover:quit', () => {
    hidePopover();
    isAppQuitting = true;
    app.quit();
  });

  // Help preferences
  ipcMain.handle('help:get-show-on-startup', () => {
    return configService ? configService.get('help.showOnStartup') !== false : true;
  });
  ipcMain.handle('help:set-show-on-startup', (_, value) => {
    if (configService) configService.set('help.showOnStartup', value);
  });

  // Session cancel from overlay UI button
  ipcMain.handle('session:cancel', () => {
    log('MAIN', 'Session cancel requested from overlay');
    if (orchestrator) {
      orchestrator.onCancel();
    } else {
      hideOverlay();
    }
  });

  // Button click from overlay
  ipcMain.handle('session:button-click', (e, label) => {
    if (orchestrator) orchestrator.onButtonClick(label);
  });

  // Session actions: copy, paste, breakout, close
  ipcMain.handle('session:action', (e, action) => {
    if (!orchestrator) return;
    switch (action) {
      case 'copy': orchestrator.onCopyAction(); break;
      case 'breakout': orchestrator.onBreakoutAction(); break;
      case 'close': orchestrator.onClose(); break;
    }
  });

  // Focus-on-click: overlay starts non-focusable, gains focus when user clicks
  ipcMain.handle('overlay:request-focus', () => {
    if (overlayWindow) {
      overlayWindow.setFocusable(true);
      overlayWindow.focus();
    }
  });

  ipcMain.handle('clipboard:copy', (e, text) => {
    clipboard.writeText(text);
  });

  // Open full-size screenshot preview from overlay thumbnail
  ipcMain.handle('screenshot:open-preview', () => {
    const base64 = orchestrator?.conversation?.screenshot?.base64;
    openScreenshotViewer(base64);
  });

  // Screen recording permission status (macOS)
  ipcMain.handle('capture:permission-status', () => {
    const captureService = getCaptureService();
    return captureService.getPermissionStatus();
  });

  // Breakout tool detection
  ipcMain.handle('breakout:detect-tools', () => {
    try {
      const breakoutService = require('./services/breakout-service');
      return breakoutService.detectTools();
    } catch (err) {
      return [];
    }
  });

  // Overlay resize — renderer reports content height, we grow upward from current bottom edge
  ipcMain.handle('overlay:resize', (event, contentHeight) => {
    if (!overlayWindow) return;
    const bounds = overlayWindow.getBounds();
    const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const { height: screenHeight } = display.workAreaSize;
    // Clamp to dynamic max based on screen and absolute cap
    const maxAvailable = screenHeight - OVERLAY_BOTTOM_MARGIN;
    const dynamicMax = Math.min(OVERLAY_MAX_HEIGHT, Math.round(screenHeight * 0.9));
    const newHeight = Math.min(Math.max(contentHeight, 140), dynamicMax, maxAvailable);
    // Grow upward: keep bottom edge fixed at current position
    const bottomEdge = bounds.y + bounds.height;
    const overlayWidth = configService.get('overlay.width') || 500;
    overlayWindow.setBounds({
      x: bounds.x,
      y: bottomEdge - newHeight,
      width: overlayWidth,
      height: newHeight,
    });
  });

  // Renderer → main process logging
  ipcMain.handle('log:renderer', (event, msg) => {
    log('OVERLAY', msg);
  });

  // Audio chunk — forward PCM from renderer to transcribe WebSocket
  let audioChunkCount = 0;
  let lastAudioLogTime = 0;
  ipcMain.handle('audio:chunk', (event, pcmData) => {
    audioChunkCount++;
    const now = Date.now();
    // Log first 3 chunks per session (reset after 5s gap) with RMS to diagnose silence
    if (now - lastAudioLogTime > 5000) audioChunkCount = 1;
    if (audioChunkCount <= 3) {
      const int16 = new Int16Array(pcmData);
      let sumSq = 0;
      for (let i = 0; i < int16.length; i++) sumSq += int16[i] * int16[i];
      const rms = Math.sqrt(sumSq / int16.length);
      const db = rms > 0 ? 20 * Math.log10(rms / 32767) : -96;
      log('AUDIO', `Chunk #${audioChunkCount}: ${pcmData?.byteLength || 0} bytes, ${int16.length} samples, RMS=${rms.toFixed(1)} (${db.toFixed(1)} dB)`);
    }
    lastAudioLogTime = now;
    const ts = getTranscribeService(configService, secretStore);
    ts.sendAudioChunk(pcmData);
    return { ok: true };
  });

  // Hotkey set — renderer captures key and sends accelerator string
  ipcMain.handle('hotkey:set', async (e, hotkey) => {
    // hotkey = { accelerator: 'F10', label: 'F10' }
    await configService.set('hotkey', hotkey);
    log('MAIN', `Hotkey set to: ${hotkey.label} (${hotkey.accelerator})`);
    if (inputMonitor) inputMonitor.updateHotkey();
    return hotkey;
  });

  ipcMain.handle('hotkey:clear', async () => {
    await configService.set('hotkey', null);
    log('MAIN', 'Hotkey cleared');
    if (inputMonitor) inputMonitor.updateHotkey();
    return null;
  });

  // ─── Secrets ──────────────────────────────────────────────────────────────────
  ipcMain.handle('secrets:get', (event, key) => {
    return secretStore ? secretStore.get(key) : null;
  });
  ipcMain.handle('secrets:set', (event, key, value) => {
    if (secretStore) secretStore.set(key, value);
    // Invalidate AI client when API key changes so it picks up new credentials
    const aiService = getAIService(configService, secretStore);
    aiService.invalidateClient();
  });
  ipcMain.handle('secrets:delete', (event, key) => {
    if (secretStore) secretStore.delete(key);
  });
  ipcMain.handle('secrets:has', (event, key) => {
    return secretStore ? secretStore.has(key) : false;
  });

  // ─── Provider Metadata ────────────────────────────────────────────────────────
  ipcMain.handle('providers:ai', () => {
    const { PROVIDERS } = require('./services/ai-service');
    return Object.keys(PROVIDERS).map(key => {
      const meta = PROVIDERS[key]();
      return { id: meta.id, label: meta.label, models: meta.models, fastModel: meta.fastModel, configFields: meta.configFields, isAvailable: meta.isAvailable ? meta.isAvailable() : true };
    });
  });

  ipcMain.handle('providers:transcribe', () => {
    const { PROVIDERS } = require('./services/transcribe-service');
    return Object.keys(PROVIDERS).map(key => {
      const meta = PROVIDERS[key]();
      return { id: meta.id, label: meta.label, configFields: meta.configFields };
    });
  });

  // Credential validation — lightweight API check for provider keys
  ipcMain.handle('providers:validate', async (event, providerType, providerId) => {
    try {
      // Look up the provider module
      let meta;
      const { PROVIDERS: aiProviders } = require('./services/ai-service');
      const { PROVIDERS: transcribeProviders } = require('./services/transcribe-service');
      if (providerType === 'ai' && aiProviders[providerId]) {
        meta = aiProviders[providerId]();
      } else if (providerType === 'transcribe' && transcribeProviders[providerId]) {
        meta = transcribeProviders[providerId]();
      }
      if (!meta?.validate) return { valid: null, reason: 'No validation available' };

      // AWS-based providers use profile/access key credentials, not a simple API key
      if (providerId === 'bedrock') {
        const bedrockConfig = configService.get('ai.bedrock') || {};
        const secrets = {
          accessKeyId: secretStore.get('bedrock.accessKeyId'),
          secretAccessKey: secretStore.get('bedrock.secretAccessKey'),
        };
        const valid = await meta.validate(null, { ...bedrockConfig, secrets, _configService: configService });
        return { valid, reason: 'Credentials valid' };
      }

      if (providerType === 'transcribe' && providerId === 'aws') {
        const awsConfig = configService.get('transcribe.aws') || {};
        const secrets = {
          accessKeyId: secretStore.get('aws.accessKeyId'),
          secretAccessKey: secretStore.get('aws.secretAccessKey'),
        };
        const valid = await meta.validate(null, { ...awsConfig, secrets, _configService: configService });
        return { valid, reason: 'Credentials valid' };
      }

      // Get the API key from the secret store
      const apiKey = secretStore.get(`${providerId}.apiKey`);
      if (!apiKey) return { valid: false, reason: 'No API key set' };

      // Azure needs extra config
      const config = providerId === 'azure' ? configService.get('ai.azure') : null;
      const valid = await meta.validate(apiKey, config);
      return { valid, reason: valid ? 'Key is valid' : 'Invalid API key' };
    } catch (err) {
      log('MAIN', `Validation error for ${providerId}: ${err.message}`);
      return { valid: false, reason: err.message };
    }
  });

  ipcMain.handle('providers:aws-profiles', () => {
    const { listAwsProfiles } = require('./services/ai-providers/bedrock');
    return listAwsProfiles();
  });

  ipcMain.handle('providers:validate-enterprise', async (event, configJson) => {
    const { EnterpriseCredentialProvider } = require('./services/enterprise-credential-provider');
    return EnterpriseCredentialProvider.validateConfig(configJson);
  });

  ipcMain.handle('providers:whisper-models', () => {
    const path = require('path');
    const fs = require('fs');
    const modelsDir = path.join(app.getPath('userData'), 'models');
    if (!fs.existsSync(modelsDir)) return [];
    return fs.readdirSync(modelsDir).filter(f => f.startsWith('ggml-') && f.endsWith('.bin'));
  });

  // ─── Model Download ───────────────────────────────────────────────────────────
  ipcMain.handle('whisper:download-model', async (event, modelFile) => {
    const { downloadModel } = require('./services/model-downloader');
    const modelsDir = path.join(app.getPath('userData'), 'models');
    return downloadModel(modelFile, modelsDir, (progress) => {
      if (popoverWindow && !popoverWindow.isDestroyed()) {
        popoverWindow.webContents.send('whisper:download-progress', progress);
      }
    });
  });

  // ─── Local AI Model Status & Download ────────────────────────────────────────
  ipcMain.handle('local-ai:get-status', () => {
    try {
      const { loadAddon } = require('mlx-inference-addon');
      const addon = loadAddon();
      return addon ? addon.getStatus() : { loaded: false };
    } catch {
      return { loaded: false };
    }
  });

  ipcMain.handle('local-ai:download-model', async (event, modelId) => {
    const { downloadModel } = require('./services/ai-providers/local');
    return downloadModel(modelId, (progress) => {
      if (popoverWindow && !popoverWindow.isDestroyed()) {
        popoverWindow.webContents.send('local-ai:download-progress', progress);
      }
    });
  });

  // ─── History ─────────────────────────────────────────────────────────────────
  ipcMain.handle('history:getAll', () => historyService ? historyService.getAll() : []);
  ipcMain.handle('history:delete', (_, id) => { if (historyService) historyService.delete(id); });
  ipcMain.handle('history:clear', () => {
    if (historyService) historyService.clear();
    try {
      const { clearSessions } = require('./services/breakout-service');
      clearSessions();
    } catch (_) {}
  });

  ipcMain.handle('history:open-detail', (_, entry) => {
    openHistoryDetailWindow(entry);
  });

  ipcMain.handle('history:get-screenshot', (_, id) => {
    if (!historyService) return null;
    const imgPath = historyService.getScreenshotPath(id);
    try {
      if (fs.existsSync(imgPath)) {
        return fs.readFileSync(imgPath).toString('base64');
      }
    } catch (err) {
      log('MAIN', `Failed to read screenshot ${id}: ${err.message}`);
    }
    return null;
  });

  ipcMain.handle('history:open-screenshot', (_, id) => {
    if (!historyService) return;
    openScreenshotWindow(historyService.getScreenshotPath(id));
  });

  ipcMain.handle('history:breakout', async (_, entry) => {
    try {
      const breakoutService = require('./services/breakout-service');
      // Load screenshot from disk if available
      let screenshot = null;
      if (entry.hasScreenshot && historyService) {
        try {
          const imgPath = historyService.getScreenshotPath(entry.id);
          if (fs.existsSync(imgPath)) {
            screenshot = 'data:image/jpeg;base64,' + fs.readFileSync(imgPath).toString('base64');
          }
        } catch (_) {}
      }
      const conversation = {
        messages: entry.messages || [
          { role: 'user', content: entry.transcript },
          { role: 'assistant', content: entry.aiText },
        ],
        windowInfo: entry.windowTitle ? { title: entry.windowTitle, owner: '' } : null,
        screenshot,
      };
      return await breakoutService.breakout(conversation, configService);
    } catch (err) {
      log('MAIN', 'History breakout failed:', err.message);
      return null;
    }
  });

  // ─── Detail Window IPC ─────────────────────────────────────────────────────
  ipcMain.handle('detail:get-entry', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const state = detailWindowState.get(win.id);
    if (!state) return null;
    return {
      entry: state.entry,
      messages: state.messages,
      screenshotBase64: state.screenshotBase64,
    };
  });

  ipcMain.handle('detail:chat', async (event, text) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    const state = detailWindowState.get(win.id);
    if (!state || state.aiInFlight) return;

    state.aiInFlight = true;
    state.messages.push({ role: 'user', content: text });
    win.webContents.send('detail:thinking', text);

    try {
      const aiService = getAIService(configService, secretStore);
      const { parseButtons } = require('./services/ai-service');

      // Build screenshot object for AI service
      const screenshot = state.screenshotBase64
        ? { base64: state.screenshotBase64, mediaType: 'image/jpeg' }
        : null;

      let accumulated = '';
      const rawText = await aiService.converse(state.messages, screenshot, state.windowInfo, (chunk) => {
        accumulated = chunk;
        if (!win.isDestroyed()) {
          win.webContents.send('detail:stream-chunk', accumulated);
        }
      });

      const { content, buttons } = parseButtons(rawText);
      state.messages.push({ role: 'assistant', content, buttons });
      state.aiInFlight = false;

      if (!win.isDestroyed()) {
        win.webContents.send('detail:round-complete', { content, buttons });
      }
    } catch (err) {
      state.aiInFlight = false;
      log('MAIN', `Detail chat error: ${err.message}`);
      if (!win.isDestroyed()) {
        win.webContents.send('detail:error', {
          title: 'AI Error',
          detail: err.message,
        });
      }
    }
  });

  ipcMain.handle('detail:copy', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const state = detailWindowState.get(win.id);
    if (!state) return;
    const copyText = state.messages.map(m =>
      (m.role === 'user' ? 'You' : 'AI') + ': ' + m.content
    ).join('\n\n');
    clipboard.writeText(copyText);
  });

  ipcMain.handle('detail:breakout', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const state = detailWindowState.get(win.id);
    if (!state) return;

    const breakoutService = require('./services/breakout-service');
    const screenshot = state.screenshotBase64
      ? 'data:image/jpeg;base64,' + state.screenshotBase64
      : null;
    const conversation = {
      messages: state.messages,
      windowInfo: state.windowInfo,
      screenshot,
    };
    await breakoutService.breakout(conversation, configService);
    if (!win.isDestroyed()) win.close();
  });

  ipcMain.handle('detail:view-screenshot', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    const state = detailWindowState.get(win.id);
    if (!state?.screenshotBase64) return;
    openScreenshotViewer(state.screenshotBase64);
  });

  // ─── Embedding / Search ──────────────────────────────────────────────────────
  ipcMain.handle('history:search', async (_, query) => {
    if (!embeddingService || !embeddingStore || !historyService) return [];
    const allEntries = historyService.getAll();
    try {
      if (!embeddingService.isModelDownloaded()) {
        return keywordSearch(query, allEntries);
      }
      // search() returns null when embeddings can't discriminate — fall back to keyword
      const results = await embeddingService.search(query, allEntries, embeddingStore);
      return results !== null ? results : keywordSearch(query, allEntries);
    } catch (err) {
      log('MAIN', `Semantic search failed, falling back to keyword: ${err.message}`);
      return keywordSearch(query, allEntries);
    }
  });

  ipcMain.handle('embedding:get-status', () => {
    if (!embeddingService || !embeddingStore || !historyService) {
      return { modelDownloaded: false, modelLoaded: false, indexedCount: 0, totalCount: 0, storageBytes: 0 };
    }

    // Calculate storage usage: history JSON + embeddings JSON + screenshots
    let storageBytes = 0;
    try {
      const historyStats = fs.statSync(historyService.filePath);
      storageBytes += historyStats.size;
    } catch (_) {}
    try {
      const embeddingStats = fs.statSync(embeddingStore.filePath);
      storageBytes += embeddingStats.size;
    } catch (_) {}
    try {
      const screenshotFiles = fs.readdirSync(historyService.screenshotsDir);
      for (const f of screenshotFiles) {
        try {
          storageBytes += fs.statSync(path.join(historyService.screenshotsDir, f)).size;
        } catch (_) {}
      }
    } catch (_) {}

    return {
      modelDownloaded: embeddingService.isModelDownloaded(),
      modelLoaded: embeddingService.isModelLoaded(),
      indexedCount: embeddingStore.count(),
      totalCount: historyService.load().length,
      storageBytes,
    };
  });

  ipcMain.handle('embedding:download-model', async () => {
    if (!embeddingService) return;
    await embeddingService.downloadModel((progress) => {
      if (popoverWindow && !popoverWindow.isDestroyed()) {
        try { popoverWindow.webContents.send('embedding:download-progress', progress); } catch (_) {}
      }
    });
  });

  ipcMain.handle('embedding:index-all', async () => {
    if (!embeddingService || !embeddingStore || !historyService) return;
    await indexUnembeddedEntries();
  });

  log('MAIN', 'IPC handlers registered');
}

function keywordSearch(query, entries) {
  const q = query.toLowerCase();
  return entries.filter(e => {
    const transcript = (e.transcript || '').toLowerCase();
    const aiText = (e.aiText || '').toLowerCase();
    return transcript.includes(q) || aiText.includes(q);
  });
}

async function indexUnembeddedEntries() {
  if (!embeddingService || !embeddingStore || !historyService) return;
  if (!embeddingService.isModelDownloaded()) return;

  const entries = historyService.load();
  const unindexed = entries.filter(e => !embeddingStore.has(e.id));
  if (unindexed.length === 0) return;

  log('MAIN', `Indexing ${unindexed.length} history entries for search...`);
  let indexed = 0;

  for (const entry of unindexed) {
    try {
      const text = HistoryService.composeSearchText(entry);
      if (!text) continue;
      const vector = await embeddingService.embed(text);
      embeddingStore.set(entry.id, vector);
      indexed++;
      if (popoverWindow && !popoverWindow.isDestroyed()) {
        try {
          popoverWindow.webContents.send('embedding:index-progress', {
            indexed,
            total: unindexed.length,
            percent: Math.round((indexed / unindexed.length) * 100),
          });
        } catch (_) {}
      }
    } catch (err) {
      log('MAIN', `Failed to embed entry ${entry.id}: ${err.message}`);
    }
  }
  log('MAIN', `Indexing complete: ${indexed} entries embedded`);
}

// ─── App Lifecycle ─────────────────────────────────────────────────────────────

// Ensure only one instance of Topside runs at a time
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error('Topside is already running.');
  app.quit();
}

app.whenReady().then(async () => {
  // Initialize config early so we can read help.showOnStartup before choosing a splash
  const userDataPath = app.getPath('userData');
  configService = getConfig(path.join(userDataPath, 'config.json'));
  await configService.initialize();

  // Always show splash during init
  await showSplash();
  // Let the event loop paint the splash before heavy init work blocks the main thread
  await new Promise(r => setTimeout(r, 100));

  // Initialize services
  initLogger(userDataPath);
  log('MAIN', `Topside v${app.getVersion()} starting...`);
  log('MAIN', `Data directory: ${userDataPath}`);
  log('MAIN', `Platform: ${process.platform}, Electron: ${process.versions.electron}`);

  // Initialize secrets store
  secretStore = new SecretStore(userDataPath);
  secretStore.initialize();
  log('MAIN', 'Secret store initialized');

  // Register IPC handlers
  registerIpcHandlers();

  // Auto-approve microphone permission for our overlay renderer
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true);
    } else {
      callback(false);
    }
  });

  // Create tray
  createTray();

  // Create overlay window (hidden)
  createOverlayWindow();

  // Start input monitor
  inputMonitor = getInputMonitor(configService);
  await inputMonitor.start();

  // Initialize history service
  historyService = new HistoryService(userDataPath);
  log('MAIN', 'History service initialized');

  // Initialize embedding store first, then service (service needs store reference)
  embeddingStore = new EmbeddingStore(userDataPath);
  embeddingStore.load();
  embeddingService = new EmbeddingService(userDataPath, embeddingStore);

  // Wire history lifecycle to embedding store
  historyService._onSave = (session) => {
    if (!embeddingService.isModelDownloaded()) return;
    const text = HistoryService.composeSearchText(session);
    if (!text) return;
    embeddingService.embed(text).then(vector => {
      // Verify entry still exists (may have been deleted while embedding)
      const entries = historyService.load();
      if (entries.find(e => e.id === session.id)) {
        embeddingStore.set(session.id, vector);
        log('MAIN', `Embedded new entry ${session.id}`);
      }
    }).catch(err => log('MAIN', `Failed to embed entry ${session.id}: ${err.message}`));
  };
  historyService._onDelete = (id) => { embeddingStore.delete(id); };
  historyService._onClear = () => { embeddingStore.clear(); };

  // Background-index any un-embedded entries (non-blocking)
  indexUnembeddedEntries().catch(err => log('MAIN', `Background indexing failed (non-fatal): ${err.message}`));
  log('MAIN', 'Embedding service initialized');

  // Pre-initialize services at startup (avoids cold start delays on first dictation)
  const aiService = getAIService(configService, secretStore);
  aiService.initialize().catch(err => log('MAIN', 'AI pre-init failed (non-fatal):', err.message));
  const transcribeService = getTranscribeService(configService, secretStore);
  // Await warmup so splash screen stays visible during whisper model loading
  await transcribeService.warmup().catch(err => log('MAIN', 'Transcribe warmup failed (non-fatal):', err.message));

  // Create session orchestrator
  let breakoutService = null;
  try {
    breakoutService = require('./services/breakout-service');
  } catch (err) {
    log('MAIN', 'Breakout service not available (non-fatal):', err.message);
  }

  orchestrator = new SessionOrchestrator({
    inputMonitor,
    overlayWindow: () => overlayWindow,
    showOverlay,
    hideOverlay,
    windowService: getWindowService(),
    captureService: getCaptureService(userDataPath),
    transcribeService,
    aiService,
    configService,
    historyService,
    breakoutService,
    isSettingsOpen: () => popoverWindow !== null && !popoverWindow.isDestroyed() && popoverWindow.isVisible(),
    highlightService,
    hideSettings: () => hidePopover(),
    screenshotPreview,
  });

  orchestrator.on('open-settings', () => {
    showPopover('settings');
  });

  // Close splash, then show popover with help view on first launch
  await closeSplash();

  const showHelpOnStartup = configService.get('help.showOnStartup') !== false;
  if (showHelpOnStartup) {
    showPopover('help');
  }

  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  log('MAIN', 'Topside ready');
});

app.on('before-quit', () => {
  isAppQuitting = true;
  if (inputMonitor) inputMonitor.stop();
  log('MAIN', 'Topside shutting down...');
});

app.on('window-all-closed', () => {
  // Don't quit when windows are closed — tray app stays running
});

process.on('uncaughtException', (error) => {
  log('ERROR', 'Uncaught exception:', error.message, error.stack);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', 'Unhandled rejection:', reason);
});
