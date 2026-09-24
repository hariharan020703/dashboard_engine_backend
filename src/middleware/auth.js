const { fail } = require('../api/response');
const { isRbacReady } = require('../auth/appMetaSchema');
const { verifyAccessToken } = require('../auth/tokenService');
const { findActorRow, publicUser } = require('../auth/userService');
const { buildActor, assertPermission } = require('../auth/authorization');
const { assertDashboardLevel } = require('../auth/accessService');
const { audit, EVENTS } = require('../auth/auditService');
const { readAccessCookie, requireCsrf } = require('./session');

/**
 * Request-level enforcement. Five guards, composed left to right on a route:
 *
 *   requireRbac              the metadata database is up
 *   requireAuth              a valid access-token cookie (plus the CSRF header on
 *                            anything but a read), resolved to a live account
 *   requirePlatform          that account is not bounded by a company
 *   requirePermission(id)    that account's role holds a permission
 *   requireDashboard(level)  that account holds a level on :dashboardId
 *
 * requireAuth attaches the whole picture to req.actor - role, company,
 * permissions and data scopes - so a handler never has to ask the database who
 * it is talking to a second time, and never has to decide for itself what the
 * company boundary is.
 */

/**
 * The API answers 503 while the metadata database is unreachable, rather than
 * 500 per query. Nothing downstream has to cope with a half-initialised schema.
 */
function requireRbac(req, res, next) {
  if (!isRbacReady()) {
    return next(fail('SERVICE_UNAVAILABLE', 'The service is starting up or its database is unreachable. Try again shortly.'));
  }
  next();
}

/*
 * The access token is read from its HttpOnly cookie only - never from a
 * response body the client stored, never from an Authorization header, never
 * from the query string (URLs leak into access logs, proxy logs and browser
 * history). One way in means one thing to reason about; see session.js for why
 * it is a cookie.
 */

// Methods that change nothing. Everything else must pass the CSRF check,
// because a cookie is attached whether or not our own page sent the request.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Resolves a token to a live account.
 *
 * Deliberately re-reads the account on every request instead of trusting the
 * claims: a role change, a deactivation, a company being switched off or a
 * deletion then takes effect on the next call rather than at token expiry.
 */
async function actorFromToken(token) {
  const payload = verifyAccessToken(token);
  const found = await findActorRow(Number(payload.sub));
  const user = found && found.user;

  if (!user) throw fail('UNAUTHENTICATED', 'This account no longer exists.');
  if (user.status === 'disabled') throw fail('ACCOUNT_DISABLED', 'This account has been deactivated.');
  if (user.status === 'pending') {
    throw fail('ACCOUNT_PENDING_ACTIVATION', 'This account has not been activated yet.');
  }
  if (user.company_id && !user.companyActive) {
    throw fail('COMPANY_DISABLED', 'This company is not currently active.');
  }

  /*
   * The role in the token must still be the role on the row. They differ only
   * when an administrator changed it after the token was minted - and that
   * change also revoked the refresh families, so the right outcome is to stop
   * here rather than serve one more request under the old role.
   */
  if (payload.rol !== user.role) {
    throw fail('UNAUTHENTICATED', 'Your access has changed. Please sign in again.');
  }

  const actor = buildActor(user, found.permissions);
  actor.scopes = found.scopes;
  actor.familyId = payload.fam;
  return { actor, account: publicUser(user) };
}

async function requireAuth(req, res, next) {
  // Already resolved for this request. /api/platform applies requireAuth and so
  // do the routers mounted beneath it (companies, users), so without this every
  // platform request resolved its actor twice - a second database round trip
  // with nothing new to learn.
  if (req.actor) return next();

  const token = readAccessCookie(req);
  if (!token) return next(fail('UNAUTHENTICATED', 'Sign in to continue.'));

  // Checked before the token is verified, so a forged cross-site request is
  // refused without costing a database read.
  if (!SAFE_METHODS.has(req.method)) {
    let csrfError = null;
    requireCsrf(req, res, (err) => { csrfError = err || null; });
    if (csrfError) return next(csrfError);
  }

  try {
    const { actor, account } = await actorFromToken(token);
    req.actor = actor;
    // The browser-safe account row, already read above, for handlers that
    // return it (/auth/me) - so none of them has to read it a second time.
    req.account = account;
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Blocks everything except the endpoints that resolve the block itself.
 *
 * An account flagged to change its password is authenticated - it has a valid
 * token and a real identity - but must not be able to read data with it. The
 * state is enforced here rather than trusted to the client, so a caller that
 * ignores the flag gets 403 rather than a dashboard.
 */
function requirePasswordCurrent(req, res, next) {
  if (req.actor && req.actor.mustChangePassword) {
    return next(fail('PASSWORD_CHANGE_REQUIRED', 'Choose a new password before continuing.'));
  }
  next();
}

/**
 * Restricts a route to platform accounts.
 *
 * This is the guard on the whole /api/platform namespace, and it is about the
 * ROLE SCOPE rather than about any one permission: the endpoints below it
 * operate across tenants, so "may read users" is not the question - "is this
 * caller bounded by a company" is. Permissions still apply underneath; a
 * platform account without `company.create` is still refused by the route.
 *
 * It reads actor.isPlatform, which buildActor derives from the role's scope in
 * the catalogue, so this is not a role-name comparison in disguise.
 */
function requirePlatform(req, res, next) {
  if (!req.actor) return next(fail('UNAUTHENTICATED', 'Sign in to continue.'));
  if (req.actor.isPlatform) return next();

  audit(EVENTS.ACCESS_DENIED, req.actor, {
    reason: 'platform_only',
    method: req.method,
    path: req.originalUrl.split('?')[0],
  });
  next(fail('TENANT_ACCESS_DENIED', 'This area is restricted to platform administrators.'));
}

/** Gate a route on one permission from auth/permissionCatalogue.js. */
function requirePermission(permission) {
  return function permissionGuard(req, res, next) {
    try {
      assertPermission(req.actor, permission);
      next();
    } catch (err) {
      if (req.actor && err.code === 'INSUFFICIENT_PERMISSION') {
        audit(EVENTS.ACCESS_DENIED, req.actor, {
          permission,
          method: req.method,
          path: req.originalUrl.split('?')[0],
        });
      }
      next(err);
    }
  };
}

/**
 * Gate a route on the caller's access level for the dashboard it names.
 *
 * This is the guard that closed the dashboard data endpoints. It checks both
 * gates in accessService - the dashboard is assigned to the caller's company,
 * and the caller holds a grant - before any query engine work begins, so no
 * row of another company's data is ever read, let alone returned.
 */
function requireDashboardAccess(level, param = 'dashboardId') {
  return async function dashboardGuard(req, res, next) {
    try {
      const dashboardId = req.params[param] || req.body?.dashboardId || req.query?.dashboardId;
      if (!dashboardId) {
        return next(fail('VALIDATION_ERROR', 'A dashboard id is required.'));
      }
      req.dashboardId = String(dashboardId);
      req.dashboardLevel = await assertDashboardLevel(req.actor, req.dashboardId, level);
      next();
    } catch (err) {
      if (req.actor && (err.code === 'DASHBOARD_NOT_FOUND' || err.code === 'INSUFFICIENT_PERMISSION')) {
        audit(EVENTS.ACCESS_DENIED, req.actor, {
          dashboardId: req.params[param] || null,
          requiredLevel: level,
          reason: err.code,
        });
      }
      next(err);
    }
  };
}

module.exports = {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePlatform,
  requirePermission,
  requireDashboardAccess,
  actorFromToken,
};
