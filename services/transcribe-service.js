const { EventEmitter } = require('events');
const { log } = require('./logger');

// Provider registry — lazy-loaded
const PROVIDERS = {
  aws: () => require('./transcribe-providers/aws-transcribe'),
  deepgram: () => require('./transcribe-providers/deepgram'),
  whisper: () => require('./transcribe-providers/whisper-local'),
};

class TranscribeService extends EventEmitter {
  constructor(configService, secretStore) {
    super();
    this.configService = configService;
    this.secretStore = secretStore;
    this.provider = null;
    this.providerType = null;
  }

  getProvider() {
    const type = this.configService.get('transcribe.provider') || 'aws';
    if (this.providerType !== type) {
      // Clean up old provider
      if (this.provider) {
        this.provider.removeAllListeners();
      }

      const meta = PROVIDERS[type]();
      const className = Object.keys(meta).find(k => k.endsWith('Provider') && typeof meta[k] === 'function');
      if (!className) throw new Error(`No provider class found for: ${type}`);

      this.provider = new meta[className](this.configService, this.secretStore);
      this.providerType = type;
    }
    return this.provider;
  }

  wireProviderEvents() {
    if (!this.provider) return;
    this.provider.removeAllListeners('partial');
    this.provider.removeAllListeners('final');
    this.provider.removeAllListeners('error');
    this.provider.on('partial', (text) => this.emit('partial', text));
    this.provider.on('final', (text) => this.emit('final', text));
    this.provider.on('error', (err) => this.emit('error', err));
  }

  async warmup() {
    try {
      await this.getProvider().warmup();
    } catch (err) {
      log('TRANSCRIBE', `Warmup failed: ${err.message}`);
    }
  }

  async start() {
    const provider = this.getProvider();
    this.wireProviderEvents();
    await provider.start();
  }

  async stop() {
    if (this.provider) {
      // Stop FIRST so final inference results propagate through forwarding listeners,
      // THEN remove listeners. Reversing this order silently drops the last transcript.
      await this.provider.stop();
      this.provider.removeAllListeners('partial');
      this.provider.removeAllListeners('final');
      this.provider.removeAllListeners('error');
    }
  }

  sendAudioChunk(pcmData) {
    if (this.provider) {
      this.provider.sendAudioChunk(pcmData);
    }
  }
}

let instance = null;

module.exports = {
  TranscribeService,
  PROVIDERS,
  getInstance: (configService, secretStore) => {
    if (!instance) {
      instance = new TranscribeService(configService, secretStore);
    }
    return instance;
  },
};
