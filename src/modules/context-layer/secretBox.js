const crypto = require('crypto');
require('../../config/env');
const { required, ConfigError } = require('../../config/configError');

/**
 * Reversible encryption for the third-party credentials this module stores.
 *
 * Everything else the platform keeps secret is one-way: passwords are bcrypt
 * hashes, refresh and activation tokens are HMACs. Nothing needs the original
 * back, so nothing can leak it.
 *
 * A warehouse credential is different. The application has to present the
 * actual token to Domo on every call, so it must be able to recover it - which
 * means encryption, not hashing, and means the key lives outside the database.
 * A dump of `context_connections` on its own is useless; a dump plus the
 * environment is not, which is the honest limit of what this buys.
 *
 * AES-256-GCM rather than CBC: the tag makes tampering a decryption failure
 * instead of a silently different plaintext, and a row someone has edited
 * should fail loudly rather than send a mangled token to a third party.
 */

const MIN_SECRET_LENGTH = 32;

const CREDENTIAL_SECRET = required(
  'CREDENTIAL_SECRET',
  'the key that encrypts stored warehouse credentials. Generate with: ' +
  'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
);

if (CREDENTIAL_SECRET.length < MIN_SECRET_LENGTH) {
  throw new ConfigError(
    `CREDENTIAL_SECRET must be at least ${MIN_SECRET_LENGTH} characters. ` +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64url\'))"'
  );
}

/*
 * The configured value is text of arbitrary length; AES-256 needs exactly 32
 * bytes. SHA-256 of the secret is a fixed, deterministic derivation - it adds
 * no entropy, which is why the length floor above matters and why the variable
 * is documented as "generate, do not invent".
 */
const KEY = crypto.createHash('sha256').update(CREDENTIAL_SECRET, 'utf8').digest();

/*
 * Versioned so a future key rotation can tell old ciphertext from new. Without
 * it, changing the scheme means every stored row becomes an undiagnosable
 * decryption failure.
 */
const VERSION = 'v1';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for

/** Encrypts a string into a self-describing, storable token. */
function seal(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext) {
    throw new Error('seal() requires a non-empty string');
  }
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64url'),
    tag.toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Recovers a sealed string.
 *
 * Throws on anything that is not intact and authentic: a changed key, an edited
 * row, a truncated column. The caller turns that into "this connection needs
 * its token re-entered", which is the only honest recovery - the original is
 * not retrievable from here.
 */
function open(sealed) {
  if (typeof sealed !== 'string') throw new Error('open() requires a string');

  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error('Stored credential is not in the expected format');
  }

  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    KEY,
    Buffer.from(ivB64, 'base64url')
  );
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * The last four characters, for showing which token is configured without
 * showing the token.
 *
 * Four, not eight: enough to tell two tokens apart on a screen, not enough to
 * shorten a search for the rest.
 */
function hint(plaintext) {
  const value = String(plaintext || '');
  return value.length <= 4 ? '****' : `••••${value.slice(-4)}`;
}

module.exports = { seal, open, hint };
