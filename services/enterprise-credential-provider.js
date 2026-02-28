const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { URL } = require('url');
const { log } = require('./logger');

// ─── Profile Parsing ─────────────────────────────────────────────────────────

function parseIsengardProfile(profileName) {
  const configPath = path.join(os.homedir(), '.aws', 'config');
  if (!fs.existsSync(configPath)) return null;

  const content = fs.readFileSync(configPath, 'utf8');
  let currentProfile = null;

  for (const line of content.split('\n')) {
    const profileMatch = line.match(/\[(?:profile\s+)?([^\]]+)\]/);
    if (profileMatch) {
      currentProfile = profileMatch[1].trim();
    } else if (currentProfile === profileName && line.includes('credential_process') && line.includes('isengardcli')) {
      // credential_process = isengardcli credentials --awscli user+account@example.com --role Admin
      const emailMatch = line.match(/--awscli\s+(\S+)/);
      const roleMatch = line.match(/--role\s+(\S+)/);
      if (emailMatch) {
        return { email: emailMatch[1], role: roleMatch ? roleMatch[1] : 'Admin' };
      }
    }
  }
  return null;
}

// ─── Cookie Reader ───────────────────────────────────────────────────────────

function readMidwayCookie(cookiePath) {
  const resolved = cookiePath.replace(/^~/, os.homedir());
  if (!fs.existsSync(resolved)) {
    throw new Error(`Midway cookie file not found: ${cookiePath}`);
  }

  const content = fs.readFileSync(resolved, 'utf8');
  const cookies = [];

  for (let line of content.split('\n')) {
    // #HttpOnly_ prefix marks HttpOnly cookies — strip prefix, keep cookie
    if (line.startsWith('#HttpOnly_')) {
      line = line.substring(10); // Remove '#HttpOnly_' prefix, domain follows
    } else if (line.startsWith('#') || !line.trim()) {
      continue;
    }
    const parts = line.split('\t');
    if (parts.length >= 7) {
      cookies.push(`${parts[5]}=${parts[6]}`);
    }
  }

  if (cookies.length === 0) {
    throw new Error('No cookies found in Midway cookie file — run mwinit first');
  }

  return cookies.join('; ');
}

// ─── HTTPS Helper ────────────────────────────────────────────────────────────

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'POST',
      headers: { ...options.headers },
    };

    const req = https.request(reqOptions, (res) => {
      // Collect set-cookie headers
      const setCookies = res.headers['set-cookie'] || [];

      if (res.statusCode === 307 || res.statusCode === 302 || res.statusCode === 301) {
        res.resume();
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          location: res.headers.location,
          setCookies,
          body: '',
        });
        return;
      }

      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, setCookies, body });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (options.body) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(options.body);
      req.write(options.body);
    }
    req.end();
  });
}

// ─── Redirect-Following API Call ─────────────────────────────────────────────
// Replicates what Python `requests` does: follows the full redirect chain
// (isengard → midway → isengard?id_token → isengard) carrying cookies through.

async function isengardApiCall(endpoint, target, payload, midwayCookie, sessionCookies) {
  const headers = {
    'Content-Type': 'application/x-amz-json-1.0',
    'X-Amz-Target': target,
  };
  if (sessionCookies) {
    headers.Cookie = sessionCookies;
  }

  const body = payload ? JSON.stringify(payload) : '{}';

  let res = await httpsRequest(endpoint, { method: 'POST', headers, body });
  const collectedCookies = [...(sessionCookies ? [sessionCookies] : [])];

  // Follow redirect chain (max 5 hops)
  for (let i = 0; i < 5 && res.location; i++) {
    // Collect any set-cookie from this response
    if (res.setCookies && res.setCookies.length > 0) {
      for (const sc of res.setCookies) {
        collectedCookies.push(sc.split(';')[0]);
      }
    }

    const redirectUrl = res.location;
    const redirectHeaders = {};

    // Determine which cookies to send based on the redirect target
    const redirectParsed = new URL(redirectUrl);
    if (redirectParsed.hostname.includes('midway')) {
      // Midway redirect — send the Midway cookie
      redirectHeaders.Cookie = midwayCookie;
    } else {
      // Back to Isengard — send collected session cookies + original headers
      redirectHeaders.Cookie = collectedCookies.filter(Boolean).join('; ');
      redirectHeaders['Content-Type'] = 'application/x-amz-json-1.0';
      redirectHeaders['X-Amz-Target'] = target;
    }

    log('ENTERPRISE', `  Redirect ${i + 1}: ${redirectParsed.hostname}${redirectParsed.pathname}`);
    res = await httpsRequest(redirectUrl, { method: 'POST', headers: redirectHeaders, body });
  }

  // Collect final cookies
  if (res.setCookies && res.setCookies.length > 0) {
    for (const sc of res.setCookies) {
      collectedCookies.push(sc.split(';')[0]);
    }
  }

  if (res.statusCode !== 200) {
    throw new Error(`${target} failed (HTTP ${res.statusCode}): ${res.body?.slice(0, 300)}`);
  }

  const finalCookies = collectedCookies.filter(Boolean).join('; ');
  return { body: JSON.parse(res.body), cookies: finalCookies };
}

// ─── Provider Class ──────────────────────────────────────────────────────────

