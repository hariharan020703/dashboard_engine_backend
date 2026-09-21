const { fail } = require('../api/response');
const { isRbacReady } = require('../auth/appMetaSchema');
const { verifyAccessToken } = require('../auth/tokenService');
const { findUserById, getRolePermissions } = require('../auth/userService');
const { getUserScopes } = require('../auth/scopeService');
const { buildActor, assertPermission } = require('../auth/authorization');
const { assertDashboardLevel } = require('../auth/accessService');
const { audit, EVENTS } = require('../auth/auditService');

/**
 * Request-level enforcement. Four guards, composed left to right on a route:
 *
 *   requireRbac              the metadata database is up
 *   requireAuth              a valid access token, resolved to a live account
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

/**
 * Bearer header only. Access tokens are not accepted in the query string: URLs
 * leak into access logs, proxy logs and browser history.
 */
function bearerToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : null;
}

/**
 * Resolves a token to a live account.
 *
 * Deliberately re-reads the account on every request instead of trusting the
 * claims: a role change, a deactivation, a company being switched off or a
 * deletion then takes effect on the next call rather than at token expiry.
 */
async function actorFromToken(token) {
  const payload = verifyAccessToken(token);
  const user = await findUserById(Number(payload.sub));

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

  const permissions = await getRolePermissions(user.role);
  const actor = buildActor(user, permissions);
  actor.scopes = await getUserScopes(user.id);
  actor.familyId = payload.fam;
  return actor;
}

async function requireAuth(req, res, next) {
  const token = bearerToken(req);
  if (!token) return next(fail('UNAUTHENTICATED', 'Sign in to continue.'));
  try {
    req.actor = await actorFromToken(token);
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
  requirePermission,
  requireDashboardAccess,
  actorFromToken,
};
