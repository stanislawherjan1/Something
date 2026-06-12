/**
 * AES-256-GCM encryption for integration credentials.
 *
 * Master key lives at /run/secrets/integrations.key inside the container
 * (bind-mounted from /srv/<ide>/secrets/integrations.key on the host, mode
 * 0600, owned by root). The key never touches PROJECT_DIR or .env — separate
 * blast radius. workspace-api reads it once at startup; if missing, the
 * integrations API responds 503 fail-closed (no plaintext fallback).
 *
 * Format on disk per credential field:
 *   { iv: <base64>, ciphertext: <base64>, tag: <base64> }
 *
 * Each field encrypted independently with a fresh IV. AES-GCM provides both
 * confidentiality and integrity (auth tag) — tampered ciphertext fails to
 * decrypt rather than producing garbage plaintext.
 */

import { readFileSync } from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const KEY_PATH = process.env.INTEGRATIONS_KEY_PATH || '/run/secrets/integrations.key';

// Lazy-load: cached after first successful read; null when unavailable.
let cachedKey = null;
let lastError = null;

function loadKey() {
  if (cachedKey) return cachedKey;
  try {
    const raw = readFileSync(KEY_PATH, 'utf8').trim();
    // Accept hex (preferred — `openssl rand -hex 32`) or base64.
    let buf;
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      buf = Buffer.from(raw, 'hex');
    } else if (/^[A-Za-z0-9+/=]+$/.test(raw) && Buffer.from(raw, 'base64').length === 32) {
      buf = Buffer.from(raw, 'base64');
    } else {
      throw new Error('master key must be 32 bytes (64 hex chars or base64)');
    }
    cachedKey = buf;
    lastError = null;
    return cachedKey;
  } catch (err) {
    lastError = err;
    cachedKey = null;
    return null;
  }
}

// Try once at import so a missing/invalid key surfaces in startup logs.
loadKey();
if (!cachedKey) {
  process.stderr.write(`[integrations-crypto] master key unavailable at ${KEY_PATH}: ${lastError?.message || 'unknown'}\n`);
  process.stderr.write(`[integrations-crypto] integrations API will respond 503 until the key is mounted.\n`);
}

/** True when encryption is configured. UI/API gate everything behind this. */
export function isReady() {
  return loadKey() !== null;
}

/** Diagnostic message — returned in 503 responses so admin sees what's wrong. */
export function readinessError() {
  return lastError ? lastError.message : 'master key not loaded';
}

/**
 * Encrypt one credential value. Returns the on-disk record.
 * Throws if encryption is not configured — callers should check isReady first.
 */
export function encryptValue(plaintext) {
  const key = loadKey();
  if (!key) throw new Error('encryption not configured');

  const iv = randomBytes(12);                            // GCM standard IV size
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv:         iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag:        tag.toString('base64'),
  };
}

/**
 * Decrypt one record. Returns the original UTF-8 plaintext.
 * Throws on missing key or invalid auth tag (= tampered or wrong key).
 */
export function decryptValue(record) {
  const key = loadKey();
  if (!key) throw new Error('encryption not configured');
  if (!record || typeof record !== 'object') throw new Error('invalid record');

  const iv  = Buffer.from(record.iv,         'base64');
  const ct  = Buffer.from(record.ciphertext, 'base64');
  const tag = Buffer.from(record.tag,        'base64');

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

/**
 * Build a redacted summary of an encrypted record for UI display:
 * `{ length, last4 }`. We decrypt once on the server to compute these,
 * never sending plaintext over the wire. Returns null if decryption fails.
 */
export function summariseRecord(record) {
  try {
    const plain = decryptValue(record);
    const last4 = plain.length >= 4 ? plain.slice(-4) : plain;
    return { length: plain.length, last4 };
  } catch {
    return null;
  }
}
