const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { log } = require('../logger');

const id = 'whisper';
const label = 'Local Whisper';

const configFields = [
  { key: 'model', label: 'Model', type: 'whisper-model-select',
    options: [
      { value: 'ggml-tiny.en.bin', label: 'Tiny (75MB, fastest)' },
      { value: 'ggml-base.en.bin', label: 'Base (142MB, balanced)' },
      { value: 'ggml-small.en.bin', label: 'Small (466MB, accurate)' },
      { value: 'ggml-medium.en.bin', label: 'Medium (1.5GB, high accuracy)' },
      { value: 'ggml-large-v3.bin', label: 'Large V3 (3GB, best accuracy)' },
      { value: 'ggml-large-v3-turbo.bin', label: 'Large V3 Turbo (1.6GB, fast + accurate)' },
    ] },
];

const INFERENCE_INTERVAL_MS = 1500;
const SAMPLE_RATE = 16000;
const MIN_DURATION_SEC = 1.5;

// Energy gate: skip silence so Whisper never hallucinates on quiet audio.
// Threshold is ~-46dB (Float32 RMS), well above typical mic noise (~-70dB).
const SILENCE_RMS_THRESHOLD = 0.005;
// After speech ends, keep accumulating for 500ms of trailing silence
// so Whisper has context to properly close the segment.
const SPEECH_TAIL_CHUNKS = 10; // 10 × 50ms = 500ms

const HALLUCINATION_PATTERNS = [
  /^\s*\.+\s*$/,                              // Just dots/periods
  /^(you|the|a|I|we|he|she|it)\.?$/i,        // Single pronoun
  /thank(s| you)( for (watching|listening))?/i,
  /please (like|subscribe)/i,
  /\[(music|applause)\]/i,
];

class WhisperLocalProvider extends EventEmitter {
  constructor(configService, secretStore) {
    super();
    this.configService = configService;
    this.secretStore = secretStore;
    this.whisperAddon = null;
    this.running = false;
    this.pendingAudio = [];       // New audio not yet transcribed
    this.pendingSamples = 0;
    this.lastSegmentText = '';    // For initial_prompt context priming
    this.processing = false;
    this.inferenceTimer = null;
    this.modelPath = null;
    this.speechCountdown = 0;    // Trailing silence countdown after speech
    this.hasSpeechContent = false; // Whether current buffer has any speech
  }

  getModelsDir() {
    return path.join(app.getPath('userData'), 'models');
  }

  getModelPath() {
    const cfg = this.configService.get('transcribe.whisper') || {};
    const modelFile = cfg.model || 'ggml-base.en.bin';
    return path.join(this.getModelsDir(), modelFile);
  }

  isModelDownloaded(modelFile) {
    const p = path.join(this.getModelsDir(), modelFile || '');
    return fs.existsSync(p);
  }

  listDownloadedModels() {
    const dir = this.getModelsDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(f => f.startsWith('ggml-') && f.endsWith('.bin'));
  }

  loadAddon() {
    if (this.whisperAddon) return true;
    try {
      const addon = require('@kutalia/whisper-node-addon');
      if (typeof addon.transcribe !== 'function') {
        throw new Error('Module loaded but transcribe() not found — is @kutalia/whisper-node-addon installed?');
      }
      this.whisperAddon = addon;
      log('TRANSCRIBE', 'Whisper addon loaded');
      return true;
    } catch (err) {
      log('TRANSCRIBE', 'Whisper addon not available:', err.message);
      return false;
    }
  }

  async warmup() {
    if (!this.loadAddon()) return;

    this.modelPath = this.getModelPath();
    if (!fs.existsSync(this.modelPath)) {
      log('TRANSCRIBE', `Whisper model not found: ${this.modelPath}`);
      return;
    }

    // Preload model into GPU memory with silent audio
    log('TRANSCRIBE', `Preloading Whisper model: ${path.basename(this.modelPath)}`);
    const cfg = this.configService.get('transcribe.whisper') || {};
    const silentBuffer = new Float32Array(1600); // 0.1s at 16kHz
    try {
      await this.whisperAddon.transcribe({
        pcmf32: silentBuffer,
        model: this.modelPath,
        language: 'en',
        use_gpu: cfg.useGpu !== false,
        n_threads: 1,
        translate: false,
        no_timestamps: true,
        no_prints: true,
      });
      log('TRANSCRIBE', 'Whisper model preloaded');
    } catch (err) {
      log('TRANSCRIBE', 'Whisper preload failed (non-fatal):', err.message);
    }
  }

  async start() {
    if (this.running) return;

    if (!this.loadAddon()) {
      throw new Error('Whisper addon not available — run npm install');
    }

    this.modelPath = this.getModelPath();
    if (!fs.existsSync(this.modelPath)) {
      throw new Error(`Whisper model not found: ${path.basename(this.modelPath)}. Download it in Settings.`);
    }

    this.running = true;
    this.pendingAudio = [];
    this.pendingSamples = 0;
    this.lastSegmentText = '';
    this.processing = false;
    this.speechCountdown = 0;
    this.hasSpeechContent = false;

    // Periodically transcribe new audio chunks
    this.inferenceTimer = setInterval(() => this.runInference(), INFERENCE_INTERVAL_MS);

    log('TRANSCRIBE', 'Whisper local started');
  }

