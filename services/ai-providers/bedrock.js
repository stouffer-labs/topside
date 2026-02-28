const fs = require('fs');
const path = require('path');
const os = require('os');
const { log } = require('../logger');

const id = 'bedrock';
const label = 'AWS Bedrock';

const models = [
  { value: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', label: 'Claude Haiku 4.5 (Fast)' },
  { value: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', label: 'Claude Sonnet 4.5' },
  { value: 'us.anthropic.claude-opus-4-5-20251101-v1:0', label: 'Claude Opus 4.5' },
];

const fastModel = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const configFields = [
  { key: 'authMethod', label: 'Authentication', type: 'select',
    options: [
      { value: 'auto', label: 'Auto-detect' },
      { value: 'profile', label: 'AWS Profile' },
      { value: 'accessKey', label: 'Access Key' },
    ] },
  { key: 'region', label: 'Region', type: 'select', default: 'us-west-2', options: [
    { value: 'us-east-1', label: 'US East (N. Virginia)' },
    { value: 'us-east-2', label: 'US East (Ohio)' },
    { value: 'us-west-2', label: 'US West (Oregon)' },
    { value: 'eu-west-1', label: 'Europe (Ireland)' },
    { value: 'eu-west-3', label: 'Europe (Paris)' },
    { value: 'eu-central-1', label: 'Europe (Frankfurt)' },
    { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
    { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
    { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  ] },
  { key: 'profile', label: 'Profile', type: 'profile-select', showWhen: { authMethod: ['auto', 'profile'] } },
  { key: 'accessKeyId', label: 'Access Key ID', type: 'secret', showWhen: { authMethod: 'accessKey' } },
  { key: 'secretAccessKey', label: 'Secret Access Key', type: 'secret', showWhen: { authMethod: 'accessKey' } },
];

function listAwsProfiles() {
  const profiles = new Set(['default']);
  const isengardProfiles = new Set();
  const configPath = path.join(os.homedir(), '.aws', 'config');
  const files = [
    path.join(os.homedir(), '.aws', 'credentials'),
    configPath,
  ];
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const content = fs.readFileSync(file, 'utf8');
      const re = /\[(?:profile\s+)?([^\]]+)\]/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        profiles.add(m[1].trim());
      }
    } catch (_) {}
  }

  // Identify which profiles use isengardcli credential_process
  try {
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf8');
      let currentProfile = null;
      for (const line of content.split('\n')) {
        const profileMatch = line.match(/\[(?:profile\s+)?([^\]]+)\]/);
        if (profileMatch) {
          currentProfile = profileMatch[1].trim();
        } else if (currentProfile && line.includes('credential_process') && line.includes('isengardcli')) {
          isengardProfiles.add(currentProfile);
        }
      }
    }
  } catch (_) {}

  // Sort with Isengard profiles first, annotated
  const sorted = Array.from(profiles).sort((a, b) => {
    const aIse = isengardProfiles.has(a);
    const bIse = isengardProfiles.has(b);
    if (aIse && !bIse) return -1;
    if (!aIse && bIse) return 1;
    return a.localeCompare(b);
  });

  return sorted.map(name => ({
    name,
    label: isengardProfiles.has(name) ? `${name} (Isengard)` : name,
    isengard: isengardProfiles.has(name),
  }));
}

function findIsengardProfile() {
  try {
    const configPath = path.join(os.homedir(), '.aws', 'config');
    if (!fs.existsSync(configPath)) return null;
    const content = fs.readFileSync(configPath, 'utf8');
    let currentProfile = null;
    for (const line of content.split('\n')) {
      const profileMatch = line.match(/\[(?:profile\s+)?([^\]]+)\]/);
      if (profileMatch) {
        currentProfile = profileMatch[1].trim();
      } else if (currentProfile && line.includes('credential_process') && line.includes('isengardcli')) {
        return currentProfile;
      }
    }
  } catch (_) {}
  return null;
}

