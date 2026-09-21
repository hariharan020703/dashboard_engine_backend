const express = require('express');
const { getSpec, invalidateSpecCache, hydrateView } = require('../dashboard/dashboardService');
const { flattenCard } = require('../dashboard/cardModel');
const registry = require('../dashboard/dashboardRegistry');
const { ok, fail } = require('../api/response');
const { elapsed } = require('../middleware/requestTimer');
const { audit, EVENTS } = require('../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
  requireDashboardAccess,
} = require('../middleware/auth');

/**
 * The dashboard endpoints: read a hydrated dashboard, and replace one card in
 * it. KPIs are cards - a card's chartType is what makes it a badge rather than
 * a chart - so a single index addresses everything on the dashboard.
 *
 * The query engine behind these is untouched. What changed is that they are no
 * longer open: every request now resolves an actor, and requireDashboardAccess
 * confirms both that the dashboard is assigned to that actor's company and that
 * they hold a grant on it BEFORE any spec is resolved or any SQL is planned.
 *
 * That ordering is the point. Authorization that runs after the engine has
 * already queried the database is not a boundary, it is a filter on the way out.
 *
 * The id-less forms of these paths are gone. They served "the default
 * dashboard", which in a multi-tenant product is a request with no company in
 * it - there is no correct dashboard to answer with.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

function parseFilters(query) {
  const filters = {};
  Object.entries(query || {}).forEach(([id, val]) => {
    // `companyId` is a routing parameter on some of these paths, never a slicer.
    if (id === 'companyId') return;
    if (typeof val === 'string') filters[id] = val.split(',').map((s) => s.trim()).filter(Boolean);
  });
  return filters;
}

// GET /api/dashboard/:dashboardId - the hydrated dashboard
router.get(
  '/:dashboardId',
  requirePermission('dashboard.read'),
  requireDashboardAccess('view'),
  async (req, res) => {
    const spec = getSpec(req.dashboardId);
    const view = await hydrateView(parseFilters(req.query), spec);
    console.log(`[api] GET /api/dashboard/${req.dashboardId} ${elapsed(res)}ms`);
    // The caller's own level travels with the view, so the client can decide
    // what to offer without a second round trip to ask.
    ok(res, { ...view, accessLevel: req.dashboardLevel });
  }
);

/*
 * PATCH /api/dashboard/:dashboardId/config - replace one card.
 *
 * Needs `developer` on the dashboard, which the access catalogue already
 * defines as "may change the dashboard card configuration", AND the
 * dashboard.update permission, which is platform-only. Editing a card rewrites
 * a JSON file that every company assigned that dashboard will then see, so it
 * is not something one tenant may do to another's view of it.
 */
router.patch(
  '/:dashboardId/config',
  requirePermission('dashboard.update'),
  requireDashboardAccess('developer'),
  async (req, res) => {
    const { index, card, filters } = req.body || {};
    if (!card || typeof index !== 'number') {
      throw fail('VALIDATION_ERROR', 'Expected { index, card }');
    }

    const spec = getSpec(req.dashboardId);
    if (!Array.isArray(spec.cards) || index < 0 || index >= spec.cards.length) {
      throw fail('VALIDATION_ERROR', 'Card index out of bounds');
    }

    spec.cards[index] = flattenCard(card);
    registry.saveSpec(req.dashboardId, spec);
    invalidateSpecCache(req.dashboardId);

    const view = await hydrateView(filters || {}, getSpec(req.dashboardId));
    audit(EVENTS.DASHBOARD_UPDATED, req.actor, { dashboardId: req.dashboardId, cardIndex: index });
    console.log(`[api] PATCH /api/dashboard/${req.dashboardId}/config ${elapsed(res)}ms`);
    ok(res, { ...view, accessLevel: req.dashboardLevel });
  }
);

module.exports = router;
