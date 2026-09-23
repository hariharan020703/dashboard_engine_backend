const express = require('express');
const { ok, fail, requireId } = require('../api/response');
const access = require('../auth/accessService');
const users = require('../auth/userService');
const groups = require('../auth/groupService');
const companies = require('../auth/companyService');
const { ACCESS_LEVELS, ACCESS_LEVEL_LABELS } = require('../auth/permissionCatalogue');
const { resolveTargetCompany } = require('../auth/authorization');
const { audit, EVENTS } = require('../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../middleware/auth');

/**
 * Dashboard grants: who may open which dashboard, and at what level.
 *
 * Every write here passes three checks before it touches a row, in this order:
 *
 *   1. the caller holds access.grant / access.revoke;
 *   2. the SUBJECT of the grant - the user or group - is in the caller's
 *      company, resolved by a scoped lookup that 404s otherwise;
 *   3. the DASHBOARD is assigned to that company.
 *
 * Skip any one of them and the id in the URL becomes a way out of the tenant.
 * Check 3 is the one that is easy to forget, because 1 and 2 already feel like
 * enough - they are not: a company administrator legitimately controls their
 * own users, so without it they could grant those users any dashboard in the
 * registry.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

/** The company a grant is being made in, and the dashboard, both validated. */
async function resolveGrantTarget(actor, requestedCompanyId, dashboardId) {
  const companyId = resolveTargetCompany(actor, requestedCompanyId);
  await companies.requireCompany(actor, companyId);
  const id = await access.requireDashboardId(dashboardId);
  await access.assertDashboardAssigned(actor, companyId, id);
  return { companyId, dashboardId: id };
}

/* ------------------------------------------------------------------ reads --- */

/*
 * GET /api/access/levels - what each per-dashboard level means, in words.
 *
 * Lives here rather than under /api/platform/roles because it is the vocabulary
 * a COMPANY_ADMIN's access screens render: they hand out levels, so they need
 * the labels. Role and permission MANAGEMENT stayed platform-only; describing a
 * level is not management.
 *
 * Ranked weakest first, which is the order the pickers show them in.
 */
router.get('/levels', requirePermission('access.read'), (req, res) => {
  ok(res, ACCESS_LEVELS.map((id) => ({ id, description: ACCESS_LEVEL_LABELS[id] })));
});

// GET /api/access/dashboards - the dashboards the caller may open
router.get('/dashboards', async (req, res) => {
  ok(res, await access.listAccessibleDashboards(req.actor));
});

/*
 * GET /api/access/dashboards/grantable - what the caller may hand out.
 *
 * For a company administrator this is their company's assignments, not the
 * whole registry. The picker therefore cannot even offer a dashboard the
 * backend would refuse.
 */
router.get('/dashboards/grantable', requirePermission('access.grant'), async (req, res) => {
  const companyId = resolveTargetCompany(req.actor, req.query.companyId);
  await companies.requireCompany(req.actor, companyId);
  ok(res, await access.listCompanyDashboards(companyId));
});

// GET /api/access/dashboards/:dashboardId/grants - who holds this dashboard
router.get('/dashboards/:dashboardId/grants', requirePermission('access.read'), async (req, res) => {
  const { companyId, dashboardId } = await resolveGrantTarget(
    req.actor,
    req.query.companyId,
    req.params.dashboardId
  );
  ok(res, await access.listDashboardGrants(companyId, dashboardId));
});

/* ----------------------------------------------------------- user grants --- */

// PUT /api/access/dashboards/:dashboardId/users/:userId - grant or change a level
router.put('/dashboards/:dashboardId/users/:userId', requirePermission('access.grant'), async (req, res) => {
  const userId = requireId(req.params.userId, 'user id');
  const level = access.requireLevel((req.body || {}).level);

  // Scoped lookup: another company's user is a 404, not a 403 with a hint.
  const target = await users.requireUserInScope(req.actor, userId);
  const { dashboardId } = await resolveGrantTarget(req.actor, target.company_id, req.params.dashboardId);

  await access.grantUserAccess(userId, dashboardId, level, req.actor.id);
  audit(EVENTS.ACCESS_GRANTED, req.actor, {
    dashboardId,
    userId,
    targetUsername: target.username,
    companyId: target.company_id,
    level,
  });
  ok(res, { dashboardId, userId, level });
});

