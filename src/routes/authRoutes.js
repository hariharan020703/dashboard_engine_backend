const express = require('express');
const { T, withTransaction } = require('../config/database');
const { ok, fail, requireString } = require('../api/response');
const {
  findUserByIdentifier,
  findUserById,
  findCredentialsById,
  publicUser,
  getRolePermissions,
  passwordProblem,
  recordLogin,
  verifyPassword,
  hashPassword,
} = require('../auth/userService');
const {
  issueAccessToken,
  issueRefreshToken,
  consumeRefreshToken,
  revokeFamily,
  revokeAllForUser,
  listSessions,
  ACCESS_TOKEN_TTL_SECONDS,
} = require('../auth/tokenService');
const { resolveActivationToken, consumeActivationToken } = require('../auth/activationService');
const throttle = require('../auth/loginThrottle');
const { listAccessibleDashboards } = require('../auth/accessService');
const { audit, EVENTS } = require('../auth/auditService');
const { requireRbac, requireAuth } = require('../middleware/auth');
const {
  setSessionCookies,
  clearSessionCookies,
  readRefreshCookie,
  requireCsrf,
} = require('../middleware/session');

/**
 * Sign-in, session lifecycle and self-service: the endpoints a person hits for
 * their own account. Everything about somebody else lives in the admin routers.
 *
 * The authentication states the client can observe are all produced here, and
 * each one is a distinct response rather than an absence of data:
 *
 *   UNAUTHENTICATED          401 from any guarded endpoint
 *   AUTHENTICATED            login or refresh returned a session
 *   PASSWORD_CHANGE_REQUIRED 403 PASSWORD_CHANGE_REQUIRED, or the flag on /me
 *   ACCOUNT_DISABLED         403 ACCOUNT_DISABLED
 *   SESSION_EXPIRED          401 TOKEN_EXPIRED / INVALID_REFRESH_TOKEN
 */
const router = express.Router();

router.use(requireRbac);

/**
 * The payload every path that establishes a session returns.
 *
 * No token is in it - not the access token, not the refresh token, not the
 * CSRF value. All three went out as cookies (session.js), and the two that
 * authenticate are HttpOnly, so no script on the page can ever read them. What
 * the body carries is only what the UI renders: who signed in and what they
 * may do.
 */
async function sessionPayload(user) {
  const permissions = await getRolePermissions(user.role);
  return {
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    user: { ...publicUser(user), permissions },
  };
}

/** Mints both tokens for a refresh family and writes them as cookies. */
function writeSession(res, user, refresh) {
  const accessToken = issueAccessToken(user, refresh.familyId);
  setSessionCookies(res, { accessToken, refreshToken: refresh.token });
}

/** Starts a brand new refresh family and writes the cookies. */
async function startSession(res, user) {
  writeSession(res, user, await issueRefreshToken(user.id));
  return sessionPayload(user);
}

/* ------------------------------------------------------------------ login --- */

