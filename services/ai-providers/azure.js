const https = require('https');
const { log } = require('../logger');

const id = 'azure';
const label = 'Azure OpenAI';

const models = []; // User configures deployment name, not model picker

const fastModel = null; // Determined by deployment

const configFields = [
  { key: 'endpoint', label: 'Endpoint', type: 'text', placeholder: 'https://myresource.openai.azure.com' },
  { key: 'apiKey', label: 'API Key', type: 'secret' },
  { key: 'deployment', label: 'Deployment Name', type: 'text', placeholder: 'gpt-4o' },
];

// Convert to OpenAI chat format (same as OpenRouter)
function buildOpenAIMessages(transcript, context) {
  const { screenshot, windowInfo, systemPrompt, previousOutput } = context;

  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }

  const winTitle = windowInfo?.title || 'unknown';
  const winOwner = windowInfo?.owner || 'unknown app';
  let userText = `App: ${winOwner} — "${winTitle}"\n\nTranscript:\n${transcript}`;
  if (previousOutput) {
    userText += `\n\nPrevious output: ${previousOutput}`;
  }

  if (screenshot) {
    const imgUrl = `data:${screenshot.source.media_type};base64,${screenshot.source.data}`;
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imgUrl } },
        { type: 'text', text: userText },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  return messages;
}

class AzureProvider {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
  }

  async initialize() {
    const key = this.secretStore.get('azure.apiKey');
    const cfg = this.configService.get('ai.azure') || {};
    if (!key) log('AI', 'Azure: no API key configured');
    if (!cfg.endpoint) log('AI', 'Azure: no endpoint configured');
  }

  invalidateClient() {}

  async refine(transcript, context, options = {}) {
    const apiKey = this.secretStore.get('azure.apiKey');
    if (!apiKey) throw new Error('Azure API key not configured');

    const cfg = this.configService.get('ai.azure') || {};
    const endpoint = cfg.endpoint;
    if (!endpoint) throw new Error('Azure endpoint not configured');

    const deployment = cfg.deployment;
    if (!deployment) throw new Error('Azure deployment name not configured');

    const { onChunk } = options;
    const messages = buildOpenAIMessages(transcript, context);

    const body = JSON.stringify({
      max_tokens: 1024,
      stream: true,
      messages,
    });

    // Parse endpoint URL
    const url = new URL(endpoint);
    const urlPath = `/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`Azure API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
          return;
        }

        let refinedText = '';
        let buffer = '';

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
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                refinedText += delta;
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
    const apiKey = this.secretStore.get('azure.apiKey');
    if (!apiKey) throw new Error('Azure API key not configured');

    const cfg = this.configService.get('ai.azure') || {};
    const endpoint = cfg.endpoint;
    if (!endpoint) throw new Error('Azure endpoint not configured');
    const deployment = cfg.deployment;
    if (!deployment) throw new Error('Azure deployment name not configured');

    const { systemPrompt, onChunk } = options;

    // Convert multi-turn messages to OpenAI chat format
    const apiMessages = [];
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        const parts = msg.content.map(part => {
          if (part.type === 'image' && part.source) {
            const imgUrl = `data:${part.source.media_type};base64,${part.source.data}`;
            return { type: 'image_url', image_url: { url: imgUrl } };
          }
          return part;
        });
        apiMessages.push({ role: 'user', content: parts });
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const body = JSON.stringify({
      max_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
      messages: apiMessages,
    });

    const url = new URL(endpoint);
    const urlPath = `/openai/deployments/${deployment}/chat/completions?api-version=2024-10-21`;

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: url.hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': apiKey,
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`Azure API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
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
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                text += delta;
                if (onChunk) onChunk(text);
              }
              if (parsed.usage) {
                usage.inputTokens = parsed.usage.prompt_tokens;
                usage.outputTokens = parsed.usage.completion_tokens;
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

async function validate(apiKey, config) {
  const endpoint = config?.endpoint;
  if (!endpoint || !apiKey) return false;
  const url = new URL(endpoint);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: url.hostname,
      path: '/openai/models?api-version=2024-02-01',
      method: 'GET',
      headers: { 'api-key': apiKey },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = { id, label, models, fastModel, configFields, AzureProvider, validate };
