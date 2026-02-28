const path = require('path');
const fs = require('fs');
const { log } = require('./logger');

const DIMENSIONS = 384;
const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const MLX_MODEL_ID = 'sentence-transformers/all-MiniLM-L6-v2';
const HF_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';

class EmbeddingService {
  constructor(userDataPath, embeddingStore) {
    this.userDataPath = userDataPath;
    this._store = embeddingStore; // for persistent model-downloaded flag
    this._backend = null; // lazily chosen
    this._idleTimer = null;
  }

  _getBackend() {
    if (this._backend) return this._backend;

    if (process.platform === 'darwin') {
      try {
        const { loadAddon } = require('mlx-inference-addon');
        const addon = loadAddon();
        if (addon && typeof addon.embed === 'function') {
          this._backend = new MLXBackend(addon, this.userDataPath);
          log('EMBEDDING', 'Using MLX backend');
          return this._backend;
        }
      } catch (_) {}
    }

    // Fallback: @huggingface/transformers (WASM, works everywhere)
    this._backend = new TransformersBackend(this.userDataPath);
    log('EMBEDDING', 'Using Transformers.js backend');
    return this._backend;
  }

  isModelDownloaded() {
    // Check persistent flag first (survives app restart)
    if (this._store && this._store.isModelDownloaded()) return true;
    // Fall back to backend in-memory check
    return this._getBackend().isModelDownloaded();
  }

  isModelLoaded() {
    if (!this._backend) return false;
    if (this._backend instanceof MLXBackend) return this._backend._loaded;
    if (this._backend instanceof TransformersBackend) return !!this._backend._pipeline;
    return false;
  }

  async downloadModel(onProgress) {
    await this._getBackend().downloadModel(onProgress);
    // Persist the flag so we remember across app restarts
    if (this._store) this._store.setModelDownloaded(true);
  }

  async loadModel() {
    await this._getBackend().loadModel();
    this._resetIdleTimer();
  }

  unloadModel() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
    this._getBackend().unloadModel();
    log('EMBEDDING', 'Model unloaded (idle timeout)');
  }

  _resetIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.unloadModel(), IDLE_TIMEOUT_MS);
  }

  async embed(text) {
    await this.loadModel();
    const vector = await this._getBackend().embed(text);
    this._resetIdleTimer();

    // Diagnostic: check vector quality
    if (vector && vector.length > 0) {
      const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
      log('EMBEDDING', `embed(${text.length} chars) → ${vector.length}-dim, norm=${norm.toFixed(4)}, sample=[${vector[0].toFixed(4)}, ${vector[1].toFixed(4)}, ${vector[2].toFixed(4)}]`);
    }

    return vector;
  }

  async search(query, entries, embeddingStore) {
    const queryVector = await this.embed(query);
    const storedVectors = embeddingStore.getAllVectors();

    // Score all entries that have embeddings
    const scored = [];
    for (const entry of entries) {
      const entryVector = storedVectors.get(entry.id);
      if (!entryVector) continue;
      const score = cosineSimilarity(queryVector, entryVector);
      scored.push({ ...entry, similarity: score });
    }

    scored.sort((a, b) => b.similarity - a.similarity);

    if (scored.length === 0) return null;

    const scores = scored.map(s => s.similarity);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const spread = max - min;
    log('EMBEDDING', `Search "${query}": ${scored.length} entries, scores min=${min.toFixed(3)} avg=${avg.toFixed(3)} max=${max.toFixed(3)} spread=${spread.toFixed(3)}`);

    // Degenerate embeddings check: the model can't discriminate if either:
    // 1. All scores are tightly clustered (spread < 0.15), or
    // 2. Even the worst match scores very high (min > 0.6) — means everything
    //    looks "similar" and the vectors are near-identical.
    // In both cases, fall back to keyword search which actually works.
    if (scored.length >= 3 && (spread < 0.15 || min > 0.6)) {
      log('EMBEDDING', `Low discrimination (spread=${spread.toFixed(3)}, min=${min.toFixed(3)}), falling back to keyword search`);
      return null;
    }

    // Absolute minimum — below this, nothing is relevant
    if (max < 0.45) return [];

    // Use a relative threshold: must be within 85% of top score and above 0.45
    const threshold = Math.max(0.45, max * 0.85);
    const results = scored.filter(s => s.similarity >= threshold);

    // Cap at 20 results
    return results.slice(0, 20);
  }
}

