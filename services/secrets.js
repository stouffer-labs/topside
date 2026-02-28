const fs = require('fs');
const path = require('path');
const { safeStorage } = require('electron');
const { log } = require('./logger');

class SecretStore {
  constructor(dataDir) {
    this.filePath = path.join(dataDir, 'secrets.json');
    this.cache = {};
    this.encryptionAvailable = false;
  }

  initialize() {
    this.encryptionAvailable = safeStorage.isEncryptionAvailable();
    if (!this.encryptionAvailable) {
      log('SECRETS', 'WARNING: OS encryption not available — secrets stored in plaintext');
    }

    try {
      if (fs.existsSync(this.filePath)) {
        this.cache = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      }
    } catch (err) {
      log('SECRETS', 'Failed to load secrets file:', err.message);
      this.cache = {};
    }
  }

  get(key) {
    const entry = this.cache[key];
    if (!entry) return null;

    if (entry.encrypted && this.encryptionAvailable) {
      try {
        const buffer = Buffer.from(entry.data, 'base64');
        return safeStorage.decryptString(buffer);
      } catch (err) {
        log('SECRETS', `Failed to decrypt "${key}":`, err.message);
        return null;
      }
    }

    // Plaintext fallback
    return entry.data || null;
  }

  set(key, value) {
    if (!value) {
      return this.delete(key);
    }

    if (this.encryptionAvailable) {
      const encrypted = safeStorage.encryptString(value);
      this.cache[key] = { encrypted: true, data: encrypted.toString('base64') };
    } else {
      this.cache[key] = { encrypted: false, data: value };
    }

    this.save();
  }

  delete(key) {
    delete this.cache[key];
    this.save();
  }

  has(key) {
    return key in this.cache;
  }

  save() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2));
    } catch (err) {
      log('SECRETS', 'Failed to save secrets:', err.message);
    }
  }
}

module.exports = { SecretStore };
