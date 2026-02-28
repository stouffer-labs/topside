const fs = require('fs');
const path = require('path');
const { log } = require('./logger');

class EmbeddingStore {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'embeddings.json');
    this._data = null;
  }

  load() {
    if (this._data) return this._data;
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        this._data = JSON.parse(raw);
        if (this._data.version !== 1) {
          log('EMBEDDING-STORE', 'Unknown version, resetting');
          this._data = null;
        }
      }
    } catch (err) {
      log('EMBEDDING-STORE', `Failed to load (resetting): ${err.message}`);
      this._data = null;
    }
    if (!this._data) {
      this._data = {
        version: 1,
        model: 'all-MiniLM-L6-v2',
        dimensions: 384,
        entries: {},
      };
    }
    return this._data;
  }

  save() {
    try {
      const data = this.load();
      fs.writeFileSync(this.filePath, JSON.stringify(data), 'utf8');
    } catch (err) {
      log('EMBEDDING-STORE', `Failed to save: ${err.message}`);
    }
  }

  get(id) {
    const data = this.load();
    const encoded = data.entries[id];
    if (!encoded) return null;
    const buf = Buffer.from(encoded, 'base64');
    return new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  }

  set(id, vector) {
    const data = this.load();
    data.entries[id] = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64');
    this.save();
  }

  delete(id) {
    const data = this.load();
    if (data.entries[id]) {
      delete data.entries[id];
      this.save();
    }
  }

  clear() {
    const wasDownloaded = this._data?.modelDownloaded;
    this._data = {
      version: 1,
      model: 'all-MiniLM-L6-v2',
      dimensions: 384,
      entries: {},
    };
    if (wasDownloaded) this._data.modelDownloaded = true;
    this.save();
  }

  getAllVectors() {
    const data = this.load();
    const map = new Map();
    for (const [id, encoded] of Object.entries(data.entries)) {
      const buf = Buffer.from(encoded, 'base64');
      map.set(id, new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    }
    return map;
  }

  has(id) {
    const data = this.load();
    return id in data.entries;
  }

  count() {
    const data = this.load();
    return Object.keys(data.entries).length;
  }

  isModelDownloaded() {
    const data = this.load();
    return !!data.modelDownloaded;
  }

  setModelDownloaded(value) {
    const data = this.load();
    data.modelDownloaded = !!value;
    this.save();
  }
}

module.exports = { EmbeddingStore };
