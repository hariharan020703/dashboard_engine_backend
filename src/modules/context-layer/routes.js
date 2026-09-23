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

/**
 * How many datasets a listing may return.
 *
 * Absent means the provider's default, which is a first page rather than
 * everything: listing is the slowest thing a connector does, and an instance
 * with thousands of datasets is dozens of round trips before the picker can
 * draw anything.
 *
 * A bad value is refused rather than quietly clamped. `?limit=abc` and
 * `?limit=-5` are a client bug, and a listing that silently returns a
 * different amount than was asked for is the kind of thing that gets noticed
 * weeks later as "sometimes it only shows twenty".
 */
const MAX_DATASET_LIMIT = 500;

function readLimit(raw) {
  if (raw === undefined || raw === '') return undefined;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_DATASET_LIMIT) {
    throw fail(
      'VALIDATION_ERROR',
      `limit must be a whole number between 1 and ${MAX_DATASET_LIMIT} (got "${raw}").`
    );
  }
  return value;
}

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
    limit: readLimit((req.body || {}).limit),
  });

  audit(EVENTS.CONTEXT_CONNECTION_CREATED, req.actor, {
    connectionId: result.connection.id,
    provider: result.connection.provider,
    name: result.connection.name,
    host: result.connection.host,
    companyId,
    // "how many were listed", not "how many exist" - the listing is capped, so
    // recording it as a total would put a wrong number in the audit trail.
    datasetsListed: result.datasets.length,
    datasetLimit: result.limit,
    datasetsTruncated: result.truncated,
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
  const limit = readLimit(req.query.limit);
  const listing = await connections.fetchDatasets(req.actor, req.params.id, { limit });
  ok(res, {
    datasets: listing.datasets,
    fetchedAt: new Date().toISOString(),
    // Echoed so the client shows the limit that was actually applied rather
    // than the one it asked for - they differ whenever it asked for too much.
    limit: listing.limit,
    // True only when the warehouse was proven to hold at least one more.
    truncated: listing.truncated,
  });
});

/*
 * GET /api/context/connections/:id/profile - the Profile step's tree.
 *
 * Served from this database rather than the warehouse: the counts were
 * captured when the datasets were chosen, so the tree draws immediately and a
 * warehouse that is briefly unreachable does not empty the screen. Anything
 * that has to be current is fetched per table, below.
 */
router.get('/connections/:id/profile', requirePermission('context.read'), async (req, res) => {
  ok(res, await connections.profileOverview(req.actor, req.params.id));
});

/*
 * GET /api/context/connections/:id/tables/:tableId - one table, live.
 *
 * Structure and statistics read from the warehouse itself - columns, types,
 * null rates, distinct counts, a row sample. None of it is generated: this is
 * what the source says about its own data, which is why it is a separate step
 * from the AI's interpretation of it.
 */
router.get(
  '/connections/:id/tables/:tableId',
  requirePermission('context.read'),
  async (req, res) => {
    ok(res, await connections.tableProfile(req.actor, req.params.id, req.params.tableId));
  }
);

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