function profileUsesCredentialProcess(name) {
  try {
    const configPath = path.join(os.homedir(), '.aws', 'config');
    if (!fs.existsSync(configPath)) return false;
    const content = fs.readFileSync(configPath, 'utf8');
    let currentProfile = null;
    for (const line of content.split('\n')) {
      const profileMatch = line.match(/\[(?:profile\s+)?([^\]]+)\]/);
      if (profileMatch) {
        currentProfile = profileMatch[1].trim();
      } else if (currentProfile === name && line.trim().startsWith('credential_process')) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

function isIsengardProfile(name) {
  try {
    const configPath = path.join(os.homedir(), '.aws', 'config');
    if (!fs.existsSync(configPath)) return false;
    const content = fs.readFileSync(configPath, 'utf8');
    let currentProfile = null;
    for (const line of content.split('\n')) {
      const profileMatch = line.match(/\[(?:profile\s+)?([^\]]+)\]/);
      if (profileMatch) {
        currentProfile = profileMatch[1].trim();
      } else if (currentProfile === name && line.includes('credential_process') && line.includes('isengardcli')) {
        return true;
      }
    }
  } catch (_) {}
  return false;
}

class BedrockProvider {
  constructor(configService, secretStore) {
    this.configService = configService;
    this.secretStore = secretStore;
    this.client = null;
  }

  async initialize() {
    await this.ensureClient();
  }

  invalidateClient() {
    this.client = null;
  }

  async ensureClient() {
    if (this.client) return;

    const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
    const cfg = this.configService.get('ai.bedrock') || {};
    const region = cfg.region || 'us-west-2';
    const authMethod = cfg.authMethod || 'auto';

    let credentials;
    if (authMethod === 'accessKey') {
      const accessKeyId = this.secretStore.get('bedrock.accessKeyId');
      const secretAccessKey = this.secretStore.get('bedrock.secretAccessKey');
      if (accessKeyId && secretAccessKey) {
        credentials = { accessKeyId, secretAccessKey };
      } else {
        throw new Error('Bedrock access key credentials not configured');
      }
    } else {
      let profile = cfg.profile || 'default';

      // Auto-detect: look for an Isengard profile first
      if (authMethod === 'auto' || profile === 'default') {
        const isengardProfile = findIsengardProfile();
        if (isengardProfile) {
          profile = isengardProfile;
          log('AI', `Auto-detected Isengard profile: ${profile}`);
        }
      }

      // Use enterprise credential provider for Isengard profiles when configured
      const enterpriseConfig = this.configService.get('enterprise');
      if (enterpriseConfig && isIsengardProfile(profile)) {
        const { EnterpriseCredentialProvider } = require('../enterprise-credential-provider');
        const ecp = new EnterpriseCredentialProvider(this.configService);
        credentials = ecp.getCredentialProvider(profile);
      } else {
        if (profileUsesCredentialProcess(profile)) {
          throw new Error(
            `Profile "${profile}" uses credential_process which requires a subprocess ` +
            `that cannot run in the App Store sandbox. Use Access Key authentication ` +
            `or an Isengard profile with Enterprise config instead.`
          );
        }
        const { fromIni } = require('@aws-sdk/credential-provider-ini');
        credentials = fromIni({ profile });
      }
    }

    this.client = new BedrockRuntimeClient({ region, credentials });
    log('AI', `Bedrock client initialized (region: ${region}, auth: ${authMethod})`);
  }

  async refine(transcript, context, options = {}) {
    await this.ensureClient();

    const { InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
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
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentParts }],
    });

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await this.client.send(command);

    let refinedText = '';
    for await (const event of response.body) {
      if (event.chunk) {
        const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          refinedText += parsed.delta.text;
          if (onChunk) onChunk(refinedText);
        }
      }
    }

    return refinedText;
  }

  async converse(messages, options = {}) {
    await this.ensureClient();

    const { InvokeModelWithResponseStreamCommand } = require('@aws-sdk/client-bedrock-runtime');
    const { systemPrompt, onChunk, model } = options;

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: 2048,
      system: systemPrompt,
      messages,
    });

    const command = new InvokeModelWithResponseStreamCommand({
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    const response = await this.client.send(command);

    let text = '';
    const usage = {};
    for await (const event of response.body) {
      if (event.chunk) {
        const parsed = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
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
      }
    }

    this.lastUsage = usage.inputTokens != null ? usage : null;
    return text;
  }
}

async function validate(apiKey, config) {
  const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
  const authMethod = config?.authMethod || 'auto';
  const region = config?.region || 'us-west-2';

  let credentials;
  if (authMethod === 'accessKey') {
    const accessKeyId = config?.secrets?.accessKeyId;
    const secretAccessKey = config?.secrets?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('Both Access Key ID and Secret Access Key are required');
    }
    credentials = { accessKeyId, secretAccessKey };
  } else {
    let profile = config?.profile || 'default';
    if ((authMethod === 'auto' || profile === 'default') && !config?.profile) {
      const isengardProfile = findIsengardProfile();
      if (isengardProfile) profile = isengardProfile;
    }

    // Use enterprise credential provider for Isengard profiles when configured
    if (config?._configService) {
      const enterpriseConfig = config._configService.get('enterprise');
      if (enterpriseConfig && isIsengardProfile(profile)) {
        const { EnterpriseCredentialProvider } = require('../enterprise-credential-provider');
        const ecp = new EnterpriseCredentialProvider(config._configService);
        credentials = ecp.getCredentialProvider(profile);
      } else {
        if (profileUsesCredentialProcess(profile)) {
          throw new Error(
            `Profile "${profile}" uses credential_process which requires a subprocess ` +
            `that cannot run in the App Store sandbox. Use Access Key authentication ` +
            `or an Isengard profile with Enterprise config instead.`
          );
        }
        const { fromIni } = require('@aws-sdk/credential-provider-ini');
        credentials = fromIni({ profile });
      }
    } else {
      if (profileUsesCredentialProcess(profile)) {
        throw new Error(
          `Profile "${profile}" uses credential_process which requires a subprocess ` +
          `that cannot run in the App Store sandbox. Use Access Key authentication ` +
          `or an Isengard profile with Enterprise config instead.`
        );
      }
      const { fromIni } = require('@aws-sdk/credential-provider-ini');
      credentials = fromIni({ profile });
    }
  }

  const client = new BedrockRuntimeClient({ region, credentials });

  // Make a real API call to verify credentials work against Bedrock.
  // Uses a non-existent model ID so the request is free — auth errors (403)
  // are distinguished from model errors (400/404) which prove auth succeeded.
  const command = new InvokeModelCommand({
    modelId: 'validation-test',
    contentType: 'application/json',
    accept: 'application/json',
    body: '{}',
  });

  try {
    await client.send(command);
  } catch (err) {
    const status = err.$metadata?.httpStatusCode;
    if (status === 403 || err.name === 'ExpiredTokenException' ||
        err.name === 'UnrecognizedClientException' ||
        err.name === 'InvalidSignatureException' ||
        (err.message && err.message.includes('security token'))) {
      throw new Error('AWS credentials expired or invalid — refresh your credentials and try again');
    }
    // Non-auth errors (model not found, validation error) mean auth is fine
  }

  return true;
}

module.exports = { id, label, models, fastModel, configFields, BedrockProvider, listAwsProfiles, findIsengardProfile, isIsengardProfile, profileUsesCredentialProcess, validate };
