const { log } = require('./logger');

const SYSTEM_PROMPT = `You are Topside, a voice-driven AI assistant embedded in the user's desktop.
You see a screenshot of either the active application or the entire screen and you hear a voice transcript.

Match your response to the context:
- Terminal / shell: output the command. Brief explanation only if non-obvious.
  (e.g. "find files bigger than a gig" → find . -size +1G)
- Code editor: output the code, matching the visible language and style.
- Email / Slack / iMessage / Teams / chat app — composing a reply:
  When the user asks to "respond to this", "reply to this", "draft a response",
  etc., read the visible message thread and compose an appropriate reply.
  Match the tone the user requests (casual, formal, brief, etc.).
  If the user's intent or key details are ambiguous, ask a clarifying question
  in your response and offer the likely answers as buttons.
  Output ONLY the reply text — no subject lines, no "Here's a draft:" preamble.
- Chat / email / text field — dictation: if the user is simply dictating
  (no visible conversation to reply to), clean up the transcript — fix filler
  words, punctuation, capitalization. Keep the user's words and meaning.
- Question about the screen ("explain this", "what does this error mean"):
  answer directly and concisely using the screenshot. No preamble.
- "highlighted" or "selected" = text with a distinct background color
  (OS selection highlight), NOT just any prominent text.
- If unclear, default to cleaning up the transcript as natural text.

For follow-up messages, respond based on the conversation history.

Keep responses focused — the user sees a small overlay window.

The transcript is live speech-to-text and may contain garbled or misheard
words, especially at the start. Interpret the user's intent. Ignore filler
words (um, uh) and recognition artifacts.

At the END of every response, include 2-4 follow-up buttons:
[BUTTONS: "Label1", "Label2", "Label3"]
Button labels should be short (1-4 words). Each button must be something
YOU can answer or do in the next turn — a question, rephrasing, or
elaboration. Never suggest actions you cannot perform (running commands,
opening apps, sending messages). Good: "Explain the error", "More detail",
"Simpler version". Bad: "Run diagnostics", "Open settings", "Send to Slack".
For message replies, include tone adjustment ("More formal" / "More casual").`;

function parseButtons(text) {
  if (!text) return { content: text || '', buttons: [] };
  // Match complete [BUTTONS: ...] tag — [\s\S] spans newlines, \s*$ tolerates trailing whitespace
  const match = text.match(/\[BUTTONS:\s*([\s\S]+?)\]\s*$/i);
  if (match) {
    const labels = match[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    return { content: text.slice(0, match.index).trim(), buttons: labels };
  }
  // Fallback: consecutive [Label] at the end of the response — either one per line
  // ("[More formal]\n[More casual]\n[Copy]") or all on one line
  // ("[More formal] [More casual] [Send as-is] [Copy]")
  const trailing = text.match(/(\n\s*\[[^\]\n]+\]){2,}\s*$/) ||
                   text.match(/\n?\s*(\[[^\]\n]+\]\s*){2,}\s*$/);
  if (trailing) {
    const labels = [...trailing[0].matchAll(/\[([^\]\n]+)\]/g)].map(m => m[1].trim()).filter(Boolean);
    if (labels.length >= 2) {
      return { content: text.slice(0, text.length - trailing[0].length).trim(), buttons: labels };
    }
  }
  // Fallback: bare short lines at the end (AI forgot brackets entirely)
  // e.g. "More casual\nMore formal\nExplain the error"
  // Match 2-4 trailing lines that are each 1-5 words, no sentence-ending punctuation
  const lines = text.trimEnd().split('\n');
  let bareCount = 0;
  for (let i = lines.length - 1; i >= 0 && bareCount < 4; i--) {
    const line = lines[i].trim().replace(/^[-•*]\s*/, ''); // strip list markers
    if (!line) break;
    const words = line.split(/\s+/).length;
    if (words <= 5 && !/[.!?:;]$/.test(line)) {
      bareCount++;
    } else {
      break;
    }
  }
  if (bareCount >= 2) {
    const bareLabels = lines.slice(-bareCount).map(l => l.trim().replace(/^[-•*]\s*/, '')).filter(Boolean);
    const remaining = lines.slice(0, -bareCount).join('\n').trim();
    if (remaining.length > 0) {
      return { content: remaining, buttons: bareLabels };
    }
  }
  // Strip incomplete [BUTTONS: patterns (no closing bracket) — [\s\S] matches across newlines
  const cleaned = text.replace(/\[BUTTONS:[\s\S]*$/i, '').trim();
  if (cleaned !== text.trim()) return { content: cleaned, buttons: [] };
  return { content: text, buttons: [] };
}

