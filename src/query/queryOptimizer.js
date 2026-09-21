function planSignature(plan) {
  const src = plan.source ? [plan.source.database, plan.source.table] : [];
  const date = plan.dateGroup
    ? [plan.dateGroup.column, plan.dateGroup.grain, plan.dateGroup.parseFormat || '']
    : null;
  const filters = (plan.filters || []).map((f) => [f.column, f.operator || 'IN', f.values || []]);
  return JSON.stringify([src, date, filters]);
}

function mergePeriodKpis(periodPlans) {
  if (!periodPlans || !periodPlans.length) return [];

  const groups = new Map();
  for (const plan of periodPlans) {
    const sig = planSignature(plan);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(plan);
  }

  const merged = [];
  for (const plans of groups.values()) {
    if (plans.length === 1) {
      merged.push(plans[0]);
      continue;
    }

    const first = plans[0];
    merged.push({
      kind: 'kpi-period-merged',
      id: 'kpis:' + plans.map((p) => p.id).join('+'),
      // Earliest declaration position in the group, so merging never decides order.
      specIndex: Math.min(...plans.map((p) => (p.specIndex == null ? 0 : p.specIndex))),
      source: first.source,
      members: plans.map((p) => ({
        id: p.id,
        specIndex: p.specIndex,
        kpi: p.kpi,
        measure: p.measures[0],
        alias: p.id + '__value',
      })),
      dateGroup: first.dateGroup,
      orderBy: [],
      filters: first.filters,
      limit: null,
    });
  }
  return merged;
}

/**
 * Merges compatible KPI queries. Execution order is an internal concern only:
 * each plan and merged member carries its original spec index so the engine can
 * restore declaration order before formatting.
 */
function optimizePlans(kpiPlans) {
  const mergedKpiPlans = mergePeriodKpis(kpiPlans.periodPlans || []);
  const allKpiPlans = [...mergedKpiPlans, ...(kpiPlans.simplePlans || [])];
  return { optimizedKpiPlans: allKpiPlans };
}

module.exports = { planSignature, mergePeriodKpis, optimizePlans };
