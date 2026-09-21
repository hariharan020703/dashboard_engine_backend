const crypto = require('crypto');
const { db, T } = require('../config/database');
const { JWT_REFRESH_SECRET, ACTIVATION_TOKEN_TTL_SECONDS, APPLICATION_URL } = require('../config/auth');
const { fail } = require('../api/response');

/**
 * Single-use links sent by email.
 *
 * One purpose today - `activation`, which covers both first onboarding and an
 * administrator reissuing access to an account whose owner has lost it. There
 * is no separate "admin sets a temporary password" path, on purpose: a
 * credential that two people have seen is a credential, and the whole point of
 * the link is that nobody but the recipient ever holds one.
 *
 * The raw token exists only in the email. What is stored is an HMAC under the
 * same secret that keys refresh tokens, so a database dump cannot be turned
 * into a working activation link.
 */

const PURPOSE_ACTIVATION = 'activation';

function hashToken(raw) {
  return crypto.createHmac('sha256', JWT_REFRESH_SECRET).update(String(raw)).digest('hex');
}

/**
 * Issues an activation token for an account, invalidating any earlier one.
 *
 * Reissuing must retire the previous link: an administrator who resends because
 * "the first one did not arrive" is usually right, but if it did arrive
 * somewhere it should not have, leaving it live defeats the resend.
 */
async function issueActivationToken(userId, issuedBy, conn) {
  const client = conn || db;

  await client.query(
    `UPDATE ${T.userTokens} SET consumed_at = now()
      WHERE user_id = ? AND purpose = ? AND consumed_at IS NULL`,
    [userId, PURPOSE_ACTIVATION]
  );

  const id = crypto.randomUUID();
  const raw = crypto.randomBytes(48).toString('base64url');
  const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_SECONDS * 1000);

  await client.query(
    `INSERT INTO ${T.userTokens} (id, user_id, purpose, token_hash, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, PURPOSE_ACTIVATION, hashToken(raw), expiresAt, issuedBy || null]
  );

  return { token: raw, expiresAt };
}

/**
 * The URL that goes in the email.
 *
 * Built from configuration, never from the request's Host header: an activation
 * link is exactly the thing a host-header injection would want to redirect.
 */
function activationUrl(token) {
  return `${APPLICATION_URL}/activate?token=${encodeURIComponent(token)}`;
}

/**
 * Resolves a presented token to the account it activates.
 *
 * Returns the token row and the user together, so the caller can show who is
 * being activated before asking for a password without a second lookup.
 */
async function resolveActivationToken(raw) {
  if (!raw || typeof raw !== 'string') {
    throw fail('INVALID_ACTIVATION_TOKEN', 'That activation link is not valid.');
  }

  const { rows } = await db.query(
    `SELECT t.id, t.user_id, t.expires_at, t.consumed_at,
            u.username, u.email, u.display_name, u.status, u.company_id,
            c.name AS "companyName", c.active AS "companyActive"
       FROM ${T.userTokens} t
       JOIN ${T.users} u ON u.id = t.user_id
       LEFT JOIN ${T.companies} c ON c.id = u.company_id
      WHERE t.token_hash = ? AND t.purpose = ?`,
    [hashToken(raw), PURPOSE_ACTIVATION]
  );
  const row = rows[0];

  // One message for every failure: a link that has been used, has expired or
  // was never real are all "ask your administrator for a new one", and telling
  // them apart only helps someone probing with guessed tokens.
  const invalid = () =>
    fail('INVALID_ACTIVATION_TOKEN', 'That activation link is no longer valid. Ask your administrator to send a new one.');

  if (!row) throw invalid();
  if (row.consumed_at) throw invalid();
  if (new Date(row.expires_at).getTime() <= Date.now()) throw invalid();
  if (row.status === 'disabled') {
    throw fail('ACCOUNT_DISABLED', 'This account has been deactivated.');
  }
  if (row.company_id && !row.companyActive) {
    throw fail('COMPANY_DISABLED', 'This company is not currently active.');
  }

  return row;
}

/** Marks a token used. Called in the same transaction that sets the password. */
async function consumeActivationToken(tokenId, conn) {
  const client = conn || db;
  const result = await client.query(
    `UPDATE ${T.userTokens} SET consumed_at = now() WHERE id = ? AND consumed_at IS NULL`,
    [tokenId]
  );
  if (!result.rowCount) {
    // Two requests raced for the same link; the loser must not also succeed.
    throw fail('INVALID_ACTIVATION_TOKEN', 'That activation link has already been used.');
  }
}

module.exports = {
  PURPOSE_ACTIVATION,
  issueActivationToken,
  activationUrl,
  resolveActivationToken,
  consumeActivationToken,
};
