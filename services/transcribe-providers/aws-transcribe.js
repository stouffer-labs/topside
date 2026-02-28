const { EventEmitter } = require('events');
const crypto = require('crypto');
const WebSocket = require('ws');
const { log } = require('../logger');

const id = 'aws';
const label = 'AWS Transcribe';

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
    { value: 'eu-central-1', label: 'Europe (Frankfurt)' },
    { value: 'ap-southeast-1', label: 'Asia Pacific (Singapore)' },
    { value: 'ap-southeast-2', label: 'Asia Pacific (Sydney)' },
    { value: 'ap-northeast-1', label: 'Asia Pacific (Tokyo)' },
  ] },
  { key: 'profile', label: 'Profile', type: 'profile-select', showWhen: { authMethod: ['auto', 'profile'] } },
  { key: 'accessKeyId', label: 'Access Key ID', type: 'secret', showWhen: { authMethod: 'accessKey' } },
  { key: 'secretAccessKey', label: 'Secret Access Key', type: 'secret', showWhen: { authMethod: 'accessKey' } },
];

// ─── CRC32 ─────────────────────────────────────────────────────────────────────

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ─── Event-Stream Encoding ─────────────────────────────────────────────────────

function encodeAudioEvent(audioBuffer) {
  const headers = Buffer.from([
    13, 0x3a, 0x63, 0x6f, 0x6e, 0x74, 0x65, 0x6e, 0x74, 0x2d, 0x74, 0x79, 0x70, 0x65,
    7, 0x00, 0x18,
    0x61, 0x70, 0x70, 0x6c, 0x69, 0x63, 0x61, 0x74, 0x69, 0x6f, 0x6e, 0x2f,
    0x6f, 0x63, 0x74, 0x65, 0x74, 0x2d, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d,
    11, 0x3a, 0x65, 0x76, 0x65, 0x6e, 0x74, 0x2d, 0x74, 0x79, 0x70, 0x65,
    7, 0x00, 0x0a,
    0x41, 0x75, 0x64, 0x69, 0x6f, 0x45, 0x76, 0x65, 0x6e, 0x74,
    13, 0x3a, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x2d, 0x74, 0x79, 0x70, 0x65,
    7, 0x00, 0x05,
    0x65, 0x76, 0x65, 0x6e, 0x74,
  ]);

  const totalLength = 16 + headers.length + audioBuffer.length;
  const message = Buffer.alloc(totalLength);
  let offset = 0;

  message.writeUInt32BE(totalLength, offset); offset += 4;
  message.writeUInt32BE(headers.length, offset); offset += 4;

  const preludeCrc = crc32(message.slice(0, 8));
  message.writeUInt32BE(preludeCrc, offset); offset += 4;

  headers.copy(message, offset); offset += headers.length;
  audioBuffer.copy(message, offset); offset += audioBuffer.length;

  const messageCrc = crc32(message.slice(0, offset));
  message.writeUInt32BE(messageCrc, offset);

  return message;
}

// ─── Event-Stream Decoding ─────────────────────────────────────────────────────

function decodeTranscribeMessage(data) {
  if (!Buffer.isBuffer(data)) {
    data = Buffer.from(data);
  }

  if (data.length < 16) return null;

  const totalLength = data.readUInt32BE(0);
  const headersLength = data.readUInt32BE(4);
  const headersStart = 12;
  const payloadStart = headersStart + headersLength;
  const payloadEnd = totalLength - 4;

  let messageType = null;
  let pos = headersStart;
  while (pos < payloadStart) {
    const nameLen = data.readUInt8(pos); pos++;
    const name = data.slice(pos, pos + nameLen).toString('utf8'); pos += nameLen;
    const headerType = data.readUInt8(pos); pos++;

    if (headerType === 7) {
      const valueLen = data.readUInt16BE(pos); pos += 2;
      const value = data.slice(pos, pos + valueLen).toString('utf8'); pos += valueLen;
      if (name === ':message-type') messageType = value;
    } else {
      break;
    }
  }

  const payload = data.slice(payloadStart, payloadEnd);

  if (messageType === 'exception') {
    let detail = payload.toString('utf8');
    try {
      const errorJson = JSON.parse(detail);
      detail = errorJson.Message || detail;
    } catch (_) {}
    log('TRANSCRIBE', 'Exception:', detail);
    throw new Error(detail);
  }

  try {
    return JSON.parse(payload.toString('utf8'));
  } catch (e) {
    return null;
  }
}

// ─── SigV4 Pre-Signed URL ──────────────────────────────────────────────────────

