const express = require('express');
const { db, T } = require('../config/database');
const { ok, fail, requireId } = require('../api/response');
const access = require('../auth/accessService');
const users = require('../auth/userService');
const groups = require('../auth/groupService');
const companies = require('../auth/companyService');
const { ACCESS_LEVELS, ACCESS_LEVEL_LABELS, levelAtLeast } = require('../auth/permissionCatalogue');
const { resolveTargetCompany, can } = require('../auth/authorization');
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
  const id = String(dashboardId || '');

  // Three independent checks, run concurrently (one round trip of latency, not
  // three) - but their failures are reported in the order they always were, so
  // a missing company is still "company not found" even if the dashboard is
  // missing too.
  const [company, exists, assigned] = await Promise.allSettled([
    companies.requireCompany(actor, companyId),
    access.requireDashboardId(id),
    access.assertDashboardAssigned(actor, companyId, id),
  ]);
  for (const outcome of [company, exists, assigned]) {
    if (outcome.status === 'rejected') throw outcome.reason;
  }
  return { companyId, dashboardId: id };
}

/**
 * May the actor read / grant / revoke on THIS dashboard?
 *
 * Two routes to yes, and they are deliberately different in reach:
 *
 *   The role permission (access.read / access.grant / access.revoke) - a
 *   company administrator. Full authority over every assigned dashboard,
 *   users and groups alike, exactly as before.
 *
 *   The dashboard's own level - what the grant ON this dashboard says the
 *   holder may do with its access:
 *     share  (Can share)    see who has it, and give people up to "Can share"
 *     admin  (Full control) the same up to "Full control", and remove access
 *
 * The second is narrower on purpose: people only, never groups, never above
 * the sharer's own level, and never their own grant - so sharing cannot be
 * used to promote yourself or out-rank whoever shared it with you.
 */
const AUTHORITY = {
  read: { permission: 'access.read', level: 'share' },
  grant: { permission: 'access.grant', level: 'share' },
  revoke: { permission: 'access.revoke', level: 'admin' },
};

async function grantAuthority(actor, dashboardId, action) {
  const rule = AUTHORITY[action];
  if (can(actor, rule.permission)) return { full: true, level: 'admin' };

  const level = await access.getAccessLevel(actor, dashboardId);
  if (!levelAtLeast(level, rule.level)) {
    throw fail(
      'INSUFFICIENT_PERMISSION',
      action === 'revoke'
        ? 'Removing access needs "Full control" of this dashboard.'
        : 'Sharing needs at least "Can share" on this dashboard.'
    );
  }
  return { full: false, level };
}

/**
 * The extra limits on a level-based (not administrator) change to one
 * person's grant. `level` is the level being set, or null for a removal.
 */
async function assertSharerMayChange(actor, authority, userId, dashboardId, level) {
  if (authority.full) return;
  if (Number(userId) === Number(actor.id)) {
    throw fail('INSUFFICIENT_PERMISSION', 'You cannot change your own access to a dashboard.');
  }
  if (level && !levelAtLeast(authority.level, level)) {
    throw fail(
      'INSUFFICIENT_PERMISSION',
      `You can give at most the access you hold yourself ("${authority.level}").`
    );
  }
  const current = await access.directUserLevel(userId, dashboardId);
  if (current && !levelAtLeast(authority.level, current)) {
    throw fail(
      'INSUFFICIENT_PERMISSION',
      'That person holds more access to this dashboard than you do, so only someone with more can change it.'
    );
  }
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
router.get('/dashboards/:dashboardId/grants', async (req, res) => {
  const { companyId, dashboardId } = await resolveGrantTarget(
    req.actor,
    req.query.companyId,
    req.params.dashboardId
  );
  const authority = await grantAuthority(req.actor, dashboardId, 'read');
  ok(res, {
    ...(await access.listDashboardGrants(companyId, dashboardId)),
    // What THIS caller may do here, so the screen offers exactly that.
    you: {
      userId: req.actor.id,
      level: authority.level,
      administrator: authority.full,
      mayRevoke: authority.full ? can(req.actor, 'access.revoke') : levelAtLeast(authority.level, 'admin'),
    },
  });
});

/*
 * GET /api/access/dashboards/:dashboardId/people - who it can be shared with.
 *
 * The active colleagues in the dashboard's company, for somebody who may share
 * it. A company administrator has the full user directory; a sharer does not,
 * and gets only the names they need to pick from.
 */
router.get('/dashboards/:dashboardId/people', async (req, res) => {
  const { dashboardId } = await resolveGrantTarget(req.actor, req.query.companyId, req.params.dashboardId);
  await grantAuthority(req.actor, dashboardId, 'grant');
  ok(res, await users.listUserOptions(req.actor));
});

/* ----------------------------------------------------------- user grants --- */

// PUT /api/access/dashboards/:dashboardId/users/:userId - grant or change a level
router.put('/dashboards/:dashboardId/users/:userId', async (req, res) => {
  const userId = requireId(req.params.userId, 'user id');
  const level = access.requireLevel((req.body || {}).level);

  // Scoped lookup: another company's user is a 404, not a 403 with a hint.
  const target = await users.requireUserInScope(req.actor, userId);
  const { dashboardId } = await resolveGrantTarget(req.actor, target.company_id, req.params.dashboardId);
  const authority = await grantAuthority(req.actor, dashboardId, 'grant');
  await assertSharerMayChange(req.actor, authority, userId, dashboardId, level);

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
router.delete('/dashboards/:dashboardId/users/:userId', async (req, res) => {
  const userId = requireId(req.params.userId, 'user id');
  const target = await users.requireUserInScope(req.actor, userId);
  const { dashboardId } = await resolveGrantTarget(req.actor, target.company_id, req.params.dashboardId);
  const authority = await grantAuthority(req.actor, dashboardId, 'revoke');
  await assertSharerMayChange(req.actor, authority, userId, dashboardId, null);

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

  // The group's own grants in one query, alongside the company's dashboards -
  // not two grant queries per assigned dashboard. The screen reads id and
  // title of what is available, plus the level of what is held.
  const [assigned, { rows }] = await Promise.all([
    access.listCompanyDashboards(group.companyId),
    db.query(
      `SELECT dashboard_id, access_level FROM ${T.groupDashboardAccess} WHERE group_id = ?`,
      [group.id]
    ),
  ]);
  const levels = new Map(rows.map((r) => [r.dashboard_id, r.access_level]));

  ok(res, {
    available: assigned.map((d) => ({ id: d.id, title: d.title })),
    held: assigned
      .filter((d) => levels.has(d.id))
      .map((d) => ({ id: d.id, title: d.title, level: levels.get(d.id) })),
  });
});

module.exports = router;
