const express = require('express');
const { ok, fail } = require('../../api/response');
const companies = require('../../auth/companyService');
const { resolveTargetCompany } = require('../../auth/authorization');
const { audit, EVENTS } = require('../../auth/auditService');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
} = require('../../middleware/auth');
const { CONNECTORS, findConnector, STATUS } = require('./connectorCatalogue');
const connections = require('./connectionService');

/**
 * The context layer: warehouse connections, and the datasets chosen from them.
 *
 * Mounted at /api/context. Company-scoped throughout - a connection holds a
 * live credential for one tenant's warehouse, so every handler resolves the
 * company from the actor rather than from the request, and the service filters
 * by it in SQL.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

/* ------------------------------------------------------------- catalogue --- */

// GET /api/context/connectors - what can be connected, and what is coming
router.get('/connectors', requirePermission('context.read'), (req, res) => {
  ok(res, CONNECTORS);
});

/* ----------------------------------------------------------- connections --- */

// GET /api/context/connections - this company's saved connections
router.get('/connections', requirePermission('context.read'), async (req, res) => {
  ok(res, await connections.listConnections(req.actor));
});

/**
 * POST /api/context/connections - validate a credential, then save it.
 *
 * The response carries the datasets the token can see, because that is the
 * next thing the person needs and asking for them again would be a second
 * round trip to Domo for an answer this request already had.
 */
router.post('/connections', requirePermission('context.manage'), async (req, res) => {
  const { provider, name, host, token } = req.body || {};

  const connector = findConnector(provider);
  if (!connector) {
    throw fail('VALIDATION_ERROR', `"${provider}" is not a connector this platform knows about.`);
  }
  if (connector.status !== STATUS.available) {
    throw fail(
      'VALIDATION_ERROR',
      `The ${connector.name} connector is not built yet, so it cannot be configured.`
    );
  }

  /*
   * A platform account must name the company; a company account gets its own
   * and any companyId in the body is ignored - the same rule as creating a
   * user, for the same reason.
   */
  const companyId = resolveTargetCompany(req.actor, (req.body || {}).companyId);
  const company = await companies.requireCompany(req.actor, companyId);
  if (!company.active) {
    throw fail('VALIDATION_ERROR', 'That company is deactivated, so connections cannot be added to it.');
  }

  const result = await connections.createConnection(req.actor, companyId, {
    provider: connector.id,
    name,
    host,
    token,
  });

  audit(EVENTS.CONTEXT_CONNECTION_CREATED, req.actor, {
    connectionId: result.connection.id,
    provider: result.connection.provider,
    name: result.connection.name,
    host: result.connection.host,
    companyId,
    datasetsVisible: result.datasets.length,
  });

  ok(res, result, 201);
});

// GET /api/context/connections/:id - one connection and its chosen datasets
router.get('/connections/:id', requirePermission('context.read'), async (req, res) => {
  ok(res, await connections.requireConnection(req.actor, req.params.id));
});

// POST /api/context/connections/:id/verify - re-check the stored credential
router.post('/connections/:id/verify', requirePermission('context.manage'), async (req, res) => {
  ok(res, await connections.verifyConnection(req.actor, req.params.id));
});

/*
 * GET /api/context/connections/:id/datasets - what the warehouse has now.
 *
 * Live, not cached: this is the list somebody picks from, and a stale one means
 * choosing a dataset id that no longer resolves - which then fails later,
 * somewhere else, for a reason invisible from this screen.
 */
router.get('/connections/:id/datasets', requirePermission('context.read'), async (req, res) => {
  const datasets = await connections.fetchDatasets(req.actor, req.params.id);
  ok(res, { datasets, fetchedAt: new Date().toISOString() });
});

/*
 * PUT /api/context/connections/:id/datasets - record the chosen datasets.
 *
 * This is the handoff the screen exists to produce. What is stored is the
 * dataset ids; building a context from them is a separate step, and nothing
 * here pretends to have done it.
 */
router.put('/connections/:id/datasets', requirePermission('context.manage'), async (req, res) => {
  const body = req.body || {};
  const connection = await connections.replaceSelection(req.actor, req.params.id, body.datasets);

  audit(EVENTS.CONTEXT_DATASETS_SELECTED, req.actor, {
    connectionId: connection.id,
    provider: connection.provider,
    companyId: connection.companyId,
    datasetIds: connection.selectedDatasets.map((d) => d.id),
  });

  ok(res, connection);
});

// DELETE /api/context/connections/:id - forget the connection and its credential
router.delete('/connections/:id', requirePermission('context.manage'), async (req, res) => {
  const removed = await connections.deleteConnection(req.actor, req.params.id);
  audit(EVENTS.CONTEXT_CONNECTION_DELETED, req.actor, {
    connectionId: req.params.id,
    provider: removed.provider,
    name: removed.name,
  });
  ok(res, { deleted: true });
});

module.exports = router;