// POST /api/auth/login - exchange credentials for a session
router.post('/login', async (req, res) => {
  const identifier = String((req.body || {}).identifier || (req.body || {}).username || '').trim();
  const password = String((req.body || {}).password || '');

  if (!identifier || !password) {
    throw fail('VALIDATION_ERROR', 'Enter your username or email and your password.');
  }

  // Checked before any hashing, so a locked identifier costs an attacker a
  // round trip rather than a bcrypt comparison.
  try {
    await throttle.assertNotLocked(identifier);
  } catch (err) {
    audit(EVENTS.LOGIN_BLOCKED, identifier, { reason: 'rate_limited' });
    throw err;
  }

  const user = await findUserByIdentifier(identifier);
  const passwordOk = user && verifyPassword(password, user.password_hash);

  /*
   * One message for every credential failure. Distinguishing "no such account"
   * from "wrong password" turns the login form into a directory of who works
   * here, and distinguishing "not activated" would say the same thing.
   *
   * A pending account has password_hash NULL, so it lands here naturally.
   */
  if (!user || !passwordOk) {
    await throttle.recordFailure(identifier);
    audit(EVENTS.LOGIN_FAILED, identifier, { known: Boolean(user) });
    throw fail('INVALID_CREDENTIALS', 'Incorrect username or password.');
  }

  // Account and company status are checked only once the password is known to
  // be right. A wrong password must not reveal that an account is disabled.
  if (user.status === 'disabled') {
    audit(EVENTS.LOGIN_FAILED, identifier, { reason: 'account_disabled' });
    throw fail('ACCOUNT_DISABLED', 'This account has been deactivated. Contact your administrator.');
  }
  if (user.company_id && !user.companyActive) {
    audit(EVENTS.LOGIN_FAILED, identifier, { reason: 'company_disabled' });
    throw fail('COMPANY_DISABLED', 'This company is not currently active. Contact your administrator.');
  }

  await throttle.recordSuccess(identifier);
  await recordLogin(user.id);

  const payload = await startSession(res, user);
  audit(EVENTS.LOGIN_SUCCESS, user, { role: user.role, companyId: user.company_id });

  /*
   * A session IS issued for an account that must change its password. It is
   * authenticated - it just cannot do anything else yet: requirePasswordCurrent
   * rejects every other endpoint until the change lands. Withholding the token
   * instead would mean the change-password call had nothing to authenticate
   * with.
   */
  ok(res, { ...payload, state: user.must_change_password ? 'PASSWORD_CHANGE_REQUIRED' : 'AUTHENTICATED' });
});

/* ---------------------------------------------------------------- refresh --- */

/*
 * POST /api/auth/refresh - rotate the refresh token and mint a new access token.
 *
 * Authenticates from the refresh cookie rather than through requireAuth, so it
 * carries its own CSRF check (as does logout).
 */
router.post('/refresh', requireCsrf, async (req, res) => {
  const presented = readRefreshCookie(req);
  let row;
  try {
    row = await consumeRefreshToken(presented);
  } catch (err) {
    // Whatever the reason, this browser's session is over. Clearing the cookies
    // stops it retrying with a token that will never work again.
    clearSessionCookies(res);
    if (err.code === 'INVALID_REFRESH_TOKEN') {
      audit(EVENTS.SESSION_REVOKED, 'anonymous', { reason: 'invalid_refresh_token' });
    }
    throw err;
  }

  const user = await findUserById(row.user_id);

  // Re-checked on every rotation, which is what bounds how long a deactivated
  // account can keep working: one access-token lifetime, not one refresh
  // lifetime.
  if (!user || user.status === 'disabled' || (user.company_id && !user.companyActive)) {
    await revokeFamily(row.family_id, 'account_unavailable');
    clearSessionCookies(res);
    audit(EVENTS.SESSION_REVOKED, user || 'unknown', { reason: 'account_unavailable' });
    throw fail('INVALID_REFRESH_TOKEN', 'Your session has ended. Please sign in again.');
  }

  const rotated = await issueRefreshToken(user.id, { familyId: row.family_id, replaces: row.id });
  writeSession(res, user, rotated);

  const payload = await sessionPayload(user);
  ok(res, { ...payload, state: user.must_change_password ? 'PASSWORD_CHANGE_REQUIRED' : 'AUTHENTICATED' });
});

/* ----------------------------------------------------------------- logout --- */

/*
 * POST /api/auth/logout - end the session for real.
 *
 * Revokes the whole family server-side before clearing the cookies. Deleting
 * the client's copy alone would leave a refresh token that still works for
 * anyone who captured it.
 */
router.post('/logout', requireCsrf, async (req, res) => {
  const presented = readRefreshCookie(req);

  if (presented) {
    try {
      const row = await consumeRefreshToken(presented);
      await revokeFamily(row.family_id, 'logout');
      audit(EVENTS.LOGOUT, { id: row.user_id, username: null }, { familyId: row.family_id });
    } catch {
      // Already invalid, already revoked, or reuse just tripped the detector.
      // Signing out is idempotent: the caller wanted the session gone, and it is.
    }
  }

  clearSessionCookies(res);
  ok(res, { state: 'UNAUTHENTICATED' });
});

/* --------------------------------------------------------------- identity --- */

