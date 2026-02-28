const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG = {
  hotkey: null,
  audio: {
    inputDevice: 'default',
  },
  ai: {
    provider: 'bedrock',   // 'bedrock' | 'anthropic' | 'openrouter' | 'google' | 'azure'
    model: null,           // null = use provider's default fast model
    systemPrompt: null,
    bedrock: {
      authMethod: 'profile',
      region: 'us-west-2',
      profile: 'default',
    },
    anthropic: {},
    openrouter: {},
    google: {},
    azure: { endpoint: '', deployment: '' },
  },
  transcribe: {
    provider: 'aws',       // 'aws' | 'deepgram' | 'whisper'
    language: 'en-US',
    aws: { authMethod: 'auto', region: 'us-west-2', profile: 'default' },
    deepgram: { model: 'nova-3' },
    whisper: { model: 'ggml-base.en.bin', useGpu: true, threads: 4 },
  },
  capture: {
    mode: 'window',
  },
  overlay: {
    position: 'bottom-center',
    opacity: 0.92,
    width: 500,
    soundEffects: true,
    fontSize: 13,
  },
  breakout: {
    cliTool: 'claude',
  },
  help: {
    showOnStartup: true,
  },
};

class ConfigService {
  constructor(configPath) {
    this.configPath = configPath;
    this.config = null;
  }

  async initialize() {
    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        const saved = JSON.parse(data);
        // Migrate old triggerButton format to new hotkey format
        if (saved.triggerButton && !saved.hotkey) {
          saved.hotkey = {
            type: 'mouse',
            code: saved.triggerButton,
            label: `Mouse ${saved.triggerButton}`,
          };
          delete saved.triggerButton;
        }
        // Migrate old uiohook hotkey format to Electron accelerator format
        if (saved.hotkey && saved.hotkey.code !== undefined && !saved.hotkey.accelerator) {
          const LEGACY_KEYCODE_MAP = {
            2: '1', 3: '2', 4: '3', 5: '4', 6: '5', 7: '6', 8: '7', 9: '8', 10: '9', 11: '0',
            16: 'Q', 17: 'W', 18: 'E', 19: 'R', 20: 'T', 21: 'Y', 22: 'U', 23: 'I', 24: 'O', 25: 'P',
            30: 'A', 31: 'S', 32: 'D', 33: 'F', 34: 'G', 35: 'H', 36: 'J', 37: 'K', 38: 'L',
            44: 'Z', 45: 'X', 46: 'C', 47: 'V', 48: 'B', 49: 'N', 50: 'M',
            59: 'F1', 60: 'F2', 61: 'F3', 62: 'F4', 63: 'F5', 64: 'F6',
            65: 'F7', 66: 'F8', 67: 'F9', 68: 'F10', 87: 'F11', 88: 'F12',
            57: 'Space', 15: 'Tab',
          };
          const accelerator = LEGACY_KEYCODE_MAP[saved.hotkey.code];
          if (accelerator) {
            saved.hotkey = { accelerator, label: saved.hotkey.label || accelerator };
          } else {
            saved.hotkey = { accelerator: 'F10', label: 'F10' };
          }
          console.log('[CONFIG] Migrated hotkey to accelerator format');
        }
        // Remove legacy activation mode (always toggle now)
        delete saved.activation;
        // Remove legacy mouse hotkey type
        if (saved.hotkey && saved.hotkey.type === 'mouse') {
          saved.hotkey = { accelerator: 'F10', label: 'F10' };
          console.log('[CONFIG] Migrated mouse hotkey to default F10');
        }

        // Migrate old flat AI/Transcribe config to nested provider format
        if (saved.ai && saved.ai.bedrockRegion !== undefined) {
          const region = saved.ai.bedrockRegion || 'us-west-2';
          const profile = saved.ai.bedrockProfile || 'default';
          const model = saved.ai.model;
          saved.ai = {
            provider: 'bedrock',
            model: model,
            systemPrompt: saved.ai.systemPrompt || null,
            bedrock: { authMethod: 'profile', region, profile },
          };
          // Migrate transcribe region
          if (saved.transcribe && !saved.transcribe.provider) {
            const tRegion = saved.transcribe.region || region;
            const language = saved.transcribe.language || 'en-US';
            saved.transcribe = {
              provider: 'aws',
              language,
              aws: { region: tRegion },
            };
          }
          console.log('[CONFIG] Migrated to multi-provider format');
        }
        this.config = this.deepMerge(DEFAULT_CONFIG, saved);
        console.log(`[CONFIG] Loaded from ${this.configPath}`);
      } else {
        this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
        await this.save();
        console.log(`[CONFIG] Created default at ${this.configPath}`);
      }
    } catch (error) {
      console.error(`[CONFIG] Failed to initialize: ${error.message}`);
      this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  }

  deepMerge(target, source) {
    const result = { ...target };
    for (const key of Object.keys(source)) {
      if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
        result[key] = this.deepMerge(target[key] || {}, source[key]);
      } else {
        result[key] = source[key];
      }
    }
    return result;
  }

  get(key) {
    if (!key) return this.config;
    const keys = key.split('.');
    let value = this.config;
    for (const k of keys) {
      if (value && typeof value === 'object' && k in value) {
        value = value[k];
      } else {
        return undefined;
      }
    }
    return value;
  }

  set(key, value) {
    const keys = key.split('.');
    let obj = this.config;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in obj) || typeof obj[k] !== 'object') {
        obj[k] = {};
      }
      obj = obj[k];
    }
    obj[keys[keys.length - 1]] = value;
    return this.save();
  }

  async save() {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
      return true;
    } catch (error) {
      console.error(`[CONFIG] Failed to save: ${error.message}`);
      return false;
    }
  }

  getAll() {
    return JSON.parse(JSON.stringify(this.config));
  }

  reset() {
    this.config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    return this.save();
  }
}

let instance = null;

module.exports = {
  ConfigService,
  getInstance: (configPath) => {
    if (!instance) {
      if (!configPath) {
        const { app } = require('electron');
        configPath = path.join(app.getPath('userData'), 'config.json');
      }
      instance = new ConfigService(configPath);
    }
    return instance;
  },
};