function cleanOutput(text) {
  if (!text) return text;

  // Strip EOS/special tokens that local models (Qwen, Llama, etc.) may append
  let stripped = text.replace(/<\|(?:endoftext|im_end|end|eot_id)\|>/gi, '');
  // Strip think tags (Qwen reasoning mode)
  stripped = stripped.replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trimEnd();

  const preamblePatterns = [
    /^I can see\b[^.:\n]*\b(?:terminal|window|screen|screenshot|editor|code|file|browser|app\w*|image|display|cursor|prompt)\b[^.:\n]*[.:\n]\s*/i,
    /^I see\b[^.:\n]*\b(?:terminal|window|screen|screenshot|editor|code|file|browser|app\w*|image|display|cursor|prompt)\b[^.:\n]*[.:\n]\s*/i,
    /^Based on\b[^.:\n]*[.:\n]\s*/i,
    /^Looking at\b[^.:\n]*[.:\n]\s*/i,
    /^It appears\b[^.:\n]*[.:\n]\s*/i,
    /^It looks like\b[^.:\n]*[.:\n]\s*/i,
    /^Let me (?:clarify|explain|help|provide|rephrase|rewrite|interpret|process)\b[^.:\n]*[.:\n]\s*/i,
    /^The (?:user|transcript|output|screenshot|image|screen)\b[^.:\n]*[.:\n]\s*/i,
    /^Here(?:'s| is) (?:the |your |a )?(?:command|code|output|result|text|answer|response|translation|cleaned|corrected|revised)\b[^.:\n]*[.:\n]\s*/i,
    /^From (?:the |what )\b[^.:\n]*[.:\n]\s*/i,
  ];

  let cleaned = stripped.trimStart();
  let changed = true;
  let iterations = 0;
  while (changed && iterations < 3) {
    changed = false;
    iterations++;
    for (const pattern of preamblePatterns) {
      if (pattern.test(cleaned)) {
        cleaned = cleaned.replace(pattern, '').trimStart();
        changed = true;
        break;
      }
    }
  }

  if (!cleaned.trim()) return text.trim();
  return cleaned;
}

// Provider registry — lazy-loaded
const PROVIDERS = {
  bedrock: () => require('./ai-providers/bedrock'),
  anthropic: () => require('./ai-providers/anthropic'),
  openai: () => require('./ai-providers/openai'),
  openrouter: () => require('./ai-providers/openrouter'),
  google: () => require('./ai-providers/google'),
  azure: () => require('./ai-providers/azure'),
  local: () => require('./ai-providers/local'),
};

class AIService {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
    this.provider = null;
    this.providerType = null;
  }

  getProviderMeta() {
    const type = this.configService.get('ai.provider') || 'bedrock';
    const loader = PROVIDERS[type];
    if (!loader) throw new Error(`Unknown AI provider: ${type}`);
    return loader();
  }

  getProvider() {
    const type = this.configService.get('ai.provider') || 'bedrock';
    if (this.providerType !== type) {
      const meta = this.getProviderMeta();
      const ProviderClass = meta.BedrockProvider || meta.AnthropicProvider ||
        meta.OpenRouterProvider || meta.GoogleProvider || meta.AzureProvider;
      // Generic: find the class export that ends with 'Provider'
      const className = Object.keys(meta).find(k => k.endsWith('Provider') && typeof meta[k] === 'function');
      if (!className) throw new Error(`No provider class found for: ${type}`);
      this.provider = new meta[className](this.configService, this.secretStore);
      this.providerType = type;
    }
    return this.provider;
  }

  async initialize() {
    try {
      await this.getProvider().initialize();
    } catch (err) {
      log('AI', `Provider init failed: ${err.message}`);
    }
  }

  invalidateClient() {
    if (this.provider && this.provider.invalidateClient) {
      this.provider.invalidateClient();
    }
    this.provider = null;
    this.providerType = null;
  }

  getModel() {
    return this.configService.get('ai.model')
      || this.configService.get('ai.fastModel')   // backward compat
      || this.getProviderMeta().fastModel;
  }

  getSystemPrompt() {
    return this.configService.get('ai.systemPrompt') || SYSTEM_PROMPT;
  }

  async converse(messages, screenshot, windowInfo, onChunk = null) {
    const provider = this.getProvider();
    const model = this.getModel();

    // Build API messages array from conversation history
    const screenshotContent = screenshot ? {
      type: 'image',
      source: { type: 'base64', media_type: screenshot.mediaType || 'image/png', data: screenshot.base64 || screenshot },
    } : null;

    const apiMessages = messages.map((msg, i) => {
      if (msg.role === 'user') {
        const parts = [];
        if (i === 0 && screenshotContent) parts.push(screenshotContent);
        const winLabel = windowInfo ? `App: ${windowInfo.owner} — "${windowInfo.title}"\n\n` : '';
        const prefix = i === 0 ? `${winLabel}Transcript:\n` : '';
        parts.push({ type: 'text', text: `${prefix}${msg.content}` });
        return { role: 'user', content: parts };
      }
      return { role: 'assistant', content: msg.content };
    });

    try {
      const rawText = await provider.converse(apiMessages, {
        systemPrompt: this.getSystemPrompt(),
        onChunk,
        model,
      });
      this.lastUsage = provider.lastUsage || null;
      return cleanOutput(rawText);
    } catch (err) {
      log('AI', `Converse error: ${err.message}`);
      throw err;
    }
  }

  reset() {
    // Provider is preserved across sessions; nothing to clear
  }
}

let instance = null;

module.exports = {
  AIService,
  SYSTEM_PROMPT,
  cleanOutput,
  parseButtons,
  PROVIDERS,
  getInstance: (configService, secretStore) => {
    if (!instance) {
      instance = new AIService(configService, secretStore);
    }
    return instance;
  },
};