class EnterpriseCredentialProvider {
  constructor(configService) {
    this.configService = configService;
    this._cache = new Map(); // profile → { credentials, expiration }
    this._pending = new Map(); // profile → Promise (dedup concurrent requests)
  }

  isConfigured() {
    return !!this.configService.get('enterprise');
  }

  getCredentialProvider(profile) {
    const self = this;
    return async function enterpriseCredentialProvider() {
      // Check cache
      const cached = self._cache.get(profile);
      if (cached) {
        const expiresAt = new Date(cached.expiration).getTime();
        const fiveMinutes = 5 * 60 * 1000;
        if (Date.now() < expiresAt - fiveMinutes) {
          return cached;
        }
        log('ENTERPRISE', `Credentials for ${profile} expiring soon, refreshing...`);
      }

      // Dedup concurrent requests for same profile
      if (self._pending.has(profile)) {
        return self._pending.get(profile);
      }

      const promise = self._fetchCredentials(profile);
      self._pending.set(profile, promise);

      try {
        const creds = await promise;
        self._cache.set(profile, creds);
        return creds;
      } finally {
        self._pending.delete(profile);
      }
    };
  }

  async _fetchCredentials(profile) {
    const config = this.configService.get('enterprise');
    if (!config) {
      throw new Error('Enterprise credential provider not configured');
    }

    const profileInfo = parseIsengardProfile(profile);
    if (!profileInfo) {
      throw new Error(`Could not parse Isengard profile: ${profile}`);
    }

    const midwayCookie = readMidwayCookie(config.cookiePath);
    const endpoint = config.credentialEndpoint;

    // Step 1: GetPermissionsForUser — this triggers the full auth redirect chain
    // (isengard → midway SSO → isengard?id_token → isengard → 200)
    log('ENTERPRISE', `Authenticating and fetching permissions...`);
    const permResult = await isengardApiCall(
      endpoint,
      'IsengardService.ListPermissionsForUser',
      null,
      midwayCookie,
      null,
    );

    // Find the account ID matching the profile email
    const permissionsList = permResult.body.PermissionsForUserList || [];
    let accountId = null;

    for (const entry of permissionsList) {
      const moniker = entry.AWSAccountMoniker || {};
      if (moniker.Email === profileInfo.email) {
        accountId = entry.AWSAccountID || moniker.AWSAccountID;
        break;
      }
    }

    if (!accountId) {
      throw new Error(
        `Account not found for ${profileInfo.email}. ` +
        `Available: ${permissionsList.slice(0, 5).map(e => e.AWSAccountMoniker?.Email).join(', ')}...`
      );
    }

    // Step 2: GetAssumeRoleCredentials — reuse session cookies from step 1
    log('ENTERPRISE', `Assuming ${profileInfo.role} on account ${accountId}...`);
    const credResult = await isengardApiCall(
      endpoint,
      'IsengardService.GetAssumeRoleCredentials',
      { AWSAccountID: accountId, IAMRoleName: profileInfo.role },
      midwayCookie,
      permResult.cookies,
    );

    // Parse the nested credential response
    // The API returns { AssumeRoleResult: "<JSON string>" } where the string contains { credentials: {...} }
    let creds;
    const assumeResult = credResult.body.AssumeRoleResult;
    if (typeof assumeResult === 'string') {
      const parsed = JSON.parse(assumeResult);
      creds = parsed.credentials || parsed.Credentials;
    } else {
      creds = credResult.body.credentials || credResult.body.Credentials || credResult.body;
    }

    const credentials = {
      accessKeyId: creds.accessKeyId || creds.AccessKeyId,
      secretAccessKey: creds.secretAccessKey || creds.SecretAccessKey,
      sessionToken: creds.sessionToken || creds.SessionToken,
      expiration: creds.expiration
        ? new Date(creds.expiration)
        : new Date(Date.now() + 3600000),
    };

    log('ENTERPRISE', `Credentials obtained for ${profile} (expires: ${credentials.expiration})`);
    return credentials;
  }

  // ─── Static Validation ──────────────────────────────────────────────────────

  static validateConfig(configJson) {
    let parsed;
    try {
      parsed = JSON.parse(configJson);
    } catch (e) {
      return { valid: false, reason: 'Invalid JSON' };
    }

    const required = ['credentialEndpoint', 'authEndpoint', 'cookiePath'];
    for (const field of required) {
      if (!parsed[field]) {
        return { valid: false, reason: `Missing required field: ${field}` };
      }
    }

    // Validate HTTPS URLs
    for (const field of ['credentialEndpoint', 'authEndpoint']) {
      try {
        const url = new URL(parsed[field]);
        if (url.protocol !== 'https:') {
          return { valid: false, reason: `${field} must use HTTPS` };
        }
      } catch (e) {
        return { valid: false, reason: `${field} is not a valid URL` };
      }
    }

    // Check cookie file exists
    const cookiePath = parsed.cookiePath.replace(/^~/, os.homedir());
    if (!fs.existsSync(cookiePath)) {
      return { valid: false, reason: `Cookie file not found: ${parsed.cookiePath} — run mwinit first` };
    }

    return { valid: true, reason: 'Configuration valid' };
  }
}

module.exports = { EnterpriseCredentialProvider, parseIsengardProfile };
