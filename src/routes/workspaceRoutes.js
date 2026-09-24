const express = require('express');
const { db, T } = require('../config/database');
const { ok, fail } = require('../api/response');
const companies = require('../auth/companyService');
const access = require('../auth/accessService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../middleware/auth');

/**
 * The customer workspace's own endpoints: /api/workspace/*.
 *
 * Everything here answers about ONE company - the caller's - and the company is
 * taken from req.actor, never from the request. There is no companyId parameter
 * on any of these routes, which is the strongest form the rule can take: a
 * caller cannot ask about another tenant because there is nowhere to say which
 * tenant they mean.
 *
 * A platform account has no company of its own, so these routes refuse it and
 * say where to go instead. That is not a limitation to work around - the
 * platform console reads the same facts through /api/platform, scoped the way a
 * platform account needs.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

/**
 * The caller's company id, or an explicit refusal.
 *
 * Reached only by a platform account, and it is a routing mistake rather than
 * an attack - so the message points at the right namespace instead of being a
 * flat denial.
 */
function tenantId(actor) {
  if (actor.isPlatform) {
    throw fail(
      'TENANT_ACCESS_DENIED',
      'A platform account has no workspace of its own. Use the platform console.'
    );
  }
  return actor.companyId;
}

/**
 * GET /api/workspace/company - the company the caller belongs to.
 *
 * Replaces the company administrator's use of the platform company list, which
 * returned a one-element array they then had to unwrap. This asks the question
 * they actually have.
 */
router.get('/company', requirePermission('company.read'), async (req, res) => {
  ok(res, await companies.requireCompany(req.actor, tenantId(req.actor), { counts: true }));
});

/**
 * GET /api/workspace/overview - the counts the workspace landing page shows.
 *
 * Real counts over the caller's own company, in one round trip, with the
 * company id bound as a parameter rather than interpolated. Nothing is
 * estimated and nothing is invented: a company with no groups reports zero
 * groups and the page renders its empty state.
 *
 * `dashboards` is how many are assigned to the company; `dashboardsGranted` is
 * how many the caller personally holds, which is the smaller and more useful
 * number on a USER's screen.
 */
router.get('/overview', async (req, res) => {
  const companyId = tenantId(req.actor);

  // Counts and the caller's own dashboard count are independent reads, run
  // concurrently. The dashboard count is COUNTed in SQL rather than by building
  // the whole accessible list to take its length.
  const [{ rows }, dashboardsGranted] = await Promise.all([db.query(
    `SELECT
       (SELECT COUNT(*) FROM ${T.users}  WHERE company_id = ?)                  AS "users",
       (SELECT COUNT(*) FROM ${T.users}  WHERE company_id = ? AND status = 'active')  AS "usersActive",
       (SELECT COUNT(*) FROM ${T.users}  WHERE company_id = ? AND status = 'pending') AS "usersPending",
       (SELECT COUNT(*) FROM ${T.groups} WHERE company_id = ?)                  AS "groups",
       (SELECT COUNT(*) FROM ${T.groups} WHERE company_id = ? AND active)       AS "groupsActive",
       (SELECT COUNT(*) FROM ${T.companyDashboards} WHERE company_id = ?)       AS "dashboards"`,
    [companyId, companyId, companyId, companyId, companyId, companyId]
  ), access.countAccessibleDashboards(req.actor)]);

  const numeric = Object.fromEntries(
    Object.entries(rows[0]).map(([key, value]) => [key, Number(value)])
  );

  // The company record is not repeated here: the overview screen shows the
  // counts, and the company is read by the screens that display it.
  ok(res, { ...numeric, dashboardsGranted });
});

module.exports = router;
