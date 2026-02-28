const https = require('https');
const { log } = require('../logger');

const id = 'anthropic';
const label = 'Anthropic';

const models = [
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Fast)' },
  { value: 'claude-sonnet-4-5-20250929', label: 'Claude Sonnet 4.5' },
  { value: 'claude-opus-4-5-20251101', label: 'Claude Opus 4.5' },
];

const fastModel = 'claude-haiku-4-5-20251001';

const configFields = [
  { key: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-ant-...' },
];

class AnthropicProvider {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
  }

  async initialize() {
    const key = this.secretStore.get('anthropic.apiKey');
    if (!key) log('AI', 'Anthropic: no API key configured');
  }

  invalidateClient() {}

  async refine(transcript, context, options = {}) {
    const apiKey = this.secretStore.get('anthropic.apiKey');
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const { screenshot, windowInfo, systemPrompt, previousOutput } = context;
    const { onChunk, model } = options;

    const contentParts = [];
    if (screenshot) {
      contentParts.push(screenshot);
    }

    const winTitle = windowInfo?.title || 'unknown';
    const winOwner = windowInfo?.owner || 'unknown app';
    let userText = `App: ${winOwner} — "${winTitle}"\n\nTranscript:\n${transcript}`;
    if (previousOutput) {
      userText += `\n\nPrevious output: ${previousOutput}`;
    }
    contentParts.push({ type: 'text', text: userText });

    const body = JSON.stringify({
      model: model || fastModel,
      max_tokens: 1024,
      system: systemPrompt,
      stream: true,
      messages: [{ role: 'user', content: contentParts }],
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`Anthropic API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
          return;
        }

        let refinedText = '';
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop(); // Keep incomplete line

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                refinedText += parsed.delta.text;
                if (onChunk) onChunk(refinedText);
              }
            } catch (_) {}
          }
        });

        res.on('end', () => resolve(refinedText));
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  async converse(messages, options = {}) {
    const apiKey = this.secretStore.get('anthropic.apiKey');
    if (!apiKey) throw new Error('Anthropic API key not configured');

    const { systemPrompt, onChunk, model } = options;

    const body = JSON.stringify({
      model: model || fastModel,
      max_tokens: 2048,
      system: systemPrompt,
      stream: true,
      messages,
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`Anthropic API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
          return;
        }

        let text = '';
        let buffer = '';
        const usage = {};

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop();

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;

            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
                text += parsed.delta.text;
                if (onChunk) onChunk(text);
              }
              if (parsed.type === 'message_start' && parsed.message?.usage) {
                usage.inputTokens = parsed.message.usage.input_tokens;
              }
              if (parsed.type === 'message_delta' && parsed.usage) {
                usage.outputTokens = parsed.usage.output_tokens;
              }
            } catch (_) {}
          }
        });

        res.on('end', () => {
          this.lastUsage = usage.inputTokens != null ? usage : null;
          resolve(text);
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

async function validate(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/models',
      method: 'GET',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = { id, label, models, fastModel, configFields, AnthropicProvider, validate };
