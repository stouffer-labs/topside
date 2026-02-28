const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { log } = require('../logger');

const id = 'deepgram';
const label = 'Deepgram';

const configFields = [
  { key: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'dg-...' },
  { key: 'model', label: 'Model', type: 'select',
    options: [
      { value: 'nova-3', label: 'Nova 3 (Latest)' },
      { value: 'nova-2', label: 'Nova 2' },
    ] },
];

class DeepgramProvider extends EventEmitter {
  constructor(configService, secretStore) {
    super();
    this.configService = configService;
    this.secretStore = secretStore;
    this.ws = null;
    this.running = false;
    this.connecting = false;
    this.pendingChunks = [];
  }

  async warmup() {
    const key = this.secretStore.get('deepgram.apiKey');
    if (!key) log('TRANSCRIBE', 'Deepgram: no API key configured');
  }

  async start() {
    if (this.running) return;

    const apiKey = this.secretStore.get('deepgram.apiKey');
    if (!apiKey) throw new Error('Deepgram API key not configured');

    this.connecting = true;
    this.pendingChunks = [];

    const dgCfg = this.configService.get('transcribe.deepgram') || {};
    const model = dgCfg.model || 'nova-3';
    const language = this.configService.get('transcribe.language') || 'en-US';
    // Deepgram uses language codes like 'en' not 'en-US'
    const lang = language.split('-')[0];

    const wsUrl = `wss://api.deepgram.com/v1/listen?model=${model}&language=${lang}&interim_results=true&encoding=linear16&sample_rate=16000&channels=1&punctuate=true`;

    log('TRANSCRIBE', `Deepgram connecting (model: ${model})...`);

    this.ws = new WebSocket(wsUrl, {
      headers: { 'Authorization': `Token ${apiKey}` },
    });

    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Connection timeout')), 10000);

        this.ws.once('open', () => {
          clearTimeout(timeout);
          resolve();
        });

        this.ws.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      this.running = true;
      this.connecting = false;
      log('TRANSCRIBE', 'Deepgram WebSocket connected');

      // Flush buffered chunks
      if (this.pendingChunks.length > 0) {
        log('TRANSCRIBE', `Flushing ${this.pendingChunks.length} buffered chunks`);
        for (const chunk of this.pendingChunks) {
          this.ws.send(chunk);
        }
        this.pendingChunks = [];
      }

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleResponse(msg);
        } catch (err) {
          log('TRANSCRIBE', 'Deepgram message parse error:', err.message);
        }
      });

      this.ws.on('error', (err) => {
        log('TRANSCRIBE', 'Deepgram WebSocket error:', err.message);
        this.emit('error', err);
      });

      this.ws.on('close', (code) => {
        log('TRANSCRIBE', `Deepgram WebSocket closed: ${code}`);
        const wasRunning = this.running;
        this.running = false;
        // 1008 = policy violation (bad key), 1011 = server error
        if (wasRunning && code !== 1000) {
          const reason = code === 1008 ? 'Invalid API key' : `Connection closed (code ${code})`;
          this.emit('error', new Error(reason));
        }
      });
    } catch (err) {
      log('TRANSCRIBE', 'Deepgram failed to start:', err.message);
      this.running = false;
      this.connecting = false;
      this.pendingChunks = [];
      throw err;
    }
  }

  async stop() {
    if (!this.running || !this.ws) return;

    this.running = false;
    this.pendingChunks = [];
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        // Send close message per Deepgram protocol
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
        this.ws.close();
      }
    } catch (err) {
      log('TRANSCRIBE', 'Error closing Deepgram WebSocket:', err.message);
    }
    this.ws = null;
    log('TRANSCRIBE', 'Deepgram stopped');
  }

  sendAudioChunk(pcmData) {
    const audioBuffer = Buffer.from(pcmData);

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      if (this.connecting || this.running) {
        this.pendingChunks.push(audioBuffer);
      }
      return;
    }

    try {
      // Deepgram accepts raw PCM bytes directly — no event-stream encoding needed
      this.ws.send(audioBuffer);
    } catch (err) {
      log('TRANSCRIBE', 'Deepgram send error:', err.message);
    }
  }

  handleResponse(msg) {
    if (msg.type !== 'Results') return;

    const transcript = msg.channel?.alternatives?.[0]?.transcript;
    if (!transcript || transcript.trim().length === 0) return;

    if (msg.is_final) {
      this.emit('final', transcript);
    } else {
      this.emit('partial', transcript);
    }
  }
}

async function validate(apiKey) {
  const https = require('https');
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.deepgram.com',
      path: '/v1/projects',
      method: 'GET',
      headers: { 'Authorization': `Token ${apiKey}` },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = { id, label, configFields, DeepgramProvider, validate };