// DELETE /api/access/dashboards/:dashboardId/users/:userId - revoke a direct grant
router.delete('/dashboards/:dashboardId/users/:userId', requirePermission('access.revoke'), async (req, res) => {
  const userId = requireId(req.params.userId, 'user id');
  const target = await users.requireUserInScope(req.actor, userId);
  const { dashboardId } = await resolveGrantTarget(req.actor, target.company_id, req.params.dashboardId);

  const removed = await access.revokeUserAccess(userId, dashboardId);
  if (!removed) {
    throw fail('RESOURCE_NOT_FOUND', 'That account holds no direct grant on this dashboard.');
  }

  audit(EVENTS.ACCESS_REVOKED, req.actor, {
    dashboardId,
    userId,
    targetUsername: target.username,
    companyId: target.company_id,
  });
  ok(res, { dashboardId, userId, revoked: true });
});

/* ---------------------------------------------------------- group grants --- */

// PUT /api/access/dashboards/:dashboardId/groups/:groupId - grant to a whole team
router.put('/dashboards/:dashboardId/groups/:groupId', requirePermission('access.grant'), async (req, res) => {
  const groupId = requireId(req.params.groupId, 'group id');
  const level = access.requireLevel((req.body || {}).level);

  const group = await groups.requireGroupInScope(req.actor, groupId);
  const { dashboardId } = await resolveGrantTarget(req.actor, group.companyId, req.params.dashboardId);

  await access.grantGroupAccess(groupId, dashboardId, level, req.actor.id);
  audit(EVENTS.ACCESS_GRANTED, req.actor, {
    dashboardId,
    groupId,
    groupName: group.name,
    companyId: group.companyId,
    level,
  });
  ok(res, { dashboardId, groupId, level });
});

// DELETE /api/access/dashboards/:dashboardId/groups/:groupId - revoke from a team
router.delete('/dashboards/:dashboardId/groups/:groupId', requirePermission('access.revoke'), async (req, res) => {
  const groupId = requireId(req.params.groupId, 'group id');
  const group = await groups.requireGroupInScope(req.actor, groupId);
  const { dashboardId } = await resolveGrantTarget(req.actor, group.companyId, req.params.dashboardId);

  const removed = await access.revokeGroupAccess(groupId, dashboardId);
  if (!removed) {
    throw fail('RESOURCE_NOT_FOUND', 'That group holds no grant on this dashboard.');
  }

  audit(EVENTS.ACCESS_REVOKED, req.actor, {
    dashboardId,
    groupId,
    groupName: group.name,
    companyId: group.companyId,
  });
  ok(res, { dashboardId, groupId, revoked: true });
});

/*
 * GET /api/access/groups/:groupId/dashboards - what one group carries.
 *
 * Answered from the company's assigned dashboards rather than by asking each
 * dashboard who holds it, which is what the group screen used to do: that was
 * one request per dashboard in the registry, every time the screen opened.
 */
router.get('/groups/:groupId/dashboards', requirePermission('access.read'), async (req, res) => {
  const group = await groups.requireGroupInScope(req.actor, requireId(req.params.groupId, 'group id'));
  const assigned = await access.listCompanyDashboards(group.companyId);

  const held = [];
  for (const dashboard of assigned) {
    const grants = await access.listDashboardGrants(group.companyId, dashboard.id);
    const row = grants.groups.find((g) => g.groupId === group.id);
    if (row) held.push({ ...dashboard, level: row.level });
  }
  ok(res, { groupId: group.id, available: assigned, held });
});

module.exports = router;
