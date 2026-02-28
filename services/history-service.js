const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

class HistoryService {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'history.json');
    this.screenshotsDir = path.join(userDataPath, 'screenshots');
    this._cache = null; // in-memory cache
    this._onSave = null; // callback: (session) => void
    this._onDelete = null; // callback: (id) => void
    this._onClear = null; // callback: () => void
    this._ensureScreenshotsDir();
  }

  _ensureScreenshotsDir() {
    try {
      if (!fs.existsSync(this.screenshotsDir)) {
        fs.mkdirSync(this.screenshotsDir, { recursive: true });
      }
    } catch (err) {
      log('HISTORY', `Failed to create screenshots dir: ${err.message}`);
    }
  }

  _loadFromDisk() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, 'utf8');
        return JSON.parse(data);
      }
    } catch (err) {
      log('HISTORY', `Failed to load history: ${err.message}`);
    }
    return [];
  }

  _writeToDisk(entries) {
    fs.writeFileSync(this.filePath, JSON.stringify(entries, null, 2), 'utf8');
  }

  load() {
    if (!this._cache) {
      this._cache = this._loadFromDisk();
    }
    return this._cache;
  }

  save(session) {
    try {
      // Save screenshot to disk as JPEG if present
      if (session.screenshot) {
        try {
          const imgPath = path.join(this.screenshotsDir, `${session.id}.jpg`);
          const base64Data = session.screenshot.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(imgPath, Buffer.from(base64Data, 'base64'));
          session.hasScreenshot = true;
          log('HISTORY', `Screenshot saved for ${session.id}`);
        } catch (err) {
          log('HISTORY', `Failed to save screenshot: ${err.message}`);
        }
        delete session.screenshot; // strip base64 from JSON
      }

      const entries = this.load();
      entries.push(session);
      this._cache = entries;
      this._writeToDisk(entries);
      log('HISTORY', `Saved session ${session.id} (${entries.length} total)`);

      // Notify embedding system (async, non-blocking)
      if (this._onSave) {
        try { this._onSave(session); } catch (_) {}
      }
    } catch (err) {
      log('HISTORY', `Failed to save session: ${err.message}`);
    }
  }

  delete(id) {
    try {
      const entries = this.load();
      const entry = entries.find(e => e.id === id);
      if (entry?.hasScreenshot) this._deleteScreenshot(id);
      const filtered = entries.filter(e => e.id !== id);
      this._cache = filtered;
      this._writeToDisk(filtered);
      log('HISTORY', `Deleted session ${id} (${filtered.length} remaining)`);

      // Notify embedding system
      if (this._onDelete) {
        try { this._onDelete(id); } catch (_) {}
      }
    } catch (err) {
      log('HISTORY', `Failed to delete session: ${err.message}`);
    }
  }

  clear() {
    try {
      this._cache = [];
      this._writeToDisk([]);
      // Remove entire screenshots directory and recreate
      if (fs.existsSync(this.screenshotsDir)) {
        fs.rmSync(this.screenshotsDir, { recursive: true, force: true });
      }
      this._ensureScreenshotsDir();
      log('HISTORY', 'History and screenshots cleared');

      // Notify embedding system
      if (this._onClear) {
        try { this._onClear(); } catch (_) {}
      }
    } catch (err) {
      log('HISTORY', `Failed to clear history: ${err.message}`);
    }
  }

  getAll() {
    return this.load().slice().reverse(); // newest first
  }

  getScreenshotPath(id) {
    return path.join(this.screenshotsDir, `${id}.jpg`);
  }

  _deleteScreenshot(id) {
    try {
      const imgPath = this.getScreenshotPath(id);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    } catch (err) {
      log('HISTORY', `Failed to delete screenshot ${id}: ${err.message}`);
    }
  }

  // Compose the text used for embedding a history entry
  static composeSearchText(entry) {
    const parts = [];
    if (entry.transcript) parts.push(entry.transcript);
    if (entry.aiText) parts.push(entry.aiText);
    return parts.join('\n\n');
  }
}

module.exports = { HistoryService };
