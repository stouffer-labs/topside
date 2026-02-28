const https = require('https');
const { log } = require('../logger');

const id = 'openrouter';
const label = 'OpenRouter';

const models = [
  { value: 'anthropic/claude-haiku-4-5', label: 'Claude Haiku 4.5 (Fast)' },
  { value: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
  { value: 'openai/gpt-4o', label: 'GPT-4o' },
  { value: 'openai/gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
  { value: 'google/gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
];

const fastModel = 'anthropic/claude-haiku-4-5';

const configFields = [
  { key: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'sk-or-...' },
];

// Convert Anthropic-style content to OpenAI chat format
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
    // OpenAI vision format
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

class OpenRouterProvider {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
  }

  async initialize() {
    const key = this.secretStore.get('openrouter.apiKey');
    if (!key) log('AI', 'OpenRouter: no API key configured');
  }

  invalidateClient() {}

  async refine(transcript, context, options = {}) {
    const apiKey = this.secretStore.get('openrouter.apiKey');
    if (!apiKey) throw new Error('OpenRouter API key not configured');

    const { onChunk, model } = options;
    const messages = buildOpenAIMessages(transcript, context);

    const body = JSON.stringify({
      model: model || fastModel,
      max_tokens: 1024,
      stream: true,
      messages,
    });

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/topside-app',
          'X-Title': 'Topside',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`OpenRouter API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
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
    const apiKey = this.secretStore.get('openrouter.apiKey');
    if (!apiKey) throw new Error('OpenRouter API key not configured');

    const { systemPrompt, onChunk, model } = options;

    // Prepend system message, then use pre-built multi-turn messages
    const apiMessages = [];
    if (systemPrompt) apiMessages.push({ role: 'system', content: systemPrompt });
    for (const msg of messages) {
      if (msg.role === 'user') {
        // Convert Anthropic-style content parts to OpenAI vision format
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

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'openrouter.ai',
        path: '/api/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://github.com/topside-app',
          'X-Title': 'Topside',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`OpenRouter API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
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

async function validate(apiKey) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'openrouter.ai',
      path: '/api/v1/models',
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

module.exports = { id, label, models, fastModel, configFields, OpenRouterProvider, validate };
