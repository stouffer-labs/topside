const { desktopCapturer, screen, systemPreferences } = require('electron');
const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

class CaptureService {
  constructor(debugDir) {
    this.debugDir = debugDir || null;
  }

  /**
   * Check screen recording permission status on macOS.
   * Returns 'granted', 'denied', 'not-determined', 'restricted', or 'unknown'.
   * On Windows/Linux, always returns 'granted'.
   */
  getPermissionStatus() {
    if (process.platform === 'darwin') {
      return systemPreferences.getMediaAccessStatus('screen');
    }
    return 'granted';
  }

  async capture(windowInfo, mode) {
    try {
      // Check screen recording permission on macOS
      if (process.platform === 'darwin') {
        const status = this.getPermissionStatus();
        if (status !== 'granted') {
          log('CAPTURE', `Screen recording permission not granted (${status})`);
          return null;
        }
      }

      const isWindowMode = mode === 'window' && windowInfo;
      const sourceTypes = isWindowMode ? ['window', 'screen'] : ['screen'];

      const sources = await desktopCapturer.getSources({
        types: sourceTypes,
        thumbnailSize: { width: 1920, height: 1080 },
        fetchWindowIcons: false,
      });

      let source = null;

      if (isWindowMode) {
        // Try to match the specific window by ID (format: "window:XXXX:0")
        if (windowInfo.windowId && windowInfo.windowId > 0) {
          source = sources.find(s => s.id === `window:${windowInfo.windowId}:0`);
        }

        // Fallback: match by window title
        if (!source && windowInfo.title) {
          source = sources.find(s =>
            s.id.startsWith('window:') && s.name === windowInfo.title
          );
        }

        // Fallback: first non-empty window that's not our app
        if (!source) {
          source = sources.find(s =>
            s.id.startsWith('window:') &&
            s.name &&
            !s.name.includes('Topside') &&
            !s.thumbnail.isEmpty()
          );
        }
      }

      // Fallback to screen capture
      if (!source) {
        const cursor = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursor);

        // Match by display_id, requiring a valid (non-empty) thumbnail
        source = sources.find(s =>
          s.id.startsWith('screen:') && s.display_id === String(display.id) && !s.thumbnail.isEmpty()
        );

        // Fallback: any screen source with a valid thumbnail
        if (!source) {
          source = sources.find(s => s.id.startsWith('screen:') && !s.thumbnail.isEmpty());
        }
      }

      if (!source || source.thumbnail.isEmpty()) {
        const totalSources = sources.length;
        const windowSources = sources.filter(s => s.id.startsWith('window:')).length;
        const screenSources = sources.filter(s => s.id.startsWith('screen:')).length;
        const emptyThumbs = sources.filter(s => s.thumbnail.isEmpty()).length;
        log('CAPTURE', `No valid capture source found (total=${totalSources}, windows=${windowSources}, screens=${screenSources}, emptyThumbs=${emptyThumbs}, windowId=${windowInfo?.windowId}, title="${windowInfo?.title?.slice(0, 40)}")`);
        return null;
      }

      // Resize and compress using NativeImage
      const isWindowScoped = source.id.startsWith('window:');
      const resizeWidth = isWindowScoped ? 1280 : 1600;
      const jpegQuality = isWindowScoped ? 80 : 72;

      let img = source.thumbnail;
      const size = img.getSize();
      if (size.width > resizeWidth) {
        img = img.resize({ width: resizeWidth, quality: 'best' });
      }

      const jpegBuffer = img.toJPEG(jpegQuality);
      const base64 = jpegBuffer.toString('base64');

      // Save debug copy
      if (this.debugDir) {
        try {
          const debugPath = path.join(this.debugDir, 'last-screenshot.jpg');
          fs.writeFileSync(debugPath, jpegBuffer);
          log('CAPTURE', `Debug screenshot saved: ${debugPath}`);
        } catch (_) {}
      }

      const modeLabel = isWindowScoped ? 'window' : 'screen';
      log('CAPTURE', `Screenshot captured: ${Math.round(jpegBuffer.length / 1024)}KB (JPEG, ${modeLabel})`);
      return { base64, mediaType: 'image/jpeg' };
    } catch (err) {
      log('CAPTURE', 'Screenshot failed:', err.message);
      return null;
    }
  }
}

let instance = null;

module.exports = {
  CaptureService,
  getInstance: (debugDir) => {
    if (!instance) instance = new CaptureService(debugDir);
    return instance;
  },
};
