const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { db, T } = require('../config/database');
const {
  JWT_ACCESS_SECRET,
  JWT_REFRESH_SECRET,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
} = require('../config/auth');
const { fail } = require('../api/response');

/**
 * Access tokens, refresh sessions, rotation and revocation.
 *
 * The split of responsibility between the two tokens:
 *
 *   access token   short-lived JWT, sent as `Authorization: Bearer`. Carries
 *                  identity only - no permissions, no company name, nothing
 *                  that a change elsewhere could make stale. Cannot be revoked,
 *                  which is why it is measured in minutes.
 *
 *   refresh token  long-lived opaque secret, sent only as an HttpOnly cookie on
 *                  /api/auth. Exists as a row, so it can be revoked, rotated
 *                  and audited. Never leaves the server in a JSON body.
 *
 * Rotation: every refresh issues a new token and marks the old one replaced.
 * Presenting a token that has already been replaced means two parties hold the
 * same secret, so the entire family - the whole login chain - is revoked at
 * once and both of them have to sign in again. That is the intended outcome:
 * the alternative is letting a thief and a victim take turns refreshing
 * indefinitely.
 */

const ACCESS_TOKEN_TYPE = 'access';

/**
 * The stored form of a refresh token: HMAC-SHA256 under JWT_REFRESH_SECRET.
 *
 * A plain hash would let anyone holding a database dump verify guesses offline.
 * Keying it means the table is useless without a secret that lives in the
 * environment, not in the database.
 */
function hashRefreshToken(raw) {
  return crypto.createHmac('sha256', JWT_REFRESH_SECRET).update(String(raw)).digest('hex');
}

/* --------------------------------------------------------- access tokens --- */

/**
 * Signs an access token.
 *
 * Claims are identity only: who this is, which company they were in, and which
 * refresh family issued it. Permissions are deliberately absent - middleware
 * re-reads them per request, so revoking a permission takes effect on the next
 * call rather than whenever the token happens to expire.
 */
function issueAccessToken(user, familyId) {
  return jwt.sign(
    {
      sub: String(user.id),
      cid: user.company_id ?? null,
      rol: user.role,
      fam: familyId,
      typ: ACCESS_TOKEN_TYPE,
      /*
       * A unique id per token, so no two are ever byte-identical.
       *
       * Without it, two tokens minted in the same second for the same account
       * and the same family carry identical claims - "iat" and "exp" have
       * one-second resolution - and JWT signing is deterministic, so a refresh
       * that lands in the same second as the login returns the very token it
       * was meant to replace. Harmless in itself, but it makes a token
       * indistinguishable in a log, and it means that refresh did not actually
       * extend anything.
       */
      jti: crypto.randomUUID(),
    },
    JWT_ACCESS_SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
  );
}

/** Verifies an access token, or throws the API error the client should see. */
function verifyAccessToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, JWT_ACCESS_SECRET);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw fail('TOKEN_EXPIRED', 'Your session has expired.');
    }
    throw fail('UNAUTHENTICATED', 'Your session is not valid.');
  }
  // A refresh token is signed differently and would never verify here, but
  // checking the type keeps the two from ever being interchangeable if that
  // changes.
  if (payload.typ !== ACCESS_TOKEN_TYPE) {
    throw fail('UNAUTHENTICATED', 'Your session is not valid.');
  }
  return payload;
}

/* -------------------------------------------------------- refresh tokens --- */

function expiryDate(seconds) {
  return new Date(Date.now() + seconds * 1000);
}

/**
 * Issues a refresh token, either starting a family (login) or continuing one
 * (rotation).
 *
 * Returns the raw secret exactly once. It is never stored, never logged and
 * never put in a response body - the caller's only correct move is to set it as
 * a cookie.
 */
