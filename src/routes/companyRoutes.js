const express = require('express');
const { ok, fail, requireId } = require('../api/response');
const companies = require('../auth/companyService');
const users = require('../auth/userService');
const access = require('../auth/accessService');
const { prepareInvitation } = require('../auth/onboardingService');
const { assertCanAssignRole } = require('../auth/authorization');
const { COMPANY_ADMIN } = require('../auth/permissionCatalogue');
const { audit, EVENTS } = require('../auth/auditService');
const { revokeAllForUser } = require('../auth/tokenService');
const { sendEmail } = require('../email/emailService');
const { db, T, withTransaction } = require('../config/database');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../middleware/auth');

/**
 * Companies, and which dashboards each one may use.
 *
 * Almost everything here is platform-only: creating a customer, switching one
 * off, deciding what it can see. The one exception is reading, which a company
 * administrator legitimately does for their own company - companyService
 * narrows that query rather than this router special-casing it.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

// GET /api/companies - every company, or just the caller's own
router.get('/', requirePermission('company.read'), async (req, res) => {
  ok(res, await companies.listCompanies(req.actor));
});

/**
 * POST /api/companies - onboard a customer company and invite its administrator.
 *
 * The administrator is not optional. A company with no account in it cannot be
 * administered, cannot be signed into and does nothing but hold a name and a
 * slug that the next attempt then collides with; making it part of the same
 * request removes that state instead of documenting it.
 *
 * The company, the account and its activation token are written in one
 * transaction, and the invitation goes out after it commits. If the mail cannot
 * be delivered the company is removed again - all or nothing, exactly as
 * creating a single user already behaves, because a customer who was told
 * "created" and never received a link is in the one state nobody checks for.
 */
router.post('/', requirePermission('company.create'), async (req, res) => {
  const { name, slug, admin } = req.body || {};

  if (!admin || typeof admin !== 'object') {
    throw fail(
      'VALIDATION_ERROR',
      "A company needs an administrator. Send an 'admin' object with a username and an email address."
    );
  }

  // Asserted rather than assumed: this is the only place the platform hands out
  // a company-scoped administrator without an existing company to check against.
  assertCanAssignRole(req.actor, COMPANY_ADMIN);

  const { company, user, invitation } = await withTransaction(async (conn) => {
    const companyRow = await companies.insertCompany(req.actor, { name, slug }, conn);
    const userRow = await users.createUser(
      {
        companyId: companyRow.id,
        username: admin.username,
        email: admin.email,
        displayName: admin.displayName,
        role: COMPANY_ADMIN,
      },
      conn
    );
    return {
      company: companyRow,
      user: userRow,
      invitation: await prepareInvitation(req.actor, userRow, { conn }),
    };
  });

  try {
    await sendEmail(invitation, {
      consequence: 'The company and its administrator were not created.',
    });
  } catch (err) {
    await companies.deleteCompanyCascade(company.id);
    throw err;
  }

  audit(EVENTS.COMPANY_CREATED, req.actor, { companyId: company.id, name: company.name });
  audit(EVENTS.USER_CREATED, req.actor, {
    userId: user.id,
    targetUsername: user.username,
    targetEmail: user.email,
    role: user.role,
    companyId: company.id,
  });

  ok(res, { ...companies.shapeCompany(company), admin: users.publicUser(user) }, 201);
});

// GET /api/companies/:id - one company
router.get('/:id', requirePermission('company.read'), async (req, res) => {
  ok(res, await companies.requireCompany(req.actor, requireId(req.params.id, 'company id')));
});

// PATCH /api/companies/:id - rename, or activate and deactivate
router.patch('/:id', requirePermission('company.update'), async (req, res) => {
  const id = requireId(req.params.id, 'company id');
  const before = await companies.requireCompany(req.actor, id);
  const company = await companies.updateCompany(id, req.body || {});

  /*
   * Switching a company off has to reach the people already signed in. Their
   * access tokens run out within minutes and refresh re-checks the company, but
   * revoking here makes it immediate rather than eventual.
   */
  if (before.active && company.active === false) {
    const { rows: users } = await db.query(
      `SELECT id FROM ${T.users} WHERE company_id = ?`,
      [id]
    );
    for (const user of users) await revokeAllForUser(user.id, 'company_disabled');
  }

  audit(EVENTS.COMPANY_UPDATED, req.actor, {
    companyId: id,
    name: company.name,
    activeChanged: before.active !== company.active,
    active: company.active,
  });
  ok(res, company);
});

// DELETE /api/companies/:id - remove an empty company
router.delete('/:id', requirePermission('company.delete'), async (req, res) => {
  const id = requireId(req.params.id, 'company id');
  const company = await companies.requireCompany(req.actor, id);
  await companies.deleteCompany(id);
  audit(EVENTS.COMPANY_DELETED, req.actor, { companyId: id, name: company.name });
  ok(res, { deleted: true });
});

/* ------------------------------------------------- dashboard assignments --- */

/*
 * GET /api/companies/:id/dashboards - every dashboard, flagged with whether
 * this company has it.
 *
 * The full registry rather than only the assigned ones, because this is the
 * screen the platform owner assigns FROM. A company administrator reads their
 * own assignments through /api/access/dashboards instead.
 */
router.get('/:id/dashboards', requirePermission('dashboard.assign'), async (req, res) => {
  const id = requireId(req.params.id, 'company id');
  await companies.requireCompany(req.actor, id);
  ok(res, await access.listAssignableDashboards(id));
});

// PUT /api/companies/:id/dashboards/:dashboardId - let this company use it
router.put('/:id/dashboards/:dashboardId', requirePermission('dashboard.assign'), async (req, res) => {
  const id = requireId(req.params.id, 'company id');
  await companies.requireCompany(req.actor, id);
  const dashboardId = access.requireDashboardId(req.params.dashboardId);

  await access.assignDashboard(id, dashboardId, req.actor.id);
  audit(EVENTS.DASHBOARD_ASSIGNED, req.actor, { companyId: id, dashboardId });
  ok(res, { companyId: id, dashboardId, assigned: true });
});

/*
 * DELETE /api/companies/:id/dashboards/:dashboardId
 *
 * Takes the grants inside the company with it - see accessService.unassignDashboard
 * for why leaving them behind would be worse than removing them.
 */
router.delete('/:id/dashboards/:dashboardId', requirePermission('dashboard.assign'), async (req, res) => {
  const id = requireId(req.params.id, 'company id');
  await companies.requireCompany(req.actor, id);

  const removed = await access.unassignDashboard(id, req.params.dashboardId);
  audit(EVENTS.DASHBOARD_UNASSIGNED, req.actor, {
    companyId: id,
    dashboardId: req.params.dashboardId,
    wasAssigned: removed,
  });
  ok(res, { companyId: id, dashboardId: req.params.dashboardId, assigned: false });
});

module.exports = router;
