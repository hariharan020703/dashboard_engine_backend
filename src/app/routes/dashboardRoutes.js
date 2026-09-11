const express = require('express');
const { getSpec, invalidateSpecCache, hydrateView } = require('../../dashboard/dashboardService');
const registry = require('../../dashboard/dashboardRegistry');
const { sendError, badRequest } = require('../httpError');
const { elapsed } = require('../middleware/requestTimer');

/**
 * Two operations, each available for the default dashboard (the paths the
 * frontend uses) and for an explicit dashboard id:
 *   read a hydrated dashboard, and replace one card or KPI in it.
 */
const router = express.Router();

function parseFilters(query) {
  const filters = {};
  Object.entries(query || {}).forEach(([id, val]) => {
    if (typeof val === 'string') filters[id] = val.split(',').map((s) => s.trim()).filter(Boolean);
  });
  return filters;
}

async function respondWithView(req, res, label) {
  // Dashboard id comes from the route; omitted means the default dashboard.
  const spec = getSpec(req.params.dashboardId);
  const view = await hydrateView(parseFilters(req.query), spec);
  console.log(`[API] ${label} ${elapsed(res)}ms`);
  res.json(view);
}

function applyCardPatch(spec, body) {
  const { kind, index, card } = body || {};
  if (!card || typeof index !== 'number') {
    throw badRequest('expected { kind, index, card }');
  }
  const list = kind === 'kpi' ? spec.kpis : spec.cards;
  if (!Array.isArray(list) || index >= list.length || index < 0) {
    throw badRequest(`${kind === 'kpi' ? 'kpi' : 'card'} index out of bounds`);
  }
  list[index] = card;
  return spec;
}

async function patchConfig(req, res, label) {
  const dashboardId = req.params.dashboardId || registry.defaultDashboardId();
  const spec = applyCardPatch(getSpec(req.params.dashboardId), req.body);
  registry.saveSpec(dashboardId, spec);
  invalidateSpecCache(dashboardId);
  const view = await hydrateView((req.body && req.body.filters) || {}, getSpec(req.params.dashboardId));
  console.log(`[API] ${label} ${elapsed(res)}ms`);
  res.json({ view });
}

// Literal routes are registered before parameterised ones: in Express the first
// matching route wins, so /api/dashboard/view must not fall into :dashboardId.

router.get('/dashboard/view', async (req, res) => {
  try {
    await respondWithView(req, res, 'GET /api/dashboard/view');
  } catch (err) {
    sendError(res, err, 'GET /api/dashboard/view');
  }
});

router.patch('/dashboard/config', async (req, res) => {
  try {
    await patchConfig(req, res, 'PATCH /api/dashboard/config');
  } catch (err) {
    sendError(res, err, 'PATCH /api/dashboard/config');
  }
});

router.patch('/dashboard/:dashboardId/config', async (req, res) => {
  try {
    await patchConfig(req, res, `PATCH /api/dashboard/${req.params.dashboardId}/config`);
  } catch (err) {
    sendError(res, err, `PATCH /api/dashboard/${req.params.dashboardId}/config`);
  }
});

router.get('/dashboard/:dashboardId', async (req, res) => {
  try {
    await respondWithView(req, res, `GET /api/dashboard/${req.params.dashboardId}`);
  } catch (err) {
    sendError(res, err, `GET /api/dashboard/${req.params.dashboardId}`);
  }
});

module.exports = router;
