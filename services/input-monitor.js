const { EventEmitter } = require('events');
const { globalShortcut } = require('electron');
const { log } = require('./logger');

class InputMonitor extends EventEmitter {
  constructor(configService) {
    super();
    this.configService = configService;
    this.sessionActive = false;
    this.started = false;
    this.registeredAccelerator = null;
    this.escapeRegistered = false;
    this.hotkeyFailed = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.registerHotkey();
    log('INPUT', 'Input monitor started (globalShortcut, toggle mode)');
  }

  stop() {
    this.unregisterAll();
    this.started = false;
    log('INPUT', 'Input monitor stopped');
  }

  updateHotkey() {
    if (!this.started) return;
    this.unregisterAll();
    this.registerHotkey();
  }

  setSessionActive(active) {
    this.sessionActive = active;
    if (active) {
      this.registerEscape();
    } else {
      this.unregisterEscape();
    }
  }

  getHotkey() {
    return this.configService.get('hotkey') || { accelerator: null, label: null };
  }

  /**
   * Returns true if the hotkey registration failed (likely due to missing
   * Accessibility permission on macOS). UI can use this to show guidance.
   */
  isHotkeyFailed() {
    return this.hotkeyFailed;
  }

  registerHotkey() {
    const hotkey = this.getHotkey();
    const accelerator = hotkey.accelerator;
    if (!accelerator) {
      log('INPUT', 'No accelerator configured');
      return;
    }

    try {
      const registered = globalShortcut.register(accelerator, () => {
        log('INPUT', `Trigger toggle (${accelerator})`);
        this.emit('trigger-down');
      });

      if (registered) {
        this.registeredAccelerator = accelerator;
        this.hotkeyFailed = false;
        log('INPUT', `Hotkey registered: "${accelerator}"`);
      } else {
        this.hotkeyFailed = true;
        log('INPUT', `Failed to register hotkey "${accelerator}" — Accessibility permission may be required`);
        this.emit('hotkey-failed', accelerator);
      }
    } catch (err) {
      this.hotkeyFailed = true;
      log('INPUT', `Error registering hotkey: ${err.message}`);
      this.emit('hotkey-failed', accelerator);
    }
  }

  registerEscape() {
    if (this.escapeRegistered) return;
    // Don't register Escape if it's the hotkey itself
    const hotkey = this.getHotkey();
    if (hotkey.accelerator === 'Escape') return;

    try {
      const registered = globalShortcut.register('Escape', () => {
        if (this.sessionActive) {
          log('INPUT', 'Cancel: Escape pressed during active session');
          this.emit('cancel');
        }
      });
      if (registered) {
        this.escapeRegistered = true;
        log('INPUT', 'Escape shortcut registered for session cancel');
      }
    } catch (err) {
      log('INPUT', `Error registering Escape shortcut: ${err.message}`);
    }
  }

  unregisterEscape() {
    if (!this.escapeRegistered) return;
    try {
      globalShortcut.unregister('Escape');
    } catch (_) {}
    this.escapeRegistered = false;
  }

  unregisterAll() {
    if (this.registeredAccelerator) {
      try {
        globalShortcut.unregister(this.registeredAccelerator);
      } catch (_) {}
      this.registeredAccelerator = null;
    }
    this.unregisterEscape();
  }
}

let instance = null;

module.exports = {
  InputMonitor,
  getInstance: (configService) => {
    if (!instance) {
      instance = new InputMonitor(configService);
    }
    return instance;
  },
};
