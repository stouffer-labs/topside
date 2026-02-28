const https = require('https');
const { log } = require('../logger');

const id = 'google';
const label = 'Google Gemini';

const models = [
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Fast)' },
  { value: 'gemini-2.5-pro-preview-06-05', label: 'Gemini 2.5 Pro' },
];

const fastModel = 'gemini-2.0-flash';

const configFields = [
  { key: 'apiKey', label: 'API Key', type: 'secret', placeholder: 'AIza...' },
];

// Convert to Gemini format
function buildGeminiRequest(transcript, context) {
  const { screenshot, windowInfo, systemPrompt, previousOutput } = context;

  const parts = [];

  if (screenshot) {
    parts.push({
      inlineData: {
        mimeType: screenshot.source.media_type,
        data: screenshot.source.data,
      },
    });
  }

  const winTitle = windowInfo?.title || 'unknown';
  const winOwner = windowInfo?.owner || 'unknown app';
  let userText = `App: ${winOwner} — "${winTitle}"\n\nTranscript:\n${transcript}`;
  if (previousOutput) {
    userText += `\n\nPrevious output: ${previousOutput}`;
  }
  parts.push({ text: userText });

  const req = {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      maxOutputTokens: 1024,
    },
  };

  if (systemPrompt) {
    req.systemInstruction = { parts: [{ text: systemPrompt }] };
  }

  return req;
}

class GoogleProvider {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
  }

  async initialize() {
    const key = this.secretStore.get('google.apiKey');
    if (!key) log('AI', 'Google: no API key configured');
  }

  invalidateClient() {}

  async refine(transcript, context, options = {}) {
    const apiKey = this.secretStore.get('google.apiKey');
    if (!apiKey) throw new Error('Google API key not configured');

    const { onChunk, model } = options;
    const modelId = model || fastModel;
    const geminiBody = buildGeminiRequest(transcript, context);

    const body = JSON.stringify(geminiBody);
    const urlPath = `/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`;

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`Gemini API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
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
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (text) {
                refinedText += text;
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
    const apiKey = this.secretStore.get('google.apiKey');
    if (!apiKey) throw new Error('Google API key not configured');

    const { systemPrompt, onChunk, model } = options;
    const modelId = model || fastModel;

    // Convert multi-turn messages to Gemini format
    const contents = messages.map(msg => {
      if (msg.role === 'user') {
        const parts = [];
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'image' && part.source) {
              parts.push({ inlineData: { mimeType: part.source.media_type, data: part.source.data } });
            } else if (part.type === 'text') {
              parts.push({ text: part.text });
            }
          }
        } else {
          parts.push({ text: msg.content });
        }
        return { role: 'user', parts };
      }
      return { role: 'model', parts: [{ text: msg.content }] };
    });

    const geminiBody = {
      contents,
      generationConfig: { maxOutputTokens: 2048 },
    };
    if (systemPrompt) {
      geminiBody.systemInstruction = { parts: [{ text: systemPrompt }] };
    }

    const body = JSON.stringify(geminiBody);
    const urlPath = `/v1beta/models/${modelId}:streamGenerateContent?key=${apiKey}&alt=sse`;

    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'generativelanguage.googleapis.com',
        path: urlPath,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (d) => errBody += d);
          res.on('end', () => reject(new Error(`Gemini API ${res.statusCode}: ${errBody.substring(0, 200)}`)));
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
            if (!data) continue;

            try {
              const parsed = JSON.parse(data);
              const t = parsed.candidates?.[0]?.content?.parts?.[0]?.text;
              if (t) {
                text += t;
                if (onChunk) onChunk(text);
              }
              if (parsed.usageMetadata) {
                usage.inputTokens = parsed.usageMetadata.promptTokenCount;
                usage.outputTokens = parsed.usageMetadata.candidatesTokenCount;
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
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      method: 'GET',
    }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(5000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

module.exports = { id, label, models, fastModel, configFields, GoogleProvider, validate };