function createTranscribeWebSocketUrl(region, sampleRate, languageCode, credentials) {
  const method = 'GET';
  const service = 'transcribe';
  const host = `transcribestreaming.${region}.amazonaws.com`;
  const endpoint = `wss://${host}:8443/stream-transcription-websocket`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;

  const queryParamsForSigning = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.accessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '300',
    ...(credentials.sessionToken && { 'X-Amz-Security-Token': credentials.sessionToken }),
    'X-Amz-SignedHeaders': 'host',
    'language-code': languageCode,
    'media-encoding': 'pcm',
    'sample-rate': String(sampleRate),
    'enable-partial-results-stabilization': 'true',
    'partial-results-stability': 'medium',
  };

  const sortedKeys = Object.keys(queryParamsForSigning).sort();
  const canonicalQueryString = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(queryParamsForSigning[k])}`)
    .join('&');

  const canonicalHeaders = `host:${host}:8443\n`;
  const signedHeaders = 'host';
  const payloadHash = crypto.createHash('sha256').update('').digest('hex');

  const canonicalRequest = [
    method,
    '/stream-transcription-websocket',
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  const getSignatureKey = (key, dateStamp, region, service) => {
    const kDate = crypto.createHmac('sha256', `AWS4${key}`).update(dateStamp).digest();
    const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
    const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
    return crypto.createHmac('sha256', kService).update('aws4_request').digest();
  };

  const signingKey = getSignatureKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const finalUrl = `${endpoint}?${canonicalQueryString}&X-Amz-Signature=${signature}`;
  return finalUrl;
}

// ─── AWS Transcribe Provider ────────────────────────────────────────────────────

class AwsTranscribeProvider extends EventEmitter {
  constructor(configService, secretStore) {
    super();
    this.configService = configService;
    this.secretStore = secretStore;
    this.ws = null;
    this.running = false;
    this.connecting = false;
    this.credentials = null;
    this.pendingChunks = [];
  }

  async warmup() {
    await this.loadCredentials();
  }

  async loadCredentials() {
    const awsCfg = this.configService.get('transcribe.aws') || {};
    const authMethod = awsCfg.authMethod || 'auto';

    // Access key auth
    if (authMethod === 'accessKey') {
      const accessKeyId = this.secretStore.get('aws.accessKeyId');
      const secretAccessKey = this.secretStore.get('aws.secretAccessKey');
      if (accessKeyId && secretAccessKey) {
        this.credentials = { accessKeyId, secretAccessKey };
        log('TRANSCRIBE', 'Using access key credentials');
        return;
      }
    }

    // Profile-based auth — auto-detect Isengard profile if on 'auto'
    const { findIsengardProfile, isIsengardProfile } = require('../ai-providers/bedrock');
    let profile = awsCfg.profile || 'default';

    if (authMethod === 'auto' || profile === 'default') {
      try {
        const isengardProfile = findIsengardProfile();
        if (isengardProfile) {
          profile = isengardProfile;
          log('TRANSCRIBE', `Auto-detected Isengard profile: ${profile}`);
        }
      } catch (_) {}
    }

    // Use enterprise credential provider for Isengard profiles when configured
    const enterpriseConfig = this.configService.get('enterprise');
    if (enterpriseConfig && isIsengardProfile(profile)) {
      const { EnterpriseCredentialProvider } = require('../enterprise-credential-provider');
      const ecp = new EnterpriseCredentialProvider(this.configService);
      const provider = ecp.getCredentialProvider(profile);
      this.credentials = await provider();
      log('TRANSCRIBE', `AWS credentials loaded via enterprise provider: ${profile}`);
      return;
    }

    const { profileUsesCredentialProcess } = require('../ai-providers/bedrock');
    if (profileUsesCredentialProcess(profile)) {
      throw new Error(
        `Profile "${profile}" uses credential_process which requires a subprocess ` +
        `that cannot run in the App Store sandbox. Use Access Key authentication ` +
        `or an Isengard profile with Enterprise config instead.`
      );
    }
    const { fromIni } = require('@aws-sdk/credential-provider-ini');
    const provider = fromIni({ profile });
    this.credentials = await provider();
    log('TRANSCRIBE', `AWS credentials loaded via profile: ${profile}`);
  }

  async start() {
    if (this.running) return;

    this.connecting = true;
    this.pendingChunks = [];

    try {
      await this.loadCredentials();

      const awsCfg = this.configService.get('transcribe.aws') || {};
      const region = awsCfg.region || 'us-west-2';
      const language = this.configService.get('transcribe.language') || 'en-US';
      const sampleRate = 16000;

      const wsUrl = createTranscribeWebSocketUrl(region, sampleRate, language, this.credentials);
      log('TRANSCRIBE', 'Connecting to WebSocket...');

      this.ws = new WebSocket(wsUrl);

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
      log('TRANSCRIBE', 'WebSocket connected');

      if (this.pendingChunks.length > 0) {
        log('TRANSCRIBE', `Flushing ${this.pendingChunks.length} buffered chunks`);
        for (const chunk of this.pendingChunks) {
          const message = encodeAudioEvent(chunk);
          this.ws.send(message);
        }
        this.pendingChunks = [];
      }

      this.ws.on('message', (data) => {
        try {
          const response = decodeTranscribeMessage(data);
          if (!response) return;
          this.handleTranscribeResponse(response);
        } catch (err) {
          log('TRANSCRIBE', 'Message decode error:', err.message);
          this.emit('error', err);
        }
      });

      this.ws.on('error', (err) => {
        log('TRANSCRIBE', 'WebSocket error:', err.message);
        this.emit('error', err);
      });

      this.ws.on('close', (code) => {
        log('TRANSCRIBE', `WebSocket closed: ${code}`);
        const wasRunning = this.running;
        this.running = false;
        if (wasRunning && code !== 1000) {
          this.emit('error', new Error(`Connection closed (code ${code})`));
        }
      });
    } catch (err) {
      log('TRANSCRIBE', 'Failed to start:', err.message);
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
        this.ws.close();
      }
    } catch (err) {
      log('TRANSCRIBE', 'Error closing WebSocket:', err.message);
    }
    this.ws = null;
    log('TRANSCRIBE', 'Stopped');
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
      const message = encodeAudioEvent(audioBuffer);
      this.ws.send(message);
    } catch (err) {
      log('TRANSCRIBE', 'Send error:', err.message);
    }
  }

  handleTranscribeResponse(response) {
    const results = response?.Transcript?.Results;
    if (!results || results.length === 0) return;

    for (const result of results) {
      if (!result.Alternatives || result.Alternatives.length === 0) continue;

      const transcript = result.Alternatives[0].Transcript;
      if (!transcript || transcript.trim().length === 0) continue;

      if (result.IsPartial) {
        this.emit('partial', transcript);
      } else {
        this.emit('final', transcript);
      }
    }
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

async function validate(apiKey, config) {
  const authMethod = config?.authMethod || 'auto';
  let creds;

  if (authMethod === 'accessKey') {
    const accessKeyId = config?.secrets?.accessKeyId;
    const secretAccessKey = config?.secrets?.secretAccessKey;
    if (!accessKeyId || !secretAccessKey) {
      throw new Error('Both Access Key ID and Secret Access Key are required');
    }
    creds = { accessKeyId, secretAccessKey };
  } else {
    const { findIsengardProfile, isIsengardProfile } = require('../ai-providers/bedrock');
    let profile = config?.profile || 'default';

    if (authMethod === 'auto' || profile === 'default') {
      try {
        const isengardProfile = findIsengardProfile();
        if (isengardProfile) profile = isengardProfile;
      } catch (_) {}
    }

    // Use enterprise credential provider for Isengard profiles when configured
    if (config?._configService) {
      const enterpriseConfig = config._configService.get('enterprise');
      if (enterpriseConfig && isIsengardProfile(profile)) {
        const { EnterpriseCredentialProvider } = require('../enterprise-credential-provider');
        const ecp = new EnterpriseCredentialProvider(config._configService);
        const provider = ecp.getCredentialProvider(profile);
        creds = await provider();
      } else {
        const { profileUsesCredentialProcess } = require('../ai-providers/bedrock');
        if (profileUsesCredentialProcess(profile)) {
          throw new Error(
            `Profile "${profile}" uses credential_process which requires a subprocess ` +
            `that cannot run in the App Store sandbox. Use Access Key authentication ` +
            `or an Isengard profile with Enterprise config instead.`
          );
        }
        const { fromIni } = require('@aws-sdk/credential-provider-ini');
        creds = await fromIni({ profile })();
      }
    } else {
      const { profileUsesCredentialProcess } = require('../ai-providers/bedrock');
      if (profileUsesCredentialProcess(profile)) {
        throw new Error(
          `Profile "${profile}" uses credential_process which requires a subprocess ` +
          `that cannot run in the App Store sandbox. Use Access Key authentication ` +
          `or an Isengard profile with Enterprise config instead.`
        );
      }
      const { fromIni } = require('@aws-sdk/credential-provider-ini');
      creds = await fromIni({ profile })();
    }
  }

  // Verify credentials by making a real Transcribe WebSocket handshake.
  // This catches expired tokens, bad signatures, and permission issues
  // that pure credential resolution from disk can't detect.
  const region = config?.region || 'us-west-2';
  const wsUrl = createTranscribeWebSocketUrl(region, 16000, 'en-US', creds);
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const settle = (fn, val) => { if (!settled) { settled = true; clearTimeout(timeout); fn(val); } };
    const timeout = setTimeout(() => { ws.close(); settle(reject, new Error('Connection timeout — check region and network')); }, 5000);

    ws.once('open', () => {
      // Don't resolve immediately — wait briefly for error messages the server
      // may send right after accepting the connection (e.g. expired token exceptions).
      setTimeout(() => { ws.close(); settle(resolve); }, 1000);
    });
    ws.once('error', () => {
      settle(reject, new Error('AWS credentials expired or invalid — refresh your credentials and try again'));
    });
    ws.once('message', (data) => {
      try {
        decodeTranscribeMessage(data);
      } catch (_) {
        ws.close();
        settle(reject, new Error('AWS credentials expired or invalid — refresh your credentials and try again'));
      }
    });
  });

  return true;
}

module.exports = { id, label, configFields, AwsTranscribeProvider, validate };
