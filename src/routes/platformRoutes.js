const express = require('express');
const { db, T } = require('../config/database');
const { ok } = require('../api/response');
const registry = require('../dashboard/dashboardRegistry');
const { describeTransport } = require('../email/emailService');
const { QUERY_CONCURRENCY } = require('../config/appConfig');
const {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  ACTIVATION_TOKEN_TTL_SECONDS,
  LOGIN_MAX_ATTEMPTS,
  LOGIN_WINDOW_SECONDS,
  LOGIN_LOCKOUT_SECONDS,
  MIN_PASSWORD_LENGTH,
  BCRYPT_ROUNDS,
  COOKIE_SECURE,
  COOKIE_SAMESITE,
} = require('../config/auth');
const companyRoutes = require('./companyRoutes');
const userRoutes = require('./userRoutes');
const roleRoutes = require('./roleRoutes');
const auditRoutes = require('./auditRoutes');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePlatform,
  requirePermission,
} = require('../middleware/auth');

/**
 * The platform console's API surface: /api/platform/*.
 *
 * The split is by SCOPE, not by resource. Everything mounted here operates
 * across tenants - the company directory, the cross-tenant user directory, the
 * permission model itself, the audit trail - so the whole namespace sits behind
 * requirePlatform and a company-scoped account is refused at the door rather
 * than by each handler.
 *
 * The routers below are the same objects mounted under /api for tenant-scoped
 * use. That is deliberate: the authorization in them already takes req.actor
 * and narrows by company, so mounting them twice adds a namespace without
 * adding a second copy of the rules. A platform-only clone of userRoutes would
 * be exactly the kind of duplicate authorization the design exists to avoid.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent, requirePlatform);

/**
 * GET /api/platform/overview - the counts the console's landing page shows.
 *
 * Every number here is a COUNT over a real table, computed in one round trip.
 * There is nothing derived, estimated or placeheld: a figure the console cannot
 * actually source is not reported, because a platform overview that invents a
 * number is worse than one that omits it.
 *
 * `dashboards` counts the registry on disk rather than a table - that is where
 * dashboards are defined - and `assignments` counts how many company/dashboard
 * pairs exist, which is the number that changes as customers are onboarded.
 */
router.get('/overview', requirePermission('company.read'), async (req, res) => {
  const { rows } = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM ${T.companies})                                  AS "companies",
       (SELECT COUNT(*) FROM ${T.companies} WHERE active)                     AS "companiesActive",
       (SELECT COUNT(*) FROM ${T.users} WHERE company_id IS NOT NULL)         AS "users",
       (SELECT COUNT(*) FROM ${T.users} WHERE status = 'active'
                                          AND company_id IS NOT NULL)         AS "usersActive",
       (SELECT COUNT(*) FROM ${T.users} WHERE status = 'pending'
                                          AND company_id IS NOT NULL)         AS "usersPending",
       (SELECT COUNT(*) FROM ${T.users} WHERE role = 'COMPANY_ADMIN')         AS "companyAdmins",
       (SELECT COUNT(*) FROM ${T.groups})                                     AS "groups",
       (SELECT COUNT(*) FROM ${T.companyDashboards})                          AS "assignments"`
  );

  const counts = rows[0];
  const numeric = Object.fromEntries(
    Object.entries(counts).map(([key, value]) => [key, Number(value)])
  );

  ok(res, {
    ...numeric,
    companiesInactive: numeric.companies - numeric.companiesActive,
    dashboards: (await registry.listDashboards()).length,
  });
});

/**
 * GET /api/platform/settings - the runtime configuration, as it actually is.
 *
 * Read from the live config objects rather than being restated here, so the
 * settings screen cannot drift from the process it claims to describe. The
 * screen used to print "15 Minutes" and "30 Days" as literals in the markup,
 * which is a number that stays right only until somebody changes the config.
 *
 * Nothing secret is included: lifetimes, limits and which transport is
 * configured, never a secret, a host or a credential.
 */
router.get('/settings', async (req, res) => {
  ok(res, {
    tokens: {
      accessTokenTtlSeconds: ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: REFRESH_TOKEN_TTL_SECONDS,
      activationTokenTtlSeconds: ACTIVATION_TOKEN_TTL_SECONDS,
    },
    login: {
      maxAttempts: LOGIN_MAX_ATTEMPTS,
      windowSeconds: LOGIN_WINDOW_SECONDS,
      lockoutSeconds: LOGIN_LOCKOUT_SECONDS,
    },
    password: {
      minLength: MIN_PASSWORD_LENGTH,
      bcryptRounds: BCRYPT_ROUNDS,
    },
    session: {
      cookieSecure: COOKIE_SECURE,
      cookieSameSite: COOKIE_SAMESITE,
    },
    engine: {
      queryConcurrency: QUERY_CONCURRENCY,
      dashboardCount: (await registry.listDashboards()).length,
    },
    email: describeTransport(),
  });
});

router.use('/companies', companyRoutes);
router.use('/users', userRoutes);
router.use('/roles', roleRoutes);
router.use('/audit', auditRoutes);

module.exports = router;
