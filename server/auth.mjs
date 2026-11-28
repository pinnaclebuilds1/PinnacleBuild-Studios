/**
 * Passwords, sessions and Google verification.
 *
 * Everything here uses Web Crypto only, so the exact same code runs on Node 18+
 * and inside a Cloudflare Worker.
 */

const ITERATIONS = 210000;
const KEY_BYTES = 32;
const encoder = new TextEncoder();

const toBase64 = (bytes) => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (value) => {
  const binary = atob(String(value));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    key,
    KEY_BYTES * 8
  );
  return new Uint8Array(bits);
}

/** Hash a password as `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** True when a stored value is a hash this build can check. */
export function isPasswordHash(stored) {
  return /^pbkdf2\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(String(stored || ''));
}

/** Constant-time password check against a stored hash. */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 2000000) return false;

  let salt;
  let expected;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }

  let actual;
  try {
    actual = await derive(password, salt, iterations);
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;

  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected[i] ^ actual[i];
  return diff === 0;
}

/** A long unpredictable session token. */
export function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${prefix}-${hex.toUpperCase()}`;
}

/**
 * Verify a Google Identity Services ID token server-side, with no client secret.
 * Returns the trusted claims, or throws a user-facing error.
 */
export async function verifyGoogleIdToken(credential, clientId) {
  const wanted = String(clientId || '').trim();
  if (!wanted) throw new Error('Google sign-in is not configured on this server yet.');
  const idToken = String(credential || '').trim();
  if (!idToken || idToken.length > 12000) throw new Error('Google sign-in did not return a valid credential.');

  const res = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`, {
    headers: { accept: 'application/json' }
  });
  if (res.status !== 200) throw new Error('Google could not verify this sign-in. Please try again.');

  let claims;
  try {
    claims = await res.json();
  } catch {
    throw new Error('Google returned an unreadable sign-in response.');
  }

  const issuer = String(claims.iss || '');
  const expiry = Number(claims.exp || 0);
  const emailVerified = claims.email_verified === true || String(claims.email_verified) === 'true';
  const audienceOk = String(claims.aud || '') === wanted;

  if (!audienceOk || !issuer.startsWith('accounts.google.com') || !claims.sub || !expiry) {
    throw new Error('Google sign-in could not be validated. Please try again.');
  }
  if (expiry * 1000 <= Date.now()) throw new Error('That Google sign-in has expired. Please try again.');
  if (!emailVerified) throw new Error('Your Google email address must be verified first.');

  return claims;
}
