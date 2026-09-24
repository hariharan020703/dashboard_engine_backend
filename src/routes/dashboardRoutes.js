const express = require('express');
const crypto = require('crypto');
const { getSpec, invalidateSpecCache, hydrateView } = require('../dashboard/dashboardService');
const { flattenCard } = require('../dashboard/cardModel');
const registry = require('../dashboard/dashboardRegistry');
const access = require('../auth/accessService');
const { ok, fail, requireString } = require('../api/response');
const { elapsed } = require('../middleware/requestTimer');
const { audit, EVENTS } = require('../auth/auditService');
const { db, T } = require('../config/database');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
  requireDashboardAccess,
} = require('../middleware/auth');

/**
 * Dashboard endpoints:
 * - Create a dashboard (Platform Admin, Company Admin, Company User)
 * - Read a hydrated dashboard
 * - Edit cards / configuration (Platform Admin, Company Admin, Company User with edit rights)
 * - Delete a dashboard (Platform Admin, Company Admin; forbidden to Company User)
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

function parseFilters(query) {
  const filters = {};
  Object.entries(query || {}).forEach(([id, val]) => {
    if (id === 'companyId') return;
    if (typeof val === 'string') filters[id] = val.split(',').map((s) => s.trim()).filter(Boolean);
  });
  return filters;
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

// POST /api/dashboard - create a new dashboard
router.post('/', requirePermission('dashboard.create'), async (req, res) => {
  const body = req.body || {};
  const title = requireString(body.title, 'Dashboard title', { min: 2, max: 150 });
  const description = body.description ? String(body.description).trim() : null;

  let id = body.id ? String(body.id).trim() : null;
  if (!id) {
    const baseSlug = slugify(title) || 'dashboard';
    const suffix = crypto.randomBytes(3).toString('hex');
    id = `${baseSlug}-${suffix}`;
  }
  registry.assertValidDashboardId(id);

  // Check if ID already exists
  if (await registry.dashboardExists(id)) {
    throw fail('CONFLICT', `A dashboard with id "${id}" already exists.`);
  }

  // Multi-tenant company scope:
  // Platform admins can specify companyId or leave it null (global).
  // Company admins and users are strictly forced to their own companyId.
  const companyId = req.actor.isPlatform
    ? (body.companyId ? Number(body.companyId) : null)
    : req.actor.companyId;

  const spec = body.spec && typeof body.spec === 'object'
    ? { ...body.spec, id, title, description }
    : {
        version: '15',
        id,
        title,
        description: description || '',
        dataSource: body.dataSource || {
          type: 'postgres',
          schema: 'public',
          table: 'cinema_analysis',
        },
        layout: body.layout || {
          cols: 12,
          gap: 'sm',
          kpi: { span: 3, minHeight: 130 },
          chart: { span: 6, minHeight: 360 },
          slicer: { span: 3, minHeight: 44 },
        },
        slicers: Array.isArray(body.slicers) ? body.slicers : [],
        cards: Array.isArray(body.cards) ? body.cards : [],
      };

  await registry.saveSpec(id, spec, {
    companyId,
    userId: req.actor.id,
    title,
    description,
  });

  // Creator automatically receives admin access level on the dashboard
  await db.query(
    `INSERT INTO ${T.dashboardAccess} (user_id, dashboard_id, access_level, granted_by)
     VALUES (?, ?, 'admin', ?)
     ON CONFLICT (user_id, dashboard_id) DO UPDATE SET access_level = 'admin'`,
    [req.actor.id, id, req.actor.id]
  );

  // If company dashboard, also ensure company assignment exists
  if (companyId) {
    await db.query(
      `INSERT INTO ${T.companyDashboards} (company_id, dashboard_id, assigned_by)
       VALUES (?, ?, ?)
       ON CONFLICT (company_id, dashboard_id) DO NOTHING`,
      [companyId, id, req.actor.id]
    );
  }

  audit(EVENTS.DASHBOARD_CREATED, req.actor, { dashboardId: id, companyId });
  console.log(`[api] POST /api/dashboard id=${id} company=${companyId} ${elapsed(res)}ms`);

  ok(res, {
    id,
    title,
    description,
    companyId,
    accessLevel: 'admin',
    spec,
  }, 201);
});

// GET /api/dashboard/:dashboardId - the hydrated dashboard
router.get(
  '/:dashboardId',
  requirePermission('dashboard.read'),
  requireDashboardAccess('view'),
  async (req, res) => {
    const spec = await getSpec(req.dashboardId);
    const view = await hydrateView(parseFilters(req.query), spec);
    console.log(`[api] GET /api/dashboard/${req.dashboardId} ${elapsed(res)}ms`);
    ok(res, { ...view, accessLevel: req.dashboardLevel });
  }
);

// PATCH /api/dashboard/:dashboardId/config - replace one card
router.patch(
  '/:dashboardId/config',
  requirePermission('dashboard.update'),
  // Changing cards is "Can edit" (developer) and above - a viewer's role may
  // include dashboard.update, but their grant on THIS dashboard does not.
  requireDashboardAccess('developer'),
  async (req, res) => {
    const { index, card, filters } = req.body || {};
    if (!card || typeof index !== 'number') {
      throw fail('VALIDATION_ERROR', 'Expected { index, card }');
    }

    const spec = await getSpec(req.dashboardId);
    if (!req.actor.isPlatform) {
      const allowed = await access.companyDashboardIds(req.actor.companyId);
      if (!allowed.has(req.dashboardId)) {
        throw fail('TENANT_ACCESS_DENIED', 'This dashboard is not assigned to your company.');
      }
      if (spec.companyId !== null && spec.companyId !== undefined && spec.companyId !== req.actor.companyId) {
        throw fail('TENANT_ACCESS_DENIED', 'This dashboard does not belong to your company.');
      }
    }

    if (!Array.isArray(spec.cards) || index < 0 || index >= spec.cards.length) {
      throw fail('VALIDATION_ERROR', 'Card index out of bounds');
    }

    spec.cards[index] = flattenCard(card);
    await registry.saveSpec(req.dashboardId, spec, {
      companyId: spec.companyId,
      userId: req.actor.id,
      title: spec.title,
      description: spec.description,
    });
    invalidateSpecCache(req.dashboardId);

    const view = await hydrateView(filters || {}, await getSpec(req.dashboardId));
    audit(EVENTS.DASHBOARD_UPDATED, req.actor, { dashboardId: req.dashboardId, cardIndex: index });
    console.log(`[api] PATCH /api/dashboard/${req.dashboardId}/config ${elapsed(res)}ms`);
    ok(res, { ...view, accessLevel: req.dashboardLevel });
  }
);

// DELETE /api/dashboard/:dashboardId - delete a dashboard
router.delete(
  '/:dashboardId',
  requirePermission('dashboard.delete'),
  // Deleting is full control of the dashboard.
  requireDashboardAccess('admin'),
  async (req, res) => {
    const id = req.params.dashboardId;
    const spec = await getSpec(id);

    if (!req.actor.isPlatform) {
      if (spec.companyId === null) {
        throw fail('TENANT_ACCESS_DENIED', 'Only platform administrators can delete platform templates.');
      }
      if (spec.companyId !== req.actor.companyId) {
        throw fail('TENANT_ACCESS_DENIED', 'This dashboard does not belong to your company.');
      }
    }

    await registry.deleteDashboard(id);
    audit(EVENTS.DASHBOARD_DELETED, req.actor, { dashboardId: id, companyId: spec.companyId });
    console.log(`[api] DELETE /api/dashboard/${id} ${elapsed(res)}ms`);
    ok(res, { deleted: true, dashboardId: id });
  }
);

module.exports = router;
