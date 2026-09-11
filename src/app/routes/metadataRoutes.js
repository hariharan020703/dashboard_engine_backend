const express = require('express');
const pool = require('../../config/database');
const { getSpec } = require('../../dashboard/dashboardService');
const { hydrateDashboard } = require('../../query/queryEngine');
const { resolveSourceMetadata } = require('../../query/metadata/metadataResolver');
const { sendError, badRequest } = require('../httpError');
const { elapsed } = require('../middleware/requestTimer');

/**
 * Editor support: the column catalogue the card editor picks fields from, and a
 * preview that runs a draft card through the real engine without saving it.
 */
const router = express.Router();

function quote(name) {
  return '`' + String(name).replace(/`/g, '``') + '`';
}

/** Columns of the dashboard's source table, split into measures and dimensions. */
router.get('/dashboard/columns', async (req, res) => {
  try {
    const spec = getSpec();
    const meta = await resolveSourceMetadata(spec);
    const [count] = await pool.query(`SELECT COUNT(*) AS n FROM ${quote(meta.table.table)}`);

    res.json({
      dashboardId: spec.id,
      database: meta.table.database,
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
    console.log(`[API] GET /api/dashboard/columns ${elapsed(res)}ms`);
  } catch (err) {
    sendError(res, err, 'GET /api/dashboard/columns');
  }
});

/**
 * Runs one draft card through the full engine and returns the formatted result.
 * Nothing is persisted, and the same validation the dashboard uses applies — so
 * an invalid draft comes back as error metadata rather than a failed request.
 */
router.post('/dashboard/preview', async (req, res) => {
  try {
    const { kind, card, filters } = req.body || {};
    if (!card || typeof card !== 'object') throw badRequest('expected { kind, card }');
    if (kind !== 'kpi' && kind !== 'chart') throw badRequest('kind must be "kpi" or "chart"');

    const spec = getSpec();
    // Slicers stay in the spec so filter ids still resolve to columns; their
    // queries are already cached from the dashboard request.
    const draftSpec = {
      ...spec,
      kpis: kind === 'kpi' ? [card] : [],
      cards: kind === 'chart' ? [card] : [],
    };

    const data = await hydrateDashboard(draftSpec, filters || {});
    const visual = kind === 'kpi' ? data.kpis[0] : data.cards[0];
    console.log(`[API] POST /api/dashboard/preview ${elapsed(res)}ms`);
    res.json({
      kind,
      visual: visual || null,
      error: (data.errors || [])[0] || null,
    });
  } catch (err) {
    sendError(res, err, 'POST /api/dashboard/preview');
  }
});

module.exports = router;