  async stop() {
    if (!this.running) return;

    this.running = false;
    if (this.inferenceTimer) {
      clearInterval(this.inferenceTimer);
      this.inferenceTimer = null;
    }

    // Wait for any in-progress inference to finish before running final pass
    const waitStart = Date.now();
    while (this.processing && Date.now() - waitStart < 5000) {
      await new Promise(r => setTimeout(r, 50));
    }

    // Run final inference on remaining audio (if any)
    if (this.pendingAudio.length > 0 && !this.processing) {
      await this.runInference(true);
    }

    this.pendingAudio = [];
    this.pendingSamples = 0;
    log('TRANSCRIBE', 'Whisper local stopped');
  }

  sendAudioChunk(pcmData) {
    if (!this.running) return;

    // Convert Int16 PCM to Float32 (Whisper expects Float32)
    const int16 = new Int16Array(pcmData instanceof ArrayBuffer ? pcmData : pcmData.buffer.slice(pcmData.byteOffset, pcmData.byteOffset + pcmData.byteLength));
    const float32 = new Float32Array(int16.length);
    let sumSq = 0;
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768.0;
      sumSq += float32[i] * float32[i];
    }

    // Energy gate: only accumulate chunks with speech energy.
    // Silence chunks are skipped so Whisper never processes dead air.
    const rms = Math.sqrt(sumSq / float32.length);
    if (rms >= SILENCE_RMS_THRESHOLD) {
      // Speech detected — accumulate and reset tail countdown
      this.speechCountdown = SPEECH_TAIL_CHUNKS;
      this.hasSpeechContent = true;
    } else if (this.speechCountdown > 0) {
      // Trailing silence after speech — include for context
      this.speechCountdown--;
    } else {
      // Pure silence — skip entirely
      return;
    }

    this.pendingAudio.push(float32);
    this.pendingSamples += float32.length;
  }

  isHallucination(text) {
    if (!text || text.trim().length <= 1) return true;
    return HALLUCINATION_PATTERNS.some(p => p.test(text.trim()));
  }

  async runInference(isFinal = false) {
    if (this.processing || this.pendingAudio.length === 0) return;

    // Skip inference if buffer has no speech (energy gate leakthrough)
    if (!isFinal && !this.hasSpeechContent) {
      this.pendingAudio = [];
      this.pendingSamples = 0;
      return;
    }

    const durationSec = this.pendingSamples / SAMPLE_RATE;

    // Don't transcribe chunks shorter than minimum duration (unless final)
    if (!isFinal && durationSec < MIN_DURATION_SEC) return;

    this.processing = true;

    try {
      // Merge pending audio into single Float32Array
      const combined = new Float32Array(this.pendingSamples);
      let offset = 0;
      for (const chunk of this.pendingAudio) {
        combined.set(chunk, offset);
        offset += chunk.length;
      }

      const cfg = this.configService.get('transcribe.whisper') || {};

      const transcribeOptions = {
        pcmf32: combined,
        model: this.modelPath,
        language: 'en',
        use_gpu: cfg.useGpu !== false,
        n_threads: cfg.threads || 4,
        translate: false,
        no_timestamps: true,
        no_prints: true,
      };

      // Context priming: base vocabulary prompt + last segment text biases
      // the decoder toward likely voice-assistant phrases and technical terms.
      const BASE_PROMPT = 'What is going on in this window? Explain this error. Reply to this message. What does this code do? Summarize this. Draft a response.';
      transcribeOptions.initial_prompt = this.lastSegmentText
        ? this.lastSegmentText + ' ' + BASE_PROMPT
        : BASE_PROMPT;

      const result = await this.whisperAddon.transcribe(transcribeOptions);

      // Addon returns { transcription: [["startTime", "endTime", " text"], ...] }
      const segments = result?.transcription || [];
      const text = segments.map(seg => (seg[2] || '')).join('').trim();

      if (text && !this.isHallucination(text)) {
        this.lastSegmentText = text;
        this.emit('final', text);
        log('TRANSCRIBE', `Whisper chunk (${durationSec.toFixed(1)}s): "${text}"`);
      } else if (text) {
        log('TRANSCRIBE', `Filtered hallucination: "${text}"`);
      }

      // Clear pending audio and reset speech flag for next accumulation cycle
      this.pendingAudio = [];
      this.pendingSamples = 0;
      this.hasSpeechContent = false;
    } catch (err) {
      log('TRANSCRIBE', 'Whisper inference error:', err.message);
    } finally {
      this.processing = false;
    }
  }
}

module.exports = { id, label, configFields, WhisperLocalProvider };
