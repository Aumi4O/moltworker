/**
 * PKCE (Proof Key for Code Exchange) for OpenAI Codex OAuth.
 * OpenAI requires PKCE; static auth links fail with "Authentication Error".
 */

const LOCALHOST_REDIRECT = 'http://localhost:1455/auth/callback';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
// Official Codex CLI client_id (from codex login flow - note: ends with double 'n')
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
// Minimal scopes per Codex docs; extra scopes may cause "Authentication Error"
const SCOPES = 'openid profile email offline_access';

/** Generate a cryptographically random string for code_verifier */
function randomString(length: number): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** Base64url encode (no padding) */
function base64UrlEncode(data: ArrayBuffer): string {
  const bytes = new Uint8Array(data);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Base64url decode */
function base64UrlDecode(str: string): ArrayBuffer {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

/** SHA-256 hash */
async function sha256(data: string | ArrayBuffer): Promise<ArrayBuffer> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return crypto.subtle.digest('SHA-256', bytes);
}

/** Encrypt code_verifier into state (avoids KV). Key derived from secret. */
async function encryptState(verifier: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const key = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('openclaw-pkce'), iterations: 100000 },
    keyMaterial,
    256,
  );
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    new TextEncoder().encode(verifier),
  );
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);
  return base64UrlEncode(combined.buffer);
}

/** Decrypt state to get code_verifier */
async function decryptState(state: string, secret: string): Promise<string> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret.padEnd(32, '0').slice(0, 32)),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const key = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode('openclaw-pkce'), iterations: 100000 },
    keyMaterial,
    256,
  );
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  const combined = new Uint8Array(base64UrlDecode(state));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv, tagLength: 128 },
    cryptoKey,
    ciphertext,
  );
  return new TextDecoder().decode(decrypted);
}

export interface PkceAuthUrlResult {
  authUrl: string;
  state: string;
}

export interface GeneratePkceOptions {
  redirectUri?: string;
}

/** Generate PKCE auth URL. State contains encrypted code_verifier. */
export async function generatePkceAuthUrl(
  secret: string,
  options?: GeneratePkceOptions,
): Promise<PkceAuthUrlResult> {
  const redirectUri = options?.redirectUri ?? LOCALHOST_REDIRECT;
  const codeVerifier = randomString(64);
  const challenge = base64UrlEncode(await sha256(codeVerifier));
  const state = await encryptState(codeVerifier, secret);

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

  return {
    authUrl: `${AUTH_URL}?${params.toString()}`,
    state,
  };
}

export interface TokenExchangeResult {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
}

/** Decode JWT payload (no verify - we trust OpenAI's response) */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = parts[1];
  const decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
  return JSON.parse(decoded) as Record<string, unknown>;
}

/** Extract profile ID from access token */
export function getProfileIdFromToken(accessToken: string): string {
  try {
    const payload = decodeJwtPayload(accessToken);
    const profile = payload['https://api.openai.com/profile'] as Record<string, unknown> | undefined;
    const email = (profile?.email ?? payload.email) as string | undefined;
    if (email) return `openai-codex:${email}`;
  } catch {
    // ignore
  }
  return 'openai-codex:default';
}

/** Exchange authorization code for tokens */
export async function exchangeCodeForTokens(
  code: string,
  codeVerifier: string,
  redirectUri: string = LOCALHOST_REDIRECT,
): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const err = await res.text();
    const errPreview = err.slice(0, 300);
    throw new Error(`Token exchange failed: ${res.status} ${errPreview}`);
  }

  const data = (await res.json()) as TokenExchangeResult & { expires_in?: number };
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in ?? 0,
    token_type: data.token_type,
  };
}

/** Parse callback URL to extract code and state */
export function parseCallbackUrl(url: string): { code: string; state: string } | null {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    if (code && state) return { code, state };
  } catch {
    // ignore
  }
  return null;
}

/** Decrypt state to recover code_verifier */
export async function decryptStateForExchange(state: string, secret: string): Promise<string> {
  return decryptState(state, secret);
}
