const { hydrateDashboard } = require('../query/queryEngine');
const registry = require('./dashboardRegistry');

/** Resolves a dashboard spec by id, or the default dashboard when id is omitted. */
function getSpec(dashboardId) {
  return dashboardId == null ? registry.resolveDefaultSpec() : registry.resolveSpec(dashboardId);
}

function invalidateSpecCache(dashboardId) {
  registry.invalidateSpecCache(dashboardId);
}

async function hydrateView(filters, spec) {
  const t0 = Date.now();
  const resolvedSpec = spec || registry.resolveDefaultSpec();
  const t1 = Date.now();

  const data = await hydrateDashboard(resolvedSpec, filters || {});
  const t2 = Date.now();

  const result = {
    dashboard: {
      id: resolvedSpec.id,
      title: resolvedSpec.title,
      description: resolvedSpec.description,
    },
    layout: resolvedSpec.layout || {},
    kpis: data.kpis,
    cards: data.cards,
    slicers: data.slicers,
    errors: data.errors || [],
  };
  const t3 = Date.now();

  console.log(
    `[Dashboard] spec=${t1 - t0}ms engine=${t2 - t1}ms assemble=${t3 - t2}ms ` +
    `total=${t3 - t0}ms queries kpi=${data._stats.kpiQueries} card=${data._stats.cardQueries} ` +
    `slicer=${data._stats.slicerQueries} cacheHits=${data._stats.cacheHits || 0} ` +
    `errors=${data._stats.errors || 0}`
  );

  return result;
}

module.exports = {
  getSpec,
  invalidateSpecCache,
  hydrateView,
};