async function issueRefreshToken(userId, { familyId, replaces } = {}, conn) {
  const client = conn || db;
  const id = crypto.randomUUID();
  const family = familyId || crypto.randomUUID();
  const raw = crypto.randomBytes(48).toString('base64url');

  await client.query(
    `INSERT INTO ${T.refreshTokens} (id, family_id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, family, userId, hashRefreshToken(raw), expiryDate(REFRESH_TOKEN_TTL_SECONDS)]
  );

  if (replaces) {
    await client.query(
      `UPDATE ${T.refreshTokens}
          SET revoked_at = now(), revoked_reason = 'rotated', replaced_by = ?
        WHERE id = ? AND revoked_at IS NULL`,
      [id, replaces]
    );
  }

  return { id, familyId: family, token: raw, expiresAt: expiryDate(REFRESH_TOKEN_TTL_SECONDS) };
}

async function revokeFamily(familyId, reason, conn) {
  const client = conn || db;
  await client.query(
    `UPDATE ${T.refreshTokens}
        SET revoked_at = now(), revoked_reason = ?
      WHERE family_id = ? AND revoked_at IS NULL`,
    [reason, familyId]
  );
}

/**
 * Ends every session an account has.
 *
 * Called on password change, deactivation, role change and company
 * deactivation. Each of those changes what the account is allowed to do, and an
 * access token already in flight cannot be recalled - revoking the refresh
 * families is what stops the holder minting a fresh one.
 */
async function revokeAllForUser(userId, reason, conn) {
  const client = conn || db;
  const result = await client.query(
    `UPDATE ${T.refreshTokens}
        SET revoked_at = now(), revoked_reason = ?
      WHERE user_id = ? AND revoked_at IS NULL`,
    [reason, userId]
  );
  return result.rowCount;
}

/** Every live session of every account in a company, in one statement. */
async function revokeAllForCompany(companyId, reason, conn) {
  const client = conn || db;
  const result = await client.query(
    `UPDATE ${T.refreshTokens}
        SET revoked_at = now(), revoked_reason = ?
      WHERE revoked_at IS NULL
        AND user_id IN (SELECT id FROM ${T.users} WHERE company_id = ?)`,
    [reason, companyId]
  );
  return result.rowCount;
}

/**
 * Validates a presented refresh token and returns its row.
 *
 * The three failure modes are deliberately one error code with one message. A
 * client can do nothing different for "expired" than for "revoked" - both mean
 * sign in again - and saying which is which tells an attacker holding a stolen
 * token whether the theft has been noticed.
 */
async function consumeRefreshToken(raw) {
  if (!raw || typeof raw !== 'string') {
    throw fail('INVALID_REFRESH_TOKEN', 'Your session has ended. Please sign in again.');
  }

  const { rows } = await db.query(
    `SELECT id, family_id, user_id, expires_at, revoked_at, revoked_reason
       FROM ${T.refreshTokens} WHERE token_hash = ?`,
    [hashRefreshToken(raw)]
  );
  const row = rows[0];

  if (!row) {
    throw fail('INVALID_REFRESH_TOKEN', 'Your session has ended. Please sign in again.');
  }

  if (row.revoked_at) {
    /*
     * A revoked token was just presented. If it was revoked by rotation, the
     * legitimate holder has already moved on and this is a replay of a copy -
     * so the copy and the current token are both burned.
     *
     * Revoking on any revoked-token replay, not only the rotated case, costs a
     * signed-out session in the benign race (two tabs refreshing at once) and
     * closes the window in the hostile one. That trade is the right way round.
     */
    await revokeFamily(row.family_id, 'reuse_detected');
    console.warn(
      `[auth] refresh token reuse detected for user ${row.user_id}; ` +
      `family ${row.family_id} revoked (previous reason: ${row.revoked_reason})`
    );
    throw fail('INVALID_REFRESH_TOKEN', 'Your session has ended. Please sign in again.');
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw fail('INVALID_REFRESH_TOKEN', 'Your session has ended. Please sign in again.');
  }

  return row;
}

/**
 * Deletes refresh rows that are long past being useful.
 *
 * Revoked rows are kept for a grace period rather than deleted immediately:
 * reuse detection works by finding the revoked row, and a row that has been
 * deleted is indistinguishable from a token that never existed.
 */
async function pruneExpiredTokens() {
  const result = await db.query(
    `DELETE FROM ${T.refreshTokens}
      WHERE expires_at < (now() - interval '7 days')
         OR (revoked_at IS NOT NULL AND revoked_at < (now() - interval '7 days'))`
  );
  return result.rowCount;
}

/** Live sessions for one account, for the profile screen. No secrets included. */
async function listSessions(userId) {
  const { rows } = await db.query(
    // What the sessions list shows: which session, and when it was last used.
    `SELECT family_id AS "familyId", MAX(issued_at) AS "lastUsedAt"
       FROM ${T.refreshTokens}
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > now()
      GROUP BY family_id
      ORDER BY MAX(issued_at) DESC`,
    [userId]
  );
  return rows;
}

module.exports = {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  issueAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeFamily,
  revokeAllForUser,
  revokeAllForCompany,
  pruneExpiredTokens,
  listSessions,
};
