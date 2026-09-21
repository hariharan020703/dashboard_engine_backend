const express = require('express');
const { db } = require('../config/database');
const { getSpec } = require('../dashboard/dashboardService');
const { hydrateDashboard } = require('../query/queryEngine');
const { resolveSourceMetadata } = require('../query/metadataResolver');
const { cardKind, flattenCard } = require('../dashboard/cardModel');
const { ok, fail } = require('../api/response');
const { elapsed } = require('../middleware/requestTimer');
const {
  requireRbac,
  requireAuth,
  requirePasswordCurrent,
  requirePermission,
  requireDashboardAccess,
} = require('../middleware/auth');

/**
 * Editor support: the column catalogue the card editor picks fields from, and a
 * preview that runs a draft card through the real engine without saving it.
 *
 * Both of these read the source table behind a dashboard, so both are now
 * guarded by the dashboard's own access check rather than being open. The
 * catalogue in particular is worth guarding: it lists every column of the
 * underlying table, which is a description of the data even before a row of it
 * is returned.
 *
 * The dashboard id is required on both. It used to be optional and fell back to
 * the default dashboard, which cannot mean anything now that dashboards belong
 * to companies.
 */
const router = express.Router();

router.use(requireRbac, requireAuth, requirePasswordCurrent);

const { quoteQualified } = require('../query/semanticLayer');

/** GET /api/dashboard/columns?dashboardId=... - the source table's columns. */
router.get(
  '/columns',
  requirePermission('data.read'),
  requireDashboardAccess('view'),
  async (req, res) => {
    const spec = getSpec(req.dashboardId);
    const meta = await resolveSourceMetadata(spec);
    // Schema-qualified: the pool's search_path is not something a dashboard's
    // row count should depend on.
    const { rows: count } = await db.query(
      `SELECT COUNT(*)::bigint AS n FROM ${quoteQualified(meta.table.schema, meta.table.table)}`
    );

    ok(res, {
      dashboardId: spec.id,
      database: meta.table.database,
      schema: meta.table.schema,
      table: meta.table.table,
      rowCount: Number(count[0].n),
      rowCountText: Number(count[0].n).toLocaleString('en-US'),
      dateParse: meta.dateParse || {},
      columns: meta.table.columns.map((c) => ({
        name: c.name,
        type: c.type,
        columnType: c.columnType,
        nullable: c.nullable,
        isNumeric: c.isNumeric,
        isDate: c.isDate,
        isString: c.isString,
        // Numeric columns can be aggregated; everything else groups.
        role: c.isNumeric ? 'measure' : 'dimension',
      })),
    });
    console.log(`[api] GET /api/dashboard/columns ${elapsed(res)}ms`);
  }
);

/**
 * POST /api/dashboard/preview - run one draft card through the full engine.
 *
 * Nothing is persisted, and the same validation the dashboard uses applies - so
 * an invalid draft comes back as error metadata rather than a failed request.
 *
 * Requires `developer` on the dashboard, not `view`: a preview accepts an
 * arbitrary card definition, which is the editor's power to choose what gets
 * queried. Somebody who may only look at the dashboard must not be able to ask
 * it for a different aggregation of the table behind it.
 */
router.post(
  '/preview',
  requirePermission('dashboard.update'),
  requireDashboardAccess('developer'),
  async (req, res) => {
    const { card, filters } = req.body || {};
    if (!card || typeof card !== 'object') throw fail('VALIDATION_ERROR', 'Expected { card }');

    const draft = flattenCard(card);
    const spec = getSpec(req.dashboardId);
    // Slicers stay in the spec so filter ids still resolve to columns; their
    // queries are already cached from the dashboard request.
    const draftSpec = { ...spec, cards: [draft] };

    const data = await hydrateDashboard(draftSpec, filters || {});
    console.log(`[api] POST /api/dashboard/preview ${elapsed(res)}ms`);
    ok(res, {
      kind: cardKind(draft),
      visual: data.cards[0] || null,
      error: (data.errors || [])[0] || null,
    });
  }
);

module.exports = router;
