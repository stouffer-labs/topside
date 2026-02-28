const { log } = require('../logger');

const id = 'local';
const label = 'Local (On-Device)';

const models = [
  { value: 'mlx-community/Qwen3-VL-4B-Instruct-4bit', label: 'Qwen3-VL 4B (best quality, ~2.5GB)', size: '2.5 GB' },
  { value: 'mlx-community/Qwen3-VL-4B-Instruct-8bit', label: 'Qwen3-VL 4B 8-bit (higher quality, ~5GB)', size: '5 GB' },
];

const fastModel = 'mlx-community/Qwen3-VL-4B-Instruct-4bit';

const configFields = [
  { key: 'model', type: 'local-ai-model-select', label: 'Model', default: 'mlx-community/Qwen3-VL-4B-Instruct-4bit' },
];

// ─── Addon Access ──────────────────────────────────────────────────────────────

let _addon = undefined; // undefined = not yet attempted

function getAddon() {
  if (_addon !== undefined) return _addon;
  try {
    const { loadAddon } = require('mlx-inference-addon');
    _addon = loadAddon();
  } catch (err) {
    log('AI', `MLX addon not available: ${err.message}`);
    _addon = null;
  }
  return _addon;
}

function isAvailable() {
  if (process.platform !== 'darwin') return false;
  return getAddon() !== null;
}

// ─── Provider ──────────────────────────────────────────────────────────────────

class LocalProvider {
  constructor(configService) {
    this.configService = configService;
  }

  async initialize() {
    const addon = getAddon();
    if (!addon) throw new Error('MLX native addon not available');

    const status = addon.getStatus();
    const modelId = this.configService.get('ai.model') || fastModel;

    // Already loaded with the right model
    if (status.loaded && status.modelId === modelId) {
      log('AI', `Local: model already loaded (${modelId})`);
      return;
    }

    log('AI', `Local: loading model ${modelId}`);
    await addon.loadModel(modelId, (progress) => {
      log('AI', `Local: loading ${progress.percent}% — ${progress.message || ''}`);
    });
    log('AI', `Local: model ready`);
  }

  invalidateClient() {
    const addon = getAddon();
    if (addon) {
      addon.unloadModel();
      log('AI', 'Local: model unloaded');
    }
  }

  async converse(messages, options = {}) {
    const addon = getAddon();
    if (!addon) throw new Error('MLX native addon not available');

    const { systemPrompt, onChunk } = options;

    // Extract prompt text and image from Anthropic-format messages.
    // The ai-service sends messages like: [{role: 'user', content: [{type: 'image', source: {data: '...'}}, {type: 'text', text: '...'}]}]
    let prompt = '';
    let imageBase64 = null;

    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'image' && part.source?.data) {
            imageBase64 = part.source.data;
          } else if (part.type === 'text') {
            prompt += (prompt ? '\n' : '') + part.text;
          }
        }
      } else if (msg.role === 'user') {
        prompt += (prompt ? '\n' : '') + String(msg.content);
      } else if (msg.role === 'assistant') {
        // Include prior assistant turns for context
        prompt += (prompt ? '\n' : '') + String(msg.content);
      }
    }

    if (!prompt) {
      prompt = 'Describe what you see on the screen.';
    }

    const genOptions = {
      prompt,
      systemPrompt: systemPrompt || undefined,
      maxTokens: 2048,
    };
    if (imageBase64) {
      genOptions.imageBase64 = imageBase64;
    }

    const fullText = await addon.generate(genOptions, (partialText) => {
      if (onChunk) onChunk(partialText);
    });

    return fullText;
  }
}

// ─── Download ──────────────────────────────────────────────────────────────────

async function downloadModel(modelId, onProgress) {
  const addon = getAddon();
  if (!addon) throw new Error('MLX native addon not available');

  log('AI', `Local: downloading model ${modelId}`);
  await addon.loadModel(modelId, (progress) => {
    if (onProgress) {
      onProgress({
        status: 'loading',
        modelId,
        percent: progress.percent || 0,
        message: progress.message || '',
      });
    }
  });

  if (onProgress) {
    onProgress({ status: 'ready', modelId });
  }
  log('AI', `Local: model ${modelId} downloaded and ready`);
}

module.exports = { id, label, models, fastModel, configFields, LocalProvider, downloadModel, isAvailable };