// ─── Cosine Similarity ──────────────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  return dot / denom;
}

// ─── MLX Backend (macOS Apple Silicon) ──────────────────────────────────────

class MLXBackend {
  constructor(addon, userDataPath) {
    this._addon = addon;
    this._loaded = false;
    this._loading = null;
  }

  isModelDownloaded() {
    const status = this._addon.embeddingStatus();
    return status.loaded;
  }

  async downloadModel(onProgress) {
    if (onProgress) onProgress({ percent: 0 });
    await this._addon.loadEmbeddingModel(MLX_MODEL_ID, (progress) => {
      if (onProgress) {
        onProgress({
          percent: Math.round(progress.percent || 0),
          file: progress.message || '',
        });
      }
    });
    this._loaded = true;
    if (onProgress) onProgress({ percent: 100 });
    log('EMBEDDING', 'MLX embedding model downloaded and loaded');
  }

  async loadModel() {
    if (this._loaded) return;
    if (this._loading) { await this._loading; return; }
    this._loading = this._addon.loadEmbeddingModel(MLX_MODEL_ID, () => {});
    try {
      await this._loading;
      this._loaded = true;
      log('EMBEDDING', 'MLX embedding model loaded');
    } finally {
      this._loading = null;
    }
  }

  unloadModel() {
    this._addon.unloadEmbeddingModel();
    this._loaded = false;
  }

  async embed(text) {
    const result = await this._addon.embed(text);
    // addon returns Float32Array directly from N-API
    return result instanceof Float32Array ? result : new Float32Array(result);
  }
}

// ─── Transformers.js Backend (Windows / fallback) ───────────────────────────

class TransformersBackend {
  constructor(userDataPath) {
    this.cacheDir = path.join(userDataPath, 'models', 'embedding');
    this._pipeline = null;
    this._loading = null;
  }

  isModelDownloaded() {
    try {
      if (!fs.existsSync(this.cacheDir)) return false;
      const files = fs.readdirSync(this.cacheDir, { recursive: true });
      return files.some(f => String(f).endsWith('.onnx'));
    } catch (_) {
      return false;
    }
  }

  async downloadModel(onProgress) {
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
    if (onProgress) onProgress({ percent: 0 });
    await this._createPipeline((progress) => {
      if (onProgress && progress.status === 'progress') {
        onProgress({
          percent: Math.round(progress.progress || 0),
          file: progress.file || '',
        });
      }
    });
    if (onProgress) onProgress({ percent: 100 });
    log('EMBEDDING', 'Transformers.js model downloaded and loaded');
  }

  async loadModel() {
    if (this._pipeline) return;
    if (this._loading) { await this._loading; return; }
    this._loading = this._createPipeline();
    try {
      await this._loading;
    } finally {
      this._loading = null;
    }
  }

  async _createPipeline(progressCallback) {
    const { pipeline, env } = await import('@huggingface/transformers');
    env.cacheDir = this.cacheDir;
    env.backends.onnx.wasm.numThreads = 1;

    this._pipeline = await pipeline('feature-extraction', HF_MODEL_ID, {
      progress_callback: progressCallback || undefined,
      dtype: 'fp32',
    });
    log('EMBEDDING', 'Transformers.js pipeline loaded');
  }

  unloadModel() {
    if (this._pipeline) {
      this._pipeline.dispose?.();
      this._pipeline = null;
    }
  }

  async embed(text) {
    const output = await this._pipeline(text, { pooling: 'mean', normalize: true });
    const embedding = output.tolist()[0];
    return new Float32Array(embedding);
  }
}

module.exports = { EmbeddingService };