// GET /api/auth/me - the signed-in account, its permissions and what it may open
router.get('/me', requireAuth, async (req, res) => {
  const actor = req.actor;
  const dashboards = actor.mustChangePassword ? [] : await listAccessibleDashboards(actor);

  ok(res, {
    state: actor.mustChangePassword ? 'PASSWORD_CHANGE_REQUIRED' : 'AUTHENTICATED',
    user: { ...req.account, permissions: actor.permissions },
    // Data scopes are not sent: no screen reads them from here (the person
    // screen reads a user's scopes from /users/:id/scope), and they are not
    // enforced yet.
    dashboards,
  });
});

// GET /api/auth/sessions - this account's live sessions, for the profile screen
router.get('/sessions', requireAuth, async (req, res) => {
  const sessions = await listSessions(req.actor.id);
  ok(res, sessions.map((s) => ({ ...s, current: s.familyId === req.actor.familyId })));
});

/* --------------------------------------------------------------- password --- */

/*
 * POST /api/auth/change-password
 *
 * Deliberately NOT behind requirePasswordCurrent: it is the one thing an
 * account in the PASSWORD_CHANGE_REQUIRED state has to be able to do.
 */
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = await findUserById(req.actor.id);
  const credentials = await findCredentialsById(req.actor.id);

  if (!verifyPassword(currentPassword, credentials && credentials.password_hash)) {
    throw fail('INVALID_CREDENTIALS', 'Your current password is incorrect.');
  }
  const problem = passwordProblem(newPassword);
  if (problem) throw fail('VALIDATION_ERROR', problem);
  if (newPassword === currentPassword) {
    throw fail('VALIDATION_ERROR', 'Your new password must differ from the current one.');
  }

  /*
   * Changing a password ends every other session, then starts a fresh one here.
   * That is the point of changing it after a suspected compromise: whoever else
   * was signed in is now signed out, including on the device that was lost.
   */
  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE ${T.users} SET password_hash = ?, must_change_password = FALSE, status = 'active'
        WHERE id = ?`,
      [hashPassword(newPassword), user.id]
    );
    await revokeAllForUser(user.id, 'password_changed', conn);
  });

  const refreshed = await findUserById(user.id);
  const payload = await startSession(res, refreshed);

  audit(EVENTS.PASSWORD_CHANGED, req.actor, { selfService: true });
  ok(res, { ...payload, state: 'AUTHENTICATED' });
});

/* ------------------------------------------------------------- activation --- */

/*
 * GET /api/auth/activation?token=... - describe an activation link.
 *
 * Public, and answers with the account's username and company so the set-
 * password screen can say who it is for. It reveals nothing a holder of the
 * link does not already have: possession of the link IS the authorisation.
 */
router.get('/activation', async (req, res) => {
  const row = await resolveActivationToken(req.query.token);
  ok(res, {
    username: row.username,
    email: row.email,
    displayName: row.display_name || null,
    companyName: row.companyName || null,
  });
});

// POST /api/auth/activation - set the password and sign the new account in
router.post('/activation', async (req, res) => {
  const token = requireString((req.body || {}).token, 'Activation token', { max: 200 });
  const password = (req.body || {}).password;

  const problem = passwordProblem(password);
  if (problem) throw fail('VALIDATION_ERROR', problem);

  const row = await resolveActivationToken(token);

  await withTransaction(async (conn) => {
    // Consumed first: if two requests race, the loser fails here rather than
    // both setting a password and the second silently winning.
    await consumeActivationToken(row.id, conn);
    await conn.query(
      `UPDATE ${T.users}
          SET password_hash = ?, status = 'active', must_change_password = FALSE
        WHERE id = ?`,
      [hashPassword(password), row.user_id]
    );
    await revokeAllForUser(row.user_id, 'account_activated', conn);
  });

  const user = await findUserById(row.user_id);
  await recordLogin(user.id);

  const payload = await startSession(res, user);
  audit(EVENTS.ACCOUNT_ACTIVATED, user, { companyId: user.company_id });
  ok(res, { ...payload, state: 'AUTHENTICATED' });
});

module.exports = router;
