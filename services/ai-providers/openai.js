const https = require('https');
const { log } = require('../logger');

const id = 'openai';
const label = 'OpenAI';

const models = [
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4.1', label: 'GPT-4.1' },
  { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini' },
  { value: 'o3-mini', label: 'o3-mini (Reasoning)' },
];

const fastModel = 'gpt-4o-mini';

const configFields = [
  { key: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-...' },
];

function buildMessages(transcript, context) {
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

function streamRequest(apiKey, body, onChunk, usageOut) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
    }, (res) => {
      if (res.statusCode !== 200) {
        let errBody = '';
        res.on('data', (d) => errBody += d);
        res.on('end', () => reject(new Error(`OpenAI API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
        return;
      }

      let text = '';
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
              text += delta;
              if (onChunk) onChunk(text);
            }
            if (usageOut && parsed.usage) {
              usageOut.inputTokens = parsed.usage.prompt_tokens;
              usageOut.outputTokens = parsed.usage.completion_tokens;
            }
          } catch (_) {}
        }
      });

      res.on('end', () => resolve(text));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

class OpenAIProvider {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
  }

  async initialize() {
    const key = this.secretStore.get('openai.apiKey');
    if (!key) log('AI', 'OpenAI: no API key configured');
  }

  invalidateClient() {}

  async refine(transcript, context, options = {}) {
    const apiKey = this.secretStore.get('openai.apiKey');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const { onChunk, model } = options;
    const messages = buildMessages(transcript, context);

    const body = JSON.stringify({
      model: model || fastModel,
      max_tokens: 1024,
      stream: true,
      messages,
    });

    return streamRequest(apiKey, body, onChunk);
  }

  async converse(messages, options = {}) {
    const apiKey = this.secretStore.get('openai.apiKey');
    if (!apiKey) throw new Error('OpenAI API key not configured');

    const { systemPrompt, onChunk, model } = options;

    const apiMessages = [];
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });
    for (const msg of messages) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const parts = msg.content.map(part => {
            if (part.type === 'image' && part.source) {
              const imgUrl = `data:${part.source.media_type};base64,${part.source.data}`;
              return { type: 'image_url', image_url: { url: imgUrl } };
            }
            return part;
          });
          apiMessages.push({ role: 'user', content: parts });
        } else {
          apiMessages.push({ role: 'user', content: msg.content });
        }
      } else {
        apiMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const body = JSON.stringify({
      model: model || fastModel,
      max_tokens: 2048,
      stream: true,
      stream_options: { include_usage: true },
      messages: apiMessages,
    });

    const usage = {};
    const text = await streamRequest(apiKey, body, onChunk, usage);
    this.lastUsage = usage.inputTokens != null ? usage : null;
    return text;
  }
}

async function validate(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/models',
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = { id, label, models, fastModel, configFields, OpenAIProvider, validate };
